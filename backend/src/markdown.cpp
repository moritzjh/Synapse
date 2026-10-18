#include "markdown.hpp"

#include <md4c/md4c.h>

#include "content.hpp"

#include <algorithm>
#include <optional>
#include <cctype>
#include <sstream>
#include <vector>

using json = nlohmann::json;

namespace {

const std::string kUploadUrl = "/uploads/";
const std::string kAttachDir = "attachments/";

std::string to_vault_src(const std::string& src) {
  return src.rfind(kUploadUrl, 0) == 0 ? kAttachDir + src.substr(kUploadUrl.size()) : src;
}

std::string from_vault_src(const std::string& src) {
  std::string s = src;
  if (s.rfind("./", 0) == 0) s = s.substr(2);
  return s.rfind(kAttachDir, 0) == 0 ? kUploadUrl + s.substr(kAttachDir.size()) : src;
}

std::vector<std::string> split_lines(const std::string& s) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : s) {
    if (c == '\n') {
      out.push_back(cur);
      cur.clear();
    } else {
      cur += c;
    }
  }
  out.push_back(cur);
  return out;
}

size_t longest_run(const std::string& s, char ch) {
  size_t best = 0, run = 0;
  for (char c : s) {
    run = c == ch ? run + 1 : 0;
    best = std::max(best, run);
  }
  return best;
}

// ---- JSON → Markdown ----------------------------------------------------------

bool is_word(char c) { return std::isalnum(static_cast<unsigned char>(c)) || (c & 0x80); }

std::string escape_text(const std::string& t, bool in_table) {
  std::string out;
  for (size_t i = 0; i < t.size(); ++i) {
    char c = t[i];
    char prev = i ? t[i - 1] : ' ';
    char next = i + 1 < t.size() ? t[i + 1] : ' ';
    bool esc = false;
    switch (c) {
      case '\\': case '*': case '`': esc = true; break;
      case '_': esc = !(is_word(prev) && is_word(next)); break;
      case '~': case '=': esc = next == c; break;
      case '<': esc = std::isalpha(static_cast<unsigned char>(next)) || next == '/' || next == '!'; break;
      case '|': esc = in_table; break;
      default: break;
    }
    if (esc) out += '\\';
    out += c;
  }
  return out;
}

struct MarkSpec {
  std::string key, open, close;
};

// Canonical nesting order so that the same marks always produce the same output.
std::vector<MarkSpec> marks_of(const json& text_node, bool& is_code) {
  static const std::vector<std::string> order = {"link", "bold", "italic", "strike", "highlight", "underline"};
  is_code = false;
  std::vector<MarkSpec> out;
  const auto& marks = text_node.value("marks", json::array());
  for (const auto& type : order) {
    for (const auto& m : marks) {
      if (m.value("type", "") != type) continue;
      if (type == "link") {
        std::string href = m.value("attrs", json::object()).value("href", "");
        out.push_back({"link:" + href, "[", "](" + href + ")"});
      } else if (type == "bold") out.push_back({type, "**", "**"});
      else if (type == "italic") out.push_back({type, "*", "*"});
      else if (type == "strike") out.push_back({type, "~~", "~~"});
      else if (type == "highlight") out.push_back({type, "==", "=="});
      else out.push_back({type, "<u>", "</u>"});
    }
  }
  for (const auto& m : marks)
    if (m.value("type", "") == "code") is_code = true;
  return out;
}

std::string code_span(const std::string& t) {
  std::string ticks(longest_run(t, '`') + 1, '`');
  bool pad = !t.empty() && (t.front() == '`' || t.back() == '`');
  return ticks + (pad ? " " : "") + t + (pad ? " " : "") + ticks;
}

