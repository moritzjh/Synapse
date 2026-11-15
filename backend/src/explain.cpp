#include "explain.hpp"

#include <algorithm>
#include <cmath>
#include <set>

using json = nlohmann::json;

namespace {

std::string trim(std::string s) {
  const char* ws = " \t\n\r";
  size_t b = s.find_first_not_of(ws);
  if (b == std::string::npos) return "";
  return s.substr(b, s.find_last_not_of(ws) - b + 1);
}

void replace_all(std::string& s, const std::string& from, const std::string& to) {
  for (size_t p = s.find(from); p != std::string::npos; p = s.find(from, p + to.size())) s.replace(p, from.size(), to);
}

// "Frage >> Antwort", "Begriff :: Definition", "{{Lücke}}", "[[Ziel|Text]]" → plain prose
std::string strip_syntax(std::string s) {
  replace_all(s, " >> ", " – ");
  replace_all(s, " :: ", " – ");
  if (s.size() >= 3 && s.compare(s.size() - 3, 3, " >>") == 0) s.resize(s.size() - 3);
  replace_all(s, "{{", "");
  replace_all(s, "}}", "");
  for (size_t open = s.find("[["); open != std::string::npos; open = s.find("[[", open)) {
    size_t close = s.find("]]", open);
    if (close == std::string::npos) break;
    std::string inner = s.substr(open + 2, close - open - 2);
    size_t bar = inner.find('|');
    if (bar != std::string::npos) inner = inner.substr(bar + 1);
    else if (size_t hash = inner.find('#'); hash != std::string::npos) inner = inner.substr(0, hash);
    s.replace(open, close + 2 - open, inner);
  }
  return trim(s);
}

std::string inline_text(const json& node) {
  std::string out;
  for (const auto& c : node.value("content", json::array())) {
    const std::string t = c.value("type", "");
    if (t == "text") out += c.value("text", "");
    else if (t == "hardBreak") out += ' ';
    else if (t == "inlineMath") out += "$" + c.value("attrs", json::object()).value("latex", "") + "$";
    else if (c.contains("content")) out += inline_text(c);
  }
  return out;
}

// all text below a node, blocks separated by "; "
std::string block_text(const json& node) {
  const std::string t = node.value("type", "");
  if (t == "paragraph" || t == "heading" || t == "detailsSummary") return strip_syntax(inline_text(node));
  if (t == "codeBlock" || t == "image" || t == "database" || t == "mermaid" || t == "pageLink") return "";
  std::string out;
  for (const auto& c : node.value("content", json::array())) {
    std::string part = block_text(c);
    if (part.empty()) continue;
    if (!out.empty()) out += (t == "tableRow" ? " | " : "; ");
    out += part;
  }
  return out;
}

int word_count(const std::string& s) {
  int n = 0;
  bool in = false;
  for (unsigned char c : s) {
    bool w = !(c == ' ' || c == '\n' || c == '\t');
    if (w && !in) ++n;
    in = w;
  }
  return n;
}

void collect(const json& nodes, std::string& heading, std::vector<ExplainPassage>& out, bool& open_question) {
  for (const auto& n : nodes) {
    const std::string t = n.value("type", "");
    if (t == "heading") {
      heading = strip_syntax(inline_text(n));
      open_question = false;
      continue;
    }
    if (t == "callout" || t == "blockquote" || t == "details" || t == "detailsContent") {
      collect(n.value("content", json::array()), heading, out, open_question);
      continue;
    }
    bool list = t == "bulletList" || t == "orderedList" || t == "taskList";
    std::string raw = t == "paragraph" ? inline_text(n) : "";
    std::string text = block_text(n);
    if (text.empty()) continue;
    if (list && open_question && !out.empty()) {
      out.back().text += ": " + text;  // "Frage >>" + its answer list are one passage
      open_question = false;
      continue;
    }
    out.push_back({heading, text, "", 0, {}});
    std::string r = trim(raw);
    open_question = r.size() >= 2 && r.compare(r.size() - 2, 2, ">>") == 0;
  }
}

// Passage text without $formulas$: LaTeX commands are neither prose to embed nor terms to remember.
std::string without_math(const std::string& s) {
  std::string out;
  bool in = false;
  for (char c : s) {
    if (c == '$') in = !in;
    else if (!in) out += c;
  }
  return out;
}

// ---- key terms ---------------------------------------------------------------------

bool is_word_byte(unsigned char c) { return std::isalnum(c) || c >= 0x80; }

std::string lower_ascii(std::string s) {
  for (auto& c : s)
    if (static_cast<unsigned char>(c) < 0x80) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  // the common upper-case umlauts, so "Ähnlich" matches "ähnlich"
  replace_all(s, "Ä", "ä");
  replace_all(s, "Ö", "ö");
  replace_all(s, "Ü", "ü");
  return s;
}

const std::set<std::string>& stopwords() {
  static const std::set<std::string> s = {
      "aber",  "alle",  "also",   "auch",  "außer", "beim",    "bzw",    "dabei", "damit", "dann",  "dass",  "denn",  "deren",
      "diese", "dieser", "dieses", "doch",  "dort",  "durch",   "eine",   "einem", "einen", "einer", "eines", "etwa",  "ganz",
      "gibt",  "haben", "hier",   "immer", "kann",  "können",  "mehr",   "nach",  "nicht", "noch",  "oder",  "ohne",  "sehr",
      "sein",  "seine", "sich",   "sind",  "sowie", "über",    "unter",  "viele", "vom",   "wenn",  "werden", "wird", "wurde",
      "zwischen", "about", "after", "also", "been", "both", "each", "from", "have", "into", "more", "most", "only", "other",
      "over",  "some",  "such",   "than",  "that",  "their",   "them",   "then",  "there", "these", "they",  "this",  "through",
      "very",  "were",  "what",   "when",  "where", "which",   "while",  "with",  "would", "your",  "does",  "every", "just",
      "important", "roughly", "approx", "approximately", "usually", "called", "known", "example", "main", "types", "wichtig",
      "ungefähr", "meist", "meistens", "genannt", "beispiel", "sogenannte", "bestimmte", "verschiedene", "different"};
  return s;
}

// distinct content words (lower-cased) with the spelling they first appear in
std::vector<std::pair<std::string, std::string>> key_terms(const std::string& text) {
  std::vector<std::pair<std::string, std::string>> out;
  std::set<std::string> seen;
  size_t i = 0;
  while (i < text.size()) {
    while (i < text.size() && !is_word_byte(text[i])) ++i;
    size_t b = i;
    while (i < text.size() && is_word_byte(text[i])) ++i;
    std::string word = text.substr(b, i - b);
    std::string low = lower_ascii(word);
    bool number = !word.empty() && std::all_of(word.begin(), word.end(), [](unsigned char c) { return std::isdigit(c); });
    if (low.size() < (number ? 2u : 4u) || stopwords().count(low) || !seen.insert(low).second) continue;
    out.emplace_back(low, word);
  }
  return out;
}

// Matches inflected forms: "Mitochondrien" covers "Mitochondrium". Compares a prefix that never ends inside a UTF-8 character.
bool mentions(const std::string& haystack_lower, const std::string& term) {
  if (haystack_lower.find(term) != std::string::npos) return true;
  if (term.size() < 7) return false;
  size_t cut = term.size() - 3;
  while (cut > 4 && (static_cast<unsigned char>(term[cut]) & 0xC0) == 0x80) --cut;
  return haystack_lower.find(term.substr(0, cut)) != std::string::npos;
}

// ---- explanation → chunks ----------------------------------------------------------

std::vector<std::string> sentences(const std::string& text) {
  std::vector<std::string> out;
  std::string cur;
  for (size_t i = 0; i < text.size(); ++i) {
    char c = text[i];
    cur += c == '\n' ? ' ' : c;
    bool end = c == '\n' || ((c == '.' || c == '!' || c == '?') && (i + 1 == text.size() || text[i + 1] == ' ' || text[i + 1] == '\n'));
    if (end) {
      std::string s = trim(cur);
      if (word_count(s) >= 2) out.push_back(s);
      else if (!out.empty() && !s.empty()) out.back() += " " + s;
      cur.clear();
    }
  }
  if (std::string s = trim(cur); !s.empty()) out.push_back(s);
  return out;
}

double dot(const std::vector<float>& a, const std::vector<float>& b) {
  double s = 0;
  for (size_t i = 0; i < a.size() && i < b.size(); ++i) s += double(a[i]) * b[i];
  return s;
}

}  // namespace

