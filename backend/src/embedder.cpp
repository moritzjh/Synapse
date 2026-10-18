#include "embedder.hpp"

#include <onnxruntime_cxx_api.h>

#include <cmath>
#include <filesystem>
#include <fstream>
#include <json.hpp>

namespace fs = std::filesystem;

struct Embedder::Ort {
  ::Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "synapse"};
  ::Ort::SessionOptions opts;
  std::unique_ptr<::Ort::Session> session;
  std::vector<std::string> input_names;
  std::string output_name;
  bool needs_token_types = false;
};

namespace {

constexpr size_t kMaxWindows = 8;  // ~2-4k tokens per note is plenty for linking

void normalize(std::vector<float>& v) {
  double norm = 0;
  for (float x : v) norm += double(x) * x;
  norm = std::sqrt(norm);
  if (norm > 0)
    for (auto& x : v) x = static_cast<float>(x / norm);
}

}  // namespace

Embedder::Embedder(const std::string& model_dir) : ort_(std::make_unique<Ort>()) {
  fs::path dir(model_dir);
  name_ = dir.filename().string();
  if (name_.empty()) name_ = dir.parent_path().filename().string();

  if (std::ifstream cfg(dir / "synapse.json"); cfg) {
    auto j = nlohmann::json::parse(cfg);
    prefix_ = j.value("prefix", "");
    query_prefix_ = j.value("query_prefix", prefix_);
    max_tokens_ = j.value("max_tokens", 256);
    link_threshold_ = j.value("link_threshold", 0.5f);
  }

  tokenizer_ = std::make_unique<Tokenizer>((dir / "tokenizer.json").string());

  ort_->opts.SetIntraOpNumThreads(2);
  ort_->opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  ort_->session = std::make_unique<::Ort::Session>(ort_->env, (dir / "model.onnx").c_str(), ort_->opts);

  ::Ort::AllocatorWithDefaultOptions alloc;
  auto& s = *ort_->session;
  for (size_t i = 0; i < s.GetInputCount(); ++i) {
    std::string n = s.GetInputNameAllocated(i, alloc).get();
    if (n == "token_type_ids") ort_->needs_token_types = true;
    ort_->input_names.push_back(n);
  }
  ort_->output_name = s.GetOutputNameAllocated(0, alloc).get();
  auto shape = s.GetOutputTypeInfo(0).GetTensorTypeAndShapeInfo().GetShape();
  if (!shape.empty() && shape.back() > 0) dim_ = static_cast<size_t>(shape.back());
}

Embedder::~Embedder() = default;

std::vector<float> Embedder::run(const std::vector<int64_t>& ids) {
  const int64_t len = static_cast<int64_t>(ids.size());
  std::array<int64_t, 2> shape{1, len};
  std::vector<int64_t> mask(ids.size(), 1), types(ids.size(), 0);
  auto mem = ::Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

  std::vector<::Ort::Value> inputs;
  std::vector<const char*> names;
  for (const auto& n : ort_->input_names) {
    std::vector<int64_t>* data = n == "input_ids" ? const_cast<std::vector<int64_t>*>(&ids)
                                 : n == "attention_mask" ? &mask
                                                         : &types;
    inputs.push_back(::Ort::Value::CreateTensor<int64_t>(mem, data->data(), data->size(), shape.data(), 2));
    names.push_back(n.c_str());
  }
  const char* out_name = ort_->output_name.c_str();
  auto out = ort_->session->Run(::Ort::RunOptions{nullptr}, names.data(), inputs.data(), inputs.size(),
                                &out_name, 1);

  auto out_shape = out[0].GetTensorTypeAndShapeInfo().GetShape();
  const float* h = out[0].GetTensorData<float>();
  size_t dim = static_cast<size_t>(out_shape.back());
  dim_ = dim;

  std::vector<float> v(dim, 0.f);
  if (out_shape.size() == 2) {  // model already pools
    std::copy(h, h + dim, v.begin());
    return v;
  }
  // Mean pooling over tokens (attention mask is all ones, batch size 1).
  for (int64_t t = 0; t < len; ++t)
    for (size_t d = 0; d < dim; ++d) v[d] += h[t * dim + d];
  for (auto& x : v) x /= static_cast<float>(len);
  return v;
}

std::vector<float> Embedder::embed(std::string_view text, bool is_query) {
  std::string input = (is_query ? query_prefix_ : prefix_) + std::string(text);
  auto windows = tokenizer_->encode_windows(input, max_tokens_, kMaxWindows);

  std::vector<float> sum;
  for (const auto& w : windows) {
    auto v = run(w);
    normalize(v);
    if (sum.empty()) sum.assign(v.size(), 0.f);
    for (size_t i = 0; i < v.size(); ++i) sum[i] += v[i];
  }
  normalize(sum);
  return sum;
}
