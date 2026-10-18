#include <httplib.h>

#include <cstdlib>
#include <iostream>
#include <json.hpp>

#include "note_store.hpp"

using json = nlohmann::json;

namespace {

json to_json(const Note& n) {
  return {{"id", n.id}, {"title", n.title}, {"content", n.content},
          {"created_at", n.created_at}, {"updated_at", n.updated_at}};
}

json to_json(const NoteSummary& n) {
  return {{"id", n.id}, {"title", n.title}, {"updated_at", n.updated_at}};
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
  content = body.value("content", "");
  if (title.empty()) title = "Untitled";
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  std::string db_path = argc > 1 ? argv[1] : "synapse.db";
  int port = std::getenv("PORT") ? std::atoi(std::getenv("PORT")) : 8080;

  NoteStore store(db_path);
  httplib::Server srv;

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

  srv.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
    send_json(res, {{"ok", true}});
  });

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
    send_json(res, to_json(store.create(title, content)), 201);
  });

  srv.Put(R"(/api/notes/(\d+))", [&](const httplib::Request& req, httplib::Response& res) {
    std::string title, content;
    if (!parse_note_body(req, res, title, content)) return;
    auto note = store.update(path_id(req), title, content);
    if (!note) return send_error(res, 404, "note not found");
    send_json(res, to_json(*note));
  });

  srv.Delete(R"(/api/notes/(\d+))", [&](const httplib::Request& req, httplib::Response& res) {
    if (!store.remove(path_id(req))) return send_error(res, 404, "note not found");
    res.status = 204;
  });

  srv.Get(R"(/api/notes/(\d+)/backlinks)", [&](const httplib::Request& req, httplib::Response& res) {
    send_json(res, to_json_array(store.backlinks(path_id(req))));
  });

  srv.Get("/api/search", [&](const httplib::Request& req, httplib::Response& res) {
    json arr = json::array();
    for (const auto& h : store.search(req.get_param_value("q"), 20)) {
      arr.push_back({{"id", h.id}, {"title", h.title}, {"snippet", h.snippet}});
    }
    send_json(res, arr);
  });

  srv.Get("/api/graph", [&](const httplib::Request&, httplib::Response& res) {
    Graph g = store.graph();
    json edges = json::array();
    for (const auto& e : g.edges) {
      edges.push_back({{"source", e.source}, {"target", e.target}, {"kind", e.kind}, {"weight", e.weight}});
    }
    send_json(res, {{"nodes", to_json_array(g.nodes)}, {"edges", edges}});
  });

  // Serve the built frontend in production (frontend/dist).
  if (const char* dir = std::getenv("SYNAPSE_STATIC")) srv.set_mount_point("/", dir);

  std::cout << "synapse backend on http://localhost:" << port << " (db: " << db_path << ")\n";
  if (!srv.listen("0.0.0.0", port)) {
    std::cerr << "failed to bind port " << port << "\n";
    return 1;
  }
}
