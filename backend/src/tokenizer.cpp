#include "tokenizer.hpp"

#include <algorithm>
#include <fstream>
#include <json.hpp>
#include <limits>
#include <stdexcept>

#include "unicode_tables.hpp"

using json = nlohmann::json;

namespace {

// ---- UTF-8 helpers --------------------------------------------------------

std::u32string utf8_decode(std::string_view s) {
  std::u32string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    unsigned char c = s[i];
    char32_t cp;
    int len;
    if (c < 0x80) { cp = c; len = 1; }
    else if ((c >> 5) == 0x6) { cp = c & 0x1F; len = 2; }
    else if ((c >> 4) == 0xE) { cp = c & 0x0F; len = 3; }
    else if ((c >> 3) == 0x1E) { cp = c & 0x07; len = 4; }
    else { out.push_back(0xFFFD); ++i; continue; }
    if (i + len > s.size()) { out.push_back(0xFFFD); break; }
    for (int k = 1; k < len; ++k) cp = (cp << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F);
    out.push_back(cp);
    i += len;
  }
  return out;
}

void utf8_append(std::string& out, char32_t cp) {
  if (cp < 0x80) {
    out += static_cast<char>(cp);
  } else if (cp < 0x800) {
    out += static_cast<char>(0xC0 | (cp >> 6));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    out += static_cast<char>(0xE0 | (cp >> 12));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (cp >> 18));
    out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  }
}

size_t utf8_char_len(unsigned char c) {
  if (c < 0x80) return 1;
  if ((c >> 5) == 0x6) return 2;
  if ((c >> 4) == 0xE) return 3;
  if ((c >> 3) == 0x1E) return 4;
  return 1;
}

// ---- Unicode classification (tables generated from unicodedata) ------------

template <size_t N>
char32_t table_lookup(const std::pair<char32_t, char32_t> (&table)[N], char32_t cp) {
  auto it = std::lower_bound(std::begin(table), std::end(table), cp,
                             [](const auto& p, char32_t v) { return p.first < v; });
  return (it != std::end(table) && it->first == cp) ? it->second : cp;
}

char32_t to_lower(char32_t cp) {
  if (cp < 0x80) return (cp >= 'A' && cp <= 'Z') ? cp + 32 : cp;
  return table_lookup(unicode_tables::kLower, cp);
}

char32_t strip_accent(char32_t cp) {
  return cp < 0x80 ? cp : table_lookup(unicode_tables::kStripAccent, cp);
}

bool is_combining_mark(char32_t cp) { return cp >= 0x300 && cp <= 0x36F; }

bool is_whitespace(char32_t cp) {
  return cp == ' ' || cp == '\t' || cp == '\n' || cp == '\r' || cp == 0xA0 ||
         (cp >= 0x2000 && cp <= 0x200A) || cp == 0x3000 || cp == 0x202F || cp == 0x205F;
}

bool is_control(char32_t cp) {
  if (cp == '\t' || cp == '\n' || cp == '\r') return false;
  return cp < 0x20 || (cp >= 0x7F && cp < 0xA0) || cp == 0xFFFD || (cp >= 0x200B && cp <= 0x200F);
}

bool is_punct(char32_t cp) {
  if (cp < 0x80) return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) ||
                        (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126);
  auto it = std::upper_bound(std::begin(unicode_tables::kPunctRanges), std::end(unicode_tables::kPunctRanges),
                             cp, [](char32_t v, const auto& r) { return v < r.first; });
  if (it == std::begin(unicode_tables::kPunctRanges)) return false;
  --it;
  return cp <= it->second;
}

bool is_cjk(char32_t cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
         (cp >= 0x2F800 && cp <= 0x2FA1F);
}

// ---- tokenizer.json helpers ----------------------------------------------

// Depth-first search for an object with the given "type" (configs nest
// normalizers/processors inside "Sequence" wrappers).
const json* find_type(const json& node, std::string_view type) {
  if (node.is_object()) {
    if (node.contains("type") && node["type"] == type) return &node;
    for (const auto& [_, v] : node.items())
      if (const json* f = find_type(v, type)) return f;
  } else if (node.is_array()) {
    for (const auto& v : node)
      if (const json* f = find_type(v, type)) return f;
  }
  return nullptr;
}

const std::string kMetaspace = "\xE2\x96\x81";  // U+2581 '▁'

}  // namespace

