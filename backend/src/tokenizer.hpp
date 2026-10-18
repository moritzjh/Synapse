#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

// Minimal loader for HuggingFace `tokenizer.json` files. Supports the two
// model families used by common sentence-embedding models:
//   - WordPiece (BERT, MiniLM)            with BertNormalizer / BertPreTokenizer
//   - Unigram   (XLM-R, multilingual-e5)  with Metaspace pre-tokenizer
// Unicode NFKC normalization (the "Precompiled" normalizer) is not applied,
// which only matters for unusual compatibility characters.
class Tokenizer {
 public:
  explicit Tokenizer(const std::string& path);

  // Token ids including the special begin/end tokens, truncated to max_len.
  std::vector<int64_t> encode(std::string_view text, size_t max_len) const;

  // Splits long input into consecutive windows of at most max_len ids each
  // (special tokens included), keeping at most max_windows windows.
  std::vector<std::vector<int64_t>> encode_windows(std::string_view text, size_t max_len,
                                                   size_t max_windows) const;

  // Text pieces without special tokens (for debugging / tests).
  std::vector<std::string> tokenize(std::string_view text) const;

 private:
  enum class Kind { WordPiece, Unigram };

  std::vector<std::string> pre_tokenize(std::string_view text) const;
  void wordpiece(const std::string& word, std::vector<int64_t>& ids) const;
  void unigram(const std::string& word, std::vector<int64_t>& ids) const;
  std::vector<int64_t> encode_words(std::string_view text) const;

  Kind kind_;
  bool lowercase_ = false;
  bool strip_accents_ = false;
  std::string continuing_prefix_ = "##";
  std::unordered_map<std::string, int64_t> vocab_;
  std::vector<std::string> id_to_piece_;
  std::vector<double> scores_;  // Unigram only
  size_t max_piece_bytes_ = 0;
  double unk_score_ = -100.0;
  int64_t unk_id_ = 0;
  int64_t begin_id_ = -1;
  int64_t end_id_ = -1;
};
