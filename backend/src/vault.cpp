#include "vault.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>

#include "content.hpp"
#include "markdown.hpp"

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

constexpr auto kPollInterval = std::chrono::seconds(2);
const std::string kIdKey = "synapse-id:";

std::string hash_hex(const std::string& s) {
  uint64_t h = 1469598103934665603ull;  // FNV-1a
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ull;
  }
  char buf[17];
  std::snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(h));
  return buf;
}

int64_t mtime_of(const fs::path& p) {
  std::error_code ec;
  auto t = fs::last_write_time(p, ec);
  return ec ? 0 : static_cast<int64_t>(t.time_since_epoch().count());
}

std::optional<std::string> read_file(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  if (!in) return std::nullopt;
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

// Write via a temp file + rename so readers (Obsidian, our scanner) never see half a file.
void write_atomic(const fs::path& p, const std::string& text) {
  fs::create_directories(p.parent_path());
  fs::path tmp = p;
  tmp += ".synapse-tmp";
  {
    std::ofstream out(tmp, std::ios::binary);
    out << text;
  }
  fs::rename(tmp, p);
}

struct Parsed {
  std::vector<std::string> front;  // front-matter lines other than synapse-id
  std::optional<int64_t> id;
  std::string body;
};

Parsed parse_file(const std::string& text) {
  Parsed p;
  p.body = text;
  if (text.rfind("---\n", 0) != 0 && text.rfind("---\r\n", 0) != 0) return p;
  std::istringstream in(text);
  std::string line;
  std::getline(in, line);  // opening ---
  size_t consumed = line.size() + 1;
  bool closed = false;
  while (std::getline(in, line)) {
    consumed += line.size() + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line == "---") {
      closed = true;
      break;
    }
    if (line.rfind(kIdKey, 0) == 0) {
      try {
        p.id = std::stoll(line.substr(kIdKey.size()));
      } catch (...) {
      }
    } else {
      p.front.push_back(line);
    }
  }
  if (!closed) return Parsed{{}, std::nullopt, text};
  p.body = consumed < text.size() ? text.substr(consumed) : "";
  while (!p.body.empty() && (p.body.front() == '\n' || p.body.front() == '\r')) p.body.erase(0, 1);
  return p;
}

std::string compose(int64_t id, const std::vector<std::string>& front, const std::string& body) {
  std::string out = "---\n" + kIdKey + " " + std::to_string(id) + "\n";
  for (const auto& l : front) out += l + "\n";
  return out + "---\n\n" + body;
}

const std::string kUntitled = "Ohne Titel";

std::string file_stem(const std::string& title) {
  std::string out;
  for (char c : title) out += std::string("/\\:*?\"<>|#^[]").find(c) != std::string::npos ? '-' : c;
  size_t b = out.find_first_not_of(" ."), e = out.find_last_not_of(" .");
  out = b == std::string::npos ? "" : out.substr(b, e - b + 1);
  return out.empty() ? kUntitled : out.substr(0, 120);
}

// "Ohne Titel", "Ohne Titel 2", … – file names given to notes without a title.
bool is_untitled_stem(const std::string& stem) {
  if (stem.rfind(kUntitled, 0) != 0) return false;
  std::string rest = stem.substr(kUntitled.size());
  return rest.empty() || (rest.size() > 1 && rest[0] == ' ' && rest.find_first_not_of("0123456789", 1) == std::string::npos);
}

bool skip_dir(const fs::path& p) {
  std::string n = p.filename().string();
  return n.empty() || n[0] == '.' || n == "attachments" || n == "node_modules";
}

}  // namespace

Vault::Vault(NoteStore& store, fs::path root, Callback on_changed, Callback on_removed)
    : store_(store), root_(std::move(root)), on_changed_(std::move(on_changed)), on_removed_(std::move(on_removed)) {
  fs::create_directories(attachments());
}

