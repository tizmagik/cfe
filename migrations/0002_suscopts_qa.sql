-- The source collection is independent of qa_entries and its semantic index.
CREATE TABLE IF NOT EXISTS suscopts_topics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_index TEXT NOT NULL,
  parent_id INTEGER REFERENCES suscopts_topics(id),
  root_id INTEGER NOT NULL REFERENCES suscopts_topics(id),
  path_ids_json TEXT NOT NULL CHECK (json_valid(path_ids_json)),
  path_names_json TEXT NOT NULL CHECK (json_valid(path_names_json)),
  question_count INTEGER NOT NULL CHECK (question_count >= 0),
  direct_question_count INTEGER NOT NULL CHECK (direct_question_count >= 0),
  source_category_json TEXT NOT NULL CHECK (json_valid(source_category_json))
);
CREATE INDEX IF NOT EXISTS suscopts_topics_parent ON suscopts_topics(parent_id, id);

CREATE TABLE IF NOT EXISTS suscopts_entries (
  qa_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_url TEXT NOT NULL,
  publisher TEXT NOT NULL,
  citation_json TEXT NOT NULL CHECK (json_valid(citation_json)),
  topic_paths_json TEXT NOT NULL CHECK (json_valid(topic_paths_json)),
  source_record_json TEXT NOT NULL CHECK (json_valid(source_record_json)),
  content_sha256 TEXT NOT NULL,
  source_html_sha256 TEXT NOT NULL,
  question_index TEXT NOT NULL,
  answer_index TEXT NOT NULL,
  topic_names_index TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suscopts_entry_topics (
  qa_id INTEGER NOT NULL REFERENCES suscopts_entries(qa_id),
  topic_id INTEGER NOT NULL REFERENCES suscopts_topics(id),
  PRIMARY KEY (qa_id, topic_id)
);
CREATE INDEX IF NOT EXISTS suscopts_entry_topics_topic ON suscopts_entry_topics(topic_id, qa_id);
CREATE TABLE IF NOT EXISTS suscopts_topic_closure (
  ancestor_id INTEGER NOT NULL REFERENCES suscopts_topics(id),
  descendant_id INTEGER NOT NULL REFERENCES suscopts_topics(id),
  depth INTEGER NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX IF NOT EXISTS suscopts_topic_closure_descendant ON suscopts_topic_closure(descendant_id, ancestor_id);

CREATE VIRTUAL TABLE IF NOT EXISTS suscopts_entries_fts USING fts5(
  question_index, answer_index, topic_names_index,
  content='suscopts_entries', content_rowid='qa_id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS suscopts_entries_ai AFTER INSERT ON suscopts_entries BEGIN
  INSERT INTO suscopts_entries_fts(rowid, question_index, answer_index, topic_names_index)
  VALUES (new.qa_id, new.question_index, new.answer_index, new.topic_names_index);
END;
CREATE TRIGGER IF NOT EXISTS suscopts_entries_ad AFTER DELETE ON suscopts_entries BEGIN
  INSERT INTO suscopts_entries_fts(suscopts_entries_fts, rowid, question_index, answer_index, topic_names_index)
  VALUES ('delete', old.qa_id, old.question_index, old.answer_index, old.topic_names_index);
END;
CREATE TRIGGER IF NOT EXISTS suscopts_entries_au AFTER UPDATE ON suscopts_entries BEGIN
  INSERT INTO suscopts_entries_fts(suscopts_entries_fts, rowid, question_index, answer_index, topic_names_index)
  VALUES ('delete', old.qa_id, old.question_index, old.answer_index, old.topic_names_index);
  INSERT INTO suscopts_entries_fts(rowid, question_index, answer_index, topic_names_index)
  VALUES (new.qa_id, new.question_index, new.answer_index, new.topic_names_index);
END;

-- A separate name index prevents phrases from spanning two different topics.
CREATE VIRTUAL TABLE IF NOT EXISTS suscopts_topics_fts USING fts5(
  name_index, content='suscopts_topics', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS suscopts_topics_ai AFTER INSERT ON suscopts_topics BEGIN
  INSERT INTO suscopts_topics_fts(rowid, name_index) VALUES (new.id, new.name_index);
END;
CREATE TRIGGER IF NOT EXISTS suscopts_topics_ad AFTER DELETE ON suscopts_topics BEGIN
  INSERT INTO suscopts_topics_fts(suscopts_topics_fts, rowid, name_index) VALUES ('delete', old.id, old.name_index);
END;
CREATE TRIGGER IF NOT EXISTS suscopts_topics_au AFTER UPDATE ON suscopts_topics BEGIN
  INSERT INTO suscopts_topics_fts(suscopts_topics_fts, rowid, name_index) VALUES ('delete', old.id, old.name_index);
  INSERT INTO suscopts_topics_fts(rowid, name_index) VALUES (new.id, new.name_index);
END;

CREATE TABLE IF NOT EXISTS suscopts_collection (
  id TEXT PRIMARY KEY CHECK (id = 'suscopts-qa'),
  source_sha256 TEXT NOT NULL,
  source_metadata_json TEXT NOT NULL CHECK (json_valid(source_metadata_json)),
  question_count INTEGER NOT NULL,
  topic_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);
