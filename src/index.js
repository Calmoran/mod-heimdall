import fs from 'node:fs'

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import mysql from 'mysql2/promise'

import { ArchiveStore } from './archive.js'
import { loadConfig } from './config.js'
import { Logger } from './logger.js'
import { HeimdallService, ticketAdminCommand } from './discord.js'
import { TicketRepository } from './repository.js'
import { SoapClient } from './soap.js'

function loadEnvironmentFile(filename = process.env.HEIMDALL_ENV_FILE) {
  if (!filename || !fs.existsSync(filename)) return
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`Invalid environment-file line: ${line}`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1')
    if (!(key in process.env)) process.env[key] = value
  }
}

async function cleanupExpired(repository, archive, logger) {
  for (const attachment of await repository.expiredAttachments()) {
    try {
      await archive.remove(attachment.stored_name)
        await repository.removeAttachment(attachment.id)
    } catch (error) {
      logger.error(`Could not remove expired attachment ${attachment.id}`, error)
    }
  }
  for (const ticketId of await repository.expiredTicketIds()) {
    try {
      await repository.purgeTicketContent(ticketId)
    } catch (error) {
      logger.error(`Could not purge expired ticket ${ticketId}`, error)
    }
  }
  await repository.pruneDeliveredSystemJobs()
}

// One instance beats every 15 seconds; another may take the lock after 60. Four missed beats before
// a takeover is far outside anything a GC pause, a slow query or a stalled connection produces, and
// it means a crashed bot blocks a restart for at most a minute - shorter than it takes an operator
// to notice the crash in the first place.
const INSTANCE_HEARTBEAT_SECONDS = 15
const INSTANCE_STALE_SECONDS = 60

async function main() {
  loadEnvironmentFile()
  const config = loadConfig()
  // Every secret this process holds is registered with the writer, so a value that reaches a log
  // line by any route - including inside a driver's error text - is replaced before it is written.
  const logger = new Logger({
    ...config.log,
    secrets: [config.token, config.mysql.password, config.soap.password],
  })
  logger.info('Heimdall bot starting', { level: config.log.level, logFile: logger.path })
  const pool = mysql.createPool({ ...config.mysql, waitForConnections: true, connectionLimit: 5, queueLimit: 20, enableKeepAlive: true })
  const repository = new TicketRepository(pool, config.instanceId)
  // Before the Discord login, so a second instance never reaches the gateway and never sees an
  // interaction it would answer twice.
  const lock = await repository.claimInstanceLock(INSTANCE_STALE_SECONDS)
  if (!lock.held) {
    throw new Error(`Another ticket bot instance is already running: "${lock.holder}", last seen ${lock.age}s ago. `
      + `Stop it first, or wait ${INSTANCE_STALE_SECONDS}s after it dies for the lock to expire. `
      + `This instance is "${repository.instanceId}"; set BOT_INSTANCE_ID to tell them apart.`)
  }

  const archive = new ArchiveStore(config.archiveDir, config.maxAttachmentBytes)
  await archive.initialize()
  const soap = new SoapClient(config.soap)
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] })
  const tickets = new HeimdallService({ client, repository, archive, config, soap, logger })

  // Everything after login happens in here, and an async listener has nowhere to reject to: a
  // failure in initialize() was an unhandled rejection rather than the readable message
  // main().catch prints for anything before login.
  client.once(Events.ClientReady, async () => {
    try {
      await tickets.initialize()
      await client.application.commands.set([ticketAdminCommand().toJSON()], config.guildId)
      logger.log(`Discord ticket bot ready as ${client.user.tag}`)
      await tickets.processDeliveries()
      await tickets.refreshQueueBoard().catch((error) => logger.error('Queue board refresh failed', error))
      await cleanupExpired(repository, archive, logger)
      await tickets.autoCloseInactiveTickets().catch((error) => logger.error('Auto-close pass failed', error))
      setInterval(() => tickets.processDeliveries().catch((error) => logger.error('Ticket delivery pass failed', error)), 5_000).unref()
      setInterval(() => {
        repository.beatInstanceLock().then((held) => {
          if (held) return
          logger.error('Another ticket bot instance has taken the lock; stopping so the two do not act on the same tickets.')
          process.exit(1)
        }).catch((error) => logger.error('Instance heartbeat failed', error))
      }, INSTANCE_HEARTBEAT_SECONDS * 1_000).unref()
      // State changes redraw the board immediately; this timer is only so the elapsed times on it
      // stay honest while nothing is happening.
      setInterval(() => tickets.refreshQueueBoard().catch((error) => logger.error('Queue board refresh failed', error)), 60_000).unref()
      setInterval(() => cleanupExpired(repository, archive, logger).catch((error) => logger.error('Retention cleanup failed', error)), 3_600_000).unref()
      // Inactivity is measured in days, so an hourly pass is ample.
        setInterval(() => tickets.autoCloseInactiveTickets().catch((error) => logger.error('Auto-close pass failed', error)), 3_600_000).unref()
    } catch (error) {
      logger.error('Discord ticket bot failed to start after login:', error?.message ?? error)
      await repository.releaseInstanceLock().catch(() => undefined)
      process.exit(1)
    }
  })

  const shutdown = async (signal) => {
    logger.log(`Received ${signal}; stopping ticket bot.`)
    client.destroy()
    await repository.releaseInstanceLock().catch((error) => logger.error('Could not release the instance lock', error))
    await pool.end()
    process.exit(0)
  }
  process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => { logger.error(error); process.exit(1) }))
  process.once('SIGINT', () => shutdown('SIGINT').catch((error) => { logger.error(error); process.exit(1) }))
  await client.login(config.token)
}

main().catch((error) => {
  console.error('Discord ticket bot did not start:', error.message)
  process.exit(1)
})
