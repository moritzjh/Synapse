#include "service.hpp"

#include <chrono>
#include <ctime>
#include <fstream>
#include <random>
#include <set>
#include <sstream>

#include "content.hpp"
#include "explain.hpp"
#include "markdown.hpp"
#include "wikilinks.hpp"

using json = nlohmann::json;
namespace fs = std::filesystem;

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

int64_t parse_date(const json& v) {
  if (v.is_number()) return v.get<int64_t>();
  if (!v.is_string()) throw ServiceError(400, "date must be YYYY-MM-DD or unix ms");
  std::string s = v.get<std::string>();
  std::tm tm{};
  int y, mo, d, h = 8, mi = 0;  // exams default to 08:00 local time
  int n = std::sscanf(s.c_str(), "%d-%d-%dT%d:%d", &y, &mo, &d, &h, &mi);
  if (n < 3) throw ServiceError(400, "date must be YYYY-MM-DD");
  tm.tm_year = y - 1900;
  tm.tm_mon = mo - 1;
  tm.tm_mday = d;
  tm.tm_hour = h;
  tm.tm_min = mi;
  tm.tm_isdst = -1;
  return static_cast<int64_t>(std::mktime(&tm)) * 1000;
}

namespace {

json to_json(const Note& n) {
  return {{"id", n.id}, {"title", n.title}, {"content", n.content},
          {"created_at", n.created_at}, {"updated_at", n.updated_at}};
}
json to_json(const NoteSummary& n) {
  return {{"id", n.id}, {"title", n.title}, {"updated_at", n.updated_at}, {"path", n.path}, {"created_at", n.created_at}};
}
json to_json(const Neighbor& n) { return {{"id", n.id}, {"title", n.title}, {"score", n.score}}; }
json to_json(const Card& c) {
  return {{"id", c.id},           {"note_id", c.note_id},     {"note_title", c.note_title},
          {"kind", c.kind},       {"front", c.front},         {"data", c.data},
          {"state", static_cast<int>(c.sched.state)},         {"due", c.sched.due},
          {"reps", c.sched.reps}, {"lapses", c.sched.lapses}, {"stability", c.sched.stability},
          {"exam_date", c.exam_date ? json(c.exam_date) : json(nullptr)}};
}

template <typename T>
json arr(const std::vector<T>& items) {
  json a = json::array();
  for (const auto& i : items) a.push_back(to_json(i));
  return a;
}

}  // namespace

void Service::changed(int64_t id) {
  semantic_.note_changed(id);
  vault_.export_note(id);
}

// ---- notes --------------------------------------------------------------------

json Service::list_notes() { return arr(store_.list()); }

json Service::get_note(int64_t id) {
  auto n = store_.get(id);
  if (!n) throw ServiceError(404, "note not found");
  return to_json(*n);
}

std::string Service::note_markdown(int64_t id) {
  auto n = store_.get(id);
  if (!n) throw ServiceError(404, "note not found");
  return doc_to_markdown(parse_content(n->content));
}

int64_t Service::find_note(const std::string& title) {
  for (const auto& n : store_.list()) {
    if (n.title.size() != title.size()) continue;
    bool eq = std::equal(n.title.begin(), n.title.end(), title.begin(),
                         [](char a, char b) { return std::tolower(static_cast<unsigned char>(a)) == std::tolower(static_cast<unsigned char>(b)); });
    if (eq) return n.id;
  }
  return 0;
}

namespace {

// Deepest nesting a note may have. Real documents stay far below; the limit keeps the recursive
// walkers (text extraction, cards, Markdown export) off the end of the stack.
constexpr int kMaxDepth = 100;

bool too_deep(const json& node, int depth = 0) {
  if (depth > kMaxDepth) return true;
  if (!node.is_structured()) return false;
  for (const auto& child : node)
    if (too_deep(child, depth + 1)) return true;
  return false;
}

// Rejects content that could not be mirrored to Markdown later (wrong attribute types, absurd nesting)
// before anything is stored – otherwise the note would exist in the database but break every export.
void validate_content(const std::string& title, const std::string& content) {
  if (title.find('\0') != std::string::npos) throw ServiceError(400, "title contains a NUL character");
  if (title.size() > 1000) throw ServiceError(400, "title too long");
  json doc;
  try {
    doc = parse_content(content);
  } catch (const std::exception& e) {
    throw ServiceError(400, std::string("invalid content: ") + e.what());
  }
  if (too_deep(doc)) throw ServiceError(400, "content is nested too deeply");
  try {
    doc_to_markdown(doc);
  } catch (const std::exception& e) {
    throw ServiceError(400, std::string("invalid content: ") + e.what());
  }
}

}  // namespace

