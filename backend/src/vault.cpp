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
  for (char c : title) {
    auto u = static_cast<unsigned char>(c);
    bool bad = u < 0x20 || u == 0x7f || std::string("/\\:*?\"<>|#^[]").find(c) != std::string::npos;
    out += bad ? '-' : c;
  }
  auto trim = [](std::string s) {
    size_t b = s.find_first_not_of(" ."), e = s.find_last_not_of(" .");
    return b == std::string::npos ? std::string() : s.substr(b, e - b + 1);
  };
  out = trim(out);
  if (out.size() > 120) {
    // cut on a character boundary, never inside a multi-byte UTF-8 sequence
    size_t cut = 120;
    while (cut > 0 && (static_cast<unsigned char>(out[cut]) & 0xC0) == 0x80) --cut;
    out = trim(out.substr(0, cut));
  }
  return out.empty() ? kUntitled : out;
}

// Replaces bytes that are not valid UTF-8 (e.g. a Latin-1 file) with U+FFFD, so one odd file cannot break JSON output.
std::string sanitize_utf8(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  size_t i = 0;
  while (i < s.size()) {
    auto c = static_cast<unsigned char>(s[i]);
    size_t len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
    bool ok = len > 0 && i + len <= s.size() && !(len == 2 && c < 0xC2) && !(len == 4 && c > 0xF4);
    for (size_t k = 1; ok && k < len; ++k) ok = (static_cast<unsigned char>(s[i + k]) & 0xC0) == 0x80;
    if (ok && len == 3) {
      auto c1 = static_cast<unsigned char>(s[i + 1]);
      ok = !(c == 0xE0 && c1 < 0xA0) && !(c == 0xED && c1 >= 0xA0);  // overlong / surrogates
    }
    if (ok && len == 4) {
      auto c1 = static_cast<unsigned char>(s[i + 1]);
      ok = !(c == 0xF0 && c1 < 0x90) && !(c == 0xF4 && c1 >= 0x90);
    }
    if (ok) {
      out.append(s, i, len);
      i += len;
    } else {
      out += "\xEF\xBF\xBD";
      ++i;
    }
  }
  return out;
}

// True if `stem` is the file name `title` is exported to, possibly with the " 2", " 3" … suffix of a duplicate.
bool stem_matches_title(const std::string& stem, const std::string& title) {
  std::string base = file_stem(title);
  if (stem == base) return true;
  if (stem.size() <= base.size() + 1 || stem.compare(0, base.size(), base) != 0 || stem[base.size()] != ' ') return false;
  return stem.find_first_not_of("0123456789", base.size() + 1) == std::string::npos;
}

// ".trash/Note.md" is taken → ".trash/Note 2.md": an earlier deleted item is never overwritten.
fs::path free_trash_path(const fs::path& wanted) {
  fs::path p = wanted;
  for (int n = 2; fs::exists(p); ++n)
    p = wanted.parent_path() / (wanted.stem().string() + " " + std::to_string(n) + wanted.extension().string());
  return p;
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
  try {
    scan();  // pick up edits made while we were not running
  } catch (const std::exception& e) {
    std::cerr << "vault scan failed: " << e.what() << "\n";
  }
  {
    std::lock_guard lock(mu_);
    std::set<int64_t> mirrored;
    for (const auto& e : store_.vault_entries()) mirrored.insert(e.note_id);
    int exported = 0;
    for (const auto& n : store_.list()) {
      if (mirrored.count(n.id)) continue;
      if (auto note = store_.get(n.id)) {
        try {
          export_locked(*note, std::nullopt);
          ++exported;
        } catch (const std::exception& e) {
          std::cerr << "vault: cannot export note " << n.id << ": " << e.what() << "\n";
        }
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
  // The file was edited in another app since we last read it and the poll has not picked that up yet:
  // keep that version as a conflict copy instead of silently overwriting it.
  if (entry) {
    if (auto disk = read_file(root_ / entry->path); disk && hash_hex(*disk) != entry->hash && *disk != text) {
      fs::path p(entry->path);
      std::string copy = unique_path((p.parent_path() / (p.stem().string() + " (conflict).md")).generic_string(), 0);
      write_atomic(root_ / copy, compose(0, parse_file(*disk).front, parse_file(*disk).body));
      std::cerr << "vault: " << entry->path << " changed on disk while being edited here – kept as " << copy << "\n";
    }
  }
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
  fs::path trash = free_trash_path(root_ / ".trash" / clean);
  std::error_code ec;
  fs::create_directories(trash.parent_path(), ec);
  fs::rename(root_ / clean, trash, ec);
  if (ec) throw std::runtime_error("cannot move folder to .trash: " + ec.message());
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
    fs::path trash = free_trash_path(root_ / ".trash" / e.path);
    std::error_code ec;
    fs::create_directories(trash.parent_path(), ec);
    fs::rename(root_ / e.path, trash, ec);
  }
}

void Vault::import_file(const std::string& rel, const std::string& raw, int64_t mtime, std::optional<int64_t> note_id) {
  std::string text = sanitize_utf8(raw);
  Parsed p = parse_file(text);
  std::string title = fs::path(rel).stem().string();
  std::string content = markdown_to_doc(p.body).dump();
  // The file name is a lossy form of the title ("A/B?" → "A-B", "" → "Ohne Titel", duplicates get " 2").
  // Unless the file was really renamed, the note keeps its own title.
  if (note_id)
    if (auto existing = store_.get(*note_id); existing && stem_matches_title(title, existing->title)) title = existing->title;

  int64_t id;
  std::string final_text = raw;
  if (note_id && store_.update(*note_id, title, content)) {
    id = *note_id;
  } else {
    id = store_.create(title, content).id;
  }
  if (p.id != id || text != raw) {
    // New file (or copied one): stamp our id into its front matter. Also rewrites files that were not valid UTF-8.
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

    // One unreadable or odd file must not stop the others from syncing.
    try {
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
    } catch (const std::exception& e) {
      if (failed_.insert(rel).second) std::cerr << "vault: cannot import " << rel << ": " << e.what() << "\n";
    }
  }

  // Files deleted in another app delete the note – but only once a file has stayed away for a few scans
  // (editors and sync tools briefly remove files while saving), and never when the whole vault is empty,
  // which looks like an unmounted drive rather than a clean-up.
  std::map<int64_t, int> still_missing;
  std::vector<int64_t> gone;
  for (const auto& e : entries) {
    if (seen.count(e.path) || moved.count(e.note_id)) continue;
    int scans = missing_[e.note_id] + 1;
    still_missing[e.note_id] = scans;
    if (scans >= kMissingScans) gone.push_back(e.note_id);
  }
  missing_ = std::move(still_missing);
  if (gone.empty()) return;
  if (seen.empty() && entries.size() > 3) {
    if (!warned_empty_) std::cerr << "vault: all " << entries.size() << " files are missing – not deleting notes (folder unavailable?)\n";
    warned_empty_ = true;
    return;
  }
  warned_empty_ = false;
  for (int64_t id : gone) {
    missing_.erase(id);
    store_.remove(id);
    on_removed_(id);
  }
}
