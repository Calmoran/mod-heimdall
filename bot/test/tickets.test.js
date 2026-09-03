import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js'

import { ADMIN_PERMISSIONS, HeimdallService, REQUIRED_PERMISSIONS, ticketAdminCommand } from '../src/discord.js'
import { deriveRunId, loadConfig } from '../src/config.js'
import { Logger } from '../src/logger.js'
import { TicketRepository } from '../src/repository.js'
import {
  GM_ACTIONS,
  MODAL_TEXT_LIMITS,
  TICKET_CATEGORIES,
  archiveExpiry,
  assertTransition,
  eventKey,
  intakeDescription,
  intakeFields,
  intakeHeadline,
  memberCanWorkTicket,
  safeChannelName,
  sanitizeText,
  splitWowMessage,
  ticketPublicKey,
  validateGmName,
  validateTeleDestination,
} from '../src/domain.js'

test('the bot mints Discord ticket keys and refuses to mint in-game ones', () => {
  assert.equal(ticketPublicKey('discord', 42), 'DIS-000042')
  // In-game keys are <REALM_TAG>-<id>, minted by the game module from server-side config.
  assert.throws(() => ticketPublicKey('ingame', 42), /Unknown ticket source/)
})

test('channel names are safe and bounded', () => {
  assert.equal(safeChannelName('DIS-000042', 'A Bug!!!'), 'dis-000042-a-bug')
  assert.ok(safeChannelName('DIS-000042', 'x'.repeat(200)).length <= 90)
})

test('wow messages split on word boundaries without exceeding bytes', () => {
  const chunks = splitWowMessage('one two three four', 9)
  assert.deepEqual(chunks, ['one two', 'three', 'four'])
})

// A long word used to throw and take the whole reply with it. The realistic trigger is a GM
// pasting a URL with query parameters, and there was no way for them to work around it.
test('a word longer than a whisper is split rather than rejected', () => {
  const url = `https://wiki.example.com/page?${'q=1&'.repeat(80)}end`
  const chunks = splitWowMessage(`See ${url} for details`, 240)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk, 'utf8') <= 240)
  // Nothing lost: the URL survives once the whispers are put back together.
  assert.ok(chunks.join('').includes(url.replace(/\s/g, '')))
  // Following words still share the last whisper rather than each getting their own.
  assert.match(chunks.at(-1), /for details$/)
})

test('splitting a long word never cuts a multi-byte character in half', () => {
  for (const alphabet of ['é', '日', '👾']) {
    const word = alphabet.repeat(200)
    const chunks = splitWowMessage(word, 41)
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= 41)
      // A byte-level slice would leave a replacement character behind here.
      assert.ok(!chunk.includes('�'), `${alphabet} was cut mid-character`)
      assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk)
    }
    assert.equal(chunks.join(''), word, `${alphabet} did not survive the round trip`)
  }
})

test('ticket transitions reject unsafe lifecycle jumps', () => {
  assert.doesNotThrow(() => assertTransition('open', 'claimed'))
  assert.throws(() => assertTransition('open', 'closed'), /Invalid ticket transition/)
})

test('only configured staff roles can work tickets', () => {
  const config = { adminRoleIds: ['a'], staffRoleIds: ['m', 'g'] }
  assert.equal(memberCanWorkTicket(['m'], config), true)
  assert.equal(memberCanWorkTicket(['a'], config), true, 'an admin lost the ability to work tickets')
  assert.equal(memberCanWorkTicket(['player'], config), false)
})

test('event keys are deterministic and archival dates use UTC days', () => {
  assert.equal(eventKey(['ticket', 1]), eventKey(['ticket', 1]))
  assert.notEqual(eventKey(['ticket', 1]), eventKey(['ticket', 2]))
  assert.equal(archiveExpiry('2026-01-01T00:00:00.000Z', 180).toISOString(), '2026-06-30T00:00:00.000Z')
})

test('staff GM names and Discord text are constrained safely', () => {
  assert.equal(validateGmName('GameMaster1'), 'GameMaster1')
  assert.throws(() => validateGmName('GM Name'), /GM names/)
  assert.equal(sanitizeText('@everyone please help'), '@\u200beveryone please help')
})

test('every intake form fits inside Discord and answers the questions staff need', () => {
  for (const [key, category] of Object.entries(TICKET_CATEGORIES)) {
    const fields = intakeFields(key)
    // Discord takes at most five components in one modal, and a form people abandon is worse than
    // a short one.
    assert.ok(fields.length <= 5, `${key} has ${fields.length} fields`)
    assert.ok(fields.some((field) => field.body), `${key} has no free-text field`)
    for (const field of fields) {
      assert.ok(field.label.length <= MODAL_TEXT_LIMITS.label, `${key}.${field.id} label is ${field.label.length}`)
      assert.ok((field.placeholder ?? '').length <= MODAL_TEXT_LIMITS.description, `${key}.${field.id} placeholder is too long`)
      for (const option of Object.values(field.options ?? {})) {
        assert.ok(option.length <= MODAL_TEXT_LIMITS.option, `${key}.${field.id} option "${option}" is too long`)
      }
    }
    assert.ok(category.label.length <= MODAL_TEXT_LIMITS.title - 4, `${key} title would not fit "New <label>"`)
  }
})

test('support intake surfaces where the problem is without reading the description', () => {
  const intake = { location: 'In game', character: 'Testplayer', details: 'Stuck under Orgrimmar.' }
  assert.deepEqual(intakeHeadline('support', intake), ['**Where:** In game', '**Character:** Testplayer'])
  // The free-text answer stands alone; anything else is labelled.
  assert.ok(intakeDescription('support', intake).endsWith('Stuck under Orgrimmar.'))
  // A blank optional answer leaves no empty heading behind.
  assert.deepEqual(intakeHeadline('support', { location: 'Discord', details: 'x' }), ['**Where:** Discord'])
})

test('every GM action names its target and none relies on an invoking GM', () => {
  for (const [key, action] of Object.entries(GM_ACTIONS)) {
    const command = action.command('Testplayer', { publicKey: 'R1-9', destination: 'stormwind' })
    assert.ok(command.startsWith('.'), `${key} is not a command`)
    assert.ok(command.includes('Testplayer'), `${key} does not name its target, so it would act on whoever invoked it`)
    // .appear, .summon and .recall are Console::No precisely because they are relative to an
    // invoker. If one ever appears here, it cannot work over SOAP.
    assert.ok(!/^\.(appear|summon|recall)\b/.test(command), `${key} cannot run without an invoking GM`)
    assert.equal(typeof action.success('Testplayer', { destination: 'stormwind' }), 'string')
  }
  // The unstuck handler dereferences its location argument without checking it, so the command is
  // only safe with one supplied.
  assert.match(GM_ACTIONS.unstuck.command('Testplayer', {}), /^\.unstuck Testplayer \w+$/)
})

test('no GM action sends the core more arguments than the command declares', () => {
  // AzerothCore refuses a command with anything left over rather than ignoring it: ".revive X junk"
  // answers with the syntax line and does nothing. A reason of "Ticket R1-5" was one token too
  // many for .kick, whose reason is a single string_view and not a Tail, so no click ever landed.
  for (const [key, action] of Object.entries(GM_ACTIONS)) {
    const command = action.command('Testplayer', { publicKey: 'R1-5', destination: 'stormwind' })
    assert.equal(command.split(/\s+/).length, action.tokens, `${key} builds "${command}", which is not ${action.tokens} tokens`)
  }
})

test('teleport destinations cannot smuggle anything into a command line', () => {
  assert.equal(validateTeleDestination('stormwind'), 'stormwind')
  assert.equal(validateTeleDestination('  $home  '), '$home')
  for (const bad of ['foo bar', 'foo; .ban x', '.kick someone', '', 'x'.repeat(49)]) {
    assert.throws(() => validateTeleDestination(bad), /destination/i, `accepted ${JSON.stringify(bad)}`)
  }
})

function scratchLogger(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-log-'))
  const silent = { error() {}, warn() {}, info() {}, log() {} }
  return { directory, logger: new Logger({ directory, console: silent, ...options }) }
}

// The value here is deliberately NOT shaped like a Discord token. It used to be, and although it
// was synthetic - the first segment decoded to 123456789012345678 - GitHub's secret scanner matches
// on shape, so it blocked the operator's first push across five historical commits. Anyone forking
// and pushing hits the same wall without the context to know it is fake. What this test proves is
// the registered-secret path, which does not care what the value looks like.
//
// Shape-based redaction is covered separately below, by a value assembled at runtime so that no
// token-shaped literal exists in this file for a scanner to find.
test('a registered secret never reaches the log file, however it was logged', () => {
  const token = 'heimdall-test-credential-not-a-real-token'
  const password = 'hunter2-correct-horse'
  const { directory, logger } = scratchLogger({ secrets: [token, password] })

  logger.error(`login failed for Bot ${token}`)
  logger.error(new Error(`connect ECONNREFUSED mysql://heimdall_bot:${password}@127.0.0.1:3306`))
  logger.info('config', { password })
  logger.info('driver said: password=' + password)

  const written = fs.readFileSync(path.join(directory, 'heimdall-bot.log'), 'utf8')
  assert.ok(!written.includes(token), 'token reached the file')
  assert.ok(!written.includes(password), 'password reached the file')
  assert.match(written, /REDACTED/)
})

// The redactor that matters most in a real leak is the one that catches a secret nobody registered -
// a token pasted into an error message by a library, say. Registering the value would test the
// wrong path, so this one is deliberately not registered.
test('a token-shaped value is redacted by its shape, even unregistered', () => {
  const unregistered = ['Z'.repeat(24), 'AAAAAA', 'B'.repeat(27)].join('.')
  const { directory, logger } = scratchLogger({ secrets: [] })

  // No "Bot " prefix: that would be caught by a different pattern and prove nothing about this one.
  logger.error(`gateway refused: ${unregistered}`)

  const written = fs.readFileSync(path.join(directory, 'heimdall-bot.log'), 'utf8')
  assert.ok(!written.includes(unregistered), 'an unregistered token-shaped value reached the file')
  assert.match(written, /REDACTED-TOKEN/)
})