json Service::create_note(const std::string& title, const std::string& content, const std::string& folder) {
  validate_content(title, content);
  Note n = store_.create(title, content);
  semantic_.note_changed(n.id);
  vault_.export_note(n.id, folder);
  return to_json(n);
}

json Service::create_note_markdown(const std::string& title, const std::string& markdown, const std::string& folder) {
  return create_note(title, markdown_to_doc(markdown).dump(), folder);
}

// ---- databases -------------------------------------------------------------------

namespace {

void find_databases(json& node, std::vector<json*>& out) {
  if (node.value("type", "") == "database") out.push_back(&node);
  if (node.contains("content") && node["content"].is_array())
    for (auto& c : node["content"]) find_databases(c, out);
}

std::string random_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  static std::mutex mu;
  std::lock_guard lock(mu);
  const char* chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  std::string id;
  for (int i = 0; i < 8; ++i) id += chars[rng() % 36];
  return id;
}

json display_rows(const json& attrs) {
  json rows = json::array();
  for (const auto& r : attrs.value("rows", json::array())) {
    json values = json::object();
    const auto& cells = r.value("cells", json::object());
    for (const auto& p : attrs.value("properties", json::array())) {
      auto it = cells.find(p.value("id", ""));
      if (it != cells.end()) values[p.value("name", "")] = cell_text(p, *it);
    }
    rows.push_back({{"id", r.value("id", "")}, {"values", values}});
  }
  return rows;
}

// Converts a user/LLM-supplied value to the stored cell format of a property.
json to_cell(json& prop, const json& v) {
  std::string type = prop.value("type", "text");
  auto option_id = [&](const std::string& name) {
    if (!prop.contains("options") || !prop["options"].is_array()) prop["options"] = json::array();
    for (const auto& o : prop["options"])
      if (o.value("name", "") == name || o.value("id", "") == name) return o.value("id", "");
    std::string id = random_id();
    prop["options"].push_back({{"id", id}, {"name", name}, {"color", "gray"}});
    return id;
  };
  if (type == "select" || type == "status") return v.is_string() ? json(option_id(v.get<std::string>())) : json(nullptr);
  if (type == "multi_select") {
    json ids = json::array();
    if (v.is_array()) {
      for (const auto& x : v)
        if (x.is_string()) ids.push_back(option_id(x.get<std::string>()));
    } else if (v.is_string()) {
      std::stringstream ss(v.get<std::string>());
      std::string part;
      while (std::getline(ss, part, ','))
        if (auto b = part.find_first_not_of(' '); b != std::string::npos) ids.push_back(option_id(part.substr(b)));
    }
    return ids;
  }
  if (type == "checkbox") return v.is_boolean() ? v : json(v.is_string() && (v == "true" || v == "ja" || v == "yes"));
  if (type == "number") {
    if (v.is_number()) return v;
    if (v.is_string()) try { return std::stod(v.get<std::string>()); } catch (...) {}
    return nullptr;
  }
  return v.is_string() ? v : json(v.dump());
}

}  // namespace

json Service::databases(int64_t note_id) {
  auto n = store_.get(note_id);
  if (!n) throw ServiceError(404, "note not found");
  json doc = parse_content(n->content);
  std::vector<json*> dbs;
  find_databases(doc, dbs);
  json out = json::array();
  for (json* db : dbs) {
    const json& a = (*db)["attrs"];
    json props = json::array();
    for (const auto& p : a.value("properties", json::array())) {
      json pj = {{"name", p.value("name", "")}, {"type", p.value("type", "")}};
      if (p.contains("options")) {
        json names = json::array();
        for (const auto& o : p["options"]) names.push_back(o.value("name", ""));
        pj["options"] = names;
      }
      if (p.contains("formula")) pj["formula"] = p["formula"];
      props.push_back(pj);
    }
    out.push_back({{"id", a.value("id", "")}, {"title", a.value("title", "")}, {"properties", props}, {"rows", display_rows(a)}});
  }
  return out;
}

