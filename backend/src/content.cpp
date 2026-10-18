#include "content.hpp"

#include <sstream>

using json = nlohmann::json;

namespace {

bool is_list(const json& n) {
  const std::string t = n.value("type", "");
  return t == "bulletList" || t == "orderedList" || t == "taskList";
}

bool is_textblock(const json& n) {
  const std::string t = n.value("type", "");
  return t == "paragraph" || t == "heading";
}

std::string trim(std::string s) {
  const char* ws = " \t\n\r";
  s.erase(0, s.find_first_not_of(ws));
  s.erase(s.find_last_not_of(ws) + 1);
  return s;
}

// Text of inline content (text nodes, hard breaks, inline atoms).
std::string inline_text(const json& node) {
  std::string out;
  if (!node.contains("content")) return out;
  for (const auto& c : node["content"]) {
    const std::string t = c.value("type", "");
    if (t == "text") out += c.value("text", "");
    else if (t == "hardBreak") out += '\n';
    else if (c.contains("content")) out += inline_text(c);
  }
  return out;
}

void collect_text(const json& node, std::string& out) {
  const std::string t = node.value("type", "");
  if (t == "text") {
    out += node.value("text", "");
    return;
  }
  if (t == "hardBreak") {
    out += '\n';
    return;
  }
  if (t == "image") {
    const auto& a = node.value("attrs", json::object());
    std::string alt = a.value("alt", json()).is_string() ? a["alt"].get<std::string>() : "";
    if (!alt.empty()) out += alt + '\n';
    return;
  }
  if (t == "mermaid") {
    const auto& a = node.value("attrs", json::object());
    if (a.contains("code") && a["code"].is_string()) out += a["code"].get<std::string>() + '\n';
    return;
  }
  if (node.contains("content"))
    for (const auto& c : node["content"]) collect_text(c, out);
  if (t == "paragraph" || t == "heading" || t == "codeBlock" || t == "tableCell" || t == "tableHeader" ||
      t == "listItem") {
    if (!out.empty() && out.back() != '\n') out += '\n';
  }
}

std::vector<std::string> list_items(const json& list) {
  std::vector<std::string> items;
  for (const auto& li : list.value("content", json::array())) {
    std::string s;
    collect_text(li, s);
    s = trim(s);
    if (!s.empty()) items.push_back(s);
  }
  return items;
}

// Finds a separator that stands on its own ("a >> b", "a >>"), so code like
// "std::vector" or "x>>2" in normal prose is not mistaken for a card.
size_t find_separator(const std::string& text, const std::string& sep) {
  for (size_t pos = text.find(sep); pos != std::string::npos; pos = text.find(sep, pos + 1)) {
    bool left_ok = pos > 0 && text[pos - 1] == ' ';
    size_t after = pos + sep.size();
    bool right_ok = after == text.size() || text[after] == ' ' || text[after] == '\n';
    if (left_ok && right_ok) return pos;
  }
  return std::string::npos;
}

void handle_block(const std::string& raw, const std::vector<std::string>& children, std::vector<CardDraft>& out) {
  std::string text = trim(raw);
  if (text.empty()) return;

  // Cloze: "Die {{Mitochondrien}} sind die {{Kraftwerke}} der Zelle"
  if (text.find("{{") != std::string::npos) {
    json segments = json::array();
    std::string front;
    size_t pos = 0;
    int gaps = 0;
    while (pos < text.size()) {
      size_t open = text.find("{{", pos);
      size_t close = open == std::string::npos ? std::string::npos : text.find("}}", open + 2);
      if (open == std::string::npos || close == std::string::npos) {
        segments.push_back({{"text", text.substr(pos)}});
        front += text.substr(pos);
        break;
      }
      if (open > pos) {
        segments.push_back({{"text", text.substr(pos, open - pos)}});
        front += text.substr(pos, open - pos);
      }
      std::string hidden = text.substr(open + 2, close - open - 2);
      segments.push_back({{"cloze", hidden}});
      front += "[…]";
      ++gaps;
      pos = close + 2;
    }
    if (gaps > 0) out.push_back({"cloze:" + text, "cloze", front, {{"segments", segments}}});
    return;
  }

  auto make = [&](const std::string& sep, bool reverse) {
    size_t p = find_separator(text, sep);
    if (p == std::string::npos) return false;
    std::string front = trim(text.substr(0, p));
    std::string back = trim(text.substr(p + sep.size()));
    if (front.empty()) return true;
    if (back.empty()) {
      if (!children.empty()) out.push_back({"list:" + front, "list", front, {{"items", children}}});
      return true;
    }
    out.push_back({"basic:" + front, "basic", front, {{"back", back}}});
    if (reverse) out.push_back({"reverse:" + front, "reverse", back, {{"back", front}}});
    return true;
  };
  if (!make(">>", false)) make("::", true);
}

void walk(const json& nodes, std::vector<CardDraft>& out) {
  if (!nodes.is_array()) return;
  for (size_t i = 0; i < nodes.size(); ++i) {
    const json& n = nodes[i];
    if (is_textblock(n)) {
      std::vector<std::string> children;
      if (i + 1 < nodes.size() && is_list(nodes[i + 1])) children = list_items(nodes[i + 1]);
      handle_block(inline_text(n), children, out);
    } else if (is_list(n)) {
      for (const auto& li : n.value("content", json::array())) {
        const auto& parts = li.value("content", json::array());
        // A list item is "paragraph [nested list]"; the nested list holds the answers.
        for (size_t k = 0; k < parts.size(); ++k) {
          if (!is_textblock(parts[k])) continue;
          std::vector<std::string> children;
          if (k + 1 < parts.size() && is_list(parts[k + 1])) children = list_items(parts[k + 1]);
          handle_block(inline_text(parts[k]), children, out);
        }
        for (const auto& p : parts)
          if (!is_textblock(p)) walk(json::array({p}), out);
      }
    } else if (n.value("type", "") != "codeBlock" && n.contains("content")) {
      walk(n["content"], out);
    }
  }
}

json text_to_doc(const std::string& text) {
  json blocks = json::array();
  json list;
  std::istringstream in(text);
  std::string line;
  auto para = [](const std::string& s) {
    json p = {{"type", "paragraph"}};
    if (!s.empty()) p["content"] = json::array({{{"type", "text"}, {"text", s}}});
    return p;
  };
  auto flush_list = [&] {
    if (!list.is_null()) blocks.push_back(list);
    list = nullptr;
  };
  while (std::getline(in, line)) {
    std::string t = trim(line);
    if (t.rfind("- ", 0) == 0 || t.rfind("* ", 0) == 0) {
      if (list.is_null()) list = {{"type", "bulletList"}, {"content", json::array()}};
      list["content"].push_back({{"type", "listItem"}, {"content", json::array({para(trim(t.substr(2)))})}});
    } else {
      flush_list();
      blocks.push_back(para(line));
    }
  }
  flush_list();
  return {{"type", "doc"}, {"content", blocks}};
}

}  // namespace

json parse_content(const std::string& content) {
  if (!content.empty() && content.front() == '{') {
    auto j = json::parse(content, nullptr, false);
    if (!j.is_discarded() && j.is_object() && j.value("type", "") == "doc") return j;
  }
  return text_to_doc(content);
}

std::string plain_text(const json& doc) {
  std::string out;
  collect_text(doc, out);
  return trim(out);
}

std::vector<CardDraft> extract_cards(const json& doc) {
  std::vector<CardDraft> out;
  walk(doc.value("content", json::array()), out);
  return out;
}
