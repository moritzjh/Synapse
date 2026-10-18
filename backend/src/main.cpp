#include <httplib.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <json.hpp>
#include <random>

#include "note_store.hpp"
#include "semantic_index.hpp"

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

constexpr int kNewCardsPerDay = 20;

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

json to_json(const Note& n) {
  return {{"id", n.id}, {"title", n.title}, {"content", n.content},
          {"created_at", n.created_at}, {"updated_at", n.updated_at}};
}

json to_json(const NoteSummary& n) {
  return {{"id", n.id}, {"title", n.title}, {"updated_at", n.updated_at}};
}

json to_json(const Neighbor& n) { return {{"id", n.id}, {"title", n.title}, {"score", n.score}}; }

json to_json(const Card& c) {
  return {{"id", c.id},
          {"note_id", c.note_id},
          {"note_title", c.note_title},
          {"kind", c.kind},
          {"front", c.front},
          {"data", c.data},
          {"state", static_cast<int>(c.sched.state)},
          {"due", c.sched.due},
          {"reps", c.sched.reps},
          {"lapses", c.sched.lapses},
          {"stability", c.sched.stability},
          {"difficulty", c.sched.difficulty}};
}

template <typename T>
json to_json_array(const std::vector<T>& items) {
  json arr = json::array();
  for (const auto& i : items) arr.push_back(to_json(i));
  return arr;
}

void send_json(httplib::Response& res, const json& body, int status = 200) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void send_error(httplib::Response& res, int status, const std::string& msg) {
  send_json(res, {{"error", msg}}, status);
}

int64_t path_id(const httplib::Request& req) { return std::stoll(req.matches[1]); }

// Parses {"title": ..., "content": ...}; returns false and fills res on bad input.
bool parse_note_body(const httplib::Request& req, httplib::Response& res,
                     std::string& title, std::string& content) {
  auto body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.is_object()) {
    send_error(res, 400, "invalid JSON");
    return false;
  }
  title = body.value("title", "Untitled");
  const auto& c = body.value("content", json(""));
  content = c.is_string() ? c.get<std::string>() : c.dump();
  if (title.empty()) title = "Untitled";
  return true;
}

std::string random_name() {
  static std::mt19937_64 rng{std::random_device{}()};
  static std::mutex mu;
  std::lock_guard lock(mu);
  char buf[17];
  std::snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(rng()));
  return buf;
}

std::unique_ptr<Embedder> load_embedder() {
  const char* dir = std::getenv("SYNAPSE_MODEL");
  if (!dir || !*dir) {
    std::cout << "semantic links disabled (set SYNAPSE_MODEL to a model directory)\n";
    return nullptr;
  }
  try {
    return std::make_unique<Embedder>(dir);
  } catch (const std::exception& e) {
    std::cerr << "cannot load model from " << dir << ": " << e.what() << "\n";
    return nullptr;
  }
}

}  // namespace