json Service::upsert_database_row(int64_t note_id, const std::string& db_id, const std::string& row_id, const json& values) {
  auto n = store_.get(note_id);
  if (!n) throw ServiceError(404, "note not found");
  if (!values.is_object()) throw ServiceError(400, "values must be an object of property name → value");
  json doc = parse_content(n->content);
  std::vector<json*> dbs;
  find_databases(doc, dbs);
  json* db = nullptr;
  for (json* d : dbs)
    if (db_id.empty() || (*d)["attrs"].value("id", "") == db_id) db = d;
  if (!db) throw ServiceError(404, "database not found");
  json& attrs = (*db)["attrs"];
  if (!attrs.contains("rows")) attrs["rows"] = json::array();

  json* row = nullptr;
  for (auto& r : attrs["rows"])
    if (!row_id.empty() && r.value("id", "") == row_id) row = &r;
  if (!row_id.empty() && !row) throw ServiceError(404, "row not found");
  if (!row) {
    attrs["rows"].push_back({{"id", random_id()}, {"cells", json::object()}});
    row = &attrs["rows"].back();
  }
  for (const auto& [name, v] : values.items()) {
    json* prop = nullptr;
    for (auto& p : attrs["properties"])
      if (p.value("name", "") == name) prop = &p;
    if (!prop) throw ServiceError(400, "unknown property: " + name);
    if (prop->value("type", "") == "formula") continue;
    (*row)["cells"][prop->value("id", "")] = to_cell(*prop, v);
  }
  std::string id = (*row).value("id", "");
  update_note(note_id, n->title, doc.dump());
  return {{"row_id", id}, {"rows", display_rows(attrs)}};
}

// ---- folders & subpages ---------------------------------------------------------

json Service::tree() {
  json folders = json::array();
  for (const auto& f : vault_.folders()) folders.push_back(f);
  json meta = json::object();
  for (const auto& m : store_.folder_meta()) meta[m.path] = {{"color", m.color}, {"icon", m.icon}};
  return {{"folders", folders}, {"folder_meta", meta}, {"notes", list_notes()}};
}

json Service::move_note(int64_t id, const std::string& folder) {
  if (!store_.get(id)) throw ServiceError(404, "note not found");
  vault_.export_note(id, folder);
  for (const auto& n : store_.list())
    if (n.id == id) return to_json(n);
  throw ServiceError(404, "note not found");
}

json Service::create_subpage(int64_t parent_id, const std::string& title, const std::string& content) {
  if (!store_.get(parent_id)) throw ServiceError(404, "parent note not found");
  auto folder = vault_.subpage_folder(parent_id);
  return create_note(title, content, folder.value_or(""));
}

std::string Service::create_folder(const std::string& path) {
  try {
    return vault_.create_folder(path);
  } catch (const std::exception& e) {
    throw ServiceError(400, e.what());
  }
}

void Service::rename_folder(const std::string& from, const std::string& to) {
  try {
    vault_.rename_folder(from, to);
    store_.move_folder_meta(Vault::clean_folder(from), Vault::clean_folder(to));
  } catch (const std::exception& e) {
    throw ServiceError(400, e.what());
  }
}

void Service::delete_folder(const std::string& path) {
  if (Vault::clean_folder(path).empty()) throw ServiceError(400, "invalid folder");
  // Move the files first: if that fails nothing is deleted, and a vault scan in between cannot re-import them.
  std::vector<int64_t> ids = vault_.notes_in(path);
  try {
    vault_.trash_folder(path);  // files (incl. non-notes) go to .trash as a whole
  } catch (const std::exception& e) {
    throw ServiceError(500, e.what());
  }
  for (int64_t id : ids) {
    store_.remove(id);
    semantic_.note_removed(id);
  }
  store_.remove_folder_meta(Vault::clean_folder(path));
}

void Service::set_folder_meta(const std::string& path, const std::string& color, const std::string& icon) {
  std::string clean = Vault::clean_folder(path);
  if (clean.empty()) throw ServiceError(400, "invalid folder");
  if (color.size() > 32 || icon.size() > 32) throw ServiceError(400, "colour or icon too long");
  store_.set_folder_meta({clean, color, icon});
}

json Service::update_note(int64_t id, const std::string& title, const std::string& content) {
  validate_content(title, content);
  auto n = store_.update(id, title, content);
  if (!n) throw ServiceError(404, "note not found");
  changed(id);
  return to_json(*n);
}

json Service::update_note_markdown(int64_t id, const std::string& title, const std::string& markdown) {
  return update_note(id, title, markdown_to_doc(markdown).dump());
}