std::vector<ExplainPassage> explain_passages(const json& doc) {
  std::vector<ExplainPassage> raw;
  std::string heading;
  bool open_question = false;
  collect(doc.value("content", json::array()), heading, raw, open_question);

  // A passage needs enough substance to be explained; fragments join their neighbour under the same heading.
  std::vector<ExplainPassage> out;
  for (auto& p : raw) {
    bool tiny = word_count(p.text) < 4;
    if (tiny && !out.empty() && out.back().heading == p.heading) out.back().text += " " + p.text;
    else if (!tiny || key_terms(p.text).size() >= 2) out.push_back(std::move(p));
  }
  return out;
}

ExplainResult explain_compare(const json& doc, const std::string& explanation, const EmbedFn& embed, double link_threshold) {
  ExplainResult res;
  res.passages = explain_passages(doc);
  if (res.passages.empty()) return res;

  // Sentences plus pairs of neighbouring sentences: a passage is often explained across two of them.
  std::vector<std::string> chunks = sentences(explanation);
  if (chunks.size() > 40) chunks.resize(40);
  size_t single = chunks.size();
  for (size_t i = 0; i + 1 < single; ++i) chunks.push_back(chunks[i] + " " + chunks[i + 1]);

  std::vector<std::vector<float>> pv, cv;
  if (embed && !chunks.empty()) {
    std::vector<std::string> texts;
    for (const auto& p : res.passages) texts.push_back(without_math(p.text));
    pv = embed(texts);
    cv = embed(chunks);
    res.semantic = pv.size() == texts.size() && cv.size() == chunks.size();
  }

  // Similarity scale of the model: `related` is where two texts are about the same thing,
  // `same` a quarter of the way from there to identical.
  const double related = link_threshold - 0.25 * (1 - link_threshold);
  const double same = link_threshold + 0.25 * (1 - link_threshold);
  const std::string said = lower_ascii(explanation);

  double total = 0, got = 0;
  for (size_t i = 0; i < res.passages.size(); ++i) {
    ExplainPassage& p = res.passages[i];
    double sim = 0;
    if (res.semantic)
      for (const auto& c : cv) sim = std::max(sim, dot(pv[i], c));
    p.similarity = sim;

    auto terms = key_terms(without_math(p.text));
    int hit = 0;
    for (const auto& [low, word] : terms) {
      if (mentions(said, low)) ++hit;
      // only name the distinctive ones as "missing": longer words, numbers, names
      else if (p.missing_terms.size() < 4 && (low.size() >= 6 || std::isdigit(static_cast<unsigned char>(low[0])) || std::isupper(static_cast<unsigned char>(word[0]))))
        p.missing_terms.push_back(word);
    }
    double lex = terms.empty() ? 0 : double(hit) / terms.size();

    bool covered = res.semantic ? (sim >= same && lex >= 0.25) || (sim >= related && lex >= 0.6) || lex >= 0.85 : lex >= 0.6;
    // being about the same topic is not enough: "partly" needs at least some of the passage's own terms
    bool partial = res.semantic ? sim >= same || (sim >= related && hit >= 1) || lex >= 0.4 : lex >= 0.3;
    if (chunks.empty()) covered = partial = false;
    p.status = covered ? "covered" : partial ? "partial" : "missing";
    if (covered) p.missing_terms.clear();

    double w = std::clamp(word_count(p.text), 4, 40);
    total += w;
    got += w * (covered ? 1.0 : partial ? 0.5 : 0.0);
  }
  res.score = total > 0 ? got / total : 0;
  return res;
}
