#pragma once

#include <json.hpp>
#include <stdexcept>
#include <string>

#include "note_store.hpp"
#include "semantic_index.hpp"
#include "vault.hpp"

// Error with an HTTP-style status, reported as JSON by the HTTP API and as a
// tool error by the MCP server.
struct ServiceError : std::runtime_error {
  ServiceError(int status, const std::string& msg) : std::runtime_error(msg), status(status) {}
  int status;
};

// Everything the app can do, in one place. The REST API (main.cpp) and the
// MCP server (mcp.cpp) are thin adapters over these methods, and every
// change to a note is propagated to the vault and the semantic index here.
class Service {
 public:
  Service(NoteStore& store, SemanticIndex& semantic, Vault& vault) : store_(store), semantic_(semantic), vault_(vault) {}

  static constexpr int kNewCardsPerDay = 20;

  // notes
  nlohmann::json list_notes();
  nlohmann::json get_note(int64_t id);                  // TipTap JSON content
  std::string note_markdown(int64_t id);                // body as Markdown
  int64_t find_note(const std::string& title);          // 0 if none
  nlohmann::json create_note(const std::string& title, const std::string& content);
  nlohmann::json create_note_markdown(const std::string& title, const std::string& markdown);
  nlohmann::json update_note(int64_t id, const std::string& title, const std::string& content);
  nlohmann::json update_note_markdown(int64_t id, const std::string& title, const std::string& markdown);
  void delete_note(int64_t id);

  nlohmann::json backlinks(int64_t id);
  nlohmann::json similar(int64_t id, size_t k = 8);
  nlohmann::json related(int64_t id);  // links + backlinks + similar
  nlohmann::json search(const std::string& q);
  nlohmann::json semantic_search(const std::string& q, size_t k = 10);
  nlohmann::json graph();

  // flashcards
  nlohmann::json note_cards(int64_t note_id);
  nlohmann::json review_queue(int64_t exam_id, int limit = 100);
  nlohmann::json review_stats(int64_t exam_id);
  nlohmann::json review_card(int64_t card_id, int rating);

  // exams
  nlohmann::json list_exams();
  nlohmann::json get_exam(int64_t id);
  nlohmann::json create_exam(const nlohmann::json& body);
  nlohmann::json update_exam(int64_t id, const nlohmann::json& body);
  void delete_exam(int64_t id);

  nlohmann::json status();

  // uploads
  std::string save_upload(const std::string& filename, const std::string& data);

 private:
  void changed(int64_t id);
  nlohmann::json exam_json(const Exam& e);
  void parse_exam(const nlohmann::json& body, std::string& name, int64_t& date, std::vector<int64_t>& notes);

  NoteStore& store_;
  SemanticIndex& semantic_;
  Vault& vault_;
};

int64_t now_ms();
// Accepts "2026-02-14", "2026-02-14T09:00" or unix milliseconds.
int64_t parse_date(const nlohmann::json& v);
