import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PermissionFlagsBits } from 'discord.js'

import { HeimdallService, REQUIRED_PERMISSIONS, ticketAdminCommand } from '../src/discord.js'
import { deriveRunId } from '../src/config.js'
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
  const config = { adminRoleId: 'a', moderatorRoleId: 'm', gmRoleId: 'g' }
  assert.equal(memberCanWorkTicket(['m'], config), true)
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

test('a secret never reaches the log file, however it was logged', () => {
  const token = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789ABCD'
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
  const guide = fs.readFileSync(new URL('../docs/INSTALL.md', import.meta.url), 'utf8')
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
  const channel = { setParent: async () => {}, permissionOverwrites: { set: async () => {} } }
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: () => {}, info: () => {} }
  service.config = { adminRoleId: 'role-admin', moderatorRoleId: 'role-mod', gmRoleId: 'role-gm', botRoleId: 'role-bot' }
  service.ids = { openCategoryId: 'cat-open', claimedCategoryId: 'cat-claimed', closedCategoryId: 'cat-closed' }
  service.guild = {
    roles: { everyone: { id: 'everyone' } },
    members: { cache: new Map(), fetch: async (id) => ({ id, roles: { cache: new Map([['role-mod', {}]]) } }) },
  }
  service.client = { channels: { fetch: async (id) => (id === 'thread-7' ? thread : channel) } }
  service.repository = {
    upsertStaff: async (...args) => { seen.upsert.push(args) },
    disableStaff: async (...args) => { seen.disable.push(args) },
    listStaff: async () => [{ discord_user_id: '900', gm_name: 'Spikebot', enabled: 1 }],
    reopen: async (...args) => { seen.reopen.push(args); return ticket },
    reassign: async (...args) => { seen.reassign.push(args); return ticket },
    staff: async () => ({ gm_name: 'Spikebot' }),
    ticketsWithOpenWork: async () => [ticket],
    getThreadId: async () => 'thread-7',
    gmIdentityNames: async () => ['Spikebot'],
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
      getString: () => 'Spikebot',
      getInteger: () => 7,
    },
    reply: async (payload) => { replies.push(payload); return payload },
  }
}

// The bug this exists for: /ticket staff-add called this.addStaffToOpenThreads(), which was never
// written. JavaScript resolves a method name when the line runs, so `npm run check` parsed it
// happily and no test reached it - it took a human running the command on a live guild. Driving
// every declared subcommand through the real prototype makes a missing method a test failure.
test('every /ticket admin subcommand runs against the real service', async () => {
  const declared = ticketAdminCommand().toJSON().options.map((option) => option.name)
  assert.ok(declared.length >= 5, 'the admin command lost subcommands')
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

  assert.deepEqual(seen.upsert, [['900', 'Spikebot']], 'the mapping was not saved')
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
  service.config = { adminRoleId: 'role-admin', moderatorRoleId: 'role-mod', gmRoleId: 'role-gm' }
  service.repository = {
    staff: async () => ({ gm_name: 'Spikebot' }),
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
  id: 3, public_key: 'R1-3', source: 'ingame', realm_tag: 'R1', player_name: 'Annoyingass',
  claimant_discord_user_id: '100', claimant_gm_name: 'Spikebot',
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
  assert.match(interaction.replies[0].content, /Delivering now — Annoyingass is online\./)
})

test('a reply to an offline player still says it is waiting for them', async () => {
  for (const context of [false, null]) {
    const { service } = replyService(context)
    const interaction = replyInteraction()
    await service.replyToPlayer(interaction, REPLY_TICKET, 'Have a look when you are back')
    assert.match(interaction.replies[0].content, /It will arrive when Annoyingass is online\./)
  }
})

test('a deleted audit channel is recreated instead of silently dropping entries', async () => {
  const warnings = []
  const board = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: (line) => warnings.push(line), info: () => {} }
  service.config = { botRoleId: 'role-bot', adminRoleId: 'role-admin', commandAuditChannel: true }
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

// The pin fails on the run that creates the channel because Discord has not finished applying the
// overwrites yet. It is a propagation race, not a permission fault, and it greeted every fresh
// install with an alarming warning that was not true.
test('the queue board pin is retried once before it is reported as a failure', async () => {
  const warnings = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: () => {}, warn: (line) => warnings.push(line), info: () => {} }

  let attempts = 0
  const flaky = { pin: async () => { attempts += 1; if (attempts === 1) throw new Error('Missing Permissions') } }
  assert.equal(await service.pinWithRetry(flaky, 'Ticket queue board'), true)
  assert.equal(attempts, 2)
  assert.equal(warnings.length, 0, 'a recovered pin must not warn')

  const broken = { pin: async () => { throw new Error('Missing Permissions') } }
  assert.equal(await service.pinWithRetry(broken, 'Ticket queue board'), false)
  assert.match(warnings[0], /Could not pin the queue board/)
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
  const { service } = identityService(['Spikebot', 'Helpdesk'])
  await assert.rejects(() => service.assertConfiguredIdentity('Spikeplay'), (error) => {
    assert.match(error.message, /"Spikeplay" is not a configured GM identity/)
    assert.match(error.message, /Spikebot, Helpdesk/)
    return true
  })
  await assert.doesNotReject(() => service.assertConfiguredIdentity('Spikebot'))
  // The realm is case-insensitive about character names and so is this.
  await assert.doesNotReject(() => service.assertConfiguredIdentity('spikebot'))
})

test('an empty identity list is explained rather than blamed on the name', async () => {
  const { service } = identityService([])
  await assert.rejects(() => service.assertConfiguredIdentity('Spikebot'), /No GM identities are configured/)
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
  const guide = fs.readFileSync(new URL('../docs/INSTALL.md', import.meta.url), 'utf8')
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

// The bug this exists for: closure side effects ran only via the bot's own performClose, so ANY
// closure originating in game - a player abandoning their ticket, or a GM typing .ticket close at
// the console - left the channel sitting in Open Tickets with no notice and no retention clock.
function closureService({ status = 'closed', alreadyHandled = false } = {}) {
  const seen = { enqueued: [], sent: [], refreshed: [], audited: [] }
  const ticket = {
    id: 9, public_key: 'R1-9', source: 'ingame', source_ticket_id: 42, realm_tag: 'R1',
    status, discord_channel_id: 'chan-9', player_name: 'Annoyingass',
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