std::string render_inline(const json& block, bool in_table) {
  std::string out, pending_ws;
  std::vector<MarkSpec> stack;
  auto close_to = [&](size_t keep) {
    while (stack.size() > keep) {
      out += stack.back().close;
      stack.pop_back();
    }
  };
  for (const auto& n : block.value("content", json::array())) {
    const std::string type = n.value("type", "");
    if (type == "hardBreak") {
      out += pending_ws;
      pending_ws.clear();
      out += in_table ? "<br>" : "  \n";
      continue;
    }
    if (type != "text") continue;
    std::string text = n.value("text", "");
    if (in_table) std::replace(text.begin(), text.end(), '\n', ' ');
    size_t b = text.find_first_not_of(" \t");
    if (b == std::string::npos) {
      pending_ws += text;
      continue;
    }
    size_t e = text.find_last_not_of(" \t");
    std::string lead = text.substr(0, b), core = text.substr(b, e - b + 1), trail = text.substr(e + 1);

    bool code = false;
    auto want = marks_of(n, code);
    size_t common = 0;
    while (common < stack.size() && common < want.size() && stack[common].key == want[common].key) ++common;
    close_to(common);
    out += pending_ws + lead;
    for (size_t i = common; i < want.size(); ++i) {
      out += want[i].open;
      stack.push_back(want[i]);
    }
    out += code ? code_span(core) : escape_text(core, in_table);
    pending_ws = trail;
  }
  close_to(0);
  return out;
}

// Lines that would otherwise start a different block type get a backslash.
std::string protect_line_start(const std::string& line) {
  size_t i = 0;
  while (i < line.size() && std::isdigit(static_cast<unsigned char>(line[i]))) ++i;
  if (i > 0 && i < line.size() && (line[i] == '.' || line[i] == ')') && (i + 1 == line.size() || line[i + 1] == ' '))
    return line.substr(0, i) + "\\" + line.substr(i);
  if (line.empty()) return line;
  char c = line[0];
  char next = line.size() > 1 ? line[1] : ' ';
  if (c == '#' || c == '>' || ((c == '-' || c == '+') && (next == ' ' || line == "---" || next == '-')))
    return "\\" + line;
  return line;
}

using Lines = std::vector<std::string>;

Lines render_block(const json& n, bool alt_marker = false);

bool is_list_node(const json& n) {
  const std::string t = n.value("type", "");
  return t == "bulletList" || t == "orderedList" || t == "taskList";
}

Lines render_children(const json& n, bool tight) {
  Lines out;
  bool first = true;
  bool alt = false;  // adjacent lists need different markers or Markdown merges them
  const json* prev = nullptr;
  for (const auto& c : n.value("content", json::array())) {
    alt = prev && is_list_node(*prev) && is_list_node(c) ? !alt : false;
    prev = &c;
    Lines l = render_block(c, alt);
    if (l.empty()) continue;
    bool is_list = c.value("type", "").find("List") != std::string::npos;
    if (!first && !(tight && is_list)) out.emplace_back("");
    out.insert(out.end(), l.begin(), l.end());
    first = false;
  }
  return out;
}

Lines prefix(const Lines& lines, const std::string& first, const std::string& rest) {
  Lines out;
  for (size_t i = 0; i < lines.size(); ++i) {
    if (lines[i].empty() && i > 0) out.emplace_back("");
    else out.push_back((i == 0 ? first : rest) + lines[i]);
  }
  return out;
}

Lines render_list(const json& list, bool alt) {
  const std::string type = list.value("type", "");
  int number = list.value("attrs", json::object()).value("start", 1);
  Lines out;
  for (const auto& item : list.value("content", json::array())) {
    std::string marker = alt ? "* " : "- ";
    std::string box;
    if (type == "orderedList") marker = std::to_string(number++) + (alt ? ") " : ". ");
    if (type == "taskList") box = item.value("attrs", json::object()).value("checked", false) ? "[x] " : "[ ] ";
    Lines body = render_children(item, true);
    if (body.empty()) body.emplace_back("");
    body[0] = box + body[0];
    Lines l = prefix(body, marker, std::string(marker.size(), ' '));
    out.insert(out.end(), l.begin(), l.end());
  }
  return out;
}

