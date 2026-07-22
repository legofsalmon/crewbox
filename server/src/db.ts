import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role       TEXT NOT NULL DEFAULT 'member',
  pin_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'public',
  topic      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- For public channels a row is just per-user read state (created lazily).
-- For DM channels the two rows also define membership.
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  seq           INTEGER NOT NULL,
  author_id     TEXT REFERENCES users(id),
  kind          TEXT NOT NULL DEFAULT 'text',
  body          TEXT NOT NULL DEFAULT '',
  client_msg_id TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (channel_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg_id
  ON messages(client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`

/**
 * Numbered migrations applied on top of the base schema, tracked with
 * PRAGMA user_version. Append only — never edit an existing entry.
 */
const MIGRATIONS: string[] = [
  // v1: files + message attachments + full-text search
  `
  CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    path       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
  ALTER TABLE messages ADD COLUMN file_id TEXT REFERENCES files(id);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body, content='messages', content_rowid='rowid'
  );
  INSERT INTO messages_fts(rowid, body) SELECT rowid, body FROM messages;
  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
  END;
  `,
  // v2: admin-retired channels
  `
  ALTER TABLE channels ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
  `,
]

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  db.exec(SCHEMA)
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as unknown as {
    user_version: number
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    db.exec(MIGRATIONS[v]!)
    db.exec(`PRAGMA user_version = ${v + 1}`)
    db.exec('COMMIT')
  }
  return db
}

/** Run fn atomically; rolls back on throw. Nested calls are flattened. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (isInTransaction(db)) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function isInTransaction(db: DatabaseSync): boolean {
  // node:sqlite exposes this on newer versions; fall back to false.
  return (db as unknown as { isTransaction?: boolean }).isTransaction ?? false
}