Tokenizer::Tokenizer(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw std::runtime_error("cannot open tokenizer: " + path);
  json cfg = json::parse(in);
  const json& model = cfg.at("model");
  std::string type = model.value("type", "");

  if (type == "WordPiece") {
    kind_ = Kind::WordPiece;
    continuing_prefix_ = model.value("continuing_subword_prefix", "##");
    for (const auto& [piece, id] : model.at("vocab").items()) vocab_[piece] = id.get<int64_t>();
    unk_id_ = vocab_.at(model.value("unk_token", "[UNK]"));
  } else if (type == "Unigram") {
    kind_ = Kind::Unigram;
    const auto& vocab = model.at("vocab");
    double min_score = std::numeric_limits<double>::max();
    for (size_t i = 0; i < vocab.size(); ++i) {
      std::string piece = vocab[i][0];
      double score = vocab[i][1];
      vocab_.emplace(piece, static_cast<int64_t>(i));
      id_to_piece_.push_back(piece);
      scores_.push_back(score);
      max_piece_bytes_ = std::max(max_piece_bytes_, piece.size());
      min_score = std::min(min_score, score);
    }
    unk_id_ = model.value("unk_id", 0);
    unk_score_ = min_score - 10.0;  // same penalty as HF tokenizers
  } else {
    throw std::runtime_error("unsupported tokenizer model: " + type);
  }

  if (const json* bn = find_type(cfg["normalizer"], "BertNormalizer")) {
    lowercase_ = bn->value("lowercase", false);
    const auto& sa = (*bn)["strip_accents"];
    strip_accents_ = sa.is_boolean() ? sa.get<bool>() : lowercase_;
  } else {
    lowercase_ = find_type(cfg["normalizer"], "Lowercase") != nullptr;
    strip_accents_ = find_type(cfg["normalizer"], "StripAccents") != nullptr;
  }

  const json& post = cfg["post_processor"];
  auto special_id = [&](const std::string& tok) {
    auto it = vocab_.find(tok);
    return it == vocab_.end() ? int64_t{-1} : it->second;
  };
  if (const json* tp = find_type(post, "TemplateProcessing")) {
    const auto& single = tp->at("single");
    if (!single.empty() && single.front().contains("SpecialToken"))
      begin_id_ = special_id(single.front()["SpecialToken"]["id"]);
    if (single.size() > 1 && single.back().contains("SpecialToken"))
      end_id_ = special_id(single.back()["SpecialToken"]["id"]);
  } else if (const json* rp = find_type(post, "RobertaProcessing")) {
    begin_id_ = (*rp)["cls"][1];
    end_id_ = (*rp)["sep"][1];
  } else if (const json* bp = find_type(post, "BertProcessing")) {
    begin_id_ = (*bp)["cls"][1];
    end_id_ = (*bp)["sep"][1];
  }
}

std::vector<std::string> Tokenizer::pre_tokenize(std::string_view text) const {
  std::vector<std::string> words;
  std::string cur;
  auto flush = [&] {
    if (!cur.empty()) words.push_back(std::move(cur));
    cur.clear();
  };

  if (kind_ == Kind::WordPiece) {
    for (char32_t cp : utf8_decode(text)) {
      if (cp == 0 || is_control(cp)) continue;
      if (is_whitespace(cp)) { flush(); continue; }
      if (lowercase_) cp = to_lower(cp);
      if (strip_accents_) {
        if (is_combining_mark(cp)) continue;
        cp = strip_accent(cp);
      }
      if (is_punct(cp) || is_cjk(cp)) {
        flush();
        utf8_append(cur, cp);
        flush();
        continue;
      }
      utf8_append(cur, cp);
    }
    flush();
    return words;
  }

  // Unigram / Metaspace: every whitespace-separated word gets a '▁' prefix.
  for (char32_t cp : utf8_decode(text)) {
    if (cp == 0 || is_control(cp)) continue;
    if (is_whitespace(cp)) { flush(); continue; }
    if (lowercase_) cp = to_lower(cp);
    if (cur.empty()) cur = kMetaspace;
    utf8_append(cur, cp);
  }
  flush();
  return words;
}

void Tokenizer::wordpiece(const std::string& word, std::vector<int64_t>& ids) const {
  if (utf8_decode(word).size() > 100) {
    ids.push_back(unk_id_);
    return;
  }
  std::vector<int64_t> pieces;
  size_t start = 0;
  while (start < word.size()) {
    size_t end = word.size();
    int64_t found = -1;
    while (end > start) {
      std::string sub = word.substr(start, end - start);
      if (start > 0) sub = continuing_prefix_ + sub;
      if (auto it = vocab_.find(sub); it != vocab_.end()) {
        found = it->second;
        break;
      }
      // step back one whole UTF-8 character
      do { --end; } while (end > start && (static_cast<unsigned char>(word[end]) & 0xC0) == 0x80);
    }
    if (found < 0) {
      ids.push_back(unk_id_);
      return;
    }
    pieces.push_back(found);
    start = end;
  }
  ids.insert(ids.end(), pieces.begin(), pieces.end());
}

