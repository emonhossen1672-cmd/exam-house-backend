// utils/leveling.js — turns a user's `points` (see routes/results.routes.js:
// +1 point per correct answer on exam submission) into a Level for the
// profile screen. Level is computed here at read time rather than stored on
// the user row, so these thresholds can be retuned later without a data
// migration.
//
// LEVEL_THRESHOLDS[i] = minimum points needed to BE level (i+1).
// e.g. 0 points -> level 1, 100 points -> level 2, 300 -> level 3, etc.
const LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5200, 6600];

function levelForPoints(points) {
  const p = Number(points) || 0;
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (p >= LEVEL_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

// Points needed to reach the NEXT level, and how far into the current level
// the user already is — handy for a progress bar like the one in the
// screenshot. Returns nulls once the top defined level is reached.
function levelProgress(points) {
  const p = Number(points) || 0;
  const level = levelForPoints(points);
  const currentFloor = LEVEL_THRESHOLDS[level - 1];
  const nextCeiling = LEVEL_THRESHOLDS[level] ?? null;
  if (nextCeiling === null) {
    return { level, points_into_level: p - currentFloor, points_for_next_level: null, progress_percent: 100 };
  }
  const span = nextCeiling - currentFloor;
  const into = p - currentFloor;
  return {
    level,
    points_into_level: into,
    points_for_next_level: nextCeiling,
    progress_percent: Math.max(0, Math.min(100, Math.round((into / span) * 100)))
  };
}

module.exports = { LEVEL_THRESHOLDS, levelForPoints, levelProgress };