void Service::delete_note(int64_t id) {
  if (!store_.get(id)) throw ServiceError(404, "note not found");
  vault_.remove_note(id);
  store_.remove(id);
  semantic_.note_removed(id);
}

json Service::backlinks(int64_t id) { return arr(store_.backlinks(id)); }

json Service::similar(int64_t id, size_t k) { return arr(store_.titles_for(semantic_.similar(id, k))); }

json Service::related(int64_t id) {
  auto n = store_.get(id);
  if (!n) throw ServiceError(404, "note not found");
  json links = json::array();
  for (const auto& t : extract_wikilinks(plain_text(parse_content(n->content))))
    links.push_back({{"title", t}, {"id", find_note(t) ? json(find_note(t)) : json(nullptr)}});
  return {{"links", links}, {"backlinks", backlinks(id)}, {"similar", similar(id, 6)}};
}

json Service::search(const std::string& q) {
  json a = json::array();
  for (const auto& h : store_.search(q, 20)) a.push_back({{"id", h.id}, {"title", h.title}, {"snippet", h.snippet}});
  return a;
}

json Service::semantic_search(const std::string& q, size_t k) { return arr(store_.titles_for(semantic_.search(q, k))); }

json Service::graph() {
  Graph g = store_.graph();
  json edges = json::array();
  for (const auto& e : g.edges)
    edges.push_back({{"source", e.source}, {"target", e.target}, {"kind", e.kind}, {"weight", e.weight}});
  return {{"nodes", arr(g.nodes)}, {"edges", edges}};
}

// ---- flashcards ------------------------------------------------------------------

json Service::note_cards(int64_t note_id) { return arr(store_.note_cards(note_id)); }

json Service::review_queue(const CardScope& scope, int limit) {
  int64_t now = now_ms();
  json a = json::array();
  for (const auto& c : store_.review_queue(now, kNewCardsPerDay, limit, scope)) {
    json j = to_json(c);
    json preview = json::object();
    for (int r = fsrs::Again; r <= fsrs::Easy; ++r)
      preview[std::to_string(r)] = fsrs::review(c.sched, static_cast<fsrs::Rating>(r), now, {}, c.exam_date).due - now;
    j["intervals"] = preview;
    a.push_back(j);
  }
  return a;
}

json Service::review_stats(const CardScope& scope) {
  ReviewStats st = store_.review_stats(now_ms(), kNewCardsPerDay, scope);
  return {{"due", st.due}, {"new", st.new_available}, {"total", st.total}, {"reviewed_today", st.reviewed_today}};
}

namespace {

// Question and answer of a card as one line of prose.
std::string card_answer(const Card& c) {
  if (c.kind == "list") {
    std::string out;
    for (const auto& i : c.data.value("items", json::array())) out += (out.empty() ? "" : "; ") + i.get<std::string>();
    return out;
  }
  if (c.kind == "cloze") {
    std::string out;
    for (const auto& s : c.data.value("segments", json::array())) out += s.value("cloze", "");
    return out;
  }
  return c.data.value("back", "");
}

std::string card_text(const Card& c) {
  if (c.kind == "cloze") {
    std::string out;
    for (const auto& s : c.data.value("segments", json::array())) out += s.contains("cloze") ? s.value("cloze", "") : s.value("text", "");
    return out;
  }
  return c.front + " – " + card_answer(c);
}

std::string squash(std::string s) {
  std::string out;
  for (unsigned char ch : s)
    if (!std::isspace(ch) && !std::ispunct(ch)) out += static_cast<char>(std::tolower(ch));
  return out;
}

}  // namespace