// A fixture that no longer matches Discord's shape is only half the fix; the other half is that it
// stays that way. This fails if someone reintroduces a token-shaped literal anywhere in the suite.
test('no token-shaped literal exists in this test file, so forks can push it', () => {
  const source = fs.readFileSync(new URL('./tickets.test.js', import.meta.url), 'utf8')
  const discordTokenShape = /['"`][MNO][A-Za-z0-9_-]{22,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}['"`]/
  assert.doesNotMatch(source, discordTokenShape,
    'a Discord-token-shaped literal is back; GitHub push protection will block forks')
})

test('info records that a whisper happened, never what it said', () => {
  const { directory, logger } = scratchLogger({ level: 'info' })
  logger.info('Posting player whisper', { ticket: 'R1-15', from: 'Testplayer', bytes: 21 })
  logger.debug('Player whisper content', { ticket: 'R1-15', body: 'my bags are stuck' })

  const written = fs.readFileSync(path.join(directory, 'heimdall-bot.log'), 'utf8')
  assert.match(written, /[R1-15]/)
  assert.match(written, /bytes=21/)
  assert.ok(!written.includes('my bags are stuck'), 'message body leaked at info')
})

test('the log rotates and drops the oldest file at the retained count', () => {
  const { directory, logger } = scratchLogger({ maxBytes: 400, retainedFiles: 2 })
  for (let index = 0; index < 60; index += 1) logger.info(`line ${index} ${'x'.repeat(40)}`)

  const files = fs.readdirSync(directory).sort()
  assert.deepEqual(files, ['heimdall-bot.log', 'heimdall-bot.log.1', 'heimdall-bot.log.2'])
  for (const file of files) {
    assert.ok(fs.statSync(path.join(directory, file)).size <= 500, `${file} grew past the cap`)
  }
})

// A stand-in for a guild where the bot holds everything except the named permissions. Every place
// the preflight looks resolves, so the run reflects a fully provisioned guild.
function serviceMissing(...missing) {
  const denied = new Set(missing)
  const held = { has: (flag) => !denied.has(flag) }
  const lines = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: (line) => lines.push(['error', line]), warn: (line) => lines.push(['warn', line]), info: (line, meta) => lines.push(['info', line, meta]) }
  service.ids = {
    openCategoryId: 'cat-open', claimedCategoryId: 'cat-claimed', closedCategoryId: 'cat-closed',
    supportCategoryId: 'cat-support', panelChannelId: 'chan-panel', queueChannelId: 'chan-queue',
  }
  service.repository = { getSetting: async () => null }
  service.guild = { members: { fetchMe: async () => ({ permissions: held }) } }
  service.client = { channels: { fetch: async () => ({ permissionsFor: () => held }) } }
  return { service, lines }
}

test('the permissions preflight names what is missing and what it breaks, then stops', async () => {
  const { service, lines } = serviceMissing(PermissionFlagsBits.CreatePrivateThreads)

  // It used to log "cannot work without" and carry on regardless, provisioning more channels it
  // could not reach and burying that line under the failures that followed.
  await assert.rejects(() => service.verifyPermissions(), /cannot work without/)

  const errors = lines.filter(([level]) => level === 'error').map(([, line]) => line)
  assert.ok(errors.some((line) => line.includes('Create Private Threads')), 'did not name the permission')
  assert.ok(errors.some((line) => line.includes('no ticket has any controls')), 'did not say what breaks')
})

test('a degrading permission warns rather than erroring, and a full set is silent', async () => {
  const degraded = serviceMissing(PermissionFlagsBits.ManageWebhooks)
  await degraded.service.verifyPermissions()
  assert.equal(degraded.lines.filter(([level]) => level === 'error').length, 0)
  assert.ok(degraded.lines.some(([level, line]) => level === 'warn' && line.includes('Manage Webhooks')))

  const complete = serviceMissing()
  await complete.service.verifyPermissions()
  assert.deepEqual(complete.lines.map(([level]) => level), ['info'])
  // Both numbers are reported. "places=2" reads exactly like success on its own.
  const [, , coverage] = complete.lines[0]
  assert.equal(coverage.places, coverage.expected, 'a full guild did not report full coverage')
  assert.equal(coverage.expected, 7)
})

// The bug this exists for: on a first run the queue board was created AFTER the preflight, so the
// one run where configuration is most likely wrong was the run with the least coverage - and the
// printed count hid it, because places=5 and places=6 both read as success.
test('a place the preflight could not check is reported as unchecked', async () => {
  const { service, lines } = serviceMissing()
  service.ids.queueChannelId = null
  await service.verifyPermissions()

  const warnings = lines.filter(([level]) => level === 'warn').map(([, line]) => line)
  assert.ok(warnings.some((line) => line.includes('6 of 7 places')), 'did not report short coverage')
  assert.ok(warnings.some((line) => line.includes('queue board')), 'did not name what went unchecked')
  assert.ok(warnings.some((line) => line.includes('not a place that passed')))
})

test('every required permission says what breaks without it', () => {
  for (const permission of REQUIRED_PERMISSIONS) {
    assert.ok(permission.name && permission.breaks, `${String(permission.flag)} is not explained`)
    assert.equal(typeof permission.fatal, 'boolean')
  }
})

test('the install guide and the preflight name the same permissions', () => {
  // These two drifted once already: the guide asked for Attach Files and Use Application Commands,
  // neither of which the bot uses. An operator reading the guide and an operator reading a startup
  // warning have to be told the same thing.
  const guide = fs.readFileSync(new URL('../../docs/INSTALL-bot.md', import.meta.url), 'utf8')
  for (const permission of REQUIRED_PERMISSIONS) {
    assert.ok(guide.includes(permission.name), `docs/INSTALL.md does not mention ${permission.name}`)
  }
  for (const stale of ['Attach Files', 'Use Application Commands']) {
    assert.ok(!guide.includes(stale), `docs/INSTALL.md still asks for ${stale}, which the bot never uses`)
  }
})

// Enough of a guild for /ticket to run against. refreshQueueBoard and refreshTicketHeader are
// replaced because they are presentation reached through every lifecycle path; everything else,
// including refreshVisibility itself, is the real method.
function adminService() {
  const seen = { upsert: [], disable: [], reopen: [], reassign: [], threadAdds: [], unarchived: 0 }
  const ticket = {
    id: 7, public_key: 'R1-7', status: 'claimed', source: 'ingame',
    discord_channel_id: 'chan-7', discord_creator_id: null, claimant_discord_user_id: '900',
  }
  const thread = {
    name: 'staff-r1-7', archived: true,
    members: { add: async (id) => { seen.threadAdds.push(id) } },
    setArchived: async () => { seen.unarchived += 1 },
  }
  const channel = { id: 'chan-7', setParent: async () => {}, permissionOverwrites: { set: async () => {} } }
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.config = { adminRoleIds: ['role-admin'], staffRoleIds: ['role-mod', 'role-gm'] }
  service.ids = { openCategoryId: 'cat-open', claimedCategoryId: 'cat-claimed', closedCategoryId: 'cat-closed' }
  service.guild = {
    roles: { everyone: { id: 'everyone' } },
    members: { cache: new Map(), fetch: async (id) => ({ id, roles: { cache: new Map([['role-mod', {}]]) } }) },
  }
  service.client = { channels: { fetch: async (id) => (id === 'thread-7' ? thread : channel) } }
  service.repository = {
    upsertStaff: async (...args) => { seen.upsert.push(args) },
    disableStaff: async (...args) => { seen.disable.push(args) },
    listStaff: async () => [{ discord_user_id: '900', gm_name: 'Helpbot', enabled: 1 }],
    reopen: async (...args) => { seen.reopen.push(args); return ticket },
    reassign: async (...args) => { seen.reassign.push(args); return ticket },
    staff: async () => ({ gm_name: 'Helpbot' }),
    ticketsWithOpenWork: async () => [ticket],
    getThreadId: async () => 'thread-7',
    gmIdentityNames: async () => ['Helpbot'],
    getTicket: async () => ticket,
    getTicketByChannel: async () => ticket,
  }
  service.refreshQueueBoard = async () => {}
  service.refreshTicketHeader = async () => {}
  return { service, seen }
}

function adminInteraction(subcommand, roles = ['role-admin']) {
  const replies = []
  return {
    replies,
    user: { id: '100' },
    member: { roles: { cache: new Map(roles.map((id) => [id, {}])) } },
    options: {
      getSubcommand: () => subcommand,
      getUser: () => ({ id: '900', toString: () => '<@900>' }),
      getString: () => 'Helpbot',
      getInteger: () => 7,
    },
    channel: null,
    reply: async (payload) => { replies.push(payload); return payload },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); return payload },
  }
}

// The bug this exists for: /ticket staff-add called this.addStaffToOpenThreads(), which was never
// written. JavaScript resolves a method name when the line runs, so `npm run check` parsed it
// happily and no test reached it - it took a human running the command on a live guild. Driving
// every declared subcommand through the real prototype makes a missing method a test failure.
test('every /ticket admin subcommand runs against the real service', async () => {
  const declared = ticketAdminCommand().toJSON().options.map((option) => option.name)
  assert.ok(declared.length >= 6, 'the admin command lost subcommands')
  for (const name of declared) {
    const { service } = adminService()
    const interaction = adminInteraction(name)
    await service.handleAdminCommand(interaction)
    assert.equal(interaction.replies.length, 1, `/ticket ${name} did not reply`)
    assert.ok(interaction.replies[0].content, `/ticket ${name} replied with nothing`)
  }
})

test('staff-add rosters the member, joins them to open threads, and counts them', async () => {
  const { service, seen } = adminService()
  const interaction = adminInteraction('staff-add')
  await service.handleAdminCommand(interaction)

  assert.deepEqual(seen.upsert, [['900', 'Helpbot']], 'the mapping was not saved')
  assert.deepEqual(seen.threadAdds, ['900'], 'the new staff member was not added to the open thread')
  assert.equal(seen.unarchived, 1, 'an archived thread was not reopened before adding')
  assert.match(interaction.replies[0].content, /Added to 1 open ticket thread/)
})

test('ticket administration is refused to anyone without the admin role', async () => {
  const { service } = adminService()
  await assert.rejects(
    service.handleAdminCommand(adminInteraction('staff-list', ['role-mod'])),
    /Only administrators/,
  )
})

// The bug this exists for: the lock holder was BOT_INSTANCE_ID, so two copies started from one
// .env wrote the same name into the row. The second read it, saw itself, and ran alongside the
// first - two bots answering every button press, each undoing the other's work.
test('two copies of one configuration get different lock identities', () => {
  const first = deriveRunId('cerberus', 1000, 'aaaaaa')
  const second = deriveRunId('cerberus', 1001, 'bbbbbb')
  assert.notEqual(first, second)
  // Same pid, because pids are reused after a process dies.
  assert.notEqual(deriveRunId('cerberus', 1000, 'aaaaaa'), deriveRunId('cerberus', 1000, 'cccccc'))
  assert.ok(first.startsWith('cerberus-'), 'the operator cannot recognise the instance')
})

