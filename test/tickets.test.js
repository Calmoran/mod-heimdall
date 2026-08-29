import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PermissionFlagsBits } from 'discord.js'

import { HeimdallService, REQUIRED_PERMISSIONS } from '../src/discord.js'
import { Logger } from '../src/logger.js'
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
  assert.throws(() => splitWowMessage('x'.repeat(256), 240), /single word/)
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

// A stand-in for a guild where the bot holds everything except the named permissions.
function serviceMissing(...missing) {
  const denied = new Set(missing)
  const held = { has: (flag) => !denied.has(flag) }
  const lines = []
  const service = Object.create(HeimdallService.prototype)
  service.logger = { error: (line) => lines.push(['error', line]), warn: (line) => lines.push(['warn', line]), info: (line) => lines.push(['info', line]) }
  service.ids = {}
  service.repository = { getSetting: async () => null }
  service.guild = { members: { fetchMe: async () => ({ permissions: held }) } }
  service.client = { channels: { fetch: async () => null } }
  return { service, lines }
}

test('the permissions preflight names what is missing and what it breaks', async () => {
  const { service, lines } = serviceMissing(PermissionFlagsBits.CreatePrivateThreads)
  await service.verifyPermissions()

  const errors = lines.filter(([level]) => level === 'error').map(([, line]) => line)
  assert.ok(errors.some((line) => line.includes('Create Private Threads')), 'did not name the permission')
  assert.ok(errors.some((line) => line.includes('no ticket has any controls')), 'did not say what breaks')
  assert.ok(errors.some((line) => line.includes('cannot work without')), 'did not summarise')
})

test('a degrading permission warns rather than erroring, and a full set is silent', async () => {
  const degraded = serviceMissing(PermissionFlagsBits.ManageWebhooks)
  await degraded.service.verifyPermissions()
  assert.equal(degraded.lines.filter(([level]) => level === 'error').length, 0)
  assert.ok(degraded.lines.some(([level, line]) => level === 'warn' && line.includes('Manage Webhooks')))

  const complete = serviceMissing()
  await complete.service.verifyPermissions()
  assert.deepEqual(complete.lines.map(([level]) => level), ['info'])
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