void Tokenizer::unigram(const std::string& word, std::vector<int64_t>& ids) const {
  // Viterbi over byte offsets that start a UTF-8 character.
  const size_t n = word.size();
  constexpr double kNeg = -std::numeric_limits<double>::infinity();
  std::vector<double> best(n + 1, kNeg);
  std::vector<size_t> from(n + 1, 0);
  std::vector<int64_t> tok(n + 1, -1);
  best[0] = 0;

  for (size_t i = 0; i < n;) {
    size_t clen = utf8_char_len(word[i]);
    if (best[i] != kNeg) {
      bool single_char_found = false;
      for (size_t j = i + clen; j <= n && j - i <= max_piece_bytes_;) {
        if (auto it = vocab_.find(word.substr(i, j - i)); it != vocab_.end()) {
          double s = best[i] + scores_[it->second];
          if (s > best[j]) { best[j] = s; from[j] = i; tok[j] = it->second; }
          if (j == i + clen) single_char_found = true;
        }
        if (j == n) break;
        j += utf8_char_len(word[j]);
      }
      if (!single_char_found) {
        double s = best[i] + unk_score_;
        size_t j = i + clen;
        if (s > best[j]) { best[j] = s; from[j] = i; tok[j] = unk_id_; }
      }
    }
    i += clen;
  }

  std::vector<int64_t> rev;
  for (size_t j = n; j > 0; j = from[j]) rev.push_back(tok[j]);
  for (auto it = rev.rbegin(); it != rev.rend(); ++it) {
    if (*it == unk_id_ && !ids.empty() && ids.back() == unk_id_) continue;  // fuse unknowns
    ids.push_back(*it);
  }
}

std::vector<int64_t> Tokenizer::encode_words(std::string_view text) const {
  std::vector<int64_t> ids;
  for (const auto& w : pre_tokenize(text)) {
    if (kind_ == Kind::WordPiece) wordpiece(w, ids);
    else unigram(w, ids);
  }
  return ids;
}

std::vector<int64_t> Tokenizer::encode(std::string_view text, size_t max_len) const {
  std::vector<int64_t> body = encode_words(text);
  size_t specials = (begin_id_ >= 0) + (end_id_ >= 0);
  if (max_len > specials && body.size() > max_len - specials) body.resize(max_len - specials);

  std::vector<int64_t> ids;
  ids.reserve(body.size() + specials);
  if (begin_id_ >= 0) ids.push_back(begin_id_);
  ids.insert(ids.end(), body.begin(), body.end());
  if (end_id_ >= 0) ids.push_back(end_id_);
  return ids;
}

std::vector<std::vector<int64_t>> Tokenizer::encode_windows(std::string_view text, size_t max_len,
                                                            size_t max_windows) const {
  std::vector<int64_t> body = encode_words(text);
  size_t specials = (begin_id_ >= 0) + (end_id_ >= 0);
  size_t step = max_len > specials ? max_len - specials : 1;
  std::vector<std::vector<int64_t>> windows;
  for (size_t off = 0; windows.size() < max_windows && (off < body.size() || windows.empty()); off += step) {
    std::vector<int64_t> w;
    if (begin_id_ >= 0) w.push_back(begin_id_);
    w.insert(w.end(), body.begin() + std::min(off, body.size()), body.begin() + std::min(off + step, body.size()));
    if (end_id_ >= 0) w.push_back(end_id_);
    windows.push_back(std::move(w));
  }
  return windows;
}

std::vector<std::string> Tokenizer::tokenize(std::string_view text) const {
  std::vector<std::string> out;
  if (id_to_piece_.empty()) {
    // WordPiece: build reverse map lazily for debugging only.
    std::vector<std::string> rev(vocab_.size());
    for (const auto& [p, id] : vocab_)
      if (static_cast<size_t>(id) < rev.size()) rev[id] = p;
    for (int64_t id : encode_words(text)) out.push_back(rev[id]);
  } else {
    for (int64_t id : encode_words(text)) out.push_back(id_to_piece_[id]);
  }
  return out;
}
