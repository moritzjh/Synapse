#include "mcp.hpp"

#include <httplib.h>

#include <ctime>
#include <iostream>
#include <sstream>

using json = nlohmann::json;

namespace {

constexpr const char* kLatestProtocol = "2025-06-18";
const std::vector<std::string> kSupportedProtocols = {"2025-06-18", "2025-03-26", "2024-11-05"};

json rpc_result(const json& id, json result) { return {{"jsonrpc", "2.0"}, {"id", id}, {"result", std::move(result)}}; }

json rpc_error(const json& id, int code, const std::string& msg) {
  return {{"jsonrpc", "2.0"}, {"id", id}, {"error", {{"code", code}, {"message", msg}}}};
}

json schema(json properties, std::vector<std::string> required = {}) {
  json s = {{"type", "object"}, {"properties", std::move(properties)}};
  if (!required.empty()) s["required"] = required;
  return s;
}

json prop(const std::string& type, const std::string& description) { return {{"type", type}, {"description", description}}; }

std::string date_str(int64_t ms) {
  std::time_t t = ms / 1000;
  std::tm tm{};
  localtime_r(&t, &tm);
  char buf[32];
  std::strftime(buf, sizeof buf, "%Y-%m-%d %H:%M", &tm);
  return buf;
}

std::string pct(double v) { return std::to_string(static_cast<int>(v * 100 + 0.5)) + "%"; }

std::string note_list_text(const json& notes) {
  std::ostringstream out;
  for (const auto& n : notes) {
    out << "- [" << n["id"].get<int64_t>() << "] " << n["title"].get<std::string>();
    if (n.contains("score")) out << " (" << pct(n["score"].get<double>()) << ")";
    if (n.contains("snippet")) out << " – " << n["snippet"].get<std::string>();
    out << "\n";
  }
  return notes.empty() ? "(none)\n" : out.str();
}

std::string card_text(const json& c) {
  std::string kind = c["kind"];
  std::string s = "[" + std::to_string(c["id"].get<int64_t>()) + "] (" + kind + ") " + c["front"].get<std::string>();
  const json& d = c["data"];
  if (d.contains("back")) s += " → " + d["back"].get<std::string>();
  if (d.contains("items")) {
    s += " →";
    for (const auto& i : d["items"]) s += " • " + i.get<std::string>();
  }
  if (d.contains("segments")) {
    s += " → ";
    for (const auto& seg : d["segments"]) s += seg.contains("cloze") ? "{{" + seg["cloze"].get<std::string>() + "}}" : seg["text"].get<std::string>();
  }
  return s;
}

}  // namespace

McpServer::McpServer(Service& service) : service_(service) { register_tools(); }

int64_t McpServer::resolve_note(const json& args) {
  if (args.contains("id") && args["id"].is_number_integer()) return args["id"].get<int64_t>();
  if (args.contains("title") && args["title"].is_string()) {
    if (int64_t id = service_.find_note(args["title"].get<std::string>())) return id;
    throw ServiceError(404, "no note titled \"" + args["title"].get<std::string>() + "\"");
  }
  throw ServiceError(400, "pass the note's id or title");
}

