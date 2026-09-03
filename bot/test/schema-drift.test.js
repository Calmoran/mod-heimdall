// The schema exists in two places on purpose: deploy/heimdall-schema.sql is what an operator reads
// and what the migration moves, and src/mod_heimdall_schema_ddl.h is the copy the module runs at
// startup. Two copies drift unless something checks, and a module that creates tables the .sql
// does not describe is the kind of mismatch nobody notices until a fresh install behaves
// differently from a migrated one. So this reads both and fails when they differ by a byte.
//
// The same goes for the list of table names: the qualifier rewrites exactly the names in its
// TABLES array, and diagnose counts exactly the ones in its own. A table added to the .sql and
// missed in either list would be created unqualified - in the characters database - and silently.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n')
}

const schemaSql = read('deploy/heimdall-schema.sql')

test('the embedded DDL is byte-for-byte the shipped heimdall-schema.sql', () => {
  const header = read('src/mod_heimdall_schema_ddl.h')
  const match = header.match(/R"heimdall\(([\s\S]*?)\)heimdall"/)
  assert.ok(match, 'mod_heimdall_schema_ddl.h has no R"heimdall(...)heimdall" literal')
  assert.equal(match[1], schemaSql,
    'src/mod_heimdall_schema_ddl.h differs from deploy/heimdall-schema.sql - edit the .sql and paste it into the header')
})

const createdTables = [...schemaSql.matchAll(/^CREATE TABLE IF NOT EXISTS (heimdall_\w+)/gm)].map((m) => m[1])

test('the schema creates the seven tables and nothing else', () => {
  assert.deepEqual(createdTables, [
    'heimdall_ticket', 'heimdall_event', 'heimdall_delivery', 'heimdall_attachment',
    'heimdall_staff', 'heimdall_setting', 'heimdall_audit',
  ])
})

test("the qualifier's table list matches the schema", () => {
  const qualify = read('src/mod_heimdall_qualify.h')
  const block = qualify.match(/TABLES = \{([\s\S]*?)\};/)
  assert.ok(block, 'mod_heimdall_qualify.h has no TABLES array')
  const listed = [...block[1].matchAll(/"(heimdall_\w+)"/g)].map((m) => m[1])
  assert.deepEqual(listed, createdTables)
})

test("diagnose's table list matches the schema", () => {
  const diagnose = read('bot/src/diagnose.js')
  const line = diagnose.match(/^const TABLES = \[(.*)\]/m)
  assert.ok(line, 'diagnose.js has no TABLES constant')
  const listed = [...line[1].matchAll(/'(\w+)'/g)].map((m) => `heimdall_${m[1]}`)
  assert.deepEqual(listed, createdTables)
})

test('every table name in the schema is bare, so the module can qualify it', () => {
  // A hard-coded database in the DDL would pin every install to that name and defeat
  // Heimdall.Database. Backquoted or dotted table references are the two ways that happens.
  assert.doesNotMatch(schemaSql, /`heimdall_/, 'backquoted table name in heimdall-schema.sql')
  assert.doesNotMatch(schemaSql, /\w\.heimdall_/, 'database-qualified table name in heimdall-schema.sql')
})
