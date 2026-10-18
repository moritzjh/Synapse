#include "note_store.hpp"

#include <chrono>
#include <cstring>
#include <ctime>
#include <map>
#include <set>
#include <sstream>

#include "content.hpp"
#include "wikilinks.hpp"

using json = nlohmann::json;

namespace {

constexpr int kSchemaVersion = 2;

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

int64_t local_day_start(int64_t ms) {
  std::time_t t = ms / 1000;
  std::tm tm{};
  localtime_r(&t, &tm);
  tm.tm_hour = tm.tm_min = tm.tm_sec = 0;
  return static_cast<int64_t>(std::mktime(&tm)) * 1000;
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

constexpr const char* kCardColumns = R"sql(
  c.id, c.note_id, n.title, c.kind, c.front, c.data,
  c.state, c.stability, c.difficulty, c.due, c.last_review, c.reps, c.lapses
)sql";

}  // namespace

NoteStore::NoteStore(const std::string& db_path) : db_(db_path) { migrate(); }

void NoteStore::migrate() {
  int version = 0;
  {
    Stmt s(db_, "PRAGMA user_version");
    if (s.step()) version = static_cast<int>(s.col_int(0));
  }
  if (version >= kSchemaVersion) return;

  Tx tx(db_);
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
  )sql");

  // v1 indexed the raw content; v2 stores rich JSON and indexes its plain text.
  bool has_text = false;
  {
    Stmt s(db_, "SELECT 1 FROM pragma_table_info('notes') WHERE name = 'text'");
    has_text = s.step();
  }
  if (!has_text) db_.exec("ALTER TABLE notes ADD COLUMN text TEXT NOT NULL DEFAULT ''");

  db_.exec(R"sql(
    DROP TRIGGER IF EXISTS notes_ai;
    DROP TRIGGER IF EXISTS notes_ad;
    DROP TRIGGER IF EXISTS notes_au;
    DROP TABLE IF EXISTS notes_fts;
    CREATE VIRTUAL TABLE notes_fts USING fts5(
      title, text, content='notes', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
    END;
    CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
    END;
    CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
      INSERT INTO notes_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
    END;

    CREATE TABLE IF NOT EXISTS embeddings (
      note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      model   TEXT NOT NULL,
      version INTEGER NOT NULL,
      vec     BLOB NOT NULL
    );

    -- Undirected similarity edges, stored once with a < b.
    CREATE TABLE IF NOT EXISTS semantic_links (
      a     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      b     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      PRIMARY KEY (a, b)
    );
    CREATE INDEX IF NOT EXISTS semantic_links_b ON semantic_links(b);

    CREATE TABLE IF NOT EXISTS cards (
      id          INTEGER PRIMARY KEY,
      note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      kind        TEXT NOT NULL,
      front       TEXT NOT NULL,
      data        TEXT NOT NULL,
      position    INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      state       INTEGER NOT NULL DEFAULT 0,
      stability   REAL NOT NULL DEFAULT 0,
      difficulty  REAL NOT NULL DEFAULT 0,
      due         INTEGER NOT NULL DEFAULT 0,
      last_review INTEGER NOT NULL DEFAULT 0,
      reps        INTEGER NOT NULL DEFAULT 0,
      lapses      INTEGER NOT NULL DEFAULT 0,
      UNIQUE (note_id, key)
    );
    CREATE INDEX IF NOT EXISTS cards_due ON cards(state, due);

    CREATE TABLE IF NOT EXISTS review_log (
      id           INTEGER PRIMARY KEY,
      card_id      INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      ts           INTEGER NOT NULL,
      rating       INTEGER NOT NULL,
      state_before INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_log_ts ON review_log(ts);
  )sql");

  // Re-derive text, links and cards for notes written by older versions.
  std::vector<std::pair<int64_t, std::string>> existing;
  {
    Stmt s(db_, "SELECT id, content FROM notes");
    while (s.step()) existing.emplace_back(s.col_int(0), s.col_text(1));
  }
  for (const auto& [id, content] : existing) index_note(id, content);

  db_.exec(("PRAGMA user_version = " + std::to_string(kSchemaVersion)).c_str());
  tx.commit();
}

// Derives everything that depends on note content: plain text (FTS),
// wikilinks and flashcards. Caller holds the lock and a transaction.
void NoteStore::index_note(int64_t id, const std::string& content) {
  json doc = parse_content(content);
  std::string text = plain_text(doc);
  Stmt(db_, "UPDATE notes SET text = ? WHERE id = ?").bind(1, text).bind(2, id).run();

  Stmt(db_, "DELETE FROM wikilinks WHERE source_id = ?").bind(1, id).run();
  Stmt ins(db_, "INSERT OR IGNORE INTO wikilinks(source_id, target_title) VALUES (?, ?)");
  for (const auto& target : extract_wikilinks(text)) {
    ins.bind(1, id).bind(2, target).run();
    ins.reset();
  }

  // Cards keep their review history as long as their key (kind + front) stays.
  std::map<std::string, int64_t> old;
  {
    Stmt s(db_, "SELECT key, id FROM cards WHERE note_id = ?");
    s.bind(1, id);
    while (s.step()) old[s.col_text(0)] = s.col_int(1);
  }
  int64_t t = now_ms();
  Stmt upd(db_, "UPDATE cards SET kind = ?, front = ?, data = ?, position = ? WHERE id = ?");
  Stmt add(db_, R"sql(
    INSERT OR IGNORE INTO cards(note_id, key, kind, front, data, position, created_at, due)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  )sql");
  int64_t pos = 0;
  for (const auto& c : extract_cards(doc)) {
    std::string data = c.data.dump();
    if (auto it = old.find(c.key); it != old.end()) {
      upd.bind(1, c.kind).bind(2, c.front).bind(3, data).bind(4, pos).bind(5, it->second).run();
      upd.reset();
      old.erase(it);
    } else {
      add.bind(1, id).bind(2, c.key).bind(3, c.kind).bind(4, c.front).bind(5, data).bind(6, pos).bind(7, t).bind(8, t)
          .run();
      add.reset();
    }
    ++pos;
  }
  Stmt del(db_, "DELETE FROM cards WHERE id = ?");
  for (const auto& [_, card_id] : old) {
    del.bind(1, card_id).run();
    del.reset();
  }
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

Note NoteStore::create(const std::string& title, const std::string& content) {
  std::lock_guard lock(mu_);
  Tx tx(db_);
  int64_t t = now_ms();
  Stmt(db_, "INSERT INTO notes(title, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(1, title).bind(2, content).bind(3, t).bind(4, t).run();
  int64_t id = db_.last_insert_id();
  index_note(id, content);
  tx.commit();
  return Note{id, title, content, t, t};
}

std::optional<Note> NoteStore::update(int64_t id, const std::string& title, const std::string& content) {
  std::lock_guard lock(mu_);
  Tx tx(db_);
  Stmt(db_, "UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?")
      .bind(1, title).bind(2, content).bind(3, now_ms()).bind(4, id).run();
  if (sqlite3_changes(db_.handle()) == 0) return std::nullopt;
  index_note(id, content);
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
  std::set<std::pair<int64_t, int64_t>> linked;
  {
    // If several notes share a title, links resolve to the oldest one.
    Stmt s(db_, R"sql(
      SELECT w.source_id, MIN(n.id)
      FROM wikilinks w JOIN notes n ON n.title = w.target_title COLLATE NOCASE
      GROUP BY w.source_id, w.target_title
    )sql");
    while (s.step()) {
      int64_t src = s.col_int(0), dst = s.col_int(1);
      if (src == dst) continue;
      g.edges.push_back({src, dst, "link", 1.0});
      linked.insert({std::min(src, dst), std::max(src, dst)});
    }
  }
  // Semantic edges are only shown where no explicit link exists.
  Stmt s(db_, "SELECT a, b, score FROM semantic_links");
  while (s.step()) {
    int64_t a = s.col_int(0), b = s.col_int(1);
    if (!linked.count({a, b})) g.edges.push_back({a, b, "semantic", s.col_double(2)});
  }
  return g;
}

// ---- flashcards -------------------------------------------------------------

std::vector<Card> NoteStore::query_cards(Stmt& s) {
  std::vector<Card> out;
  while (s.step()) {
    Card c{s.col_int(0), s.col_int(1), s.col_text(2), s.col_text(3), s.col_text(4),
           json::parse(s.col_text(5), nullptr, false), {}};
    c.sched.state = static_cast<fsrs::State>(s.col_int(6));
    c.sched.stability = s.col_double(7);
    c.sched.difficulty = s.col_double(8);
    c.sched.due = s.col_int(9);
    c.sched.last_review = s.col_int(10);
    c.sched.reps = static_cast<int>(s.col_int(11));
    c.sched.lapses = static_cast<int>(s.col_int(12));
    out.push_back(std::move(c));
  }
  return out;
}

std::vector<Card> NoteStore::note_cards(int64_t note_id) {
  std::lock_guard lock(mu_);
  Stmt s(db_, (std::string("SELECT ") + kCardColumns +
               " FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.note_id = ? ORDER BY c.position")
                  .c_str());
  s.bind(1, note_id);
  return query_cards(s);
}

std::optional<Card> NoteStore::card(int64_t id) {
  std::lock_guard lock(mu_);
  Stmt s(db_, (std::string("SELECT ") + kCardColumns + " FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?")
                  .c_str());
  s.bind(1, id);
  auto cards = query_cards(s);
  if (cards.empty()) return std::nullopt;
  return cards.front();
}

int NoteStore::new_introduced_today(int64_t now) {
  Stmt s(db_, "SELECT COUNT(DISTINCT card_id) FROM review_log WHERE state_before = 0 AND ts >= ?");
  s.bind(1, local_day_start(now));
  s.step();
  return static_cast<int>(s.col_int(0));
}

std::vector<Card> NoteStore::review_queue(int64_t now, int new_per_day, int limit) {
  std::lock_guard lock(mu_);
  std::vector<Card> out;
  {
    Stmt s(db_, (std::string("SELECT ") + kCardColumns +
                 " FROM cards c JOIN notes n ON n.id = c.note_id"
                 " WHERE c.state != 0 AND c.due <= ? ORDER BY c.due LIMIT ?")
                    .c_str());
    s.bind(1, now).bind(2, static_cast<int64_t>(limit));
    out = query_cards(s);
  }
  int new_left = std::max(0, new_per_day - new_introduced_today(now));
  int room = std::min<int>(new_left, limit - static_cast<int>(out.size()));
  if (room > 0) {
    Stmt s(db_, (std::string("SELECT ") + kCardColumns +
                 " FROM cards c JOIN notes n ON n.id = c.note_id"
                 " WHERE c.state = 0 ORDER BY c.created_at, c.note_id, c.position LIMIT ?")
                    .c_str());
    s.bind(1, static_cast<int64_t>(room));
    for (auto& c : query_cards(s)) out.push_back(std::move(c));
  }
  return out;
}

std::optional<Card> NoteStore::review_card(int64_t id, fsrs::Rating rating, int64_t now) {
  auto c = card(id);
  if (!c) return std::nullopt;
  fsrs::CardState next = fsrs::review(c->sched, rating, now);

  std::lock_guard lock(mu_);
  Tx tx(db_);
  Stmt(db_, R"sql(
    UPDATE cards SET state = ?, stability = ?, difficulty = ?, due = ?, last_review = ?, reps = ?, lapses = ?
    WHERE id = ?
  )sql")
      .bind(1, static_cast<int64_t>(next.state)).bind(2, next.stability).bind(3, next.difficulty)
      .bind(4, next.due).bind(5, next.last_review).bind(6, static_cast<int64_t>(next.reps))
      .bind(7, static_cast<int64_t>(next.lapses)).bind(8, id).run();
  Stmt(db_, "INSERT INTO review_log(card_id, ts, rating, state_before) VALUES (?, ?, ?, ?)")
      .bind(1, id).bind(2, now).bind(3, static_cast<int64_t>(rating))
      .bind(4, static_cast<int64_t>(c->sched.state)).run();
  tx.commit();
  c->sched = next;
  return c;
}

ReviewStats NoteStore::review_stats(int64_t now, int new_per_day) {
  std::lock_guard lock(mu_);
  ReviewStats st;
  {
    Stmt s(db_, R"sql(
      SELECT COUNT(*), SUM(state != 0 AND due <= ?), SUM(state = 0) FROM cards
    )sql");
    s.bind(1, now);
    s.step();
    st.total = static_cast<int>(s.col_int(0));
    st.due = static_cast<int>(s.col_int(1));
    int fresh = static_cast<int>(s.col_int(2));
    st.new_available = std::min(fresh, std::max(0, new_per_day - new_introduced_today(now)));
  }
  Stmt s(db_, "SELECT COUNT(*) FROM review_log WHERE ts >= ?");
  s.bind(1, local_day_start(now));
  s.step();
  st.reviewed_today = static_cast<int>(s.col_int(0));
  return st;
}

// ---- embeddings ---------------------------------------------------------------

std::vector<int64_t> NoteStore::stale_embeddings(const std::string& model) {
  std::lock_guard lock(mu_);
  Stmt s(db_, R"sql(
    SELECT n.id FROM notes n LEFT JOIN embeddings e ON e.note_id = n.id
    WHERE e.note_id IS NULL OR e.model != ? OR e.version != n.updated_at
  )sql");
  s.bind(1, model);
  std::vector<int64_t> out;
  while (s.step()) out.push_back(s.col_int(0));
  return out;
}

std::optional<EmbedJob> NoteStore::embed_job(int64_t id) {
  std::lock_guard lock(mu_);
  Stmt s(db_, "SELECT updated_at, title, text FROM notes WHERE id = ?");
  s.bind(1, id);
  if (!s.step()) return std::nullopt;
  return EmbedJob{id, s.col_int(0), s.col_text(1) + "\n" + s.col_text(2)};
}

bool NoteStore::save_embedding(int64_t id, const std::string& model, int64_t version, const std::vector<float>& vec) {
  std::lock_guard lock(mu_);
  {
    Stmt s(db_, "SELECT updated_at FROM notes WHERE id = ?");
    s.bind(1, id);
    if (!s.step() || s.col_int(0) != version) return false;
  }
  Stmt s(db_, "INSERT OR REPLACE INTO embeddings(note_id, model, version, vec) VALUES (?, ?, ?, ?)");
  s.bind(1, id).bind(2, model).bind(3, version).bind_blob(4, vec.data(), vec.size() * sizeof(float)).run();
  return true;
}

std::vector<std::pair<int64_t, std::vector<float>>> NoteStore::load_embeddings(const std::string& model) {
  std::lock_guard lock(mu_);
  Stmt s(db_, "SELECT note_id, vec FROM embeddings WHERE model = ?");
  s.bind(1, model);
  std::vector<std::pair<int64_t, std::vector<float>>> out;
  while (s.step()) {
    std::string blob = s.col_blob(1);
    std::vector<float> v(blob.size() / sizeof(float));
    std::memcpy(v.data(), blob.data(), v.size() * sizeof(float));
    out.emplace_back(s.col_int(0), std::move(v));
  }
  return out;
}

void NoteStore::set_semantic_links(int64_t id, const std::vector<std::pair<int64_t, float>>& neighbors) {
  std::lock_guard lock(mu_);
  Tx tx(db_);
  Stmt(db_, "DELETE FROM semantic_links WHERE a = ? OR b = ?").bind(1, id).bind(2, id).run();
  Stmt ins(db_, "INSERT OR REPLACE INTO semantic_links(a, b, score) VALUES (?, ?, ?)");
  for (const auto& [other, score] : neighbors) {
    if (other == id) continue;
    ins.bind(1, std::min(id, other)).bind(2, std::max(id, other)).bind(3, static_cast<double>(score)).run();
    ins.reset();
  }
  tx.commit();
}

std::vector<Neighbor> NoteStore::titles_for(const std::vector<std::pair<int64_t, float>>& scored) {
  std::lock_guard lock(mu_);
  std::vector<Neighbor> out;
  Stmt s(db_, "SELECT title FROM notes WHERE id = ?");
  for (const auto& [id, score] : scored) {
    s.bind(1, id);
    if (s.step()) out.push_back({id, s.col_text(0), score});
    s.reset();
  }
  return out;
}
