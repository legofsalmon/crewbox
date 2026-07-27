// Consistent snapshot of a live crewbox database, without the sqlite3 CLI.
//
// Usage: node --experimental-sqlite deploy/snapshot-db.mjs <src.db> <dest.db>
//
// backup.sh prefers the sqlite3 CLI and falls back to this, because a backup
// script that needs software installing first is no use on the night it
// matters. VACUUM INTO is WAL-safe on a running database, which a plain cp
// is not — that would capture the main file without the -wal alongside it
// and lose every write since the last checkpoint.
import { DatabaseSync } from 'node:sqlite'

const [src, dest] = process.argv.slice(2)
if (!src || !dest) {
  console.error('usage: snapshot-db.mjs <src.db> <dest.db>')
  process.exit(2)
}

const db = new DatabaseSync(src, { readOnly: true })
try {
  // SQLite reads a double-quoted token as an identifier, so this has to be a
  // single-quoted string literal with any embedded quote doubled.
  db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`)
} finally {
  db.close()
}