Lines render_table(const json& table) {
  std::vector<std::vector<std::string>> rows;
  size_t cols = 0;
  for (const auto& row : table.value("content", json::array())) {
    std::vector<std::string> cells;
    for (const auto& cell : row.value("content", json::array())) {
      std::string text;
      for (const auto& p : cell.value("content", json::array())) {
        if (!text.empty()) text += "<br>";
        text += render_inline(p, true);
      }
      cells.push_back(text.empty() ? " " : text);
    }
    cols = std::max(cols, cells.size());
    rows.push_back(std::move(cells));
  }
  if (rows.empty() || cols == 0) return {};
  auto line = [&](const std::vector<std::string>& cells) {
    std::string s = "|";
    for (size_t i = 0; i < cols; ++i) s += " " + (i < cells.size() ? cells[i] : std::string(" ")) + " |";
    return s;
  };
  Lines out{line(rows[0])};
  std::string sep = "|";
  for (size_t i = 0; i < cols; ++i) sep += " --- |";
  out.push_back(sep);
  for (size_t r = 1; r < rows.size(); ++r) out.push_back(line(rows[r]));
  return out;
}

Lines fenced(const std::string& lang, const std::string& code) {
  std::string fence(std::max<size_t>(3, longest_run(code, '`') + 1), '`');
  Lines out{fence + lang};
  if (!code.empty())
    for (const auto& l : split_lines(code)) out.push_back(l);
  out.push_back(fence);
  return out;
}

std::string node_text(const json& n) {
  std::string s;
  for (const auto& c : n.value("content", json::array())) s += c.value("text", "");
  return s;
}

// Synapse-only data rides along in HTML comments, which Obsidian hides.
std::string hidden_json(const std::string& tag, const json& data) {
  std::string j = data.dump();
  for (size_t p = j.find("-->"); p != std::string::npos; p = j.find("-->", p)) j.replace(p, 3, "--\\u003e");
  return "<!-- " + tag + " " + j + " -->";
}

Lines render_database(const json& attrs) {
  Lines out{hidden_json("synapse-db", attrs), ""};
  const auto& props = attrs.value("properties", json::array());
  if (props.empty()) return {out[0]};
  auto esc = [](std::string v) {
    std::string r;
    for (char c : v) {
      if (c == '|') r += "\\|";
      else if (c == '\n') r += "<br>";
      else r += c;
    }
    return r.empty() ? std::string(" ") : r;
  };
  std::string head = "|", sep = "|";
  for (const auto& p : props) {
    head += " " + esc(p.value("name", "")) + " |";
    sep += " --- |";
  }
  out.push_back(head);
  out.push_back(sep);
  for (const auto& row : attrs.value("rows", json::array())) {
    std::string line = "|";
    const auto& cells = row.value("cells", json::object());
    for (const auto& p : props) {
      auto it = cells.find(p.value("id", ""));
      line += " " + esc(it == cells.end() ? "" : cell_text(p, *it)) + " |";
    }
    out.push_back(line);
  }
  return out;
}

// Notion callouts and toggles map to Obsidian callouts ("> [!tip]", foldable "> [!toggle]-").
Lines render_callout(const std::string& marker, const json& body) {
  Lines inner = render_children(body, false);
  Lines out{"> " + marker};
  for (const auto& l : inner) out.push_back(l.empty() ? ">" : "> " + l);
  return out;
}

