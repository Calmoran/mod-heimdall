// Does the bot actually start?
//
// This exists because 1.1.0 shipped a bot that could not. Removing the SOAP client left a reference
// to its configuration in index.js, in the list of secrets handed to the log writer - which is built
// before anything is logged - so every start died with "Cannot read properties of undefined
// (reading 'password')" and, on Windows, a console window that opened and closed.
//
// Nothing caught it: the other tests exercise the service and never main(), and `npm run check` only
// parses. The gap was that no test ever ran the program. This one does: it launches src/index.js as
// a real process and waits for the startup line, which main() writes immediately after building the
// logger and before it touches MySQL or Discord. So it needs neither, and it fails on exactly the
// class of mistake that got through - a wiring error in the first few statements of startup.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// Values are shaped like the real thing but reach nothing: the port is one nothing listens on, and
// the token is refused by Discord. Startup gets far enough to prove the wiring either way.
const ENVIRONMENT = [
  'DISCORD_TOKEN=not-a-real-token',
  'DISCORD_GUILD_ID=100000000000000000',
  'DISCORD_STAFF_ROLE_IDS=100000000000000001',
  'DISCORD_ADMIN_ROLE_IDS=100000000000000002',
  'MYSQL_HOST=127.0.0.1',
  'MYSQL_PORT=1',
  'MYSQL_DATABASE=heimdall_smoke',
  'MYSQL_USER=heimdall_smoke',
  'MYSQL_PASSWORD=not-a-real-password',
  'BOT_INSTANCE_ID=smoke-test',
]

test('the bot starts far enough to prove its startup wiring', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-smoke-'))
  const envFile = path.join(scratch, 'smoke.env')
  fs.writeFileSync(envFile, [
    ...ENVIRONMENT,
    `ARCHIVE_DIR=${path.join(scratch, 'archive')}`,
    `LOG_DIR=${scratch}`,
  ].join('\n'))

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, HEIMDALL_ENV_FILE: envFile },
  })

  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  const exit = await new Promise((resolve) => {
    // It cannot finish starting - there is no database and no valid token - so it is stopped once
    // it has said what this test needs to know, or after a grace period if it says nothing.
    const timer = setTimeout(() => { child.kill(); resolve('timeout') }, 15000)
    const poll = setInterval(() => {
      if (/Heimdall bot starting/.test(output)) { clearInterval(poll); clearTimeout(timer); child.kill(); resolve('started') }
    }, 100)
    child.on('exit', () => { clearInterval(poll); clearTimeout(timer); resolve('exited') })
  })

  fs.rmSync(scratch, { recursive: true, force: true })

  // A TypeError here is the 1.1.0 failure exactly: startup referred to configuration that no longer
  // exists. Checked before the assertion below, because it is the more useful message of the two.
  assert.doesNotMatch(output, /TypeError|ReferenceError/,
    `startup threw before it could run:\n${output.slice(0, 800)}`)
  assert.match(output, /Heimdall bot starting/,
    `the bot never reached its startup line (${exit}):\n${output.slice(0, 800)}`)
})
