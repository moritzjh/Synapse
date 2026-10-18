#include "service.hpp"

#include <chrono>
#include <ctime>
#include <fstream>
#include <random>
#include <set>

#include "content.hpp"
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
json to_json(const NoteSummary& n) { return {{"id", n.id}, {"title", n.title}, {"updated_at", n.updated_at}}; }
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

json Service::create_note(const std::string& title, const std::string& content) {
  Note n = store_.create(title.empty() ? "Untitled" : title, content);
  changed(n.id);
  return to_json(n);
}

json Service::create_note_markdown(const std::string& title, const std::string& markdown) {
  return create_note(title, markdown_to_doc(markdown).dump());
}

json Service::update_note(int64_t id, const std::string& title, const std::string& content) {
  auto n = store_.update(id, title.empty() ? "Untitled" : title, content);
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

json Service::review_queue(int64_t exam_id, int limit) {
  int64_t now = now_ms();
  json a = json::array();
  for (const auto& c : store_.review_queue(now, kNewCardsPerDay, limit, exam_id)) {
    json j = to_json(c);
    json preview = json::object();
    for (int r = fsrs::Again; r <= fsrs::Easy; ++r)
      preview[std::to_string(r)] = fsrs::review(c.sched, static_cast<fsrs::Rating>(r), now, {}, c.exam_date).due - now;
    j["intervals"] = preview;
    a.push_back(j);
  }
  return a;
}

json Service::review_stats(int64_t exam_id) {
  ReviewStats st = store_.review_stats(now_ms(), kNewCardsPerDay, exam_id);
  return {{"due", st.due}, {"new", st.new_available}, {"total", st.total}, {"reviewed_today", st.reviewed_today}};
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
