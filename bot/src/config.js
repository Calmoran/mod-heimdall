import crypto from 'node:crypto'
import path from 'node:path'

// DISCORD_BOT_ROLE_ID is deliberately not here. It is the one role id an operator must NOT create -
// Discord makes a managed role per application and that is the only role a bot is ever in - so
// asking for it beside three ids they do create invited exactly the mistake that bricked an install.
// The bot finds its own; setting it is optional and is verified properly when it is set.
const required = [
  'DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'MYSQL_HOST', 'MYSQL_DATABASE',
  'MYSQL_USER', 'MYSQL_PASSWORD', 'ARCHIVE_DIR', 'BOT_INSTANCE_ID',
]

function positiveInt(value, name, fallback, minimum = 1) {
  const parsed = Number.parseInt(value ?? fallback, 10)
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return parsed
}

// Resolves the closed-channel lifetime to hours. CLOSED_CHANNEL_DELETE_DAYS is the current
// setting; CLOSED_CHANNEL_DELETE_HOURS is the superseded one, still read so upgrading an install
// does not silently change its retention. Setting both is a configuration mistake, so it is
// refused rather than silently resolved one way.
function closedChannelDeleteHours(env) {
  const hasDays = (env.CLOSED_CHANNEL_DELETE_DAYS ?? '') !== ''
  const hasHours = (env.CLOSED_CHANNEL_DELETE_HOURS ?? '') !== ''
  if (hasDays && hasHours) {
    throw new Error('Set CLOSED_CHANNEL_DELETE_DAYS or the superseded CLOSED_CHANNEL_DELETE_HOURS, not both.')
  }
  if (hasHours) return positiveInt(env.CLOSED_CHANNEL_DELETE_HOURS, 'CLOSED_CHANNEL_DELETE_HOURS', 24, 0)
  return positiveInt(env.CLOSED_CHANNEL_DELETE_DAYS, 'CLOSED_CHANNEL_DELETE_DAYS', 7, 0) * 24
}

function logLevel(value) {
  const level = (value ?? 'info').trim().toLowerCase()
  if (!['error', 'warn', 'info', 'debug'].includes(level)) {
    throw new Error(`LOG_LEVEL must be error, warn, info or debug, not ${JSON.stringify(level)}`)
  }
  return level
}

// The panel channel and the three categories are provisioned on first run and their IDs stored in
// the database, so these are optional. An untouched `replace_with_...` counts as absent, not as a
// configured value - otherwise a fresh install would try to fetch a channel named after the
// placeholder. A real ID set here always wins, and is checked at startup rather than trusted.
// Absent means the default, which is why this cannot just be `Boolean(value)`.
function flag(value, name, fallback) {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  throw new Error(`${name} must be a yes/no value, not ${JSON.stringify(value)}`)
}

function optionalId(value) {
  const trimmed = (value ?? '').trim()
  if (!trimmed || trimmed.startsWith('replace_with_')) return null
  return trimmed
}

// A comma-separated list of role ids. Order is preserved and duplicates within one list are
// dropped, so a pasted id cannot silently count twice.
function roleIdList(value) {
  return [...new Set((value ?? '').split(',').map((entry) => optionalId(entry)).filter(Boolean))]
}

// The instance lock and the delivery leases are owned by the PROCESS, not by the configuration.
// An id taken straight from BOT_INSTANCE_ID could not see the likeliest accident: two copies
// started from one .env share that value, so the second read the lock row, found its own name
// there and concluded it held the lock. Both then answered the same button presses, and the loser's
// complaints about work the winner had already done correctly ("this ticket is no longer available
// to claim") read as bugs in the ticket logic.
//
// The pid is included because it is the number an operator can act on; the random suffix because
// pids are reused. BOT_INSTANCE_ID stays the human-readable label in messages and logs.
export function deriveRunId(instanceId, pid = process.pid, entropy = crypto.randomBytes(3).toString('hex')) {
  const suffix = `-${pid}-${entropy}`
  // heimdall_delivery.lease_owner is VARCHAR(64) and the schema is frozen, so a long
  // BOT_INSTANCE_ID gives up characters rather than the parts that make this id unique. Truncating
  // the other way round would let two processes share an id again, which is the bug this fixes.
  return `${String(instanceId).slice(0, 64 - suffix.length)}${suffix}`
}

