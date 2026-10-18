#pragma once

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "tokenizer.hpp"

// Sentence embeddings with a local ONNX model (BERT / XLM-R family).
//
// A model directory contains:
//   model.onnx       – transformer exporting last_hidden_state
//   tokenizer.json   – HuggingFace tokenizer
//   synapse.json     – optional: {"prefix": "passage: ", "query_prefix": "query: ",
//                                 "max_tokens": 512, "link_threshold": 0.82}
class Embedder {
 public:
  explicit Embedder(const std::string& model_dir);
  ~Embedder();

  // L2-normalized embedding. Long texts are split into windows of
  // max_tokens and the window embeddings are averaged. Queries (short search
  // input) get a different prefix than stored passages for e5-style models.
  std::vector<float> embed(std::string_view text, bool is_query = false);

  size_t dim() const { return dim_; }
  const std::string& name() const { return name_; }
  float link_threshold() const { return link_threshold_; }

 private:
  std::vector<float> run(const std::vector<int64_t>& ids);

  struct Ort;  // hides onnxruntime headers from the rest of the code
  std::unique_ptr<Ort> ort_;
  std::unique_ptr<Tokenizer> tokenizer_;
  std::string name_;
  std::string prefix_;
  std::string query_prefix_;
  size_t max_tokens_ = 256;
  size_t dim_ = 0;
  float link_threshold_ = 0.5f;
};