void McpServer::register_tools() {
  const json note_ref = {{"id", prop("integer", "Note id")}, {"title", prop("string", "Note title (alternative to id)")}};

  tools_.push_back({"list_notes", "List notes", "List all notes (id and title), most recently edited first.", schema(json::object()),
                    [this](const json&) {
                      json n = service_.list_notes();
                      return ToolResult{note_list_text(n), {{"notes", n}}};
                    }});

  tools_.push_back({"read_note", "Read note",
                    "Read a note as Markdown, together with its [[links]], backlinks and semantically similar notes.",
                    schema(note_ref), [this](const json& a) {
                      int64_t id = resolve_note(a);
                      json note = service_.get_note(id);
                      std::string md = service_.note_markdown(id);
                      json rel = service_.related(id);
                      std::ostringstream out;
                      out << "# " << note["title"].get<std::string>() << "  (id " << id << ")\n\n" << md << "\n---\n";
                      out << "Backlinks:\n" << note_list_text(rel["backlinks"]) << "Similar:\n" << note_list_text(rel["similar"]);
                      return ToolResult{out.str(), {{"id", id}, {"title", note["title"]}, {"markdown", md}, {"related", rel}}};
                    }});

  tools_.push_back({"search_notes", "Search notes",
                    "Search notes. mode 'text' = full-text (exact words, prefix match), 'semantic' = by meaning using the "
                    "local embedding model, 'both' (default) = both result lists.",
                    schema({{"query", prop("string", "Search query")},
                            {"mode", {{"type", "string"}, {"enum", {"text", "semantic", "both"}}}}},
                           {"query"}),
                    [this](const json& a) {
                      std::string q = a.value("query", "");
                      std::string mode = a.value("mode", "both");
                      json res = json::object();
                      std::string text;
                      if (mode != "semantic") {
                        res["text"] = service_.search(q);
                        text += "Full-text matches:\n" + note_list_text(res["text"]);
                      }
                      if (mode != "text") {
                        res["semantic"] = service_.semantic_search(q);
                        text += "Semantically similar:\n" + note_list_text(res["semantic"]);
                      }
                      return ToolResult{text, res};
                    }});

  const std::string syntax_help =
      " Markdown supports headings, **bold**, *italic*, ==highlight==, lists, - [ ] tasks, tables, ```code``` and "
      "```mermaid diagrams. Link notes with [[Title]]. Flashcards: 'Question >> Answer', 'Term :: Definition' "
      "(both directions), 'Question >>' followed by a bullet list (points revealed one by one), and {{cloze}} gaps.";

  tools_.push_back({"create_note", "Create note", "Create a new note from Markdown." + syntax_help,
                    schema({{"title", prop("string", "Note title")}, {"markdown", prop("string", "Note body in Markdown")}},
                           {"title", "markdown"}),
                    [this](const json& a) {
                      json n = service_.create_note_markdown(a.value("title", ""), a.value("markdown", ""));
                      int64_t id = n["id"];
                      json cards = service_.note_cards(id);
                      return ToolResult{"Created note " + std::to_string(id) + " with " + std::to_string(cards.size()) + " flashcard(s).",
                                        {{"id", id}, {"title", n["title"]}, {"cards", cards.size()}}};
                    },
                    false});

  tools_.push_back({"update_note", "Update note",
                    "Change a note: replace its Markdown body, append Markdown to the end, and/or rename it." + syntax_help,
                    schema({{"id", prop("integer", "Note id")},
                            {"title", prop("string", "Current title (alternative to id)")},
                            {"new_title", prop("string", "Rename the note")},
                            {"markdown", prop("string", "Replace the whole body with this Markdown")},
                            {"append_markdown", prop("string", "Append this Markdown to the end")}}),
                    [this](const json& a) {
                      int64_t id = resolve_note(a);
                      json note = service_.get_note(id);
                      std::string title = a.value("new_title", note["title"].get<std::string>());
                      std::string md = a.contains("markdown") ? a.value("markdown", "") : service_.note_markdown(id);
                      if (a.contains("append_markdown")) md += "\n" + a.value("append_markdown", "");
                      service_.update_note_markdown(id, title, md);
                      json cards = service_.note_cards(id);
                      return ToolResult{"Updated note " + std::to_string(id) + " (" + std::to_string(cards.size()) + " flashcard(s)).",
                                        {{"id", id}, {"title", title}, {"cards", cards.size()}}};
                    },
                    false});

  tools_.push_back({"delete_note", "Delete note", "Delete a note (its Markdown file is moved to the vault's .trash).",
                    schema(note_ref), [this](const json& a) {
                      int64_t id = resolve_note(a);
                      service_.delete_note(id);
                      return ToolResult{"Deleted note " + std::to_string(id) + ".", {{"id", id}}};
                    },
                    false});

  tools_.push_back({"get_graph", "Knowledge graph",
                    "The knowledge graph: notes plus edges of kind 'link' ([[wikilinks]]) and 'semantic' (similar content, "
                    "weight = cosine similarity).",
                    schema(json::object()), [this](const json&) {
                      json g = service_.graph();
                      std::map<int64_t, std::string> title;
                      for (const auto& n : g["nodes"]) title[n["id"]] = n["title"];
                      std::ostringstream out;
                      out << g["nodes"].size() << " notes, " << g["edges"].size() << " edges\n";
                      for (const auto& e : g["edges"])
                        out << title[e["source"]] << (e["kind"] == "link" ? " → " : " ~ ") << title[e["target"]]
                            << (e["kind"] == "semantic" ? " (" + pct(e["weight"].get<double>()) + ")" : "") << "\n";
                      return ToolResult{out.str(), g};
                    }});

  tools_.push_back({"list_cards", "List flashcards", "List the flashcards generated from a note.", schema(note_ref),
                    [this](const json& a) {
                      json cards = service_.note_cards(resolve_note(a));
                      std::string text;
                      for (const auto& c : cards) text += card_text(c) + "\n";
                      return ToolResult{text.empty() ? "(no cards)" : text, {{"cards", cards}}};
                    }});

  tools_.push_back({"review_queue", "Cards to review",
                    "Flashcards that are due now (and new cards for today), optionally only for one exam. Use to quiz the user.",
                    schema({{"exam_id", prop("integer", "Only cards of this exam")}, {"limit", prop("integer", "Max cards (default 20)")}}),
                    [this](const json& a) {
                      json q = service_.review_queue(a.value("exam_id", int64_t{0}), a.value("limit", 20));
                      std::string text;
                      for (const auto& c : q) text += card_text(c) + "\n";
                      return ToolResult{text.empty() ? "Nothing due." : text, {{"cards", q}, {"stats", service_.review_stats(a.value("exam_id", int64_t{0}))}}};
                    }});

  tools_.push_back({"review_card", "Grade a card",
                    "Record a review of a flashcard: rating 1 = again (forgotten), 2 = hard, 3 = good, 4 = easy. "
                    "The FSRS scheduler (exam-aware) computes the next due date.",
                    schema({{"card_id", prop("integer", "Card id")}, {"rating", {{"type", "integer"}, {"minimum", 1}, {"maximum", 4}}}},
                           {"card_id", "rating"}),
                    [this](const json& a) {
                      json c = service_.review_card(a.value("card_id", int64_t{0}), a.value("rating", 0));
                      return ToolResult{"Next review: " + date_str(c["due"].get<int64_t>()), c};
                    },
                    false});

  tools_.push_back({"list_exams", "List exams",
                    "Exams with date, covered notes and progress (cards, mastered, predicted recall on exam day, new cards to "
                    "learn today).",
                    schema(json::object()), [this](const json&) {
                      json ex = service_.list_exams();
                      std::ostringstream out;
                      for (const auto& e : ex) {
                        const auto& p = e["progress"];
                        out << "[" << e["id"].get<int64_t>() << "] " << e["name"].get<std::string>() << " – "
                            << date_str(e["date"].get<int64_t>()) << ": " << p["cards"].get<int>() << " cards, "
                            << p["mastered"].get<int>() << " mastered, predicted recall "
                            << pct(p["predicted_retention"].get<double>()) << ", " << p["new_today"].get<int>()
                            << " new today, " << p["due"].get<int>() << " due\n";
                      }
                      return ToolResult{ex.empty() ? "(no exams)" : out.str(), {{"exams", ex}}};
                    }});

  const json exam_props = {{"name", prop("string", "Exam name, e.g. 'Biologie Klausur'")},
                           {"date", prop("string", "Exam date YYYY-MM-DD (optionally THH:MM)")},
                           {"note_ids", {{"type", "array"}, {"items", {{"type", "integer"}}}}},
                           {"note_titles", {{"type", "array"}, {"items", {{"type", "string"}}}}}};

  tools_.push_back({"create_exam", "Create exam",
                    "Schedule an exam. Flashcards of the given notes are then planned so that every card is learned in time "
                    "and reviewed shortly before the exam date.",
                    schema(exam_props, {"name", "date"}), [this](const json& a) {
                      json e = service_.create_exam(a);
                      return ToolResult{"Created exam " + std::to_string(e["id"].get<int64_t>()) + " covering " +
                                            std::to_string(e["progress"]["cards"].get<int>()) + " cards.",
                                        e};
                    },
                    false});

  json update_props = exam_props;
  update_props["id"] = prop("integer", "Exam id");
  tools_.push_back({"update_exam", "Update exam", "Change an exam's name, date or notes (all fields are replaced).",
                    schema(update_props, {"id", "name", "date"}), [this](const json& a) {
                      json e = service_.update_exam(a.value("id", int64_t{0}), a);
                      return ToolResult{"Updated exam " + e["name"].get<std::string>() + ".", e};
                    },
                    false});

  tools_.push_back({"delete_exam", "Delete exam", "Delete an exam (cards keep their history).",
                    schema({{"id", prop("integer", "Exam id")}}, {"id"}), [this](const json& a) {
                      service_.delete_exam(a.value("id", int64_t{0}));
                      return ToolResult{"Deleted exam.", json::object()};
                    },
                    false});
}

