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
  // v3: drop deleted messages from the search index. Without this, orphaned
  // FTS rows can match a later message that reuses the rowid.
  `
  CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
  `,
  // v4: runtime key/value settings (admin-editable config without a redeploy).
  `
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v5: deletion log, replayed on welcome so offline clients drop stale
  // cache entries for messages removed while they were away.
  `
  CREATE TABLE IF NOT EXISTS deleted_messages (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deleted_messages_at ON deleted_messages(deleted_at);
  `,
  // v6: image dimensions + client-generated thumbnail, so the message list
  // can reserve layout before pixels arrive and render small previews.
  `
  ALTER TABLE files ADD COLUMN width INTEGER;
  ALTER TABLE files ADD COLUMN height INTEGER;
  ALTER TABLE files ADD COLUMN thumb_path TEXT;
  `,
  // v7: network-audit history — minute rollups, discrete events, probe runs.
  // Bounded by the collector (key caps, event throttling, 7-day prune), so
  // a five-day festival's audit trail survives restarts and power cuts
  // without the database growing past tens of megabytes.
  `
  CREATE TABLE IF NOT EXISTS audit_metrics (
    ts     INTEGER NOT NULL,
    metric TEXT    NOT NULL,
    key    TEXT    NOT NULL DEFAULT '',
    min    REAL    NOT NULL,
    avg    REAL    NOT NULL,
    max    REAL    NOT NULL,
    count  INTEGER NOT NULL,
    PRIMARY KEY (metric, key, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_metrics_ts ON audit_metrics(ts);

  CREATE TABLE IF NOT EXISTS audit_events (
    id      TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    network TEXT NOT NULL,
    kind    TEXT NOT NULL,
    key     TEXT NOT NULL DEFAULT '',
    detail  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events(at);

  CREATE TABLE IF NOT EXISTS audit_probe_runs (
    id          TEXT PRIMARY KEY,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    by_name     TEXT NOT NULL,
    report      TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_probe_runs_started
    ON audit_probe_runs(started_at);
  `,
  // v8: the show log — one append-only stream for the whole box.
  //
  // Not per-channel like messages: there is one show, and an entry filed by
  // lighting is part of the same night as one filed by stage management.
  // `seq` is unique across the table for that reason.
  //
  // author_name is stored beside author_id on purpose. The id is the link
  // while the account exists; the name is what the log says next year, after
  // a rename or a departure. Both are cleared together when somebody deletes
  // their account, which keeps the record and drops the person.
  //
  // No entry's content is ever UPDATEd: a correction is a new row whose
  // `amends` names the row it corrects. The only write after INSERT is the
  // one above — clearing author_id and author_name when somebody deletes
  // their account (see Store.deleteUser) — which changes who filed an entry
  // and never what it says. `at` and `logged_at` are separate because the
  // show does not wait for anyone to get their phone out.
  `
  CREATE TABLE IF NOT EXISTS incidents (
    id            TEXT PRIMARY KEY,
    seq           INTEGER NOT NULL UNIQUE,
    author_id     TEXT REFERENCES users(id),
    author_name   TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'note',
    severity      TEXT NOT NULL DEFAULT 'note',
    body          TEXT NOT NULL DEFAULT '',
    at            INTEGER NOT NULL,
    logged_at     INTEGER NOT NULL,
    stage         TEXT NOT NULL DEFAULT '',
    act_id        TEXT NOT NULL DEFAULT '',
    act_name      TEXT NOT NULL DEFAULT '',
    amends        TEXT,
    client_msg_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_client_msg_id
    ON incidents(client_msg_id) WHERE client_msg_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_incidents_at ON incidents(at);
  `,
  // v9: a channel's sequence numbers become a high-water mark.
  //
  // They were `MAX(seq) + 1`, which reuses a number the moment the newest
  // message is deleted — and deleting a message someone shared by mistake is
  // a supported thing to do. A phone holding seq 42 in its cache then asks
  // for everything after 42; the replacement message *is* 42, so the server
  // has nothing after it, and that message never arrives on that phone
  // again. Silent, permanent, and invisible from the box.
  //
  // Backfilled from what each channel already has, so an existing box
  // carries on from where it was rather than starting again at 1.
  `
  ALTER TABLE channels ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
  UPDATE channels SET last_seq = (
    SELECT COALESCE(MAX(seq), 0) FROM messages WHERE messages.channel_id = channels.id
  );
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