json Service::confusables(const CardScope& scope, size_t limit) {
  if (!semantic_.enabled()) return {{"enabled", false}, {"pending", 0}, {"pairs", json::array()}};
  constexpr size_t kEmbedPerCall = 250;  // keeps the first request on a large collection responsive
  constexpr size_t kMaxCards = 3000;
  const std::string model = semantic_.model();

  std::vector<Card> cards;
  for (auto& c : store_.cards_in(scope)) {
    // an image has no text to compare; the reverse card is the same knowledge as its basic card
    if (c.kind == "occlusion" || c.kind == "reverse") continue;
    if (cards.size() < kMaxCards) cards.push_back(std::move(c));
  }

  auto cached = store_.card_embeddings(model);
  std::vector<std::string> texts(cards.size());
  std::vector<size_t> todo;
  for (size_t i = 0; i < cards.size(); ++i) {
    texts[i] = card_text(cards[i]);
    auto it = cached.find(cards[i].id);
    if (it == cached.end() || it->second.text != texts[i]) todo.push_back(i);
  }
  size_t pending = todo.size() > kEmbedPerCall ? todo.size() - kEmbedPerCall : 0;
  if (todo.size() > kEmbedPerCall) todo.resize(kEmbedPerCall);
  if (!todo.empty()) {
    std::vector<std::string> batch;
    for (size_t i : todo) batch.push_back(texts[i]);
    auto vecs = semantic_.embed_all(batch);
    for (size_t k = 0; k < todo.size() && k < vecs.size(); ++k) {
      CardEmbedding e{batch[k], std::move(vecs[k])};
      store_.save_card_embedding(cards[todo[k]].id, model, e);
      cached[cards[todo[k]].id] = std::move(e);
    }
  }

  // "Easy to mix up" = clearly about the same thing (above the model's "related" level by a margin),
  // but not the same card written twice, and with different answers.
  const double t = semantic_.link_threshold();
  const double lo = t + 0.25 * (1 - t), hi = 0.985;
  struct Pair {
    size_t a, b;
    double sim, score;
  };
  std::vector<Pair> found;
  std::vector<const std::vector<float>*> vec(cards.size(), nullptr);
  std::vector<std::string> answer(cards.size());
  for (size_t i = 0; i < cards.size(); ++i) {
    auto it = cached.find(cards[i].id);
    if (it != cached.end() && it->second.text == texts[i]) vec[i] = &it->second.vec;
    answer[i] = squash(card_answer(cards[i]));
  }
  for (size_t i = 0; i < cards.size(); ++i) {
    if (!vec[i]) continue;
    for (size_t j = i + 1; j < cards.size(); ++j) {
      if (!vec[j] || vec[i]->size() != vec[j]->size()) continue;
      double sim = 0;
      for (size_t d = 0; d < vec[i]->size(); ++d) sim += double((*vec[i])[d]) * (*vec[j])[d];
      if (sim < lo || sim >= hi || answer[i] == answer[j]) continue;
      // cards you have already got wrong are the likelier mix-ups
      int lapses = std::min(5, cards[i].sched.lapses + cards[j].sched.lapses);
      found.push_back({i, j, sim, sim + 0.03 * lapses});
    }
  }
  std::sort(found.begin(), found.end(), [](const Pair& x, const Pair& y) { return x.score > y.score; });

  json pairs = json::array();
  std::set<size_t> used;  // each card at most once per session
  for (const auto& p : found) {
    if (pairs.size() >= limit) break;
    if (used.count(p.a) || used.count(p.b)) continue;
    used.insert(p.a);
    used.insert(p.b);
    pairs.push_back({{"a", to_json(cards[p.a])}, {"b", to_json(cards[p.b])}, {"similarity", p.sim}});
  }
  return {{"enabled", true}, {"pending", pending}, {"pairs", pairs}, {"candidates", found.size()}};
}

