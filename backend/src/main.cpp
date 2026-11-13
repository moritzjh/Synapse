#include <httplib.h>

#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <json.hpp>
#include <set>
#include <sstream>

#include "markdown.hpp"
#include "mcp.hpp"
#include "note_store.hpp"
#include "semantic_index.hpp"
#include "service.hpp"
#include "vault.hpp"

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

std::string env(const char* name, const std::string& fallback) {
  const char* v = std::getenv(name);
  return v && *v ? v : fallback;
}

void send_json(httplib::Response& res, const json& body, int status = 200) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

int64_t path_id(const httplib::Request& req) { return std::stoll(req.matches[1]); }

json parse_body(const httplib::Request& req) {
  auto body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.is_object()) throw ServiceError(400, "invalid JSON");
  return body;
}

// {"title", "content"} – content may be TipTap JSON (string or object) or
// plain text; {"markdown"} is accepted instead of content.
void note_fields(const json& body, std::string& title, std::string& content, bool& is_markdown) {
  if (body.contains("folder") && !body["folder"].is_string()) throw ServiceError(400, "folder must be a string");
  title = body.value("title", "");
  is_markdown = body.contains("markdown");
  const json& c = is_markdown ? body["markdown"] : body.value("content", json(""));
  content = c.is_string() ? c.get<std::string>() : c.dump();
}

