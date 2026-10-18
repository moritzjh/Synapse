#include "fsrs.hpp"

#include <algorithm>
#include <cmath>

namespace fsrs {
namespace {

constexpr double kDecay = -0.5;
constexpr double kFactor = 19.0 / 81.0;  // makes R(S, S) == 0.9
constexpr int64_t kMinute = 60'000;
constexpr int64_t kDay = 86'400'000;

double forgetting_curve(double elapsed_days, double s) { return std::pow(1 + kFactor * elapsed_days / s, kDecay); }

double init_stability(const Params& p, Rating g) { return std::max(p.w[g - 1], 0.1); }

double init_difficulty(const Params& p, Rating g) {
  return std::clamp(p.w[4] - std::exp(p.w[5] * (g - 1)) + 1, 1.0, 10.0);
}

double next_difficulty(const Params& p, double d, Rating g) {
  double delta = -p.w[6] * (g - 3);
  double damped = d + delta * (10 - d) / 9;
  double reverted = p.w[7] * init_difficulty(p, Easy) + (1 - p.w[7]) * damped;
  return std::clamp(reverted, 1.0, 10.0);
}

double recall_stability(const Params& p, double d, double s, double r, Rating g) {
  double hard = g == Hard ? p.w[15] : 1;
  double easy = g == Easy ? p.w[16] : 1;
  return s * (1 + std::exp(p.w[8]) * (11 - d) * std::pow(s, -p.w[9]) * (std::exp((1 - r) * p.w[10]) - 1) * hard *
                      easy);
}

double forget_stability(const Params& p, double d, double s, double r) {
  double sf = p.w[11] * std::pow(d, -p.w[12]) * (std::pow(s + 1, p.w[13]) - 1) * std::exp((1 - r) * p.w[14]);
  return std::min(sf, s / std::exp(p.w[17] * p.w[18]));
}

double short_term_stability(const Params& p, double s, Rating g) {
  return s * std::exp(p.w[17] * (g - 3 + p.w[18]));
}

int64_t interval_days(const Params& p, double s) {
  double ivl = s / kFactor * (std::pow(p.desired_retention, 1 / kDecay) - 1);
  return static_cast<int64_t>(std::clamp(std::round(ivl), 1.0, p.maximum_interval_days));
}

}  // namespace

double retrievability_at(const CardState& c, int64_t at_ms) {
  if (c.state == State::New || c.stability <= 0) return 0;
  double elapsed = std::max<int64_t>(0, at_ms - c.last_review) / double(kDay);
  return forgetting_curve(elapsed, c.stability);
}

double retrievability(const CardState& c, int64_t now_ms) { return retrievability_at(c, now_ms); }

CardState review(const CardState& card, Rating g, int64_t now, const Params& p, int64_t exam) {
  CardState c = card;
  double elapsed = c.last_review ? std::max<int64_t>(0, now - c.last_review) / double(kDay) : 0;

  if (c.state == State::New) {
    c.stability = init_stability(p, g);
    c.difficulty = init_difficulty(p, g);
  } else if (c.state == State::Review) {
    double r = forgetting_curve(elapsed, c.stability);
    c.difficulty = next_difficulty(p, card.difficulty, g);
    c.stability = g == Again ? forget_stability(p, card.difficulty, card.stability, r)
                             : recall_stability(p, card.difficulty, card.stability, r, g);
  } else {  // (re)learning: same-day review
    c.difficulty = next_difficulty(p, card.difficulty, g);
    c.stability = short_term_stability(p, card.stability, g);
  }

  ++c.reps;
  c.last_review = now;

  if (c.state == State::Review && g == Again) {
    ++c.lapses;
    c.state = State::Relearning;
    c.due = now + 10 * kMinute;
    return c;
  }
  if (c.state != State::Review && (g == Again || g == Hard)) {
    c.state = c.state == State::New ? State::Learning : c.state;
    c.due = now + (g == Again ? 1 : 6) * kMinute;
    return c;
  }
  if (c.state != State::Review && g == Good && card.state == State::New) {
    c.state = State::Learning;  // one more step before graduating
    c.due = now + 10 * kMinute;
    return c;
  }

  int64_t ivl = interval_days(p, c.stability);
  if (card.state == State::Review) {
    // Keep Hard < Good < Easy ordering even when stability barely moves.
    int64_t last_ivl = std::max<int64_t>(1, std::llround(elapsed));
    if (g == Hard) ivl = std::max<int64_t>(ivl, last_ivl);
    if (g == Good) ivl = std::max<int64_t>(ivl, last_ivl + 1);
    if (g == Easy) ivl = std::max<int64_t>(ivl, last_ivl + 2);
  }
  c.state = State::Review;
  c.due = now + ivl * kDay;

  if (exam > now && c.due >= exam) {
    double days_left = double(exam - now) / kDay;
    // Close to the exam only cards at real risk come back, so the last
    // evening doesn't turn into an endless loop of re-reviews.
    double target = days_left >= 2 ? p.exam_retention : 0.85;
    if (forgetting_curve(days_left, c.stability) < target) {
      // Review once more right before the exam: the day before, or – if the
      // exam is closer than that – halfway there (at least 10 minutes).
      c.due = days_left >= 2 ? now + static_cast<int64_t>(std::floor(days_left - 1)) * kDay
                             : now + std::max<int64_t>(10 * kMinute, (exam - now) / 2);
    }
  }
  return c;
}

}  // namespace fsrs