test('a run id always fits heimdall_delivery.lease_owner', () => {
  // VARCHAR(64), and the schema is frozen. A silently truncated id could collide with another
  // process, which is the failure this whole change exists to prevent.
  const id = deriveRunId('x'.repeat(200), 4194304, 'abcdef')
  assert.ok(id.length <= 64, `run id is ${id.length} characters`)
  assert.ok(id.endsWith('-4194304-abcdef'), 'truncation ate the part that makes it unique')
})

test('the lock and the delivery leases are owned by the process, not the configuration', async () => {
  const executed = []
  const pool = {
    execute: async (sql, params = []) => {
      executed.push({ sql, params })
      return [[{ holder: 'cerberus-1000-aaaaaa', age: 3 }]]
    },
  }
  const mine = new TicketRepository(pool, 'cerberus-1000-aaaaaa', 'cerberus')
  const theirs = new TicketRepository(pool, 'cerberus-1001-bbbbbb', 'cerberus')

  assert.equal((await mine.instanceLockHolder()).held, true)
  // Same BOT_INSTANCE_ID label, different process: it must not believe it holds the lock.
  assert.equal((await theirs.instanceLockHolder()).held, false)
  assert.equal(theirs.instanceId, 'cerberus', 'the human-readable label was lost')

  executed.length = 0
  await theirs.claimInstanceLock(60)
  const update = executed.find((entry) => entry.sql.startsWith('UPDATE heimdall_setting'))
  assert.ok(update, 'no claim was attempted')
  assert.ok(!update.params.includes('cerberus'), 'the claim used the shared label instead of the run id')
})

// Discord's error for a deleted parent. The numeric code is the generic form-body one, so the
// detail is what identifies it - and getting that wrong means falling back to a bare stack trace.
function deletedCategoryError() {
  const error = new Error('Invalid Form Body\nparent_id[CHANNEL_PARENT_INVALID]: Category does not exist')
  error.code = 50035
  error.rawError = { code: 50035, errors: { parent_id: { _errors: [{ code: 'CHANNEL_PARENT_INVALID' }] } } }
  return error
}

// The bug this exists for: an operator deleted the Open and Claimed categories mid-run. The bot
// already knew how to recreate them, but only at startup, so every delivery failed until somebody
// restarted it.
test('a category deleted while the bot runs is recreated and the work retried', async () => {
  const service = Object.create(HeimdallService.prototype)
  const warnings = []
  service.logger = { error: () => {}, warn: (line) => warnings.push(line), info: () => {} }
  let provisioned = 0
  let secured = 0
  service.provisionGuildLayout = async () => { provisioned += 1 }
  service.secureCategories = async () => { secured += 1 }

  let attempts = 0
  const result = await service.withFreshCategories('Creating a channel for R1-1', async () => {
    attempts += 1
    if (attempts === 1) throw deletedCategoryError()
    return 'created'
  })

  assert.equal(result, 'created')
  assert.equal(attempts, 2, 'the work was not retried')
  assert.equal(provisioned, 1, 'the categories were not re-resolved')
  assert.equal(secured, 1, 'the recreated categories were left unsecured')
  assert.match(warnings[0], /category no longer exists/)
  assert.match(warnings[0], /Creating a channel for R1-1/)
})

test('an unrelated Discord failure is not swallowed by the category retry', async () => {
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.provisionGuildLayout = async () => assert.fail('re-provisioned for an unrelated error')

  const missingPermission = new Error('Missing Permissions')
  missingPermission.code = 50013
  let attempts = 0
  await assert.rejects(
    service.withFreshCategories('anything', async () => { attempts += 1; throw missingPermission }),
    /Missing Permissions/,
  )
  assert.equal(attempts, 1, 'an unrelated failure must not be retried')
})

test('a configured channel id that resolves to nothing refuses at startup', async () => {
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.guild = { name: 'Test Guild' }
  service.client = { channels: { fetch: async () => null } }
  service.repository = { getSetting: async () => null, setSetting: async () => {} }

  // Silently creating a replacement would leave .env naming the dead channel and make a new
  // category on every restart, so this is refused rather than worked around.
  await assert.rejects(
    service.resolveGuildChannel({
      configured: '404', envVar: 'DISCORD_CLOSED_CATEGORY_ID', settingKey: 'discord.closed_category_id',
      describe: 'closed tickets category', create: async () => assert.fail('created a replacement anyway'),
    }),
    /DISCORD_CLOSED_CATEGORY_ID is set to "404"/,
  )
})

// The bug this exists for: the confirmation always said "it will arrive when X is online", which
// at the moment of success - player online, whisper already landed - reads as a failure notice.
function replyService(online) {
  const sent = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.config = { adminRoleIds: ['role-admin'], staffRoleIds: ['role-mod', 'role-gm'] }
  service.repository = {
    staff: async () => ({ gm_name: 'Helpbot' }),
    getSetting: async () => 'held',
    enqueue: async (job) => { sent.push(job) },
    recordMessage: async () => {},
    playerContext: async () => (online === null ? null : { online }),
  }
  service.setIdentityHeld = async () => {}
  service.staffThreadFor = async () => ({ send: async () => {} })
  service.refreshTicketHeader = async () => {}
  return { service, sent }
}

const REPLY_TICKET = {
  id: 3, public_key: 'R1-3', source: 'ingame', realm_tag: 'R1', player_name: 'Dustpaw',
  claimant_discord_user_id: '100', claimant_gm_name: 'Helpbot',
}

function replyInteraction() {
  const replies = []
  return {
    replies,
    id: 'interaction-1',
    user: { id: '100' },
    member: { roles: { cache: new Map([['role-gm', {}]]) } },
    channel: null,
    deferred: false,
    deferReply: async function deferReply() { this.deferred = true },
    reply: async (payload) => { replies.push(payload) },
    editReply: async (payload) => { replies.push(payload) },
  }
}

test('a reply to an online player is not reported as if it were queued', async () => {
  const { service, sent } = replyService(true)
  const interaction = replyInteraction()
  await service.replyToPlayer(interaction, REPLY_TICKET, 'Have a look now please')
  assert.equal(sent.length, 1)
  assert.match(interaction.replies[0].content, /Delivering now — Dustpaw is online\./)
})

test('a reply to an offline player still says it is waiting for them', async () => {
  for (const context of [false, null]) {
    const { service } = replyService(context)
    const interaction = replyInteraction()
    await service.replyToPlayer(interaction, REPLY_TICKET, 'Have a look when you are back')
    assert.match(interaction.replies[0].content, /It will arrive when Dustpaw is online\./)
  }
})

test('a deleted audit channel is recreated instead of silently dropping entries', async () => {
  const warnings = []
  const board = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: (line) => warnings.push(line), info: () => {} }
  service.config = { adminRoleIds: ['role-admin'], staffRoleIds: ['role-mod'], commandAuditChannel: true }
  service.botRoleId = 'role-bot'
  service.guild = {
    roles: { everyone: { id: 'everyone' } },
    channels: { create: async () => ({ id: 'audit-new' }) },
  }
  service.client = { channels: { fetch: async () => null } }
  const stored = { 'discord.audit_channel_id': 'audit-old' }
  service.repository = {
    getSetting: async (key) => stored[key] ?? null,
    setSetting: async (key, value) => { stored[key] = value },
  }
  service.queueBoardChannel = async () => ({ send: async (payload) => board.push(payload.content) })

  // create:false is the never-enabled guard. A stored id means it WAS enabled, so that guard
  // must not apply here - it was what turned a deleted channel into silence.
  const channel = await service.auditChannel({ create: false })
  assert.equal(channel.id, 'audit-new')
  assert.equal(stored['discord.audit_channel_id'], 'audit-new', 'the new id was not remembered')
  assert.match(warnings[0], /no longer exists/)
  assert.match(board[0], /audit entries were being discarded/)
})

test('an install that never enabled the audit stays quiet', async () => {
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => assert.fail('warned about a feature never enabled'), info: () => {} }
  service.config = { commandAuditChannel: true }
  service.repository = { getSetting: async () => null }
  service.guild = { channels: { create: async () => assert.fail('created a channel unasked') } }
  assert.equal(await service.auditChannel({ create: false }), null)
})

// One switch for both writers. The bug it replaced was the two of them having different rights to
// create the channel, so opting in for one silently disabled the other.
test('the audit switch turns off creation, recovery and both writers', async () => {
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
  service.config = { commandAuditChannel: false }
  // A stored id that no longer resolves is the "enabled, then deleted" case, which normally
  // recreates. An operator who switched this off and deleted the channel must not find it back.
  service.repository = { getSetting: async () => 'audit-old', setSetting: async () => {} }
  service.client = { channels: { fetch: async () => null } }
  service.guild = { channels: { create: async () => assert.fail('recreated the channel while switched off') } }

  assert.equal(await service.auditChannel({ create: true }), null)
  // And a module-queued entry is dropped rather than retried to death and left as `dead`.
  await assert.doesNotReject(() => service.postCommandAudit({ entries: [{ line: 'anything' }] }))
})

// A bot cannot be added to a role you create. The operator made one called "BOT", pasted its id,
// and the bot provisioned channels granting access to a role it was not in - locking itself out of
// channels it could then neither read nor repair. One wrong id, an install only manual surgery
// could fix. So this refuses before anything is provisioned.
function botRoleService(configuredId, memberOf = []) {
  const service = Object.create(HeimdallService.prototype)
  const logged = []
  service.logger = { error: () => {}, warn: () => {}, info: (line) => logged.push(line) }
  service.config = { botRoleId: configuredId }
  service.client = { user: { id: 'bot-user' } }
  service.guild = {
    name: 'Test Guild',
    members: { fetchMe: async () => ({ roles: { cache: new Map(memberOf.map((id) => [id, { id, managed: id === 'managed-role' }])) } }) },
    roles: { fetch: async () => {}, botRoleFor: () => ({ id: 'managed-role', name: 'Heimdall' }) },
  }
  return { service, logged }
}

