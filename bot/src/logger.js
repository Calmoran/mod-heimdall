import fs from 'node:fs'
import path from 'node:path'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

// Anything that looks like a credential, whether or not this process knows its value. A driver's
// connection error arrives as text we did not build and can carry a password in it.
const PATTERNS = [
  // Discord bot tokens: three dot-separated base64url parts, the first being a snowflake.
  [/\b[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6,10}\.[A-Za-z0-9_-]{25,110}\b/g, '[REDACTED-TOKEN]'],
  // "Bot <token>" and "Authorization: Bearer <token>".
  [/\b(Bot|Bearer)\s+[A-Za-z0-9._-]{16,}/gi, '$1 [REDACTED-TOKEN]'],
  // user:password@host in any URL, which is how connection strings leak.
  [/\/\/([^\s:/@]+):([^\s@/]+)@/g, '//$1:[REDACTED]@'],
  // key=value and key: value forms, including the spellings MySQL and Node drivers use.
  [/\b(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]'],
]

function redact(text, literals) {
  let value = String(text)
  // Known values first: an exact match is worth catching even when no pattern would.
  for (const literal of literals) value = value.split(literal).join('[REDACTED]')
  for (const [pattern, replacement] of PATTERNS) value = value.replace(pattern, replacement)
  return value
}

function serialise(value) {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// A hundred lines rather than a dependency. This file is installed on other people's servers, and a
// logging library is a large amount of supply chain for appending strings to a file.
export class Logger {
  constructor({
    level = 'info',
    directory = process.cwd(),
    filename = 'heimdall-bot.log',
    maxBytes = 5 * 1024 * 1024,
    retainedFiles = 5,
    secrets = [],
    console: target = console,
  } = {}) {
    this.threshold = LEVELS[level] ?? LEVELS.info
    this.levelName = level
    this.directory = directory
    this.path = path.join(directory, filename)
    this.maxBytes = maxBytes
    this.retainedFiles = retainedFiles
    // Short or empty values would redact half the file, so only real secrets are registered.
    this.secrets = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret.length >= 6))]
    this.console = target
    this.failed = false

    fs.mkdirSync(this.directory, { recursive: true })
    this.size = fs.existsSync(this.path) ? fs.statSync(this.path).size : 0
  }

  error(message, meta) { this.write('error', message, meta) }
  warn(message, meta) { this.write('warn', message, meta) }
  info(message, meta) { this.write('info', message, meta) }
  debug(message, meta) { this.write('debug', message, meta) }

  // Existing call sites use console's name for this.
  log(message, meta) { this.write('info', message, meta) }

  write(level, message, meta) {
    const parts = [serialise(message)]
    let ticket = null

    if (meta instanceof Error || (meta !== undefined && meta !== null && !(typeof meta === 'object' && !Array.isArray(meta)))) {
      parts.push(serialise(meta))
    } else if (meta) {
      const { ticket: key, ...rest } = meta
      ticket = key ?? null
      for (const [name, value] of Object.entries(rest)) parts.push(`${name}=${serialise(value)}`)
    }

    const text = parts.join(' ')
    const consoleMethod = level === 'debug' ? 'log' : level
    if (LEVELS[level] <= this.threshold) {
      this.console[consoleMethod]?.(ticket ? `[${ticket}] ${text}` : text)
    }
    if (LEVELS[level] > this.threshold) return

    // Redaction happens here, at the only place that writes the file, so nothing can route around
    // it by logging through a different call.
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${ticket ? `[${ticket}] ` : ''}${redact(text, this.secrets)}\n`
    this.append(line)
  }

  append(line) {
    try {
      if (this.size + Buffer.byteLength(line) > this.maxBytes) this.rotate()
      fs.appendFileSync(this.path, line)
      this.size += Buffer.byteLength(line)
      this.failed = false
    } catch (error) {
      // Losing the log must never take the bot down with it, but say so once.
      if (!this.failed) this.console.error(`Could not write ${this.path}: ${error.message}`)
      this.failed = true
    }
  }

  rotate() {
    // heimdall-bot.log -> .1 -> .2 ... and the oldest falls off the end.
    const oldest = `${this.path}.${this.retainedFiles}`
    fs.rmSync(oldest, { force: true })
    for (let index = this.retainedFiles - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`
      if (fs.existsSync(from)) fs.renameSync(from, `${this.path}.${index + 1}`)
    }
    if (fs.existsSync(this.path)) fs.renameSync(this.path, `${this.path}.1`)
    this.size = 0
  }
}

export const redactForTests = redact
