#include "semantic_index.hpp"

#include <hnswlib/hnswlib.h>

#include <chrono>
#include <iostream>

namespace {

constexpr int64_t kDebounceMs = 1500;
constexpr size_t kLinksPerNote = 6;
constexpr size_t kInitialCapacity = 1024;

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

}  // namespace

SemanticIndex::SemanticIndex(NoteStore& store, std::unique_ptr<Embedder> embedder)
    : store_(store), embedder_(std::move(embedder)) {
  if (!embedder_) return;

  size_t dim = embedder_->dim();
  if (dim == 0) dim = embedder_->embed("init").size();
  space_ = std::make_unique<hnswlib::InnerProductSpace>(dim);

  auto stored = store_.load_embeddings(embedder_->name());
  capacity_ = std::max(kInitialCapacity, stored.size() * 2);
  hnsw_ = std::make_unique<hnswlib::HierarchicalNSW<float>>(space_.get(), capacity_, 16, 200);
  hnsw_->setEf(64);
  for (auto& [id, v] : stored)
    if (v.size() == dim) index_put(id, v);

  int64_t t = now_ms();
  for (int64_t id : store_.stale_embeddings(embedder_->name())) queue_[id] = t;
  std::cout << "semantic index: model " << embedder_->name() << ", dim " << dim << ", " << vectors_.size()
            << " notes loaded, " << queue_.size() << " to embed\n";
  thread_ = std::thread([this] { worker(); });
}

SemanticIndex::~SemanticIndex() {
  {
    std::lock_guard lock(queue_mu_);
    stop_ = true;
  }
  queue_cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void SemanticIndex::note_changed(int64_t id) {
  if (!embedder_) return;
  {
    std::lock_guard lock(queue_mu_);
    queue_[id] = now_ms() + kDebounceMs;
  }
  queue_cv_.notify_all();
}

void SemanticIndex::note_removed(int64_t id) {
  if (!embedder_) return;
  {
    std::lock_guard lock(queue_mu_);
    queue_.erase(id);
  }
  std::lock_guard lock(index_mu_);
  if (vectors_.erase(id)) hnsw_->markDelete(static_cast<hnswlib::labeltype>(id));
}

void SemanticIndex::worker() {
  std::unique_lock lock(queue_mu_);
  while (!stop_) {
    if (queue_.empty()) {
      queue_cv_.wait(lock);
      continue;
    }
    auto next = std::min_element(queue_.begin(), queue_.end(),
                                 [](const auto& a, const auto& b) { return a.second < b.second; });
    int64_t wait = next->second - now_ms();
    if (wait > 0) {
      queue_cv_.wait_for(lock, std::chrono::milliseconds(wait));
      continue;
    }
    int64_t id = next->first;
    queue_.erase(next);
    lock.unlock();
    try {
      process(id);
    } catch (const std::exception& e) {
      std::cerr << "embedding note " << id << " failed: " << e.what() << "\n";
    }
    lock.lock();
  }
}

void SemanticIndex::process(int64_t id) {
  auto job = store_.embed_job(id);
  if (!job) return note_removed(id);

  std::vector<float> v;
  {
    std::lock_guard lock(embed_mu_);
    v = embedder_->embed(job->text);
  }
  // The note changed while we were embedding; the newer version is queued.
  if (!store_.save_embedding(id, embedder_->name(), job->version, v)) return;

  index_put(id, v);
  Scored links;
  for (const auto& [other, score] : knn(v, kLinksPerNote, id))
    if (score >= embedder_->link_threshold()) links.emplace_back(other, score);
  store_.set_semantic_links(id, links);
}

void SemanticIndex::index_put(int64_t id, const std::vector<float>& v) {
  std::lock_guard lock(index_mu_);
  if (!vectors_.count(id) && hnsw_->getCurrentElementCount() >= capacity_) {
    capacity_ *= 2;
    hnsw_->resizeIndex(capacity_);
  }
  // addPoint on an existing (or deleted) label updates it in place.
  hnsw_->addPoint(v.data(), static_cast<hnswlib::labeltype>(id));
  vectors_[id] = v;
}

SemanticIndex::Scored SemanticIndex::knn(const std::vector<float>& v, size_t k, int64_t exclude) {
  std::lock_guard lock(index_mu_);
  size_t n = vectors_.size();
  if (n == 0) return {};
  auto pq = hnsw_->searchKnn(v.data(), std::min(n, k + 1));
  Scored out;
  while (!pq.empty()) {
    auto [dist, label] = pq.top();
    pq.pop();
    if (static_cast<int64_t>(label) != exclude) out.emplace_back(static_cast<int64_t>(label), 1.f - dist);
  }
  std::reverse(out.begin(), out.end());  // best first
  if (out.size() > k) out.resize(k);
  return out;
}

SemanticIndex::Scored SemanticIndex::similar(int64_t id, size_t k) {
  if (!embedder_) return {};
  std::vector<float> v;
  {
    std::lock_guard lock(index_mu_);
    auto it = vectors_.find(id);
    if (it == vectors_.end()) return {};
    v = it->second;
  }
  return knn(v, k, id);
}

SemanticIndex::Scored SemanticIndex::search(const std::string& query, size_t k) {
  if (!embedder_ || query.empty()) return {};
  std::vector<float> v;
  {
    std::lock_guard lock(embed_mu_);
    v = embedder_->embed(query, /*is_query=*/true);
  }
  return knn(v, k, -1);
}

size_t SemanticIndex::indexed() {
  std::lock_guard lock(index_mu_);
  return vectors_.size();
}

size_t SemanticIndex::pending() {
  std::lock_guard lock(queue_mu_);
  return queue_.size();
}
