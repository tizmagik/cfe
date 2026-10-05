CREATE TABLE qa_entries (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX qa_published ON qa_entries(published);
