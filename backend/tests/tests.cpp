// Small self-contained test runner (no external framework).
#include <cmath>
#include <iostream>
#include <string>

#include "content.hpp"
#include "fsrs.hpp"
#include "wikilinks.hpp"

namespace {
int failures = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK(" #cond ") failed\n"; \
      ++failures;                                                            \
    }                                                                        \
  } while (0)

using json = nlohmann::json;

json para(const std::string& t) { return {{"type", "paragraph"}, {"content", {{{"type", "text"}, {"text", t}}}}}; }
json item(json content) { return {{"type", "listItem"}, {"content", content}}; }
json bullets(json items) { return {{"type", "bulletList"}, {"content", items}}; }
json doc(json blocks) { return {{"type", "doc"}, {"content", blocks}}; }

void test_wikilinks() {
  auto l = extract_wikilinks("a [[One]] b [[Two|alias]] [[Three#h]] [[One]] [[\nno]]");
  CHECK(l.size() == 3);
  CHECK(l[0] == "One" && l[1] == "Two" && l[2] == "Three");
}

void test_plain_text() {
  CHECK(plain_text(parse_content("hello\nworld")) == "hello\nworld");
  json d = doc({para("Titel"), bullets({item({para("eins")}), item({para("zwei")})})});
  CHECK(plain_text(d) == "Titel\neins\nzwei");
}

void test_cards() {
  json d = doc({
      para("Hauptstadt von Frankreich >> Paris"),
      para("ATP :: Adenosintriphosphat"),
      para("Die {{Mitochondrien}} sind die {{Kraftwerke}} der Zelle"),
      para("Organellen der Zelle >>"),
      bullets({item({para("Zellkern")}), item({para("Ribosomen")}), item({para("Golgi-Apparat")})}),
      para("std::vector and x>>2 are not cards"),
      {{"type", "codeBlock"}, {"content", {{{"type", "text"}, {"text", "a >> b"}}}}},
  });
  auto cards = extract_cards(d);
  CHECK(cards.size() == 5);
  if (cards.size() != 5) return;
  CHECK(cards[0].kind == "basic" && cards[0].front == "Hauptstadt von Frankreich" && cards[0].data["back"] == "Paris");
  CHECK(cards[1].kind == "basic" && cards[1].front == "ATP");
  CHECK(cards[2].kind == "reverse" && cards[2].front == "Adenosintriphosphat" && cards[2].data["back"] == "ATP");
  CHECK(cards[3].kind == "cloze" && cards[3].data["segments"].size() == 5);
  CHECK(cards[3].data["segments"][1]["cloze"] == "Mitochondrien");
  CHECK(cards[4].kind == "list" && cards[4].data["items"].size() == 3);

  // Nested list inside a list item: "Frage >>" with children.
  json nested = doc({bullets({item({para("Phasen der Mitose >>"),
                                    bullets({item({para("Prophase")}), item({para("Metaphase")})})})})});
  auto c2 = extract_cards(parse_content(nested.dump()));
  CHECK(c2.size() == 1 && c2[0].kind == "list" && c2[0].data["items"][1] == "Metaphase");

  // Plain-text notes support the same syntax.
  auto c3 = extract_cards(parse_content("Frage >>\n- a\n- b\nX :: Y"));
  CHECK(c3.size() == 3 && c3[0].kind == "list");
}

void test_fsrs() {
  const int64_t day = 86'400'000;
  fsrs::CardState c;
  int64_t t = 1'000'000'000'000;
  c = fsrs::review(c, fsrs::Good, t);
  CHECK(c.state == fsrs::State::Learning && c.due - t == 10 * 60'000);
  c = fsrs::review(c, fsrs::Good, t + 10 * 60'000);
  CHECK(c.state == fsrs::State::Review && c.due - (t + 10 * 60'000) >= day);
  int64_t first_ivl = c.due - c.last_review;
  auto good = fsrs::review(c, fsrs::Good, c.due);
  auto hard = fsrs::review(c, fsrs::Hard, c.due);
  auto easy = fsrs::review(c, fsrs::Easy, c.due);
  auto again = fsrs::review(c, fsrs::Again, c.due);
  CHECK(good.due - c.due > first_ivl);
  CHECK(hard.due < good.due && good.due < easy.due);
  CHECK(again.state == fsrs::State::Relearning && again.lapses == 1 && again.stability < c.stability);
  CHECK(std::abs(fsrs::retrievability(c, c.last_review + static_cast<int64_t>(c.stability * day)) - 0.9) < 1e-6);
}
}  // namespace

int main() {
  test_wikilinks();
  test_plain_text();
  test_cards();
  test_fsrs();
  if (failures) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all tests passed\n";
}