Lines render_block(const json& n, bool alt_marker) {
  const std::string type = n.value("type", "");
  const json attrs = n.value("attrs", json::object());
  if (type == "pageLink") return {"[[" + attrs.value("title", std::string("Untitled")) + "]]"};
  if (type == "database") return render_database(attrs);
  if (type == "callout") return render_callout("[!" + attrs.value("kind", std::string("note")) + "]", n);
  if (type == "details") {
    std::string summary;
    json body = {{"content", json::array()}};
    for (const auto& c : n.value("content", json::array())) {
      if (c.value("type", "") == "detailsSummary") summary = render_inline(c, true);
      else if (c.value("type", "") == "detailsContent") body = c;
    }
    return render_callout("[!toggle]- " + summary, body);
  }
  if (type == "paragraph") {
    std::string inl = render_inline(n, false);
    if (inl.empty()) return {};
    Lines l = split_lines(inl);
    for (auto& line : l) line = protect_line_start(line);
    return l;
  }
  if (type == "heading") {
    int level = std::clamp(attrs.value("level", 1), 1, 6);
    return {std::string(level, '#') + " " + render_inline(n, true)};
  }
  if (type == "codeBlock") {
    std::string lang = attrs.contains("language") && attrs["language"].is_string() ? attrs["language"].get<std::string>() : "";
    if (lang == "plaintext") lang.clear();
    return fenced(lang, node_text(n));
  }
  if (type == "mermaid") return fenced("mermaid", attrs.value("code", ""));
  if (type == "horizontalRule") return {"---"};
  if (type == "image") {
    std::string src = to_vault_src(attrs.value("src", json("")).is_string() ? attrs["src"].get<std::string>() : "");
    std::string alt = attrs.contains("alt") && attrs["alt"].is_string() ? attrs["alt"].get<std::string>() : "";
    if (src.find(' ') != std::string::npos) src = "<" + src + ">";
    Lines out{"![" + escape_text(alt, false) + "](" + src + ")"};
    const json masks = attrs.value("occlusions", json::array());
    if (masks.is_array() && !masks.empty()) {
      out.emplace_back("");
      out.push_back(hidden_json("synapse-occlusion", masks));
    }
    return out;
  }
  if (type == "blockquote") return prefix(render_children(n, false), "> ", "> ");
  if (is_list_node(n)) return render_list(n, alt_marker);
  if (type == "table") return render_table(n);
  return render_children(n, false);
}

// ---- Markdown → JSON (md4c callbacks build the tree) ---------------------------

struct Builder {
  struct Frame {
    json node;
    bool implicit = false;  // paragraph we opened ourselves (tight lists, cells)
  };
  std::vector<Frame> stack;
  std::vector<json> marks;
  bool in_image = false;
  std::string image_src, image_alt;
  bool skip_table = false;  // the table after a synapse-db comment is only a rendering
  int skipping = 0;         // depth inside a skipped table

  Builder() { stack.push_back(Frame{json{{"type", "doc"}, {"content", json::array()}}, false}); }

  static bool is_inline_container(const std::string& t) { return t == "paragraph" || t == "heading"; }

  void push(json node, bool implicit = false) {
    if (!node.contains("content") && node.value("type", "") != "codeBlock") node["content"] = json::array();
    stack.push_back({std::move(node), implicit});
  }

  void pop() {
    Frame f = std::move(stack.back());
    stack.pop_back();
    const std::string t = f.node.value("type", "");
    // TipTap requires list items / cells to contain at least a paragraph.
    if ((t == "listItem" || t == "taskItem" || t == "tableCell" || t == "tableHeader") && f.node["content"].empty())
      f.node["content"].push_back({{"type", "paragraph"}, {"content", json::array()}});
    if (t == "paragraph" && f.implicit && f.node["content"].empty()) return;
    if (f.node.contains("content") && f.node["content"].empty() && (t == "paragraph" || t == "heading"))
      f.node.erase("content");
    stack.back().node["content"].push_back(std::move(f.node));
  }

  void close_implicit() {
    if (stack.back().implicit) pop();
  }

  json& inline_target() {
    if (!is_inline_container(stack.back().node.value("type", ""))) push({{"type", "paragraph"}}, true);
    return stack.back().node["content"];
  }

