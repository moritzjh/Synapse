#pragma once

#include <json.hpp>
#include <string>
#include <vector>

// Note content is a TipTap/ProseMirror JSON document. Older notes (and API
// clients) may send plain text; it is converted to an equivalent document.
nlohmann::json parse_content(const std::string& content);

// Plain text of a document: one line per block, used for full-text search,
// [[wikilink]] extraction and embeddings.
std::string plain_text(const nlohmann::json& doc);

// Flashcards written RemNote-style inside a note:
//   Frage >> Antwort        basic card
//   Begriff :: Definition   two cards (forward + reverse)
//   Frage >>  + list below  "list" card: points are revealed one by one
//   Text mit {{Lücken}}     cloze card: every gap is covered and can be
//                           revealed individually
struct CardDraft {
  std::string key;   // stable identity within a note (kind + front)
  std::string kind;  // basic | reverse | list | cloze
  std::string front;
  nlohmann::json data;  // kind-specific payload shown on the back
};

std::vector<CardDraft> extract_cards(const nlohmann::json& doc);
