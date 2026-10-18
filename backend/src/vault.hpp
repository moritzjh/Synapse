#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "note_store.hpp"

// Mirrors every note to a Markdown file in a folder that can be opened as an
// Obsidian vault, and imports edits made there:
//
//   vault/
//     Zellbiologie.md          ← one file per note, file name = title
//     Ordner/Mitose.md         ← subfolders are kept
//     attachments/ab12….png    ← uploaded images
//
// Each file carries `synapse-id` in its front matter so renames in Obsidian
// keep the note (and its flashcard history). The folder is polled every
// two seconds; files changed by other apps are re-imported.
class Vault {
 public:
  using Callback = std::function<void(int64_t note_id)>;

  Vault(NoteStore& store, std::filesystem::path root, Callback on_changed, Callback on_removed);
  ~Vault();

  // Initial sync plus background watcher.
  void start();

  // Called after a note was created/updated through the API.
  void export_note(int64_t id);
  // Called before a note is deleted through the API.
  void remove_note(int64_t id);

  const std::filesystem::path& root() const { return root_; }
  std::filesystem::path attachments() const { return root_ / "attachments"; }

  // One polling pass (public for tests).
  void scan();

 private:
  void export_locked(const Note& note, const std::optional<VaultEntry>& entry);
  void import_file(const std::string& rel, const std::string& text, int64_t mtime, std::optional<int64_t> note_id);
  std::string unique_path(const std::string& wanted, int64_t note_id);
  void watch();

  NoteStore& store_;
  std::filesystem::path root_;
  Callback on_changed_, on_removed_;

  std::mutex mu_;
  std::mutex stop_mu_;
  std::condition_variable stop_cv_;
  bool stop_ = false;
  std::thread thread_;
};