  void add_text(const std::string& text) {
    if (text.empty()) return;
    if (in_image) {
      image_alt += text;
      return;
    }
    if (json& node = stack.back().node; node.value("type", "") == "codeBlock") {
      node["_code"] = node.value("_code", "") + text;
      return;
    }
    // ==highlight== is not part of CommonMark; split it out here.
    size_t pos = 0;
    while (pos < text.size()) {
      size_t open = text.find("==", pos);
      size_t close = open == std::string::npos ? std::string::npos : text.find("==", open + 2);
      if (open == std::string::npos || close == std::string::npos || close == open + 2) {
        append_text(text.substr(pos), marks);
        return;
      }
      if (open > pos) append_text(text.substr(pos, open - pos), marks);
      auto hl = marks;
      hl.push_back({{"type", "highlight"}});
      append_text(text.substr(open + 2, close - open - 2), hl);
      pos = close + 2;
    }
  }

  void append_text(const std::string& text, const std::vector<json>& m) {
    if (text.empty()) return;
    json& target = inline_target();
    json mk = json::array();
    for (const auto& x : m) mk.push_back(x);
    if (!target.empty() && target.back().value("type", "") == "text" &&
        target.back().value("marks", json::array()) == mk) {
      target.back()["text"] = target.back()["text"].get<std::string>() + text;
      return;
    }
    json t = {{"type", "text"}, {"text", text}};
    if (!mk.empty()) t["marks"] = mk;
    target.push_back(std::move(t));
  }

  void hard_break() {
    if (in_image) return;
    inline_target().push_back({{"type", "hardBreak"}});
  }

  void toggle_mark(const std::string& type, bool on, json attrs = nullptr) {
    if (on) {
      json m = {{"type", type}};
      if (!attrs.is_null()) m["attrs"] = attrs;
      marks.push_back(m);
    } else {
      for (auto it = marks.rbegin(); it != marks.rend(); ++it)
        if (it->value("type", "") == type) {
          marks.erase(std::next(it).base());
          break;
        }
    }
  }

  void finish_image() {
    in_image = false;
    // Images are block nodes: end the paragraph they were written in.
    bool in_para = is_inline_container(stack.back().node.value("type", ""));
    bool was_implicit = in_para && stack.back().implicit;
    if (in_para) pop();
    stack.back().node["content"].push_back(
        {{"type", "image"}, {"attrs", {{"src", from_vault_src(image_src)}, {"alt", image_alt}, {"title", nullptr}}}});
    // Re-open a stand-in for the paragraph md4c will close; empty ones are dropped.
    if (in_para && !was_implicit) push({{"type", "paragraph"}}, false);
    image_alt.clear();
  }

  json finish() {
    while (stack.size() > 1) pop();
    // Drop the empty leftovers of paragraphs split by images.
    json& c = stack[0].node["content"];
    json cleaned = json::array();
    for (auto& n : c)
      if (!(n.value("type", "") == "paragraph" && !n.contains("content"))) cleaned.push_back(std::move(n));
    if (cleaned.empty()) cleaned.push_back({{"type", "paragraph"}});
    stack[0].node["content"] = cleaned;
    return stack[0].node;
  }
};

std::string attr_str(const MD_ATTRIBUTE& a) { return std::string(a.text, a.size); }

std::string decode_entity(const std::string& e) {
  if (e == "&amp;") return "&";
  if (e == "&lt;") return "<";
  if (e == "&gt;") return ">";
  if (e == "&quot;") return "\"";
  if (e == "&nbsp;") return "\xC2\xA0";
  if (e.size() > 3 && e[1] == '#') {
    long cp = e[2] == 'x' || e[2] == 'X' ? std::strtol(e.c_str() + 3, nullptr, 16) : std::strtol(e.c_str() + 2, nullptr, 10);
    std::string out;
    if (cp < 0x80) out += static_cast<char>(cp);
    else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    return out;
  }
  return e;
}