json Service::explain(int64_t note_id, const std::string& explanation) {
  auto n = store_.get(note_id);
  if (!n) throw ServiceError(404, "note not found");
  if (explanation.size() > 100'000) throw ServiceError(400, "explanation too long");
  json doc = parse_content(n->content);
  json previous = nullptr;
  if (auto last = store_.last_explain_attempt(note_id)) previous = {{"ts", last->first}, {"score", last->second}};

  bool blank = explanation.find_first_not_of(" \t\r\n") == std::string::npos;
  if (blank) {
    auto passages = explain_passages(doc);
    json headings = json::array();
    for (const auto& p : passages)
      if (!p.heading.empty() && (headings.empty() || headings.back() != p.heading)) headings.push_back(p.heading);
    return {{"passages", passages.size()}, {"headings", headings}, {"previous", previous}, {"semantic", semantic_.enabled()}};
  }

  EmbedFn embed;
  if (semantic_.enabled()) embed = [this](const std::vector<std::string>& texts) { return semantic_.embed_all(texts); };
  ExplainResult r = explain_compare(doc, explanation, embed, semantic_.link_threshold());
  if (r.passages.empty()) throw ServiceError(400, "this note has no text to explain");
  store_.add_explain_attempt(note_id, now_ms(), r.score);

  json passages = json::array();
  for (const auto& p : r.passages)
    passages.push_back({{"heading", p.heading}, {"text", p.text}, {"status", p.status}, {"missing_terms", p.missing_terms}});
  return {{"score", r.score}, {"semantic", r.semantic}, {"passages", passages}, {"previous", previous}};
}

json Service::mastery(int64_t at_ms, int study_minutes) {
  json a = json::array();
  int64_t now = now_ms();
  for (const auto& m : store_.note_mastery(now, at_ms > now ? at_ms : now, std::clamp(study_minutes, 0, 600)))
    a.push_back({{"note_id", m.note_id}, {"cards", m.cards}, {"new", m.new_cards}, {"due", m.due}, {"retention", m.retention}});
  return a;
}

json Service::review_card(int64_t card_id, int rating) {
  if (rating < fsrs::Again || rating > fsrs::Easy) throw ServiceError(400, "rating must be 1..4");
  auto c = store_.review_card(card_id, static_cast<fsrs::Rating>(rating), now_ms());
  if (!c) throw ServiceError(404, "card not found");
  return to_json(*c);
}

// ---- exams -------------------------------------------------------------------------

json Service::exam_json(const Exam& e) {
  ExamProgress p = store_.exam_progress(e, now_ms());
  json notes = json::array();
  for (int64_t id : e.note_ids)
    if (auto n = store_.get(id)) notes.push_back({{"id", id}, {"title", n->title}});
  return {{"id", e.id},
          {"name", e.name},
          {"date", e.date},
          {"notes", notes},
          {"progress",
           {{"cards", p.cards},
            {"new", p.new_cards},
            {"due", p.due},
            {"mastered", p.mastered},
            {"new_today", p.new_today},
            {"predicted_retention", p.predicted_retention}}}};
}

void Service::parse_exam(const json& body, std::string& name, int64_t& date, std::vector<int64_t>& notes) {
  if (!body.is_object()) throw ServiceError(400, "invalid JSON");
  name = body.value("name", "");
  if (name.empty()) throw ServiceError(400, "name is required");
  if (!body.contains("date")) throw ServiceError(400, "date is required");
  date = parse_date(body["date"]);
  std::set<int64_t> ids;
  for (const auto& id : body.value("note_ids", json::array()))
    if (id.is_number_integer()) ids.insert(id.get<int64_t>());
  for (const auto& t : body.value("note_titles", json::array())) {
    int64_t id = t.is_string() ? find_note(t.get<std::string>()) : 0;
    if (!id) throw ServiceError(404, "note not found: " + t.dump());
    ids.insert(id);
  }
  notes.assign(ids.begin(), ids.end());
}

json Service::list_exams() {
  json a = json::array();
  for (const auto& e : store_.list_exams()) a.push_back(exam_json(e));
  return a;
}

json Service::get_exam(int64_t id) {
  auto e = store_.exam(id);
  if (!e) throw ServiceError(404, "exam not found");
  return exam_json(*e);
}

json Service::create_exam(const json& body) {
  std::string name;
  int64_t date;
  std::vector<int64_t> notes;
  parse_exam(body, name, date, notes);
  return exam_json(store_.create_exam(name, date, notes));
}

json Service::update_exam(int64_t id, const json& body) {
  std::string name;
  int64_t date;
  std::vector<int64_t> notes;
  parse_exam(body, name, date, notes);
  auto e = store_.update_exam(id, name, date, notes);
  if (!e) throw ServiceError(404, "exam not found");
  return exam_json(*e);
}

void Service::delete_exam(int64_t id) {
  if (!store_.delete_exam(id)) throw ServiceError(404, "exam not found");
}

json Service::status() {
  return {{"semantic",
           {{"enabled", semantic_.enabled()},
            {"model", semantic_.model()},
            {"indexed", semantic_.indexed()},
            {"pending", semantic_.pending()}}},
          {"vault", fs::absolute(vault_.root()).string()}};
}

std::string Service::save_upload(const std::string& filename, const std::string& data) {
  std::string ext = fs::path(filename).extension().string();
  for (auto& ch : ext) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  static const std::set<std::string> allowed = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"};
  if (!allowed.count(ext)) throw ServiceError(400, "unsupported image type");

  static std::mt19937_64 rng{std::random_device{}()};
  static std::mutex mu;
  char buf[17];
  {
    std::lock_guard lock(mu);
    std::snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(rng()));
  }
  std::string name = buf + ext;
  std::ofstream(vault_.attachments() / name, std::ios::binary).write(data.data(), static_cast<std::streamsize>(data.size()));
  return "/uploads/" + name;
}
