#pragma once

#include <condition_variable>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "embedder.hpp"
#include "note_store.hpp"

namespace hnswlib {
template <typename T>
class HierarchicalNSW;
class InnerProductSpace;
}  // namespace hnswlib

// Keeps an HNSW vector index of all notes in sync with the database and
// derives "semantic" graph edges between notes with similar content.
// Embedding runs on a background thread, debounced so that autosave while
// typing does not re-embed on every keystroke.
class SemanticIndex {
 public:
  using Scored = std::vector<std::pair<int64_t, float>>;

  // `embedder` may be null: the index is then disabled and all queries are empty.
  SemanticIndex(NoteStore& store, std::unique_ptr<Embedder> embedder);
  ~SemanticIndex();

  void note_changed(int64_t id);
  void note_removed(int64_t id);

  Scored similar(int64_t id, size_t k);
  Scored search(const std::string& query, size_t k);

  bool enabled() const { return embedder_ != nullptr; }
  std::string model() const { return embedder_ ? embedder_->name() : ""; }
  size_t indexed();
  size_t pending();

 private:
  void worker();
  void process(int64_t id);
  void index_put(int64_t id, const std::vector<float>& v);
  Scored knn(const std::vector<float>& v, size_t k, int64_t exclude);

  NoteStore& store_;
  std::unique_ptr<Embedder> embedder_;
  std::mutex embed_mu_;  // Embedder is not re-entrant

  std::mutex index_mu_;
  std::unique_ptr<hnswlib::InnerProductSpace> space_;
  std::unique_ptr<hnswlib::HierarchicalNSW<float>> hnsw_;
  std::unordered_map<int64_t, std::vector<float>> vectors_;
  size_t capacity_ = 0;

  std::mutex queue_mu_;
  std::condition_variable queue_cv_;
  std::map<int64_t, int64_t> queue_;  // note id -> earliest processing time (ms)
  bool stop_ = false;
  std::thread thread_;
};