// Text inside "<!-- … -->" with the given tag, or nullopt.
std::optional<std::string> comment_payload(const std::string& raw, const std::string& tag) {
  std::string head = "<!-- " + tag + " ";
  size_t start = raw.find(head);
  size_t end = raw.rfind("-->");
  if (start != 0 || end == std::string::npos || end < head.size()) return std::nullopt;
  return raw.substr(head.size(), end - head.size());
}

// "> [!kind] Title" blockquotes become callouts, "> [!kind]- Title" toggles.
void convert_callout(json& quote) {
  auto& content = quote["content"];
  if (content.empty() || content[0].value("type", "") != "paragraph") return;
  json& first = content[0];
  auto& inl = first["content"];
  if (!inl.is_array() || inl.empty() || inl[0].value("type", "") != "text") return;
  std::string head = inl[0]["text"];
  if (head.rfind("[!", 0) != 0) return;
  size_t close = head.find(']');
  if (close == std::string::npos) return;
  std::string kind = head.substr(2, close - 2);
  std::string rest = head.substr(close + 1);
  bool fold = !rest.empty() && (rest[0] == '-' || rest[0] == '+');
  if (fold) rest = rest.substr(1);
  size_t b = rest.find_first_not_of(' ');
  rest = b == std::string::npos ? "" : rest.substr(b);

  // Split the marker line (up to the first hard break) from the body.
  json title_inline = json::array(), body_inline = json::array();
  if (!rest.empty()) title_inline.push_back({{"type", "text"}, {"text", rest}});
  bool after_break = false;
  for (size_t i = 1; i < inl.size(); ++i) {
    if (!after_break && inl[i].value("type", "") == "hardBreak") {
      after_break = true;
      continue;
    }
    (after_break ? body_inline : title_inline).push_back(inl[i]);
  }
  json blocks = json::array();
  if (!body_inline.empty()) blocks.push_back({{"type", "paragraph"}, {"content", body_inline}});
  for (size_t i = 1; i < content.size(); ++i) blocks.push_back(content[i]);

  if (fold || kind == "toggle") {
    if (blocks.empty()) blocks.push_back({{"type", "paragraph"}});
    json summary = {{"type", "detailsSummary"}};
    if (!title_inline.empty()) summary["content"] = title_inline;
    quote = {{"type", "details"},
             {"content", json::array({summary, {{"type", "detailsContent"}, {"content", blocks}}})}};
    return;
  }
  if (!title_inline.empty()) {
    for (auto& t : title_inline)
      if (t.value("type", "") == "text") t["marks"] = json::array({{{"type", "bold"}}});
    blocks.insert(blocks.begin(), {{"type", "paragraph"}, {"content", title_inline}});
  }
  if (blocks.empty()) blocks.push_back({{"type", "paragraph"}});
  quote = {{"type", "callout"}, {"attrs", {{"kind", kind}}}, {"content", blocks}};
}