int main(int argc, char** argv) {
  std::string db_path = argc > 1 ? argv[1] : "synapse.db";
  int port = std::getenv("PORT") ? std::atoi(std::getenv("PORT")) : 8080;
  fs::path uploads = std::getenv("SYNAPSE_UPLOADS") ? std::getenv("SYNAPSE_UPLOADS") : "uploads";
  fs::create_directories(uploads);

  NoteStore store(db_path);
  SemanticIndex semantic(store, load_embedder());
  httplib::Server srv;
  srv.set_payload_max_length(25 * 1024 * 1024);

  srv.set_default_headers({
      {"Access-Control-Allow-Origin", "*"},
      {"Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"},
      {"Access-Control-Allow-Headers", "Content-Type"},
  });
  srv.Options(R"(/api/.*)", [](const httplib::Request&, httplib::Response& res) { res.status = 204; });

  srv.set_exception_handler([](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
    try {
      std::rethrow_exception(ep);
    } catch (const std::exception& e) {
      send_error(res, 500, e.what());
    }
  });

  srv.Get("/api/status", [&](const httplib::Request&, httplib::Response& res) {
    send_json(res, {{"semantic",
                     {{"enabled", semantic.enabled()},
                      {"model", semantic.model()},
                      {"indexed", semantic.indexed()},
                      {"pending", semantic.pending()}}}});
  });

  // ---- notes ----

  srv.Get("/api/notes", [&](const httplib::Request&, httplib::Response& res) {
    send_json(res, to_json_array(store.list()));
  });

  srv.Get(R"(/api/notes/(\d+))", [&](const httplib::Request& req, httplib::Response& res) {
    auto note = store.get(path_id(req));
    if (!note) return send_error(res, 404, "note not found");
    send_json(res, to_json(*note));
  });

  srv.Post("/api/notes", [&](const httplib::Request& req, httplib::Response& res) {
    std::string title, content;
    if (!parse_note_body(req, res, title, content)) return;
    Note note = store.create(title, content);
    semantic.note_changed(note.id);
    send_json(res, to_json(note), 201);
  });

  srv.Put(R"(/api/notes/(\d+))", [&](const httplib::Request& req, httplib::Response& res) {
    std::string title, content;
    if (!parse_note_body(req, res, title, content)) return;
    auto note = store.update(path_id(req), title, content);
    if (!note) return send_error(res, 404, "note not found");
    semantic.note_changed(note->id);
    send_json(res, to_json(*note));
  });

  srv.Delete(R"(/api/notes/(\d+))", [&](const httplib::Request& req, httplib::Response& res) {
    int64_t id = path_id(req);
    if (!store.remove(id)) return send_error(res, 404, "note not found");
    semantic.note_removed(id);
    res.status = 204;
  });

  srv.Get(R"(/api/notes/(\d+)/backlinks)", [&](const httplib::Request& req, httplib::Response& res) {
    send_json(res, to_json_array(store.backlinks(path_id(req))));
  });

  srv.Get(R"(/api/notes/(\d+)/similar)", [&](const httplib::Request& req, httplib::Response& res) {
    send_json(res, to_json_array(store.titles_for(semantic.similar(path_id(req), 8))));
  });

  srv.Get(R"(/api/notes/(\d+)/cards)", [&](const httplib::Request& req, httplib::Response& res) {
    send_json(res, to_json_array(store.note_cards(path_id(req))));
  });

  srv.Get("/api/search", [&](const httplib::Request& req, httplib::Response& res) {
    json arr = json::array();
    for (const auto& h : store.search(req.get_param_value("q"), 20)) {
      arr.push_back({{"id", h.id}, {"title", h.title}, {"snippet", h.snippet}});
    }
    send_json(res, arr);
  });

  srv.Get("/api/semantic-search", [&](const httplib::Request& req, httplib::Response& res) {
    send_json(res, to_json_array(store.titles_for(semantic.search(req.get_param_value("q"), 10))));
  });

  srv.Get("/api/graph", [&](const httplib::Request&, httplib::Response& res) {
    Graph g = store.graph();
    json edges = json::array();
    for (const auto& e : g.edges) {
      edges.push_back({{"source", e.source}, {"target", e.target}, {"kind", e.kind}, {"weight", e.weight}});
    }
    send_json(res, {{"nodes", to_json_array(g.nodes)}, {"edges", edges}});
  });

  // ---- flashcards ----

  srv.Get("/api/review/stats", [&](const httplib::Request&, httplib::Response& res) {
    ReviewStats st = store.review_stats(now_ms(), kNewCardsPerDay);
    send_json(res, {{"due", st.due}, {"new", st.new_available}, {"total", st.total},
                    {"reviewed_today", st.reviewed_today}});
  });

  srv.Get("/api/review/queue", [&](const httplib::Request&, httplib::Response& res) {
    int64_t now = now_ms();
    json arr = json::array();
    for (const auto& c : store.review_queue(now, kNewCardsPerDay, 100)) {
      json j = to_json(c);
      json preview = json::object();
      for (int r = fsrs::Again; r <= fsrs::Easy; ++r)
        preview[std::to_string(r)] = fsrs::review(c.sched, static_cast<fsrs::Rating>(r), now).due - now;
      j["intervals"] = preview;
      arr.push_back(j);
    }
    send_json(res, arr);
  });

  srv.Post(R"(/api/cards/(\d+)/review)", [&](const httplib::Request& req, httplib::Response& res) {
    auto body = json::parse(req.body, nullptr, false);
    int rating = body.is_object() ? body.value("rating", 0) : 0;
    if (rating < fsrs::Again || rating > fsrs::Easy) return send_error(res, 400, "rating must be 1..4");
    auto card = store.review_card(path_id(req), static_cast<fsrs::Rating>(rating), now_ms());
    if (!card) return send_error(res, 404, "card not found");
    send_json(res, to_json(*card));
  });

  // ---- uploads (images) ----

  srv.Post("/api/uploads", [&](const httplib::Request& req, httplib::Response& res) {
    if (!req.has_file("file")) return send_error(res, 400, "multipart field 'file' missing");
    const auto& f = req.get_file_value("file");
    std::string ext = fs::path(f.filename).extension().string();
    for (auto& ch : ext) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    static const std::set<std::string> allowed = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"};
    if (!allowed.count(ext)) return send_error(res, 400, "unsupported image type");
    std::string name = random_name() + ext;
    std::ofstream(uploads / name, std::ios::binary).write(f.content.data(), static_cast<std::streamsize>(f.content.size()));
    send_json(res, {{"url", "/uploads/" + name}}, 201);
  });
  srv.set_mount_point("/uploads", uploads.string());

  // Serve the built frontend in production (frontend/dist).
  if (const char* dir = std::getenv("SYNAPSE_STATIC")) srv.set_mount_point("/", dir);

  std::cout << "synapse backend on http://localhost:" << port << " (db: " << db_path << ")\n";
  if (!srv.listen("0.0.0.0", port)) {
    std::cerr << "failed to bind port " << port << "\n";
    return 1;
  }
}
