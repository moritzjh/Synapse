#pragma once

#include <cstdint>
#include <json.hpp>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "db.hpp"
#include "fsrs.hpp"

struct Note {
  int64_t id = 0;
  std::string title;
  std::string content;  // TipTap JSON document
  int64_t created_at = 0;
  int64_t updated_at = 0;
};

struct NoteSummary {
  int64_t id;
  std::string title;
  int64_t updated_at;
};

struct SearchHit {
  int64_t id;
  std::string title;
  std::string snippet;
};

struct GraphEdge {
  int64_t source;
  int64_t target;
  std::string kind;  // "link" for [[wikilinks]], "semantic" for similar content
  double weight;
};

struct Graph {
  std::vector<NoteSummary> nodes;
  std::vector<GraphEdge> edges;
};

struct Card {
  int64_t id;
  int64_t note_id;
  std::string note_title;
  std::string kind;
  std::string front;
  nlohmann::json data;
  fsrs::CardState sched;
  int64_t exam_date = 0;  // nearest upcoming exam covering the note (0 = none)
};

struct Exam {
  int64_t id;
  std::string name;
  int64_t date;  // unix ms
  std::vector<int64_t> note_ids;
};

struct ExamProgress {
  int cards = 0;
  int new_cards = 0;
  int due = 0;
  int mastered = 0;  // cards with >= 90% predicted recall on exam day
  int new_today = 0; // new cards to learn today to be done in time
  double predicted_retention = 0;
};

struct ReviewStats {
  int due = 0;           // learning + review cards due now
  int new_available = 0; // new cards that may still be introduced today
  int total = 0;
  int reviewed_today = 0;
};

struct EmbedJob {
  int64_t id;
  int64_t version;  // note.updated_at at the time the text was read
  std::string text;
};

struct VaultEntry {
  int64_t note_id;
  std::string path;  // relative to the vault root
  std::string hash;
  int64_t mtime;
};

struct Neighbor {
  int64_t id;
  std::string title;
  float score;
};

// All persistence (notes, links, cards, embeddings). Thread-safe.
class NoteStore {
 public:
  explicit NoteStore(const std::string& db_path);

  // --- notes ---
  std::vector<NoteSummary> list();
  std::optional<Note> get(int64_t id);
  Note create(const std::string& title, const std::string& content);
  std::optional<Note> update(int64_t id, const std::string& title, const std::string& content);
  bool remove(int64_t id);

  std::vector<SearchHit> search(const std::string& query, int limit);
  std::vector<NoteSummary> backlinks(int64_t id);
  Graph graph();

  // --- flashcards ---
  std::vector<Card> note_cards(int64_t note_id);
  // exam_id != 0 restricts to the cards of that exam.
  std::vector<Card> review_queue(int64_t now_ms, int new_per_day, int limit, int64_t exam_id = 0);
  std::optional<Card> card(int64_t id);
  std::optional<Card> review_card(int64_t id, fsrs::Rating rating, int64_t now_ms);
  ReviewStats review_stats(int64_t now_ms, int new_per_day, int64_t exam_id = 0);

  // --- exams ---
  std::vector<Exam> list_exams();
  std::optional<Exam> exam(int64_t id);
  Exam create_exam(const std::string& name, int64_t date, const std::vector<int64_t>& note_ids);
  std::optional<Exam> update_exam(int64_t id, const std::string& name, int64_t date, const std::vector<int64_t>& note_ids);
  bool delete_exam(int64_t id);
  ExamProgress exam_progress(const Exam& e, int64_t now_ms);

  // --- markdown vault bookkeeping ---
  std::vector<VaultEntry> vault_entries();
  void set_vault_entry(const VaultEntry& e);

  // --- embeddings / semantic links ---
  std::vector<int64_t> stale_embeddings(const std::string& model);
  std::optional<EmbedJob> embed_job(int64_t id);
  // Stores the vector only if the note is still at `version`; returns false otherwise.
  bool save_embedding(int64_t id, const std::string& model, int64_t version, const std::vector<float>& vec);
  std::vector<std::pair<int64_t, std::vector<float>>> load_embeddings(const std::string& model);
  void set_semantic_links(int64_t id, const std::vector<std::pair<int64_t, float>>& neighbors);
  std::vector<Neighbor> titles_for(const std::vector<std::pair<int64_t, float>>& scored);

 private:
  void migrate();
  void migrate_v2();
  void index_note(int64_t id, const std::string& content);
  std::optional<Note> get_locked(int64_t id);
  int new_introduced_today(int64_t now_ms, int64_t exam_id);
  int exam_new_quota(int64_t now_ms, int64_t exam_id, int64_t exam_date);
  int new_limit(int64_t now_ms, int new_per_day, int64_t exam_id);
  void set_exam_notes(int64_t exam_id, const std::vector<int64_t>& note_ids);
  std::optional<Exam> exam_locked(int64_t id);
  std::vector<Card> query_cards(Stmt& s);

  std::mutex mu_;
  Db db_;
};