int enter_block(MD_BLOCKTYPE type, void* detail, void* ud) {
  auto& b = *static_cast<Builder*>(ud);
  if (b.skipping) {
    ++b.skipping;
    return 0;
  }
  if (type == MD_BLOCK_TABLE && b.skip_table) {
    b.skip_table = false;
    b.skipping = 1;
    return 0;
  }
  if (type != MD_BLOCK_DOC) b.skip_table = false;
  b.close_implicit();
  switch (type) {
    case MD_BLOCK_DOC: break;
    case MD_BLOCK_QUOTE: b.push({{"type", "blockquote"}}); break;
    case MD_BLOCK_UL: b.push({{"type", "bulletList"}}); break;
    case MD_BLOCK_OL: {
      unsigned start = static_cast<MD_BLOCK_OL_DETAIL*>(detail)->start;
      b.push({{"type", "orderedList"}, {"attrs", {{"start", start}}}});
      break;
    }
    case MD_BLOCK_LI: {
      auto* d = static_cast<MD_BLOCK_LI_DETAIL*>(detail);
      if (d->is_task) {
        b.stack.back().node["type"] = "taskList";
        b.push({{"type", "taskItem"}, {"attrs", {{"checked", d->task_mark != ' '}}}});
      } else {
        b.push({{"type", "listItem"}});
      }
      break;
    }
    case MD_BLOCK_HR: b.push({{"type", "horizontalRule"}}); break;
    case MD_BLOCK_H: b.push({{"type", "heading"}, {"attrs", {{"level", static_cast<MD_BLOCK_H_DETAIL*>(detail)->level}}}}); break;
    case MD_BLOCK_CODE: {
      std::string lang = attr_str(static_cast<MD_BLOCK_CODE_DETAIL*>(detail)->lang);
      b.push({{"type", "codeBlock"}, {"attrs", {{"language", lang.empty() ? json(nullptr) : json(lang)}}}});
      break;
    }
    case MD_BLOCK_HTML: b.push({{"type", "paragraph"}, {"_raw", ""}}); break;
    case MD_BLOCK_P: b.push({{"type", "paragraph"}}); break;
    case MD_BLOCK_TABLE: b.push({{"type", "table"}}); break;
    case MD_BLOCK_THEAD: case MD_BLOCK_TBODY: break;
    case MD_BLOCK_TR: b.push({{"type", "tableRow"}}); break;
    case MD_BLOCK_TH: b.push({{"type", "tableHeader"}}); break;
    case MD_BLOCK_TD: b.push({{"type", "tableCell"}}); break;
  }
  return 0;
}

int leave_block(MD_BLOCKTYPE type, void*, void* ud) {
  auto& b = *static_cast<Builder*>(ud);
  if (b.skipping) {
    --b.skipping;
    return 0;
  }
  if (type == MD_BLOCK_DOC || type == MD_BLOCK_THEAD || type == MD_BLOCK_TBODY) return 0;
  b.close_implicit();
  json& node = b.stack.back().node;
  if (node.contains("_raw")) {
    std::string raw = node["_raw"];
    while (!raw.empty() && (raw.back() == '\n' || raw.back() == ' ')) raw.pop_back();
    node.erase("_raw");
    if (auto p = comment_payload(raw, "synapse-db")) {
      json attrs = json::parse(*p, nullptr, false);
      if (!attrs.is_discarded()) {
        node = {{"type", "database"}, {"attrs", attrs}};
        b.skip_table = true;
        b.pop();
        return 0;
      }
    }
    if (auto p = comment_payload(raw, "synapse-occlusion")) {
      json masks = json::parse(*p, nullptr, false);
      json& siblings = b.stack[b.stack.size() - 2].node["content"];
      // The image is the last real block (skip the empty stand-in paragraph after it).
      json* image = nullptr;
      for (auto it = siblings.rbegin(); it != siblings.rend(); ++it) {
        if (it->value("type", "") == "paragraph" && !it->contains("content")) continue;
        if (it->value("type", "") == "image") image = &*it;
        break;
      }
      if (!masks.is_discarded() && image) {
        (*image)["attrs"]["occlusions"] = masks;
        b.stack.pop_back();  // drop the comment itself
        return 0;
      }
    }
    node["content"] = json::array({{{"type", "text"}, {"text", raw}}});
  }
  if (node.value("type", "") == "blockquote") convert_callout(node);
  if (node.value("type", "") == "horizontalRule") node.erase("content");
  if (node.value("type", "") == "codeBlock") {
    std::string code = node.value("_code", "");
    if (!code.empty() && code.back() == '\n') code.pop_back();
    node.erase("_code");
    const auto& lang = node["attrs"]["language"];
    if (lang.is_string() && lang == "mermaid") {
      node = {{"type", "mermaid"}, {"attrs", {{"code", code}}}};
    } else if (!code.empty()) {
      node["content"] = json::array({{{"type", "text"}, {"text", code}}});
    }
  }
  b.pop();
  return 0;
}