Vault::~Vault() {
  {
    std::lock_guard lock(stop_mu_);
    stop_ = true;
  }
  stop_cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void Vault::start() {
  scan();  // pick up edits made while we were not running
  {
    std::lock_guard lock(mu_);
    std::set<int64_t> mirrored;
    for (const auto& e : store_.vault_entries()) mirrored.insert(e.note_id);
    int exported = 0;
    for (const auto& n : store_.list()) {
      if (mirrored.count(n.id)) continue;
      if (auto note = store_.get(n.id)) {
        export_locked(*note, std::nullopt);
        ++exported;
      }
    }
    std::cout << "vault: " << fs::absolute(root_).string() << " (" << exported << " notes exported)\n";
  }
  thread_ = std::thread([this] { watch(); });
}

void Vault::watch() {
  std::unique_lock lock(stop_mu_);
  while (!stop_) {
    stop_cv_.wait_for(lock, kPollInterval);
    if (stop_) break;
    lock.unlock();
    try {
      scan();
    } catch (const std::exception& e) {
      std::cerr << "vault scan failed: " << e.what() << "\n";
    }
    lock.lock();
  }
}

std::string Vault::unique_path(const std::string& wanted, int64_t note_id) {
  std::map<std::string, int64_t> owner;
  for (const auto& e : store_.vault_entries()) owner[e.path] = e.note_id;
  fs::path w(wanted);
  for (int n = 1;; ++n) {
    fs::path cand = n == 1 ? w : w.parent_path() / (w.stem().string() + " " + std::to_string(n) + ".md");
    std::string rel = cand.generic_string();
    auto it = owner.find(rel);
    bool ours = it != owner.end() && it->second == note_id;
    if (ours || (it == owner.end() && !fs::exists(root_ / cand))) return rel;
  }
}

std::string Vault::clean_folder(const std::string& rel) {
  std::string out;
  std::stringstream ss(rel);
  std::string part;
  while (std::getline(ss, part, '/')) {
    if (part.empty() || part == "." || part == "..") continue;
    std::string clean = file_stem(part);
    if (clean.empty() || clean[0] == '.' || clean == "attachments") continue;
    out += (out.empty() ? "" : "/") + clean;
  }
  return out;
}

// Re-points every vault entry below folder `from` to `to` after a directory move.
void Vault::move_prefix(const std::string& from, const std::string& to) {
  std::string prefix = from + "/";
  for (auto e : store_.vault_entries()) {
    if (e.path.rfind(prefix, 0) != 0) continue;
    e.path = to + "/" + e.path.substr(prefix.size());
    store_.set_vault_entry(e);
  }
}

void Vault::export_locked(const Note& note, const std::optional<VaultEntry>& entry,
                          const std::optional<std::string>& folder) {
  fs::path dir = folder ? fs::path(*folder) : entry ? fs::path(entry->path).parent_path() : fs::path();
  std::string rel = unique_path((dir / (file_stem(note.title) + ".md")).generic_string(), note.id);

  // Keep front matter written by other tools (tags, aliases, …).
  std::vector<std::string> front;
  if (entry)
    if (auto old = read_file(root_ / entry->path)) front = parse_file(*old).front;

  std::string text = compose(note.id, front, doc_to_markdown(parse_content(note.content)));
  write_atomic(root_ / rel, text);
  if (entry && entry->path != rel) {
    std::error_code ec;
    fs::remove(root_ / entry->path, ec);
    // Subpages travel with their note: "Old.md" + "Old/" → "New.md" + "New/".
    fs::path old_sub = fs::path(entry->path).replace_extension();
    fs::path new_sub = fs::path(rel).replace_extension();
    if (fs::is_directory(root_ / old_sub) && !fs::exists(root_ / new_sub)) {
      fs::create_directories((root_ / new_sub).parent_path(), ec);
      fs::rename(root_ / old_sub, root_ / new_sub, ec);
      if (!ec) move_prefix(old_sub.generic_string(), new_sub.generic_string());
    }
  }
  store_.set_vault_entry({note.id, rel, hash_hex(text), mtime_of(root_ / rel)});
}

std::vector<std::string> Vault::folders() {
  std::lock_guard lock(mu_);
  std::vector<std::string> out;
  if (!fs::is_directory(root_)) return out;
  for (auto it = fs::recursive_directory_iterator(root_); it != fs::recursive_directory_iterator(); ++it) {
    if (!it->is_directory()) continue;
    if (skip_dir(it->path())) {
      it.disable_recursion_pending();
      continue;
    }
    out.push_back(fs::relative(it->path(), root_).generic_string());
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::string Vault::create_folder(const std::string& rel) {
  std::string clean = clean_folder(rel);
  if (clean.empty()) throw std::runtime_error("invalid folder name");
  std::lock_guard lock(mu_);
  fs::create_directories(root_ / clean);
  return clean;
}

void Vault::rename_folder(const std::string& from, const std::string& to) {
  std::string a = clean_folder(from), b = clean_folder(to);
  if (a.empty() || b.empty()) throw std::runtime_error("invalid folder name");
  if (b == a || b.rfind(a + "/", 0) == 0) throw std::runtime_error("cannot move a folder into itself");
  std::lock_guard lock(mu_);
  if (!fs::is_directory(root_ / a)) throw std::runtime_error("folder not found");
  if (fs::exists(root_ / b)) throw std::runtime_error("target exists");
  fs::create_directories((root_ / b).parent_path());
  fs::rename(root_ / a, root_ / b);
  move_prefix(a, b);
}

std::vector<int64_t> Vault::notes_in(const std::string& rel) {
  std::string prefix = clean_folder(rel) + "/";
  std::vector<int64_t> out;
  for (const auto& e : store_.vault_entries())
    if (e.path.rfind(prefix, 0) == 0) out.push_back(e.note_id);
  return out;
}

void Vault::trash_folder(const std::string& rel) {
  std::string clean = clean_folder(rel);
  if (clean.empty()) return;
  std::lock_guard lock(mu_);
  fs::path trash = root_ / ".trash" / clean;
  std::error_code ec;
  if (fs::exists(trash)) fs::remove_all(trash, ec);
  fs::create_directories(trash.parent_path(), ec);
  fs::rename(root_ / clean, trash, ec);
}

std::optional<std::string> Vault::subpage_folder(int64_t id) {
  for (const auto& e : store_.vault_entries())
    if (e.note_id == id) return fs::path(e.path).replace_extension().generic_string();
  return std::nullopt;
}

void Vault::export_note(int64_t id, std::optional<std::string> folder) {
  std::lock_guard lock(mu_);
  auto note = store_.get(id);
  if (!note) return;
  std::optional<VaultEntry> entry;
  for (const auto& e : store_.vault_entries())
    if (e.note_id == id) entry = e;
  if (folder) {
    *folder = clean_folder(*folder);
    if (!folder->empty()) fs::create_directories(root_ / *folder);
  }
  export_locked(*note, entry, folder);
}

void Vault::remove_note(int64_t id) {
  std::lock_guard lock(mu_);
  for (const auto& e : store_.vault_entries()) {
    if (e.note_id != id) continue;
    // Like Obsidian: deleted notes go to .trash instead of vanishing.
    fs::path trash = root_ / ".trash" / e.path;
    std::error_code ec;
    fs::create_directories(trash.parent_path(), ec);
    fs::rename(root_ / e.path, trash, ec);
  }
}

void Vault::import_file(const std::string& rel, const std::string& text, int64_t mtime, std::optional<int64_t> note_id) {
  Parsed p = parse_file(text);
  std::string title = fs::path(rel).stem().string();
  std::string content = markdown_to_doc(p.body).dump();
  // A note without a title lives in "Ohne Titel.md" – keep its title empty.
  if (note_id && is_untitled_stem(title))
    if (auto existing = store_.get(*note_id); existing && existing->title.empty()) title.clear();

  int64_t id;
  std::string final_text = text;
  if (note_id && store_.update(*note_id, title, content)) {
    id = *note_id;
  } else {
    id = store_.create(title, content).id;
  }
  if (p.id != id) {
    // New file (or copied one): stamp our id into its front matter.
    final_text = compose(id, p.front, p.body);
    write_atomic(root_ / rel, final_text);
    mtime = mtime_of(root_ / rel);
  }
  store_.set_vault_entry({id, rel, hash_hex(final_text), mtime});
  on_changed_(id);
}

void Vault::scan() {
  std::lock_guard lock(mu_);
  if (!fs::is_directory(root_)) return;

  auto entries = store_.vault_entries();
  std::map<std::string, VaultEntry> by_path;
  std::map<int64_t, VaultEntry> by_id;
  for (const auto& e : entries) {
    by_path[e.path] = e;
    by_id[e.note_id] = e;
  }

  std::set<std::string> seen;
  std::set<int64_t> moved;
  for (auto it = fs::recursive_directory_iterator(root_); it != fs::recursive_directory_iterator(); ++it) {
    if (it->is_directory()) {
      if (skip_dir(it->path())) it.disable_recursion_pending();
      continue;
    }
    if (it->path().extension() != ".md") continue;
    std::string rel = fs::relative(it->path(), root_).generic_string();
    seen.insert(rel);
    int64_t mtime = mtime_of(it->path());

    if (auto e = by_path.find(rel); e != by_path.end()) {
      if (e->second.mtime == mtime) continue;
      auto text = read_file(it->path());
      if (!text) continue;
      std::string h = hash_hex(*text);
      if (h == e->second.hash) {
        store_.set_vault_entry({e->second.note_id, rel, h, mtime});
      } else {
        import_file(rel, *text, mtime, e->second.note_id);
      }
      continue;
    }

    // A file we have not seen: a renamed/moved note, or a brand-new one.
    auto text = read_file(it->path());
    if (!text) continue;
    std::optional<int64_t> target;
    if (auto id = parse_file(*text).id) {
      auto e = by_id.find(*id);
      bool old_file_gone = e == by_id.end() || !fs::exists(root_ / e->second.path);
      if (old_file_gone && store_.get(*id)) {
        target = *id;
        moved.insert(*id);
      }
    }
    import_file(rel, *text, mtime, target);
  }

  // Files deleted in another app delete the note – unless it looks like the
  // whole folder went missing (e.g. an unmounted drive).
  std::vector<int64_t> gone;
  for (const auto& e : entries)
    if (!seen.count(e.path) && !moved.count(e.note_id)) gone.push_back(e.note_id);
  if (gone.empty()) return;
  if (gone.size() > 3 && gone.size() * 2 > entries.size()) {
    std::cerr << "vault: " << gone.size() << " files missing – not deleting notes (folder unavailable?)\n";
    return;
  }
  for (int64_t id : gone) {
    store_.remove(id);
    on_removed_(id);
  }
}
