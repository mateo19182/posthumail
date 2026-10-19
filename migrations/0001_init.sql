CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chats (person_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL UNIQUE, linked_at INTEGER NOT NULL);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  recipients TEXT NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL
);
CREATE TABLE deliveries (
  message_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (message_id, person_id, channel)
);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT);