json McpServer::call_tool(const json& params) {
  std::string name = params.value("name", "");
  json args = params.value("arguments", json::object());
  for (const auto& t : tools_) {
    if (t.name != name) continue;
    try {
      ToolResult r = t.run(args);
      json res = {{"content", {{{"type", "text"}, {"text", r.text}}}}, {"isError", false}};
      if (r.structured.is_object()) res["structuredContent"] = r.structured;
      return res;
    } catch (const std::exception& e) {
      return {{"content", {{{"type", "text"}, {"text", std::string("Error: ") + e.what()}}}}, {"isError", true}};
    }
  }
  throw ServiceError(-32602, "unknown tool: " + name);
}

std::optional<json> McpServer::handle(const json& message) {
  if (message.is_array()) {
    json out = json::array();
    for (const auto& m : message)
      if (auto r = handle_one(m)) out.push_back(*r);
    if (out.empty()) return std::nullopt;
    return out;
  }
  return handle_one(message);
}

std::optional<json> McpServer::handle_one(const json& msg) {
  if (!msg.is_object() || msg.value("jsonrpc", "") != "2.0") return rpc_error(nullptr, -32600, "invalid request");
  if (!msg.contains("id")) return std::nullopt;  // notification (e.g. notifications/initialized)
  const json& id = msg["id"];
  std::string method = msg.value("method", "");
  json params = msg.value("params", json::object());

  try {
    if (method == "initialize") {
      std::string requested = params.value("protocolVersion", kLatestProtocol);
      bool known = std::find(kSupportedProtocols.begin(), kSupportedProtocols.end(), requested) != kSupportedProtocols.end();
      return rpc_result(id, {{"protocolVersion", known ? requested : kLatestProtocol},
                             {"capabilities", {{"tools", {{"listChanged", false}}}}},
                             {"serverInfo", {{"name", "synapse"}, {"title", "Synapse"}, {"version", "0.3.0"}}},
                             {"instructions",
                              "Synapse is the user's personal knowledge base: Markdown notes linked with [[wikilinks]], "
                              "flashcards written inside notes, spaced repetition with exam planning. Search before "
                              "creating notes to avoid duplicates, and link related notes with [[Title]]."}});
    }
    if (method == "ping") return rpc_result(id, json::object());
    if (method == "tools/list") {
      json list = json::array();
      for (const auto& t : tools_)
        list.push_back({{"name", t.name},
                        {"title", t.title},
                        {"description", t.description},
                        {"inputSchema", t.schema},
                        {"annotations", {{"readOnlyHint", t.read_only}, {"destructiveHint", t.name.rfind("delete", 0) == 0}}}});
      return rpc_result(id, {{"tools", list}});
    }
    if (method == "tools/call") return rpc_result(id, call_tool(params));
    if (method == "resources/list") return rpc_result(id, {{"resources", json::array()}});
    if (method == "prompts/list") return rpc_result(id, {{"prompts", json::array()}});
    return rpc_error(id, -32601, "method not found: " + method);
  } catch (const ServiceError& e) {
    return rpc_error(id, e.status < 0 ? e.status : -32602, e.what());
  } catch (const std::exception& e) {
    return rpc_error(id, -32603, e.what());
  }
}

int run_mcp_stdio_bridge(const std::string& url) {
  httplib::Client client(url);
  client.set_read_timeout(60, 0);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.find_first_not_of(" \t\r") == std::string::npos) continue;
    auto res = client.Post("/mcp", line, "application/json");
    if (res && res->status == 200) {
      std::cout << res->body << "\n" << std::flush;
    } else if (!res || res->status != 202) {
      auto msg = json::parse(line, nullptr, false);
      if (!msg.is_discarded() && msg.is_object() && msg.contains("id")) {
        std::string why = res ? "HTTP " + std::to_string(res->status) : "Synapse backend not reachable at " + url + " – start it first";
        std::cout << rpc_error(msg["id"], -32603, why).dump() << "\n" << std::flush;
      }
    }
  }
  return 0;
}