std::unique_ptr<Embedder> load_embedder() {
  std::string dir = env("SYNAPSE_MODEL", "");
  if (dir.empty()) {
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

// "Example.com:8080" / "[::1]:8080" → lower-case host without the port.
std::string host_only(std::string h) {
  for (auto& c : h) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (!h.empty() && h[0] == '[') {
    size_t close = h.find(']');
    return close == std::string::npos ? h : h.substr(0, close + 1);
  }
  size_t colon = h.rfind(':');
  return colon == std::string::npos ? h : h.substr(0, colon);
}

// Host names this server answers to. Loopback names always; more via
// SYNAPSE_ALLOWED_HOSTS="notes.example.com,192.168.1.20" ("*" = any).
// Checking the Host header stops DNS-rebinding, checking Origin stops other
// websites from calling the API of a server running on localhost.
struct HostPolicy {
  std::set<std::string> allowed{"localhost", "127.0.0.1", "[::1]"};
  bool any = false;

  explicit HostPolicy(const std::string& extra) {
    std::stringstream ss(extra);
    std::string h;
    while (std::getline(ss, h, ',')) {
      h.erase(0, h.find_first_not_of(" \t"));
      h.erase(h.find_last_not_of(" \t") + 1);
      if (h == "*") any = true;
      else if (!h.empty()) allowed.insert(host_only(h));
    }
  }

  bool host_ok(const std::string& host) const { return any || allowed.count(host_only(host)) > 0; }

  // "https://notes.example.com:8443" → allowed if its host is one of ours
  bool origin_ok(const std::string& origin) const {
    size_t scheme = origin.find("://");
    if (scheme == std::string::npos) return false;  // "null" and other opaque origins
    return host_ok(origin.substr(scheme + 3));
  }
};

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> args(argv + 1, argv + argc);
  int port = std::stoi(env("PORT", "8080"));

  // `synapse mcp [url]` – stdio MCP transport for Claude Desktop & co.
  if (!args.empty() && args[0] == "mcp") {
    return run_mcp_stdio_bridge(args.size() > 1 ? args[1] : "http://127.0.0.1:" + std::to_string(port));
  }

  // SIGINT/SIGTERM (Ctrl+C, `docker stop`) are handled by a dedicated thread so the
  // server shuts down cleanly and the database is closed properly.
  sigset_t stop_signals;
  sigemptyset(&stop_signals);
  sigaddset(&stop_signals, SIGINT);
  sigaddset(&stop_signals, SIGTERM);
  pthread_sigmask(SIG_BLOCK, &stop_signals, nullptr);

  std::string db_path = !args.empty() ? args[0] : env("SYNAPSE_DB", "synapse.db");
  fs::path vault_dir = env("SYNAPSE_VAULT", "vault");

  NoteStore store(db_path);
  SemanticIndex semantic(store, load_embedder());
  Vault vault(
      store, vault_dir, [&](int64_t id) { semantic.note_changed(id); }, [&](int64_t id) { semantic.note_removed(id); });
  vault.start();
  Service svc(store, semantic, vault);
  McpServer mcp(svc);

  httplib::Server srv;
  srv.set_payload_max_length(25 * 1024 * 1024);
  const HostPolicy hosts(env("SYNAPSE_ALLOWED_HOSTS", ""));
  srv.set_pre_routing_handler([&hosts](const httplib::Request& req, httplib::Response& res) {
    auto deny = [&](const char* why) {
      send_json(res, {{"error", why}}, 403);
      return httplib::Server::HandlerResponse::Handled;
    };
    if (!hosts.host_ok(req.get_header_value("Host"))) return deny("host not allowed (set SYNAPSE_ALLOWED_HOSTS)");
    if (req.has_header("Origin")) {
      std::string origin = req.get_header_value("Origin");
      if (!hosts.origin_ok(origin)) return deny("origin not allowed");
      // only our own origins may read responses (dev server on another port, reverse proxy)
      res.set_header("Access-Control-Allow-Origin", origin);
      res.set_header("Vary", "Origin");
      res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.set_header("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version");
    }
    return httplib::Server::HandlerResponse::Unhandled;
  });
  srv.Options(R"(/(api|mcp).*)", [](const httplib::Request&, httplib::Response& res) { res.status = 204; });

  srv.set_exception_handler([](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
    try {
      std::rethrow_exception(ep);
    } catch (const ServiceError& e) {
      send_json(res, {{"error", e.what()}}, e.status);
    } catch (const json::exception& e) {
      send_json(res, {{"error", std::string("invalid request: ") + e.what()}}, 400);  // wrong JSON types
    } catch (const std::invalid_argument&) {
      send_json(res, {{"error", "invalid number"}}, 400);
    } catch (const std::out_of_range&) {
      send_json(res, {{"error", "number out of range"}}, 400);
    } catch (const std::exception& e) {
      send_json(res, {{"error", e.what()}}, 500);
    }
  });

  using Req = const httplib::Request&;
  using Res = httplib::Response&;

  srv.Get("/api/status", [&](Req, Res res) { send_json(res, svc.status()); });

  // ---- notes ----
  srv.Get("/api/notes", [&](Req, Res res) { send_json(res, svc.list_notes()); });
  srv.Get(R"(/api/notes/(\d+))", [&](Req req, Res res) {
    json n = svc.get_note(path_id(req));
    if (req.get_param_value("format") == "markdown") n["markdown"] = svc.note_markdown(path_id(req));
    send_json(res, n);
  });
  srv.Post("/api/notes", [&](Req req, Res res) {
    std::string title, content;
    bool md;
    json body = parse_body(req);
    note_fields(body, title, content, md);
    std::string folder = body.value("folder", "");
    if (body.contains("parent_id") && body["parent_id"].is_number_integer()) {
      if (md) content = markdown_to_doc(content).dump();
      return send_json(res, svc.create_subpage(body["parent_id"].get<int64_t>(), title, content), 201);
    }
    send_json(res, md ? svc.create_note_markdown(title, content, folder) : svc.create_note(title, content, folder), 201);
  });
  srv.Put(R"(/api/notes/(\d+)/move)", [&](Req req, Res res) {
    send_json(res, svc.move_note(path_id(req), parse_body(req).value("folder", "")));
  });

  // ---- folders ----
  srv.Get("/api/tree", [&](Req, Res res) { send_json(res, svc.tree()); });
  srv.Post("/api/folders", [&](Req req, Res res) {
    send_json(res, {{"path", svc.create_folder(parse_body(req).value("path", ""))}}, 201);
  });
  srv.Put("/api/folders", [&](Req req, Res res) {
    json b = parse_body(req);
    svc.rename_folder(b.value("from", ""), b.value("to", ""));
    send_json(res, {{"path", Vault::clean_folder(b.value("to", ""))}});
  });
  srv.Put("/api/folders/meta", [&](Req req, Res res) {
    json body = parse_body(req);
    svc.set_folder_meta(body.value("path", ""), body.value("color", ""), body.value("icon", ""));
    res.status = 204;
  });
  srv.Delete("/api/folders", [&](Req req, Res res) {
    svc.delete_folder(req.get_param_value("path"));
    res.status = 204;
  });
  srv.Put(R"(/api/notes/(\d+))", [&](Req req, Res res) {
    std::string title, content;
    bool md;
    json body = parse_body(req);
    int64_t id = path_id(req);
    // a rename-only request keeps the body instead of emptying the note
    if (!body.contains("content") && !body.contains("markdown")) body["content"] = svc.get_note(id)["content"];
    if (!body.contains("title")) body["title"] = svc.get_note(id)["title"];
    note_fields(body, title, content, md);
    send_json(res, md ? svc.update_note_markdown(id, title, content) : svc.update_note(id, title, content));
  });
  srv.Delete(R"(/api/notes/(\d+))", [&](Req req, Res res) {
    svc.delete_note(path_id(req));
    res.status = 204;
  });
  srv.Get(R"(/api/notes/(\d+)/backlinks)", [&](Req req, Res res) { send_json(res, svc.backlinks(path_id(req))); });
  srv.Get(R"(/api/notes/(\d+)/similar)", [&](Req req, Res res) { send_json(res, svc.similar(path_id(req))); });
  srv.Get(R"(/api/notes/(\d+)/databases)", [&](Req req, Res res) { send_json(res, svc.databases(path_id(req))); });
  srv.Get(R"(/api/notes/(\d+)/cards)", [&](Req req, Res res) { send_json(res, svc.note_cards(path_id(req))); });

  srv.Get("/api/search", [&](Req req, Res res) { send_json(res, svc.search(req.get_param_value("q"))); });
  srv.Get("/api/semantic-search", [&](Req req, Res res) { send_json(res, svc.semantic_search(req.get_param_value("q"))); });
  srv.Get("/api/graph", [&](Req, Res res) { send_json(res, svc.graph()); });

  // ---- flashcards ----
  // ?exam=<id> and/or ?path=<folder or note file> narrow a review session
  auto scope_param = [](Req req) {
    std::string e = req.get_param_value("exam");
    return CardScope{e.empty() ? int64_t{0} : std::stoll(e), req.get_param_value("path")};
  };
  srv.Get("/api/mastery", [&](Req, Res res) { send_json(res, svc.mastery()); });
  srv.Get("/api/review/stats", [&](Req req, Res res) { send_json(res, svc.review_stats(scope_param(req))); });
  srv.Get("/api/review/queue", [&](Req req, Res res) { send_json(res, svc.review_queue(scope_param(req))); });
  srv.Post(R"(/api/cards/(\d+)/review)", [&](Req req, Res res) {
    send_json(res, svc.review_card(path_id(req), parse_body(req).value("rating", 0)));
  });

  // ---- exams ----
  srv.Get("/api/exams", [&](Req, Res res) { send_json(res, svc.list_exams()); });
  srv.Get(R"(/api/exams/(\d+))", [&](Req req, Res res) { send_json(res, svc.get_exam(path_id(req))); });
  srv.Post("/api/exams", [&](Req req, Res res) { send_json(res, svc.create_exam(parse_body(req)), 201); });
  srv.Put(R"(/api/exams/(\d+))", [&](Req req, Res res) { send_json(res, svc.update_exam(path_id(req), parse_body(req))); });
  srv.Delete(R"(/api/exams/(\d+))", [&](Req req, Res res) {
    svc.delete_exam(path_id(req));
    res.status = 204;
  });

  // ---- uploads (images live in the vault's attachments folder) ----
  srv.Post("/api/uploads", [&](Req req, Res res) {
    if (!req.has_file("file")) throw ServiceError(400, "multipart field 'file' missing");
    const auto& f = req.get_file_value("file");
    send_json(res, {{"url", svc.save_upload(f.filename, f.content)}}, 201);
  });
  srv.set_mount_point("/uploads", vault.attachments().string());

  // ---- MCP (Streamable HTTP; responses are plain JSON, no SSE stream) ----
  srv.Post("/mcp", [&](Req req, Res res) {
    auto msg = json::parse(req.body, nullptr, false);
    if (msg.is_discarded()) {
      return send_json(res, {{"jsonrpc", "2.0"}, {"id", nullptr}, {"error", {{"code", -32700}, {"message", "parse error"}}}}, 400);
    }
    auto reply = mcp.handle(msg);
    if (!reply) {
      res.status = 202;
      return;
    }
    send_json(res, *reply);
  });
  srv.Get("/mcp", [](Req, Res res) { res.status = 405; });

  if (const char* dir = std::getenv("SYNAPSE_STATIC")) srv.set_mount_point("/", dir);

  std::string host = env("SYNAPSE_HOST", "127.0.0.1");
  std::cout << "synapse on http://" << host << ":" << port << "  (db " << db_path << ", MCP at /mcp)" << std::endl;
  std::thread([&] {
    int sig = 0;
    sigwait(&stop_signals, &sig);
    std::cout << "shutting down" << std::endl;
    srv.stop();
  }).detach();
  if (!srv.listen(host, port)) {
    std::cerr << "failed to bind " << host << ":" << port << "\n";
    return 1;
  }
}
