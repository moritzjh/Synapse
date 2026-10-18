#pragma once

#include <array>
#include <cstdint>

// FSRS-5 spaced-repetition scheduler (same model as modern Anki), with
// the published default parameters and short learning steps for new and
// lapsed cards.
namespace fsrs {

enum class State : int { New = 0, Learning = 1, Review = 2, Relearning = 3 };
enum Rating : int { Again = 1, Hard = 2, Good = 3, Easy = 4 };

struct CardState {
  State state = State::New;
  double stability = 0;   // days until recall probability drops to 90%
  double difficulty = 0;  // 1..10
  int64_t due = 0;        // unix ms
  int64_t last_review = 0;
  int reps = 0;
  int lapses = 0;
};

struct Params {
  std::array<double, 19> w = {0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604,
                              0.0046,  1.54575, 0.1192, 1.01925, 1.9395, 0.11,   0.29605,
                              2.2698,  0.2315,  2.9898, 0.51655, 0.6621};
  double desired_retention = 0.9;
  double maximum_interval_days = 36500;
  // Recall probability the card should still have on exam day.
  double exam_retention = 0.95;
};

// `exam_ms` (optional) is the date of the next exam that covers this card.
// Intervals are then shortened so the card is reviewed shortly before the
// exam unless it would be remembered there with `exam_retention` anyway.
CardState review(const CardState& card, Rating rating, int64_t now_ms, const Params& p = {}, int64_t exam_ms = 0);

// Recall probability at an arbitrary point in time.
double retrievability_at(const CardState& card, int64_t at_ms);

// Recall probability right now (0..1); 0 for new cards.
double retrievability(const CardState& card, int64_t now_ms);

}  // namespace fsrs