test('a bot role the bot is not in refuses before anything is provisioned', async () => {
  const { service } = botRoleService('hand-made-role', ['managed-role'])
  await assert.rejects(() => service.verifyBotRole(), (error) => {
    assert.match(error.message, /"hand-made-role"/)
    assert.match(error.message, /cannot be added to a role you create/)
    // Naming the right id is the whole point: the operator has to know what to put there.
    assert.match(error.message, /managed-role/)
    assert.match(error.message, /Nothing has been provisioned/)
    return true
  })
  assert.equal(service.botRoleId, undefined, 'a rejected role must not be adopted')
})

test('an unset bot role is found rather than demanded', async () => {
  const { service, logged } = botRoleService(null, ['managed-role'])
  await service.verifyBotRole()
  assert.equal(service.botRoleId, 'managed-role')
  assert.ok(logged.some((line) => line.includes('managed role')))
})

test('a correctly configured bot role is accepted as given', async () => {
  const { service } = botRoleService('managed-role', ['managed-role'])
  await service.verifyBotRole()
  assert.equal(service.botRoleId, 'managed-role')
})

// Heimdall used to pin the queue board, and the pin lost a race against Discord applying the new
// channel's overwrites - so every fresh install was greeted by an alarming "Missing Permissions"
// warning that was not true. The board is the only message that will ever sit in that channel, so
// pinning bought nothing and was removed, taking the Manage Messages permission with it. This holds
// that line: the board is posted and remembered, and nothing tries to pin it.
// 1.1.2 dropped Manage Messages from the invite set but left it in ADMIN_PERMISSIONS, which is
// GRANTED to admin roles and to the bot's own role in every channel overwrite. Discord refuses to
// let a bot grant a permission it does not hold, so the first bot invited under the narrower set
// could not create its own channels: five went in, then "Missing Permissions". Every existing test
// passed, because the bots that ran them had been invited under the older, wider set.
//
// The invariant is simple and worth holding: nothing may be granted that is not also asked for.
test('every permission Heimdall grants is one it actually asks for', () => {
  const asked = new Set(REQUIRED_PERMISSIONS.map((entry) => entry.flag))
  for (const [label, list] of [['ADMIN_PERMISSIONS', ADMIN_PERMISSIONS]]) {
    for (const flag of list) {
      assert.ok(asked.has(flag),
        `${label} grants a permission missing from REQUIRED_PERMISSIONS (flag ${flag}). `
        + 'Discord will refuse the overwrite with "Missing Permissions" and the bot cannot build its channels.')
    }
  }
})

test('the queue board is posted and remembered, and never pinned', async () => {
  const stored = {}
  const posted = { id: 'board-1', pin: async () => { assert.fail('the queue board must not be pinned') } }
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.queueBoardChannel = async () => ({ send: async () => posted, messages: { fetch: async () => null } })
  service.queueBoardEmbed = () => ({})
  service.nudgeUnclaimed = async () => {}
  service.repository = {
    queueSnapshot: async () => [],
    getSetting: async () => null,
    setSetting: async (key, value) => { stored[key] = value },
  }

  const message = await service.refreshQueueBoard()
  assert.equal(message, posted)
  assert.equal(stored['discord.queue_message_id'], 'board-1', 'the board id must be remembered')
  assert.equal(typeof service.pinWithRetry, 'undefined', 'the pin helper should be gone, not merely unused')
})

// The bug this exists for: validateGmName is a format check, so a GM name that simply does not
// exist on the realm was accepted here and only refused later, over SOAP, to a GM who was
// mid-conversation with a player.
function identityService(names) {
  const warnings = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: (line) => warnings.push(line), info: () => {} }
  service.repository = { gmIdentityNames: async () => names }
  return { service, warnings }
}

test('staff-add refuses a GM name the realm has not accepted, and lists the real ones', async () => {
  const { service } = identityService(['Helpbot', 'Helpdesk'])
  await assert.rejects(() => service.assertConfiguredIdentity('Helpbat'), (error) => {
    assert.match(error.message, /"Helpbat" is not a configured GM identity/)
    assert.match(error.message, /Helpbot, Helpdesk/)
    return true
  })
  await assert.doesNotReject(() => service.assertConfiguredIdentity('Helpbot'))
  // The realm is case-insensitive about character names and so is this.
  await assert.doesNotReject(() => service.assertConfiguredIdentity('helpbot'))
})

test('an empty identity list is explained rather than blamed on the name', async () => {
  const { service } = identityService([])
  await assert.rejects(() => service.assertConfiguredIdentity('Helpbot'), /No GM identities are configured/)
})

test('a module that has not published its list warns instead of blocking', async () => {
  // Otherwise every staff-add fails on an install whose worldserver has not restarted since the
  // upgrade that started publishing the list.
  const { service, warnings } = identityService(null)
  await assert.doesNotReject(() => service.assertConfiguredIdentity('Anything'))
  assert.match(warnings[0], /has not published its GM identity list/)
})

test('a reply defers before touching SOAP so a slow refusal still reaches the GM', async () => {
  // Discord closes an interaction after three seconds; a slow SOAP failure used to blow that window
  // and the GM saw nothing at all, exactly when something had gone wrong.
  const order = []
  const { service } = replyService(true)
  service.setIdentityHeld = async () => { order.push('soap') }
  service.repository.getSetting = async () => 'offline'

  const interaction = replyInteraction()
  interaction.deferReply = async () => { order.push('defer') }
  await service.replyToPlayer(interaction, REPLY_TICKET, 'anything at all')

  assert.deepEqual(order, ['defer', 'soap'], 'SOAP was called before the interaction was deferred')
})

// Telling an operator to create a Bot role is what bricked a first install: the bot cannot be a
// member of a role you make, so it granted channel access to a role it was not in and locked itself
// out of channels it could then neither read nor repair. The guide and the code have to agree that
// this role is Discord's to create, not the operator's.
test('the install guide does not tell anyone to create a role for the bot', () => {
  const guide = fs.readFileSync(new URL('../../docs/INSTALL-bot.md', import.meta.url), 'utf8')
  assert.doesNotMatch(guide, /roles: Admin, Moderator, Game Master, and Bot/,
    'the guide still asks the operator to create a Bot role')
  assert.match(guide, /Do not create a role for the bot/)
  assert.match(guide, /managed/)

  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  assert.doesNotMatch(example, /^DISCORD_BOT_ROLE_ID=/m,
    '.env.example still offers DISCORD_BOT_ROLE_ID as something to fill in')
})

test('the provisioned-id block names every id an operator can pin', () => {
  const service = Object.create(HeimdallService.prototype)
  const lines = []
  service.logger = { error: () => {}, warn: () => {}, info: (line) => lines.push(line) }
  service.ids = {
    panelChannelId: '1', queueChannelId: '2', openCategoryId: '3',
    claimedCategoryId: '4', closedCategoryId: '5', supportCategoryId: '6',
  }
  // The block is only printed on a run that actually created something. A run that reused ids
  // already pinned in .env used to print it anyway, which read as though channels had appeared.
  service.provisionedThisRun = ['ticket queue channel']
  service.reportProvisionedIds()

  const block = lines[0]
  // Every id the bot provisions must be pinnable, or the block is a trap: an operator who pins the
  // ones on offer and restarts finds the rest still floating.
  for (const variable of ['DISCORD_PANEL_CHANNEL_ID', 'DISCORD_QUEUE_CHANNEL_ID', 'DISCORD_OPEN_CATEGORY_ID',
    'DISCORD_CLAIMED_CATEGORY_ID', 'DISCORD_CLOSED_CATEGORY_ID', 'DISCORD_SUPPORT_CATEGORY_ID']) {
    assert.ok(block.includes(`${variable}=`), `the block omits ${variable}`)
  }
  // And it must be honest about what pinning costs.
  assert.match(block, /survive restarts without it/)
  assert.match(block, /switches\s+off the self-heal/)
})

test('a run that created nothing says so, instead of offering ids to paste', () => {
  const service = Object.create(HeimdallService.prototype)
  const lines = []
  service.logger = { error: () => {}, warn: () => {}, info: (line) => lines.push(line) }
  service.ids = { panelChannelId: '1', queueChannelId: '2' }
  service.reportProvisionedIds()

  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /DISCORD_PANEL_CHANNEL_ID=/, 'it offered a paste block for ids it did not create')
  assert.doesNotMatch(lines[0], /Provisioned Discord layout/, 'it still claims to have provisioned a layout')
  assert.match(lines[0], /nothing was created/)
})

// The bug this exists for: closure side effects ran only via the bot's own performClose, so ANY
// closure originating in game - a player abandoning their ticket, or a GM typing .ticket close at
// the console - left the channel sitting in Open Tickets with no notice and no retention clock.
function closureService({ status = 'closed', alreadyHandled = false } = {}) {
  const seen = { enqueued: [], sent: [], refreshed: [], audited: [] }
  const ticket = {
    id: 9, public_key: 'R1-9', source: 'ingame', source_ticket_id: 42, realm_tag: 'R1',
    status, discord_channel_id: 'chan-9', player_name: 'Dustpaw',
  }
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.config = { closedChannelDeleteHours: 168, retentionDays: 180 }
  service.repository = {
    getIngameTicket: async () => ticket,
    hasAudit: async () => alreadyHandled,
    audit: async (...args) => { seen.audited.push(args) },
    enqueue: async (job) => { seen.enqueued.push(job) },
    ingameDescriptionSeen: async () => 1,
  }
  service.client = { channels: { fetch: async () => ({ send: async (payload) => seen.sent.push(payload.content) }) } }
  service.refreshVisibility = async (channel, row) => { seen.refreshed.push(row.status) }
  service.ensureTicketChannel = async () => {
    assert.fail('a ticket that has ended must not have a channel built for it')
  }
  return { service, seen, ticket }
}

test('a ticket closed in game gets the same Discord treatment as one closed from Discord', async () => {
  const { service, seen } = closureService()
  await service.syncIngameTicket({ realmTag: 'R1', sourceTicketId: 42, completed: 1, description: 'help' })

  const deletion = seen.enqueued.find((job) => job.kind === 'delete_channel')
  assert.ok(deletion, 'the closed-channel retention clock never started')
  assert.equal(deletion.payload.channelId, 'chan-9')
  assert.ok(deletion.availableAt instanceof Date, 'the deletion was not scheduled')

  assert.equal(seen.sent.length, 1, 'the player was never told the ticket ended')
  assert.match(seen.sent[0], /closed in game/)
  assert.deepEqual(seen.refreshed, ['closed'], 'the channel was not moved out of Open Tickets')
  assert.equal(seen.audited[0][1], 'ingame_closed')

  // Nothing here may talk to the realm: it closed the ticket, we are catching up.
  assert.equal(seen.enqueued.filter((job) => job.direction === 'soap').length, 0,
    'told the realm to close a ticket it had already closed')
})

