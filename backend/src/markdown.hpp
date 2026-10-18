#pragma once

#include <json.hpp>
#include <string>

// Conversion between note documents (TipTap JSON) and Obsidian-flavoured
// Markdown: GFM tables, task lists, ~~strike~~, ==highlight==, <u>underline</u>,
// fenced code (```mermaid renders as a diagram in Obsidian too) and images.
//
// Image sources are mapped between the backend URL (/uploads/x.png) and the
// vault-relative path (attachments/x.png). [[wikilinks]], {{cloze}} and the
// >> / :: card syntax are plain text and pass through unchanged.

std::string doc_to_markdown(const nlohmann::json& doc);
nlohmann::json markdown_to_doc(const std::string& markdown);