export function loadConfig(env = process.env) {
  const missing = required.filter((key) => !env[key] || env[key].startsWith('replace_with_'))
  if (missing.length) throw new Error(`Missing required environment values: ${missing.join(', ')}`)
  const archiveDir = path.resolve(env.ARCHIVE_DIR)

  // Two lists replaced three fixed roles. Moderator and GM were treated identically at every call
  // site - two tiers wearing three names - and a server with one staff tier could not express
  // itself: putting one id in all three variables would have handed Discord a channel-overwrite
  // array with duplicate targets, which it rejects. The three old singular variables are still
  // read and folded in, so an install that predates the lists upgrades untouched.
  //
  // Folding them in SILENTLY was the gap: nothing told an operator they were on the old shape, so
  // they found out by reading a CHANGELOG, or never. Each legacy variable still set is collected
  // here and warned about once at startup, naming its replacement and saying it is still honoured -
  // so the change happens when it suits them rather than during an outage, and a maintainer can
  // tell from a pasted log how many installs still carry the old configuration.
  //
  // Collected rather than logged, because configuration is read before there is a logger to read
  // it with.
  const deprecations = []
  const deprecate = (oldName, replacement) => {
    if (optionalId(env[oldName])) {
      deprecations.push(`${oldName} is deprecated - use ${replacement} (comma-separated). `
        + 'It is still honoured, so nothing is broken and there is no rush.')
    }
  }
  deprecate('DISCORD_MODERATOR_ROLE_ID', 'DISCORD_STAFF_ROLE_IDS')
  deprecate('DISCORD_GM_ROLE_ID', 'DISCORD_STAFF_ROLE_IDS')
  deprecate('DISCORD_ADMIN_ROLE_ID', 'DISCORD_ADMIN_ROLE_IDS')

  const staffRoleIds = [...new Set([
    ...roleIdList(env.DISCORD_STAFF_ROLE_IDS),
    optionalId(env.DISCORD_MODERATOR_ROLE_ID),
    optionalId(env.DISCORD_GM_ROLE_ID),
  ].filter(Boolean))]
  // Empty is allowed and means: anyone with Discord's own Manage Server permission administers the
  // roster. A one-tier server configures exactly one variable and is done.
  const adminRoleIds = [...new Set([
    ...roleIdList(env.DISCORD_ADMIN_ROLE_IDS),
    optionalId(env.DISCORD_ADMIN_ROLE_ID),
  ].filter(Boolean))]
  if (!staffRoleIds.length) {
    throw new Error('DISCORD_STAFF_ROLE_IDS must name at least one role that can answer tickets '
      + '(comma-separated role ids; the legacy DISCORD_MODERATOR_ROLE_ID / DISCORD_GM_ROLE_ID are '
      + 'also still read).')
  }
  return Object.freeze({
    token: env.DISCORD_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    staffRoleIds,
    adminRoleIds,
    deprecations: Object.freeze(deprecations),
    botRoleId: optionalId(env.DISCORD_BOT_ROLE_ID),
    panelChannelId: optionalId(env.DISCORD_PANEL_CHANNEL_ID),
    openCategoryId: optionalId(env.DISCORD_OPEN_CATEGORY_ID),
    claimedCategoryId: optionalId(env.DISCORD_CLAIMED_CATEGORY_ID),
    closedCategoryId: optionalId(env.DISCORD_CLOSED_CATEGORY_ID),
    supportCategoryId: optionalId(env.DISCORD_SUPPORT_CATEGORY_ID),
    queueChannelId: optionalId(env.DISCORD_QUEUE_CHANNEL_ID),
    // Named rather than fixed, because an operator with an existing support structure may want
    // Heimdall's channels to read as part of it.
    supportCategoryName: (env.DISCORD_SUPPORT_CATEGORY_NAME || 'Heimdall Support').trim().slice(0, 100),
    mysql: {
      host: env.MYSQL_HOST,
      port: positiveInt(env.MYSQL_PORT, 'MYSQL_PORT', 3306),
      database: env.MYSQL_DATABASE,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
    },
    archiveDir,
    maxAttachmentBytes: positiveInt(env.ARCHIVE_MAX_ATTACHMENT_BYTES, 'ARCHIVE_MAX_ATTACHMENT_BYTES', 10 * 1024 * 1024),
    retentionDays: positiveInt(env.TRANSCRIPT_RETENTION_DAYS, 'TRANSCRIPT_RETENTION_DAYS', 180),
    // Days is the natural unit for "keep closed tickets around for a while". The superseded hours
    // setting is still honoured so an existing install keeps working; setting both is refused at
    // startup rather than resolved silently one way.
    closedChannelDeleteHours: closedChannelDeleteHours(env),
    leaseSeconds: positiveInt(env.DELIVERY_LEASE_SECONDS, 'DELIVERY_LEASE_SECONDS', 60),
    maxAttempts: positiveInt(env.DELIVERY_MAX_ATTEMPTS, 'DELIVERY_MAX_ATTEMPTS', 12),
    // 0 disables auto-close entirely, which is the default so no existing install changes.
    autoCloseInactiveDays: positiveInt(env.AUTO_CLOSE_INACTIVE_DAYS, 'AUTO_CLOSE_INACTIVE_DAYS', 0, 0),
    // Minutes a ticket may sit unclaimed before staff are pinged. 0 keeps an existing install
    // silent, which is what it was before this option existed.
    queueNudgeMinutes: positiveInt(env.QUEUE_NUDGE_MINUTES, 'QUEUE_NUDGE_MINUTES', 0, 0),
    // Governs BOTH producers that write to the GM command audit channel: the module's own command
    // log, and the bot's attribution of the SOAP commands it issues. One switch, because the bug
    // this replaced was the two of them having different rights to create the channel - opting in
    // for one silently disabled the other. On by default: a bot that runs GM commands on your realm
    // should say so, and the realm's own log records them all as "Console".
    commandAuditChannel: flag(env.COMMAND_AUDIT_CHANNEL, 'COMMAND_AUDIT_CHANNEL', true),
    log: {
      level: logLevel(env.LOG_LEVEL),
      directory: env.LOG_DIR ? path.resolve(env.LOG_DIR) : path.resolve('.'),
      maxBytes: positiveInt(env.LOG_MAX_FILE_BYTES, 'LOG_MAX_FILE_BYTES', 5 * 1024 * 1024),
      retainedFiles: positiveInt(env.LOG_RETAINED_FILES, 'LOG_RETAINED_FILES', 5),
    },
    instanceId: env.BOT_INSTANCE_ID,
    runId: deriveRunId(env.BOT_INSTANCE_ID),
  })
}
