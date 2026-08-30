// Prints a summary an operator can paste into a bug report alongside their log file.
//
// Every secret is masked here rather than omitted, so the output still answers "is it set, and does
// it look right" - a wrong-length token and an unset one are different problems.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import mysql from 'mysql2/promise'

import { loadConfig } from './config.js'

function mask(value) {
  if (value === undefined || value === null || value === '') return '(not set)'
  const text = String(value)
  if (text.length <= 8) return `(set, ${text.length} chars)`
  return `${text.slice(0, 3)}…${text.slice(-2)} (${text.length} chars)`
}

function packageVersion() {
  try {
    const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'package.json')
    return JSON.parse(fs.readFileSync(file, 'utf8')).version
  } catch {
    return 'unknown'
  }
}

function loadEnvironmentFile(filename = process.env.HEIMDALL_ENV_FILE) {
  if (!filename || !fs.existsSync(filename)) return
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1')
    if (!(key in process.env)) process.env[key] = value
  }
}

const TABLES = ['ticket', 'event', 'delivery', 'attachment', 'staff', 'setting', 'audit']

async function main() {
  loadEnvironmentFile()
  const out = []
  const say = (label, value) => out.push(`${String(label).padEnd(26)} ${value}`)

  out.push('Heimdall bot diagnostics')
  out.push('='.repeat(60))
  say('heimdall-bot version', packageVersion())
  say('node', process.version)
  say('platform', `${process.platform} ${process.arch}`)

  let config = null
  try {
    config = loadConfig()
  } catch (error) {
    say('configuration', `FAILED: ${error.message}`)
    console.log(out.join('\n'))
    process.exitCode = 1
    return
  }

  out.push('')
  out.push('Configuration')
  out.push('-'.repeat(60))
  say('guild id', config.guildId)
  say('discord token', mask(config.token))
  say('admin / mod / gm role', [config.adminRoleId, config.moderatorRoleId, config.gmRoleId].join(' '))
  // "auto" is the recommended state: the bot's role is the managed one Discord made, which it finds
  // itself. A value here is an override and is verified at startup.
  say('bot role', config.botRoleId ?? 'auto (managed role)')
  say('panel / queue', [config.panelChannelId ?? 'auto', config.queueChannelId ?? 'auto'].join(' '))
  say('open / claimed / closed', [config.openCategoryId ?? 'auto', config.claimedCategoryId ?? 'auto', config.closedCategoryId ?? 'auto'].join(' '))
  say('support category', `${config.supportCategoryId ?? 'auto'} (${config.supportCategoryName})`)
  say('mysql', `${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`)
  say('mysql password', mask(config.mysql.password))
  say('soap url', config.soap.url)
  say('soap user / password', `${config.soap.user} / ${mask(config.soap.password)}`)
  say('archive dir', config.archiveDir)
  say('instance id', config.instanceId)

  out.push('')
  out.push('Features and limits')
  out.push('-'.repeat(60))
  say('log level', config.log.level)
  say('log file', path.join(config.log.directory, 'heimdall-bot.log'))
  say('log rotation', `${config.log.maxBytes} bytes, ${config.log.retainedFiles} retained`)
  say('transcript retention', `${config.retentionDays} days`)
  say('closed channel deletion', `${config.closedChannelDeleteHours} hours`)
  say('auto-close inactive', config.autoCloseInactiveDays ? `${config.autoCloseInactiveDays} days` : 'off')
  say('queue nudge', config.queueNudgeMinutes ? `${config.queueNudgeMinutes} minutes` : 'off')
  say('delivery lease / attempts', `${config.leaseSeconds}s / ${config.maxAttempts}`)
  say('max attachment bytes', config.maxAttachmentBytes)

  out.push('')
  out.push('Database')
  out.push('-'.repeat(60))
  let pool = null
  try {
    pool = mysql.createPool({ ...config.mysql, connectionLimit: 1, waitForConnections: true })
    const [[version]] = await pool.execute('SELECT VERSION() AS v')
    say('connection', `ok, MySQL ${version.v}`)
    for (const table of TABLES) {
      try {
        const [[row]] = await pool.execute(`SELECT COUNT(*) AS n FROM heimdall_${table}`)
        say(`heimdall_${table}`, `${row.n} row(s)`)
      } catch (error) {
        say(`heimdall_${table}`, `UNREADABLE: ${error.code ?? error.message}`)
      }
    }
    try {
      const [rows] = await pool.execute("SELECT state, COUNT(*) AS n FROM heimdall_delivery GROUP BY state")
      say('delivery states', rows.length ? rows.map((row) => `${row.state}=${row.n}`).join(' ') : 'empty')
    } catch { /* counted above */ }
    try {
      const [rows] = await pool.execute("SELECT status, COUNT(*) AS n FROM heimdall_ticket GROUP BY status")
      say('ticket states', rows.length ? rows.map((row) => `${row.status}=${row.n}`).join(' ') : 'empty')
    } catch { /* counted above */ }
    const [[staff]] = await pool.execute('SELECT COUNT(*) AS n FROM heimdall_staff WHERE enabled = 1')
    say('enabled staff', staff.n)
    if (!staff.n) out.push('  ! No enabled staff. Nobody can claim a ticket, and new staff threads will have no members.')
  } catch (error) {
    say('connection', `FAILED: ${error.code ?? ''} ${error.message}`)
  } finally {
    if (pool) await pool.end().catch(() => undefined)
  }

  out.push('')
  out.push('Log file')
  out.push('-'.repeat(60))
  const logFile = path.join(config.log.directory, 'heimdall-bot.log')
  if (fs.existsSync(logFile)) {
    const stat = fs.statSync(logFile)
    say('current size', `${stat.size} bytes, last written ${stat.mtime.toISOString()}`)
  } else {
    say('current size', '(no file yet)')
  }

  out.push('')
  out.push('Nothing above contains a secret in full. Safe to paste into a bug report.')
  console.log(out.join('\n'))
}

main().catch((error) => {
  console.error('Diagnostics failed:', error.message)
  process.exitCode = 1
})
