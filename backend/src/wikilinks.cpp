#include "wikilinks.hpp"

#include <algorithm>
#include <unordered_set>

namespace {

std::string_view trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  return s;
}

}  // namespace

std::vector<std::string> extract_wikilinks(std::string_view text) {
  std::vector<std::string> out;
  std::unordered_set<std::string> seen;
  size_t pos = 0;
  while ((pos = text.find("[[", pos)) != std::string_view::npos) {
    size_t end = text.find("]]", pos + 2);
    if (end == std::string_view::npos) break;
    std::string_view inner = text.substr(pos + 2, end - pos - 2);
    pos = end + 2;
    if (inner.find('\n') != std::string_view::npos) continue;

    size_t cut = std::min(inner.find('|'), inner.find('#'));
    std::string target(trim(inner.substr(0, cut)));
    if (!target.empty() && seen.insert(target).second) out.push_back(std::move(target));
  }
  return out;
}
