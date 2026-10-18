#include "note_store.hpp"

#include <chrono>
#include <sstream>

#include "wikilinks.hpp"

namespace {

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

// Turns free user input into a safe FTS5 query: every token is quoted and
// prefix-matched, so "vect dat" finds "vector database".
std::string to_fts_query(const std::string& input) {
  std::istringstream in(input);
  std::string tok, out;
  while (in >> tok) {
    std::string esc;
    for (char c : tok) {
      if (c == '"') esc += "\"\"";
      else esc += c;
    }
    if (!out.empty()) out += ' ';
    out += '"' + esc + "\"*";
  }
  return out;
}

struct Tx {
  explicit Tx(Db& db) : db(db) { db.exec("BEGIN"); }
  ~Tx() {
    if (!done) db.exec("ROLLBACK");
  }
  void commit() {
    db.exec("COMMIT");
    done = true;
  }
  Db& db;
  bool done = false;
};

}  // namespace

NoteStore::NoteStore(const std::string& db_path) : db_(db_path) { migrate(); }

void NoteStore::migrate() {
  db_.exec(R"sql(
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_title ON notes(title COLLATE NOCASE);

    -- Outgoing [[wikilinks]] by target title, resolved at query time so a
    -- link starts working as soon as the target note is created.
    CREATE TABLE IF NOT EXISTS wikilinks (
      source_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_title TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (source_id, target_title)
    );
    CREATE INDEX IF NOT EXISTS wikilinks_target ON wikilinks(target_title);

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, content, content='notes', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
  )sql");
}

std::vector<NoteSummary> NoteStore::list() {
  std::lock_guard lock(mu_);
  Stmt s(db_, "SELECT id, title, updated_at FROM notes ORDER BY updated_at DESC");
  std::vector<NoteSummary> out;
  while (s.step()) out.push_back({s.col_int(0), s.col_text(1), s.col_int(2)});
  return out;
}

std::optional<Note> NoteStore::get_locked(int64_t id) {
  Stmt s(db_, "SELECT id, title, content, created_at, updated_at FROM notes WHERE id = ?");
  s.bind(1, id);
  if (!s.step()) return std::nullopt;
  return Note{s.col_int(0), s.col_text(1), s.col_text(2), s.col_int(3), s.col_int(4)};
}

std::optional<Note> NoteStore::get(int64_t id) {
  std::lock_guard lock(mu_);
  return get_locked(id);
}

void NoteStore::reindex_links(int64_t id, const std::string& content) {
  Stmt(db_, "DELETE FROM wikilinks WHERE source_id = ?").bind(1, id).run();
  Stmt ins(db_, "INSERT OR IGNORE INTO wikilinks(source_id, target_title) VALUES (?, ?)");
  for (const auto& target : extract_wikilinks(content)) {
    ins.bind(1, id).bind(2, target).run();
    ins.reset();
  }
}

Note NoteStore::create(const std::string& title, const std::string& content) {
  std::lock_guard lock(mu_);
  Tx tx(db_);
  int64_t t = now_ms();
  Stmt(db_, "INSERT INTO notes(title, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(1, title).bind(2, content).bind(3, t).bind(4, t).run();
  int64_t id = db_.last_insert_id();
  reindex_links(id, content);
  tx.commit();
  return Note{id, title, content, t, t};
}

std::optional<Note> NoteStore::update(int64_t id, const std::string& title, const std::string& content) {
  std::lock_guard lock(mu_);
  Tx tx(db_);
  Stmt(db_, "UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?")
      .bind(1, title).bind(2, content).bind(3, now_ms()).bind(4, id).run();
  if (sqlite3_changes(db_.handle()) == 0) return std::nullopt;
  reindex_links(id, content);
  tx.commit();
  return get_locked(id);
}

bool NoteStore::remove(int64_t id) {
  std::lock_guard lock(mu_);
  Stmt(db_, "DELETE FROM notes WHERE id = ?").bind(1, id).run();
  return sqlite3_changes(db_.handle()) > 0;
}

std::vector<SearchHit> NoteStore::search(const std::string& query, int limit) {
  std::string fts = to_fts_query(query);
  if (fts.empty()) return {};
  std::lock_guard lock(mu_);
  Stmt s(db_, R"sql(
    SELECT rowid, title, snippet(notes_fts, 1, '<b>', '</b>', '…', 12)
    FROM notes_fts WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 5.0, 1.0) LIMIT ?
  )sql");
  s.bind(1, fts).bind(2, static_cast<int64_t>(limit));
  std::vector<SearchHit> out;
  while (s.step()) out.push_back({s.col_int(0), s.col_text(1), s.col_text(2)});
  return out;
}

std::vector<NoteSummary> NoteStore::backlinks(int64_t id) {
  std::lock_guard lock(mu_);
  Stmt s(db_, R"sql(
    SELECT DISTINCT n.id, n.title, n.updated_at
    FROM notes target
    JOIN wikilinks w ON w.target_title = target.title COLLATE NOCASE
    JOIN notes n ON n.id = w.source_id
    WHERE target.id = ? AND n.id != target.id
    ORDER BY n.updated_at DESC
  )sql");
  s.bind(1, id);
  std::vector<NoteSummary> out;
  while (s.step()) out.push_back({s.col_int(0), s.col_text(1), s.col_int(2)});
  return out;
}

Graph NoteStore::graph() {
  std::lock_guard lock(mu_);
  Graph g;
  {
    Stmt s(db_, "SELECT id, title, updated_at FROM notes");
    while (s.step()) g.nodes.push_back({s.col_int(0), s.col_text(1), s.col_int(2)});
  }
  // If several notes share a title, links resolve to the oldest one.
  Stmt s(db_, R"sql(
    SELECT w.source_id, MIN(n.id)
    FROM wikilinks w JOIN notes n ON n.title = w.target_title COLLATE NOCASE
    GROUP BY w.source_id, w.target_title
  )sql");
  while (s.step()) {
    int64_t src = s.col_int(0), dst = s.col_int(1);
    if (src != dst) g.edges.push_back({src, dst, "link", 1.0});
  }
  return g;
}
