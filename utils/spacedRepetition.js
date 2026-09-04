// utils/spacedRepetition.js
//
// Simplified SM-2 (the algorithm behind Anki/SuperMemo), trimmed down for a
// binary correct/wrong signal instead of SM-2's 0-5 quality rating — MCQ
// review only ever gives us "got it" or "missed it", so a 6-point scale
// would be fake precision.
//
// Behavior:
//   - Wrong  -> back to square one: due again tomorrow, ease_factor drops
//               (harder questions get shown more often).
//   - Correct -> interval grows (1 day -> 6 days -> interval * ease_factor),
//               ease_factor nudges up slightly (well-known questions get
//               spaced out further and further, eventually rarely shown).
//
// ease_factor is clamped to [1.3, 2.8] — SM-2's own floor is 1.3 (below that
// a card spirals into being reviewed too often to ever escape); 2.8 is a
// practical ceiling so a single lucky streak can't push a question out to
// implausible multi-year gaps.

const MIN_EASE = 1.3;
const MAX_EASE = 2.8;

/**
 * @param {object} card - current state: { repetitions, ease_factor, interval_days }
 * @param {'correct'|'wrong'} result
 * @returns {{ repetitions:number, ease_factor:number, interval_days:number, due_date:Date }}
 */
function schedule(card, result) {
  let { repetitions, ease_factor: ease, interval_days: interval } = card;
  ease = Number(ease);
  interval = Number(interval);

  if (result === 'wrong') {
    repetitions = 0;
    interval = 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(interval * ease);
    ease = Math.min(MAX_EASE, ease + 0.1);
  }

  const due_date = new Date();
  due_date.setDate(due_date.getDate() + interval);

  return { repetitions, ease_factor: Math.round(ease * 100) / 100, interval_days: interval, due_date };
}

module.exports = { schedule, MIN_EASE, MAX_EASE };
