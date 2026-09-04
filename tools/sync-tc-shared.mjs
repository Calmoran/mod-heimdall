// Copies the module's core-neutral headers into the TrinityCore port.
//
// Three of the module's headers depend on the standard library and nothing else - which is why
// test/qualify_test.cpp and test/command_test.cpp already compile two of them outside the core's
// build. They are the same source for both cores, so the port takes them as byte-identical copies
// rather than as a second transcription: mod_heimdall_schema_ddl.h carries the schema, which must
// not drift, and mod_heimdall_command.h carries the fixed command switch, which is the T13
// security shape and is unit tested where it stands.
//
// Run this after editing any of them: node tools/sync-tc-shared.mjs
// bot/test/schema-drift.test.js fails if the copies fall out of date, so forgetting is loud.

import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const SHARED_HEADERS = [
  'mod_heimdall_qualify.h',
  'mod_heimdall_command.h',
  'mod_heimdall_schema_ddl.h'
]

let changed = 0
for (const name of SHARED_HEADERS) {
  const from = join(root, 'src', name)
  const to = join(root, 'trinitycore', 'src', name)
  if (readFileSync(from).equals(readFileSync(to))) {
    console.log(`unchanged  ${name}`)
    continue
  }

  copyFileSync(from, to)
  console.log(`copied     ${name}`)
  changed++
}

console.log(changed === 0 ? 'trinitycore/src is up to date.' : `${changed} file(s) updated.`)