test('an abandoned ticket reaches that same end state', async () => {
  // Abandoning calls TicketMgr::CloseTicket, which sets type = TICKET_TYPE_CLOSED and leaves the row
  // in place - so it arrives as an ordinary completed sync and must not be a special case.
  const { service, seen } = closureService()
  await service.syncIngameTicket({ realmTag: 'R1', sourceTicketId: 42, completed: 1, description: 'help' })
  assert.equal(seen.sent.length, 1)
  assert.deepEqual(seen.refreshed, ['closed'])
})

test('a second delivery for the same in-game closure changes nothing', async () => {
  const { service, seen } = closureService({ alreadyHandled: true })
  await service.syncIngameTicket({ realmTag: 'R1', sourceTicketId: 42, completed: 1, description: 'help' })
  assert.deepEqual(seen.sent, [], 'the closing notice was posted twice')
  assert.deepEqual(seen.enqueued, [])
})

test('a sync for a ticket that is still open closes nothing', async () => {
  const { service, seen } = closureService({ status: 'open' })
  service.ensureTicketChannel = async () => ({ channel: { id: 'chan-9', send: async () => {} }, created: false })
  await service.syncIngameTicket({ realmTag: 'R1', sourceTicketId: 42, completed: 0, description: 'help' })
  assert.deepEqual(seen.sent, [])
  assert.deepEqual(seen.refreshed, [])
  assert.deepEqual(seen.audited, [])
})

test('both closure routes run the same Discord side effects', () => {
  // Duplicated closure paths are how this class of bug comes back, so the two routes must share
  // one implementation rather than two that look alike today.
  const source = fs.readFileSync(new URL('../src/discord.js', import.meta.url), 'utf8')
  const calls = source.match(/this\.applyClosureToDiscord\(/g) ?? []
  assert.equal(calls.length, 2, 'expected exactly performClose and closeFromGame to call it')
  const body = source.slice(source.indexOf('async applyClosureToDiscord'))
  assert.ok(body.includes('delete_channel'), 'the retention clock left the shared path')
  assert.ok(body.includes('refreshVisibility'), 'the category move left the shared path')
})

// Finding 41's shapes. Channel creation is where duplicate overwrite targets would surface as a
// Discord rejection, so every shape is asserted on the overwrite arrays it would send.
function roleService(staffRoleIds, adminRoleIds) {
  const service = Object.create(HeimdallService.prototype)
  service.config = { staffRoleIds, adminRoleIds }
  service.botRoleId = 'role-bot'
  service.guild = { roles: { everyone: { id: 'everyone' } } }
  return service
}

function assertNoDuplicateTargets(entries, label) {
  const ids = entries.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, `${label} carries a duplicate overwrite target, which Discord rejects`)
}

test('one role in each list produces one admin and one staff overwrite', () => {
  const service = roleService(['staff-1'], ['admin-1'])
  const entries = service.staffOverwriteEntries()
  assert.deepEqual(entries.map((entry) => entry.id), ['admin-1', 'staff-1'])
  assertNoDuplicateTargets(service.categoryOverwrites(), 'categoryOverwrites')
})

test('the same role in both lists produces ONE overwrite, with admin permissions', () => {
  // The old workaround - the same id in every variable - would have sent Discord duplicate
  // targets. The lists must collapse it instead.
  const service = roleService(['role-x', 'staff-2'], ['role-x'])
  const entries = service.staffOverwriteEntries()
  assert.deepEqual(entries.map((entry) => entry.id), ['role-x', 'staff-2'])
  assert.equal(entries[0].allow, ADMIN_PERMISSIONS, 'the shared role was demoted to staff permissions')
  assertNoDuplicateTargets(service.categoryOverwrites(), 'categoryOverwrites')

  const ticket = { status: 'open', source: 'ingame', discord_creator_id: null, claimant_discord_user_id: null }
  assertNoDuplicateTargets(service.overwrites(ticket), 'ticket overwrites')
})

test('many staff tiers all land in the overwrites and the unclaimed-ticket audience', () => {
  const service = roleService(['t1', 't2', 't3', 't4', 't5'], ['boss'])
  const ticket = { status: 'open', source: 'ingame', discord_creator_id: null, claimant_discord_user_id: null }
  const ids = service.overwrites(ticket).map((entry) => entry.id)
  for (const tier of ['t1', 't2', 't3', 't4', 't5']) assert.ok(ids.includes(tier), `${tier} cannot see unclaimed tickets`)
  assertNoDuplicateTargets(service.overwrites(ticket), 'ticket overwrites')
})

test('an empty admin list falls back to the Manage Server permission', () => {
  const service = roleService(['staff-1'], [])
  const managers = { memberPermissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild } }
  const mortals = { memberPermissions: { has: () => false }, member: { roles: { cache: new Map([['staff-1', {}]]) } } }
  assert.equal(service.isAdmin(managers), true, 'a guild manager was refused ticket administration')
  assert.equal(service.isAdmin(mortals), false, 'a staff member without Manage Server became an admin')
  // And escalations still land on real, mentionable roles - a permission cannot be mentioned.
  assert.deepEqual(service.escalationRoleIds(), ['staff-1'])
})

test('a configured admin role does not also grant admin to Manage Server holders', () => {
  // The fallback exists only for the empty list. With a role configured, the role is the tier.
  const service = roleService(['staff-1'], ['admin-1'])
  const manager = { memberPermissions: { has: () => true }, member: { roles: { cache: new Map() } } }
  assert.equal(service.isAdmin(manager), false)
})

test('the three legacy variables still configure an install untouched', () => {
  const env = {
    DISCORD_TOKEN: 't'.repeat(30), DISCORD_GUILD_ID: '1', BOT_INSTANCE_ID: 'legacy-install',
    MYSQL_HOST: 'db', MYSQL_DATABASE: 'chars', MYSQL_USER: 'u', MYSQL_PASSWORD: 'p'.repeat(10),
    SOAP_URL: 'http://127.0.0.1:7878/', SOAP_USER: 's', SOAP_PASSWORD: 'sp'.repeat(5),
    ARCHIVE_DIR: './archive',
    DISCORD_ADMIN_ROLE_ID: '111', DISCORD_MODERATOR_ROLE_ID: '222', DISCORD_GM_ROLE_ID: '333',
  }
  const config = loadConfig(env)
  assert.deepEqual(config.adminRoleIds, ['111'])
  assert.deepEqual(config.staffRoleIds, ['222', '333'])

  // Mixing old and new merges rather than replaces, and duplicates collapse.
  const mixed = loadConfig({ ...env, DISCORD_STAFF_ROLE_IDS: ' 444 , 222 ,, 555 ', DISCORD_ADMIN_ROLE_IDS: '111,666' })
  assert.deepEqual(mixed.staffRoleIds, ['444', '222', '555', '333'])
  assert.deepEqual(mixed.adminRoleIds, ['111', '666'])

  // No staff source at all is refused, naming the variable to set.
  const bare = { ...env }
  delete bare.DISCORD_ADMIN_ROLE_ID; delete bare.DISCORD_MODERATOR_ROLE_ID; delete bare.DISCORD_GM_ROLE_ID
  assert.throws(() => loadConfig(bare), /DISCORD_STAFF_ROLE_IDS must name at least one role/)
  // And an admin-only install still needs a staff list - admins are also staff, but the variable
  // that says who answers tickets is the staff list.
  assert.throws(() => loadConfig({ ...bare, DISCORD_ADMIN_ROLE_IDS: '111' }), /DISCORD_STAFF_ROLE_IDS/)
})

test('the empty-roster fallback without an admin role still lands on someone', async () => {
  const sent = []
  const service = roleService(['staff-1', 'staff-2'], [])
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.repository = {
    getThreadId: async () => null,
    setThreadId: async () => {},
    activeStaffIds: async () => [],
  }
  const thread = { send: async (payload) => { sent.push(payload); return { flags: { bitfield: 0 } } } }
  const channel = { threads: { create: async () => thread } }
  await service.ensureStaffThread(channel, { id: 1, public_key: 'R1-1' })

  assert.equal(sent.length, 1, 'nobody was told the roster is empty')
  assert.match(sent[0].content, /<@&staff-1> <@&staff-2>/, 'the staff roles were not mentioned, so nobody joined the thread')
  assert.match(sent[0].content, /Manage Server permission/, 'the message does not say who can fix it')
  assert.deepEqual(sent[0].allowedMentions.roles, ['staff-1', 'staff-2'])
})

// ---------------------------------------------------------------------------- T30: threads only
// where a reader exists. An in-game ticket's channel is staff-only by its overwrites, so its
// staff content lives in the channel; a Discord ticket's reporter is in the room, so that path
// keeps the private thread.

// A Components V2 payload is a tree of builders rather than an embed, so these walk it. Everything
// is normalised through toJSON, so a builder and a message read back from Discord inspect alike.
function v2Nodes(payload) {
  const out = []
  const walk = (items) => {
    for (const item of items ?? []) {
      const node = typeof item?.toJSON === 'function' ? item.toJSON() : item
      out.push(node)
      walk(node.components)
    }
  }
  walk(payload.components)
  return out
}

function v2ActionRows(payload) {
  return v2Nodes(payload).filter((node) => node.type === 1)
}

function v2Text(payload) {
  return v2Nodes(payload).filter((node) => node.type === 10).map((node) => node.content).join('\n')
}

