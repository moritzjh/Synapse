#include <httplib.h>

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <json.hpp>

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
  title = body.value("title", "Untitled");
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

bool local_origin(const httplib::Request& req) {
  if (!req.has_header("Origin")) return true;
  std::string o = req.get_header_value("Origin");
  for (const char* ok : {"http://localhost", "http://127.0.0.1", "https://localhost", "https://127.0.0.1"})
    if (o.rfind(ok, 0) == 0) return true;
  return false;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> args(argv + 1, argv + argc);
  int port = std::stoi(env("PORT", "8080"));

  // `synapse mcp [url]` – stdio MCP transport for Claude Desktop & co.
  if (!args.empty() && args[0] == "mcp") {
    return run_mcp_stdio_bridge(args.size() > 1 ? args[1] : "http://127.0.0.1:" + std::to_string(port));
  }

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
  srv.set_default_headers({
      {"Access-Control-Allow-Origin", "*"},
      {"Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"},
      {"Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version"},
  });
  srv.Options(R"(/(api|mcp).*)", [](const httplib::Request&, httplib::Response& res) { res.status = 204; });

  srv.set_exception_handler([](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
    try {
      std::rethrow_exception(ep);
    } catch (const ServiceError& e) {
      send_json(res, {{"error", e.what()}}, e.status);
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
  srv.Delete("/api/folders", [&](Req req, Res res) {
    svc.delete_folder(req.get_param_value("path"));
    res.status = 204;
  });
  srv.Put(R"(/api/notes/(\d+))", [&](Req req, Res res) {
    std::string title, content;
    bool md;
    note_fields(parse_body(req), title, content, md);
    int64_t id = path_id(req);
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
  auto exam_param = [](Req req) {
    std::string e = req.get_param_value("exam");
    return e.empty() ? int64_t{0} : std::stoll(e);
  };
  srv.Get("/api/review/stats", [&](Req req, Res res) { send_json(res, svc.review_stats(exam_param(req))); });
  srv.Get("/api/review/queue", [&](Req req, Res res) { send_json(res, svc.review_queue(exam_param(req))); });
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
    if (!local_origin(req)) return send_json(res, {{"error", "forbidden origin"}}, 403);
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
  if (!srv.listen(host, port)) {
    std::cerr << "failed to bind " << host << ":" << port << "\n";
    return 1;
  }
}
