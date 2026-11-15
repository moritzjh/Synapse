#pragma once

#include <functional>
#include <json.hpp>
#include <string>
#include <vector>

// "Explain it" mode (Feynman technique): the user writes what they remember of a
// note; we report which passages of the note their text covers.
//
// A passage counts as covered when the explanation says the same thing (cosine
// similarity of sentence embeddings) or uses most of its key terms; both
// signals are combined so that neither a paraphrase nor a keyword list alone
// has to be perfect.

struct ExplainPassage {
  std::string heading;  // nearest heading above, "" at the top
  std::string text;
  std::string status;   // "covered" | "partial" | "missing"
  double similarity = 0;
  std::vector<std::string> missing_terms;
};

struct ExplainResult {
  double score = 0;  // 0..1, passages weighted by length
  bool semantic = false;
  std::vector<ExplainPassage> passages;
};

// Texts → L2-normalised embeddings, in order. Empty function = no model (key terms only).
using EmbedFn = std::function<std::vector<std::vector<float>>(const std::vector<std::string>&)>;

// The passages of a note worth explaining (paragraphs, lists, tables; cards without their syntax).
std::vector<ExplainPassage> explain_passages(const nlohmann::json& doc);

// `link_threshold` is the model's "these two texts are related" similarity (synapse.json).
ExplainResult explain_compare(const nlohmann::json& doc, const std::string& explanation, const EmbedFn& embed,
                              double link_threshold);
