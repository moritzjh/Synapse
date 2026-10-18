#pragma once

#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "db.hpp"

struct Note {
  int64_t id = 0;
  std::string title;
  std::string content;
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
  std::string kind;  // "link" for [[wikilinks]]; "semantic" comes in step 2
  double weight;
};

struct Graph {
  std::vector<NoteSummary> nodes;
  std::vector<GraphEdge> edges;
};

// All persistence for notes and links. Every public method is thread-safe.
class NoteStore {
 public:
  explicit NoteStore(const std::string& db_path);

  std::vector<NoteSummary> list();
  std::optional<Note> get(int64_t id);
  Note create(const std::string& title, const std::string& content);
  std::optional<Note> update(int64_t id, const std::string& title, const std::string& content);
  bool remove(int64_t id);

  std::vector<SearchHit> search(const std::string& query, int limit);
  std::vector<NoteSummary> backlinks(int64_t id);
  Graph graph();

 private:
  void migrate();
  void reindex_links(int64_t id, const std::string& content);
  std::optional<Note> get_locked(int64_t id);

  std::mutex mu_;
  Db db_;
};