int enter_span(MD_SPANTYPE type, void* detail, void* ud) {
  auto& b = *static_cast<Builder*>(ud);
  if (b.skipping) return 0;
  switch (type) {
    case MD_SPAN_EM: b.toggle_mark("italic", true); break;
    case MD_SPAN_STRONG: b.toggle_mark("bold", true); break;
    case MD_SPAN_DEL: b.toggle_mark("strike", true); break;
    case MD_SPAN_CODE: b.toggle_mark("code", true); break;
    case MD_SPAN_U: b.toggle_mark("underline", true); break;
    case MD_SPAN_A:
      b.toggle_mark("link", true, {{"href", attr_str(static_cast<MD_SPAN_A_DETAIL*>(detail)->href)}});
      break;
    case MD_SPAN_IMG:
      b.in_image = true;
      b.image_src = attr_str(static_cast<MD_SPAN_IMG_DETAIL*>(detail)->src);
      break;
    default: break;
  }
  return 0;
}

int leave_span(MD_SPANTYPE type, void*, void* ud) {
  auto& b = *static_cast<Builder*>(ud);
  if (b.skipping) return 0;
  switch (type) {
    case MD_SPAN_EM: b.toggle_mark("italic", false); break;
    case MD_SPAN_STRONG: b.toggle_mark("bold", false); break;
    case MD_SPAN_DEL: b.toggle_mark("strike", false); break;
    case MD_SPAN_CODE: b.toggle_mark("code", false); break;
    case MD_SPAN_U: b.toggle_mark("underline", false); break;
    case MD_SPAN_A: b.toggle_mark("link", false); break;
    case MD_SPAN_IMG: b.finish_image(); break;
    default: break;
  }
  return 0;
}

int on_text(MD_TEXTTYPE type, const MD_CHAR* text, MD_SIZE size, void* ud) {
  auto& b = *static_cast<Builder*>(ud);
  if (b.skipping) return 0;
  std::string t(text, size);
  if (json& top = b.stack.back().node; top.contains("_raw")) {
    top["_raw"] = top["_raw"].get<std::string>() + t;
    return 0;
  }
  switch (type) {
    case MD_TEXT_BR: case MD_TEXT_SOFTBR: b.hard_break(); break;
    case MD_TEXT_NULLCHAR: break;
    case MD_TEXT_ENTITY: b.add_text(decode_entity(t)); break;
    case MD_TEXT_HTML: {
      std::string lower = t;
      for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      if (lower == "<u>") b.toggle_mark("underline", true);
      else if (lower == "</u>") b.toggle_mark("underline", false);
      else if (lower == "<br>" || lower == "<br/>" || lower == "<br />") b.hard_break();
      else b.add_text(t);
      break;
    }
    default: b.add_text(t); break;
  }
  return 0;
}

}  // namespace

std::string doc_to_markdown(const json& doc) {
  Lines lines = render_children(doc, false);
  std::string out;
  for (const auto& l : lines) out += l + "\n";
  return out;
}

json markdown_to_doc(const std::string& markdown) {
  Builder b;
  MD_PARSER parser{};
  parser.flags = MD_FLAG_TABLES | MD_FLAG_STRIKETHROUGH | MD_FLAG_TASKLISTS | MD_FLAG_PERMISSIVEURLAUTOLINKS |
                 MD_FLAG_PERMISSIVEWWWAUTOLINKS | MD_FLAG_NOINDENTEDCODEBLOCKS;
  parser.enter_block = enter_block;
  parser.leave_block = leave_block;
  parser.enter_span = enter_span;
  parser.leave_span = leave_span;
  parser.text = on_text;
  md_parse(markdown.data(), static_cast<MD_SIZE>(markdown.size()), &parser, &b);
  return b.finish();
}