function headerService({ source, threadId = null, staff = ['s1'] }) {
  const sent = { channel: [], thread: [], threadCreated: 0 }
  const headerIds = new Map()
  const ticket = {
    id: 5, public_key: source === 'ingame' ? 'R1-5' : 'DIS-000005', source, realm_tag: 'R1',
    status: 'open', claimant_discord_user_id: null, claimant_gm_name: null,
    player_name: source === 'ingame' ? 'Dustpaw' : null, discord_creator_id: source === 'discord' ? '900' : null,
  }
  let posted = 0
  const thread = {
    isThread: () => true, archived: false,
    send: async (payload) => { sent.thread.push(payload); posted += 1; return { id: `msg-${posted}`, flags: { bitfield: 0 } } },
    members: { add: async () => {} },
    messages: { fetch: async () => ({ find: () => null }) },
  }
  const channel = {
    send: async (payload) => { sent.channel.push(payload); posted += 1; return { id: `msg-${posted}` } },
    messages: { fetch: async () => ({ find: () => null }) },
    threads: { create: async () => { sent.threadCreated += 1; return thread } },
  }
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.config = { adminRoleIds: ['role-admin'], staffRoleIds: ['role-staff'] }
  service.client = { user: { id: 'bot-user' }, channels: { fetch: async () => thread } }
  service.repository = {
    getThreadId: async () => threadId,
    setThreadId: async () => {},
    activeStaffIds: async () => staff,
    getSetting: async () => null,
    playerContext: async () => null,
    accountTicketHistory: async () => null,
    playerNotes: async () => [],
    ticketIntake: async () => null,
    ticketBody: async () => null,
    staff: async () => null,
    getHeaderId: async (id, which) => headerIds.get(`${id}:${which}`) ?? null,
    setHeaderId: async (id, messageId, which) => { headerIds.set(`${id}:${which}`, messageId) },
  }
  service.ticketAccountId = async () => null
  return { service, sent, ticket, channel, headerIds }
}

