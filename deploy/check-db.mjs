// Is this file a readable crewbox database, or half of one?
//
// Usage: node --experimental-sqlite deploy/check-db.mjs <db>
// Exits 0 and prints the schema version when the database is sound; exits 1
// and says what is wrong when it is not.
//
// restore.sh runs this before it moves a live data directory aside. A backup
// truncated by a pulled USB stick opens perfectly happily — SQLite only
// notices when it reads the page that is missing — so "the file is there" is
// not the same question as "this restores". `PRAGMA integrity_check` reads
// every page and every index, which is the only answer worth having at the
// moment somebody is standing over a dead box with a spare.
import { DatabaseSync } from 'node:sqlite'

const [path] = process.argv.slice(2)
if (!path) {
  console.error('usage: check-db.mjs <db>')
  process.exit(2)
}

let db
try {
  db = new DatabaseSync(path, { readOnly: true })
} catch (err) {
  console.error(`cannot open ${path}: ${err.message}`)
  process.exit(1)
}

try {
  // Returns exactly one row reading 'ok' on a sound database, and up to a
  // hundred rows naming the damage on a broken one.
  const rows = db.prepare('PRAGMA integrity_check').all()
  const problems = rows.map((r) => Object.values(r)[0]).filter((v) => v !== 'ok')
  if (problems.length > 0) {
    console.error(`${path} is damaged:`)
    for (const p of problems.slice(0, 10)) console.error(`  ${p}`)
    if (problems.length > 10) console.error(`  …and ${problems.length - 10} more`)
    process.exit(1)
  }
  // A crewbox database has these; an unrelated SQLite file does not, and
  // restoring one would leave a box that starts and knows nobody.
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
  )
  const missing = ['users', 'channels', 'messages'].filter((t) => !tables.has(t))
  if (missing.length > 0) {
    console.error(`${path} is a database, but not a crewbox one: no ${missing.join(', ')} table`)
    process.exit(1)
  }
  const version = db.prepare('PRAGMA user_version').get()
  console.log(`ok (schema v${Object.values(version ?? {})[0] ?? '?'})`)
} finally {
  db.close()
}