test('an in-game ticket creates no thread and carries header plus controls in its channel', async () => {
  const { service, sent, ticket, channel, headerIds } = headerService({ source: 'ingame' })
  const surface = await service.postTicketHeader(channel, ticket, 'hey my quest is stuck')

  assert.equal(surface, channel, 'the staff surface for an in-game ticket is the channel itself')
  assert.equal(sent.threadCreated, 0, 'a private thread was created for a channel with no player in it')
  assert.equal(sent.channel.length, 1, 'expected exactly one header message')
  const header = sent.channel[0]
  assert.equal(header.flags, MessageFlags.IsComponentsV2, 'the header did not go out as Components V2')
  assert.equal(header.embeds, undefined, 'a V2 message may not carry embeds')
  assert.equal(header.content, undefined, 'a V2 message may not carry content')
  assert.equal(header.components.length, 2, 'the header should be exactly two containers')
  assert.equal(v2ActionRows(header).length, 3, 'the consolidated controls should be three rows')
  assert.match(v2Text(header), /### Ticket R1-5/, 'the recovery marker is missing from the header')
  assert.match(v2Text(header), /hey my quest is stuck/, 'the ticket body never reached the header')
  // Without the stored id the next redraw has to fall back to scanning, which is recovery only.
  assert.equal(headerIds.get('5:staff'), 'msg-1', 'the header message id was not remembered')
})

test('a Discord ticket still gets its private thread and a player-safe channel header', async () => {
  const { service, sent, ticket, channel, headerIds } = headerService({ source: 'discord' })
  const surface = await service.postTicketHeader(channel, ticket, 'my account is broken')

  assert.notEqual(surface, channel, 'the reporter is in this channel; staff content must not be')
  assert.equal(sent.threadCreated, 1)
  // The channel header carries no controls and no staff content - the reporter can read it.
  assert.equal(sent.channel.length, 1)
  assert.equal(v2ActionRows(sent.channel[0]).length, 0, 'controls leaked into the reporter-visible channel')
  assert.match(v2Text(sent.channel[0]), /### DIS-000005/, 'the player header has no recovery marker')
  // The staff header, with the controls, went to the thread.
  const staffHeader = sent.thread.find((payload) => v2ActionRows(payload).length)
  assert.ok(staffHeader, 'the staff header never reached the thread')
  assert.equal(v2ActionRows(staffHeader).length, 3)
  assert.equal(headerIds.get('5:player') != null, true, 'the player header id was not remembered')
  assert.equal(headerIds.get('5:staff') != null, true, 'the staff header id was not remembered')
})

test('an in-game ticket that already has a thread keeps it - controls never exist in two places', async () => {
  const { service, sent, ticket, channel } = headerService({ source: 'ingame', threadId: 'legacy-thread' })
  const surface = await service.postTicketHeader(channel, ticket, 'old ticket')

  assert.notEqual(surface, channel, 'a legacy threaded ticket must keep its thread until it closes')
  // Both headers are Components V2 messages now, so "carries components" no longer separates
  // them. What must never exist twice is the controls, so that is what this counts.
  const controlsInChannel = sent.channel.filter((payload) => v2ActionRows(payload).length)
  assert.equal(controlsInChannel.length, 0, 'controls appeared in the channel while the thread still holds them')
})

test('the transcript captures staff messages on both surfaces', async () => {
  const recorded = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.config = { retentionDays: 180 }
  service.repository = {
    getTicketByChannel: async (id) => (id === 'chan-9' ? { id: 9, public_key: 'R1-9' } : null),
    recordMessage: async (row) => { recorded.push(row); return 'key' },
  }
  service.actorKindFor = async () => 'staff'
  service.archive = { save: async () => ({}) }

  // In-game shape: the staff message is in the ticket channel itself.
  await service.archiveDiscordMessage({
    guildId: 'g', channelId: 'chan-9', channel: { isThread: () => false },
    author: { id: '100', bot: false }, content: 'note in channel', attachments: new Map(),
  })
  // Discord shape: the staff message is in the private thread, matched via its parent.
  await service.archiveDiscordMessage({
    guildId: 'g', channelId: 'thread-9', channel: { isThread: () => true, parentId: 'chan-9' },
    author: { id: '100', bot: false }, content: 'note in thread', attachments: new Map(),
  })

  assert.deepEqual(recorded.map((row) => row.body), ['note in channel', 'note in thread'])
  assert.ok(recorded.every((row) => row.ticketId === 9))
})

test('the GM menu drives the same commands the buttons did, and kick is last', async () => {
  const ran = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.repository = { getTicket: async () => ({ id: 5, public_key: 'R1-5', source: 'ingame', player_name: 'Dustpaw' }) }
  service.runGmAction = async (interaction, ticket, key) => { ran.push(key) }
  service.requireRosteredStaff = async () => ({ gm_name: 'Helpbot' })
  service.requireTicketOwner = () => {}

  for (const key of ['revive', 'unstuck', 'combatstop', 'kick']) {
    await service.handleSelect({ customId: 'ticket:gm-menu:5', values: [key] })
  }
  assert.deepEqual(ran, ['revive', 'unstuck', 'combatstop', 'kick'])

  // Teleport still asks for its destination before acting.
  let modal = null
  await service.handleSelect({ customId: 'ticket:gm-menu:5', values: ['teleport'], showModal: (m) => { modal = m } })
  assert.ok(modal, 'teleport ran without asking for a destination')
  assert.equal(ran.length, 4, 'teleport executed before its destination was known')

  // And the rendered menu puts kick last, because it disconnects the player.
  const rows = await (async () => {
    const svc = Object.create(HeimdallService.prototype)
    svc.identityState = async () => 'offline'
    return svc.controls({ id: 5, source: 'ingame', player_name: 'Dustpaw', claimant_discord_user_id: null, realm_tag: 'R1' })
  })()
  // The dropdown is the last row, below the buttons and the player-card utilities.
  const menu = rows[2].components[0].toJSON()
  assert.equal(menu.options.at(-1).value, 'kick')
  assert.equal(menu.options.length, 5)
})

test('the identity toggle acts on re-read state, not the label it was rendered from', async () => {
  // The stale case: the header was rendered when the identity was HELD, so the button says
  // "Log Out Of Game" - but the GM has since logged out from another ticket. Acting on the label
  // would log out an identity that is already out; acting on re-read state logs it back in.
  const calls = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.config = { adminRoleIds: ['role-admin'], staffRoleIds: ['role-staff'] }
  service.repository = {
    getTicket: async () => TOGGLE_TICKET,
    staff: async () => ({ gm_name: 'Helpbot' }),
    getSetting: async () => 'offline', // what is true NOW
  }
  service.setIdentityHeld = async (realmTag, ticketId, name, held) => { calls.push(held) }
  service.refreshTicketHeader = async () => {}

  const TOGGLE_TICKET = { id: 7, public_key: 'R1-7', source: 'ingame', realm_tag: 'R1', claimant_discord_user_id: '100', claimant_gm_name: 'Helpbot' }
  const interaction = {
    customId: 'ticket:identity-toggle:7',
    user: { id: '100' },
    member: { roles: { cache: new Map([['role-staff', {}]]) } },
    channel: null,
    reply: async () => {},
  }
  // Route through handleButton the way Discord would.
  const [, action] = interaction.customId.split(':')
  assert.equal(action, 'identity-toggle')
  await service.handleButton(interaction).catch((error) => { throw error })

  assert.deepEqual(calls, [true], 'the toggle obeyed its stale label instead of the actual state')
})

test('an empty roster on an in-game ticket warns in the channel, since there is no thread to join', async () => {
  const { service, sent, ticket, channel } = headerService({ source: 'ingame', staff: [] })
  await service.postTicketHeader(channel, ticket, 'help')

  const notice = sent.channel.find((payload) => payload.content?.includes('staff roster'))
  assert.ok(notice, 'nobody was told the roster is empty')
  assert.match(notice.content, /<@&role-admin>/)
  assert.match(notice.content, /nobody can claim/)
  assert.equal(sent.threadCreated, 0)
})

test('/ticket refresh redraws for staff, without the admin gate', async () => {
  const { service, seen } = adminService()
  const redrawn = []
  service.refreshVisibility = async (channel, ticket) => { redrawn.push(ticket.public_key) }
  service.client = { channels: { fetch: async () => ({ id: 'chan-7' }) } }

  // A moderator - decidedly not an admin - inside the ticket channel.
  const interaction = adminInteraction('refresh', ['role-mod'])
  interaction.options.getInteger = () => null
  interaction.channel = { id: 'chan-7', isThread: () => false }
  await service.handleAdminCommand(interaction)

  assert.deepEqual(redrawn, ['R1-7'], 'the ticket was not redrawn')
  assert.match(interaction.replies[0].content, /R1-7 redrawn/)

  // But someone with no staff role at all is still refused.
  const stranger = adminInteraction('refresh', ['bystander'])
  await assert.rejects(() => service.handleAdminCommand(stranger), /staff or admin role/)

  // And the admin gate still holds for everything that changes state.
  await assert.rejects(() => service.handleAdminCommand(adminInteraction('staff-list', ['role-mod'])), /Only administrators/)
})

test('/ticket refresh outside a ticket channel asks for a ticket id', async () => {
  const { service } = adminService()
  service.repository.getTicketByChannel = async () => null
  const interaction = adminInteraction('refresh', ['role-mod'])
  interaction.options.getInteger = () => null
  interaction.channel = { id: 'somewhere-else', isThread: () => false }
  await assert.rejects(() => service.handleAdminCommand(interaction), /inside a ticket channel, or pass ticket_id/)
})

// Two installs sharing one Discord guild both mint the key "R1-3": the realm tag falls back to
// R<RealmID> and almost every standalone install is RealmID 1. Before install ids, the second
// install adopted the first's channel by its topic marker, and a new ticket arrived in the Closed
// category carrying another realm's history and permissions. Observed on the first Linux install.
//
// The categories are deliberately SHARED in these fixtures, because that is what actually happened:
// the second install's .env was copied from the first, category ids included. A category check
// alone would have passed and adopted anyway, which is why the marker carries the install id.
function adoptionService(installId, channels) {
  const seen = { created: [], setChannel: [], boardPosts: [], errors: [] }
  const service = Object.create(HeimdallService.prototype)
  service.installId = installId
  service.ids = { openCategoryId: 'cat-open', claimedCategoryId: 'cat-claimed', closedCategoryId: 'cat-closed', supportCategoryId: 'cat-support' }
  service.logger = { error: (message) => { seen.errors.push(message) }, warn: () => {}, info: () => {} }
  service.guild = { channels: { fetch: async () => new Map(channels.map((channel) => [channel.id, channel])) } }
  service.client = { channels: { fetch: async () => null } }
  service.repository = { setChannel: async (...args) => { seen.setChannel.push(args) } }
  service.createTicketChannel = async (ticket) => {
    const channel = { id: 'freshly-created', topic: service.channelMarker(ticket.public_key) }
    seen.created.push(channel)
    // The real createTicketChannel stores the id itself; the fake must too, or the assertion
    // below would be testing the fake rather than the code.
    await service.repository.setChannel(ticket.id, channel.id)
    return channel
  }
  service.postTicketHeader = async () => {}
  service.queueBoardChannel = async () => ({ send: async (message) => { seen.boardPosts.push(message) } })
  return { service, seen }
}

function guildChannel(id, topic, parentId = 'cat-open') {
  const channel = { id, name: id, type: ChannelType.GuildText, topic, parentId }
  channel.setTopic = async (value) => { channel.topic = value }
  return channel
}

const collidingTicket = { id: 3, public_key: 'R1-3', discord_channel_id: null }

test('a channel stamped by another install is never adopted, even in a shared category', async () => {
  const theirs = guildChannel('their-chan', 'mod-heimdall:aaaaaaaa:R1-3', 'cat-open')
  const { service, seen } = adoptionService('bbbbbbbb', [theirs])

  const { channel, created } = await service.ensureTicketChannel(collidingTicket, 'stuck')

  assert.equal(created, true, 'it adopted the other install\'s channel instead of creating its own')
  assert.equal(channel.id, 'freshly-created')
  assert.equal(theirs.topic, 'mod-heimdall:aaaaaaaa:R1-3', 'it rewrote a channel it does not own')
  assert.equal(seen.setChannel.length, 1)
  assert.equal(seen.setChannel[0][1], 'freshly-created')
})

test('a collision is announced on the queue board, because the other install cannot see it', async () => {
  const theirs = guildChannel('their-chan', 'mod-heimdall:aaaaaaaa:R1-3')
  const { service, seen } = adoptionService('bbbbbbbb', [theirs])

  await service.ensureTicketChannel(collidingTicket, 'stuck')

  assert.equal(seen.boardPosts.length, 1, 'the operator was not told two installs share this guild')
  assert.match(seen.boardPosts[0].content, /R1-3/)
  assert.match(seen.boardPosts[0].content, /RealmPrefix/)
  assert.equal(seen.errors.length, 1)

  // Once per ticket key per process: a busy realm must not paper the board with the same warning.
  await service.ensureTicketChannel(collidingTicket, 'stuck')
  assert.equal(seen.boardPosts.length, 1, 'the collision warning repeated for the same ticket')
})

test('recovering our own channel still works - finding 36 is not traded away', async () => {
  const ours = guildChannel('our-chan', 'mod-heimdall:bbbbbbbb:R1-3')
  const { service, seen } = adoptionService('bbbbbbbb', [ours])

  const { channel, created } = await service.ensureTicketChannel(collidingTicket, 'stuck')

  assert.equal(created, false, 'it failed to recover a channel it created itself')
  assert.equal(channel.id, 'our-chan')
  assert.equal(seen.boardPosts.length, 0, 'recovering our own channel warned about a collision')
})

test('a pre-install-id channel in our own category is adopted once and then claimed', async () => {
  const legacy = guildChannel('legacy-chan', 'mod-heimdall:R1-3', 'cat-closed')
  const { service, seen } = adoptionService('bbbbbbbb', [legacy])

  const { channel, created } = await service.ensureTicketChannel(collidingTicket, 'stuck')

  assert.equal(created, false, 'an install could not adopt its own pre-upgrade channel')
  assert.equal(channel.id, 'legacy-chan')
  assert.equal(legacy.topic, 'mod-heimdall:bbbbbbbb:R1-3', 'the adopted channel was not restamped')
  assert.equal(seen.boardPosts.length, 0)
})

test('a pre-install-id channel outside our categories is left alone', async () => {
  const stranger = guildChannel('elsewhere', 'mod-heimdall:R1-3', 'someone-elses-category')
  const { service, seen } = adoptionService('bbbbbbbb', [stranger])

  const { created } = await service.ensureTicketChannel(collidingTicket, 'stuck')

  assert.equal(created, true, 'it adopted a legacy channel from outside its own categories')
  assert.equal(stranger.topic, 'mod-heimdall:R1-3')
  assert.equal(seen.boardPosts.length, 1, 'an unadoptable marker should still be reported')
})

// Finding 45. The legacy singular role variables kept working, which was the point, but nothing
// said so: an operator on the old shape found out from a CHANGELOG or never. Silence is the bug.
function legacyEnv(extra = {}) {
  return {
    DISCORD_TOKEN: 't'.repeat(30), DISCORD_GUILD_ID: '1', BOT_INSTANCE_ID: 'deprecation-test',
    MYSQL_HOST: 'db', MYSQL_DATABASE: 'chars', MYSQL_USER: 'u', MYSQL_PASSWORD: 'p'.repeat(10),
    SOAP_URL: 'http://127.0.0.1:7878/', SOAP_USER: 's', SOAP_PASSWORD: 'sp'.repeat(5),
    ARCHIVE_DIR: './archive',
    ...extra,
  }
}

test('each legacy role variable still set is named once, with its replacement', () => {
  const config = loadConfig(legacyEnv({
    DISCORD_ADMIN_ROLE_ID: '111', DISCORD_MODERATOR_ROLE_ID: '222', DISCORD_GM_ROLE_ID: '333',
  }))

  assert.equal(config.deprecations.length, 3, 'one notice per superseded variable')
  for (const [oldName, replacement] of [
    ['DISCORD_MODERATOR_ROLE_ID', 'DISCORD_STAFF_ROLE_IDS'],
    ['DISCORD_GM_ROLE_ID', 'DISCORD_STAFF_ROLE_IDS'],
    ['DISCORD_ADMIN_ROLE_ID', 'DISCORD_ADMIN_ROLE_IDS'],
  ]) {
    const notice = config.deprecations.find((line) => line.startsWith(oldName))
    assert.ok(notice, `nothing warned about ${oldName}`)
    assert.ok(notice.includes(replacement), `${oldName}'s notice does not name ${replacement}`)
    // A warning that reads like a breakage sends someone to fix it during an outage.
    assert.match(notice, /still honoured/)
  }

  // And the warning changes nothing about what was resolved.
  assert.deepEqual(config.staffRoleIds, ['222', '333'])
  assert.deepEqual(config.adminRoleIds, ['111'])
})

test('an install on the current variables is not nagged', () => {
  const config = loadConfig(legacyEnv({ DISCORD_STAFF_ROLE_IDS: '222,333', DISCORD_ADMIN_ROLE_IDS: '111' }))
  assert.deepEqual(config.deprecations, [], 'a correctly configured install was warned at')
})

test('only the legacy variables actually set are warned about', () => {
  const config = loadConfig(legacyEnv({ DISCORD_STAFF_ROLE_IDS: '222', DISCORD_GM_ROLE_ID: '333' }))
  assert.equal(config.deprecations.length, 1)
  assert.match(config.deprecations[0], /^DISCORD_GM_ROLE_ID/)
})

// The realm is the authority on its own character names. staff-add matched case-insensitively and
// then stored what was typed, so ".ticket assign 1 heimdalltest" was refused by a core that wanted
// "Heimdalltest" - and the refusal surfaced only as a delivery retrying for 81 minutes and dying.
function gmNameCanonicalService(publishedNames) {
  const stored = { staff: [], repaired: [] }
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.repository = {
    gmIdentityNames: async () => publishedNames,
    upsertStaff: async (...args) => { stored.staff.push(args) },
    canonicaliseGmName: async (...args) => { stored.repaired.push(args) },
  }
  return { service, stored }
}

test('staff-add stores the spelling the realm uses, not the one that was typed', async () => {
  const { service } = gmNameCanonicalService(['Heimdalltest', 'Helpbot'])
  assert.equal(await service.assertConfiguredIdentity('heimdalltest'), 'Heimdalltest')
  assert.equal(await service.assertConfiguredIdentity('HEIMDALLTEST'), 'Heimdalltest')
  assert.equal(await service.assertConfiguredIdentity('Heimdalltest'), 'Heimdalltest')
})

test('a name the realm does not know is still refused, with the list', async () => {
  const { service } = gmNameCanonicalService(['Heimdalltest'])
  await assert.rejects(() => service.assertConfiguredIdentity('Helpbat'), /not a configured GM identity/)
})

test('an unpublished identity list stores the input rather than blocking staff-add', async () => {
  const { service } = gmNameCanonicalService(null)
  assert.equal(await service.assertConfiguredIdentity('whatever'), 'whatever',
    'a half-upgraded install could not add staff at all')
})

test('an existing wrong-cased name is corrected before the command, and repaired in place', async () => {
  const { service, stored } = gmNameCanonicalService(['Heimdalltest'])
  assert.equal(await service.canonicalGmNameForCommand('heimdalltest'), 'Heimdalltest')
  assert.deepEqual(stored.repaired, [['heimdalltest', 'Heimdalltest']],
    'the stored row was left wrong, so it would be corrected again on every delivery')
})

test('a name already correct is not needlessly rewritten', async () => {
  const { service, stored } = gmNameCanonicalService(['Heimdalltest'])
  assert.equal(await service.canonicalGmNameForCommand('Heimdalltest'), 'Heimdalltest')
  assert.deepEqual(stored.repaired, [])
})

test('an unknown name reaches the core to be refused there, not swallowed here', async () => {
  const { service, stored } = gmNameCanonicalService(['Heimdalltest'])
  assert.equal(await service.canonicalGmNameForCommand('Nobody'), 'Nobody')
  assert.deepEqual(stored.repaired, [])
})

// A delivery that fails keeps retrying for about 81 minutes and is then marked dead. None of that
// was ever said out loud: Discord showed a ticket claimed while the realm had never been told.
function announceService(ticket = { public_key: 'DKR-1', discord_channel_id: 'chan-1' }) {
  const sent = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.repository = { getTicket: async () => ticket }
  service.client = { channels: { fetch: async () => ({ send: async (m) => { sent.push(m.content) } }) } }
  service.queueBoardChannel = async () => ({ send: async (m) => { sent.push('[board] ' + m.content) } })
  return { service, sent }
}

test('giving up on a delivery says so, naming the ticket, the action and the reason', async () => {
  const { service, sent } = announceService()
  await service.announceDeliveryTrouble(
    { id: 2, kind: 'assign_ticket', ticket_id: 1 },
    new Error('Invalid name specified. Name should be that of an online Gamemaster.'),
    { state: 'dead', attempts: 12 })

  assert.equal(sent.length, 1)
  assert.match(sent[0], /DKR-1/)
  assert.match(sent[0], /given up/)
  assert.match(sent[0], /assign this ticket/)
  assert.match(sent[0], /Invalid name specified/)
  // The point of the message: the channel says claimed and the realm disagrees.
  assert.match(sent[0], /realm did not do this/)
  // Counted, not asserted. An earlier draft hardcoded "about 80 minutes", which was simply false on
  // an install that had lowered DELIVERY_MAX_ATTEMPTS - the live test caught it saying so after a
  // single try.
  assert.match(sent[0], /after 12 attempts/)
  assert.doesNotMatch(sent[0], /80 minutes/, 'the message invents a duration it cannot know')
})

test('a job that died on its first attempt says so, rather than claiming a long wait', async () => {
  const { service, sent } = announceService()
  await service.announceDeliveryTrouble({ id: 2, kind: 'assign_ticket', ticket_id: 1 },
    new Error('nope'), { state: 'dead', attempts: 1 })
  assert.match(sent[0], /after one attempt/)
})

test('the trailing carriage return SOAP appends is not quoted back at the operator', async () => {
  const { service, sent } = announceService()
  await service.announceDeliveryTrouble({ id: 2, kind: 'assign_ticket', ticket_id: 1 },
    new Error('Core rejected ".ticket assign 1 X": Ticket not found.&#xD;'), { state: 'dead', attempts: 4 })
  assert.doesNotMatch(sent[0], /&#xD;/, 'the raw carriage-return entity reached the message')
  assert.match(sent[0], /Ticket not found\./)
})

test('the third failure warns quietly; the first two stay silent', async () => {
  for (const attempts of [1, 2]) {
    const { service, sent } = announceService()
    await service.announceDeliveryTrouble({ id: 2, kind: 'assign_ticket', ticket_id: 1 },
      new Error('boom'), { state: 'queued', attempts })
    assert.equal(sent.length, 0, `attempt ${attempts} spoke; a blip must stay quiet`)
  }
  const { service, sent } = announceService()
  await service.announceDeliveryTrouble({ id: 2, kind: 'assign_ticket', ticket_id: 1 },
    new Error('boom'), { state: 'queued', attempts: 3 })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /still trying/)
  assert.match(sent[0], /may clear on its own/)
})

test('a retry that is neither the third nor the last says nothing at all', async () => {
  const { service, sent } = announceService()
  for (const attempts of [4, 5, 9, 11]) {
    await service.announceDeliveryTrouble({ id: 2, kind: 'assign_ticket', ticket_id: 1 },
      new Error('boom'), { state: 'queued', attempts })
  }
  assert.equal(sent.length, 0, 'the retry itself became noisy')
})

test('a job with no ticket falls back to the queue board', async () => {
  const { service, sent } = announceService(null)
  await service.announceDeliveryTrouble({ id: 9, kind: 'gm_command_audit', ticket_id: null },
    new Error('nope'), { state: 'dead', attempts: 12 })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^\[board\]/)
  assert.match(sent[0], /background job/)
})

// --- 1.1.0: the bot no longer holds a SOAP account ------------------------------------------
//
// The property these guard is the one the security claim rests on: what the bot puts in the queue
// is an action and its arguments, never a command string, so a compromised bot cannot express a
// command Heimdall does not perform. Asserting that in a README is worth nothing; these fail if it
// stops being true.

function commandChannelService({ inModule = true } = {}) {
  const service = Object.create(HeimdallService.prototype)
  const seen = { enqueued: [], audited: [], warned: [] }
  service.logger = { info() {}, warn: (message, meta) => seen.warned.push({ message, meta }), error() {} }
  service.repository = {
    enqueue: async (job) => { seen.enqueued.push(job); return 'key' },
    audit: async (...args) => { seen.audited.push(args) },
    getSetting: async (key) => (inModule && key.startsWith('runtime.command_channel.') ? '1.1.0' : null),
  }
  service.soap = {
    command: async () => assert.fail('the module owns this realm: nothing may go over SOAP'),
    commandExpectingEffect: async () => assert.fail('the module owns this realm: nothing may go over SOAP'),
  }
  return { service, seen }
}

test('a GM action becomes an intent row carrying fields, not a command', async () => {
  const { service, seen } = commandChannelService()
  const ticket = { id: 7, public_key: 'R1-7', source: 'ingame', realm_tag: 'R1', player_name: 'Bob', claimant_discord_user_id: '100' }
  service.requireRosteredStaff = async () => ({ gm_name: 'Helpbot' })
  service.requireTicketOwner = () => {}
  service.staffThreadFor = async () => ({ send: async () => {} })

  const interaction = {
    user: { id: '100' },
    deferReply: async () => {},
    editReply: async () => {},
  }
  await service.runGmAction(interaction, ticket, 'revive')

  const job = seen.enqueued.find((row) => row.kind === 'gm_action')
  assert.ok(job, 'the GM action never reached the queue')
  assert.equal(job.direction, 'soap')
  assert.equal(job.payload.action, 'revive')
  assert.equal(job.payload.playerName, 'Bob')
  assert.equal(job.payload.causedBy, '100', 'the Discord user who pressed the button was not recorded')
  assert.equal(job.payload.realmTag, 'R1')

  // The whole design in one assertion: no field of this row is a command.
  for (const [field, value] of Object.entries(job.payload)) {
    assert.ok(!String(value ?? '').includes('.revive'), `payload.${field} carries a command string`)
    assert.ok(!String(value ?? '').startsWith('.'), `payload.${field} looks like a command`)
  }
})

test('a payload that tries to carry a command is inert', async () => {
  // The module composes commands from a fixed switch on `action`, so the worst a poisoned row can
  // do is name an action that does not exist. This is the bot half of that: the fields it writes
  // are the ones the module reads, and none of them is passed through as command text.
  const { service, seen } = commandChannelService()
  await service.queueGameCommand({
    ticketId: 7,
    realmTag: 'R1',
    kind: 'gm_action',
    payload: { action: '.ban Bob', playerName: 'Bob; .account set gmlevel Bob 3 -1' },
    causedBy: '100',
    uniqueParts: ['x'],
  })

  const job = seen.enqueued[0]
  // The row is written as asked - the bot does not sanitise it, and must not be trusted to.
  // What makes it inert is that ".ban Bob" is not an action the module's switch knows, and the
  // player name fails the module's letters-only check. Both are asserted against the module's
  // rules in the C++ side; here we pin the shape the module relies on.
  assert.equal(job.kind, 'gm_action')
  assert.equal(job.payload.action, '.ban Bob')
  assert.ok(!Object.keys(job.payload).includes('command'), 'the queue must have no command field at all')
})

test('a realm command the module gave up on still reaches Discord as a dead letter', async () => {
  // The module fails a job with the same attempt count and the same rule for "dead" the bot uses,
  // then queues this so the announcement is made where announcements are made. What is verified
  // here is that the module's row reaches the SAME renderer - so the warning and the dead letter
  // say what they have always said.
  const service = Object.create(HeimdallService.prototype)
  const announced = []
  service.announceDeliveryTrouble = async (job, error, outcome) => announced.push({ job, error, outcome })

  await service.announceModuleTrouble({
    ticket_id: 7,
    payload: { ofKind: 'close_ticket', state: 'dead', attempts: 12, error: 'Ticket not found.', realmTag: 'R1' },
  })

  assert.equal(announced.length, 1, 'the module-side failure was never announced')
  assert.equal(announced[0].job.kind, 'close_ticket', 'the dead letter would not say which action failed')
  assert.equal(announced[0].job.ticket_id, 7)
  assert.equal(announced[0].outcome.state, 'dead')
  assert.equal(announced[0].outcome.attempts, 12, 'the attempt count must be the realm\'s, not a guess')
  assert.match(String(announced[0].error.message), /Ticket not found/)
})

test('the third failure of a module-side job warns, and earlier ones stay quiet', async () => {
  // Same thresholds as a bot-side failure, because it is the same function deciding.
  const service = Object.create(HeimdallService.prototype)
  const sent = []
  service.deliveryAudience = async () => ({ channel: { send: async (payload) => sent.push(payload.content) }, key: 'R1-7' })

  for (const attempts of [1, 2, 3]) {
    await service.announceModuleTrouble({
      ticket_id: 7,
      payload: { ofKind: 'assign_ticket', state: 'queued', attempts, error: 'Invalid name specified' },
    })
  }
  assert.equal(sent.length, 1, 'the warning fired on the wrong attempt')
  assert.match(sent[0], /still trying to assign this ticket/)

  await service.announceModuleTrouble({
    ticket_id: 7,
    payload: { ofKind: 'assign_ticket', state: 'dead', attempts: 12, error: 'Invalid name specified' },
  })
  assert.equal(sent.length, 2)
  assert.match(sent[1], /given up trying to assign this ticket/)
  assert.match(sent[1], /after 12 attempts/)
})
