/// <reference path="../../pb_data/types.d.ts" />

/**
 * Bucketing maths for GET /api/pos/analytics.
 *
 * A module rather than file-scope helpers in the hook: PocketBase runs each
 * handler in its own isolated JSVM context, so a callback cannot close over
 * anything declared beside it in the file. Shared code has to be `require`d
 * from inside the handler, which is what this file is for.
 *
 * Timezone offsets throughout are minutes as `-new Date().getTimezoneOffset()`
 * gives them (Addis Ababa = 180). They matter: sales are stored in UTC, and a
 * day has to start at the shop's own midnight. Bucketing in UTC would push the
 * first three hours of every Ethiopian day into the day before, and the
 * owner's "today" would disagree with the app's.
 */

/** Periods we bucket by, and how many buckets each returns by default. */
const PERIODS = {
  day: { count: 7, seconds: 86400 },
  week: { count: 12, seconds: 604800 },
  month: { count: 12, seconds: 0 },
  year: { count: 5, seconds: 0 },
};

const MAX_BUCKETS = 60;

/**
 * Start of the period containing `dateMs`, in shop-local terms.
 *
 * Works on a shifted timestamp: local time is UTC plus the offset, so shifting
 * the instant by the offset lets plain UTC arithmetic land on local
 * boundaries. The result is shifted back before it is used as a UTC bound.
 */
function periodStart(dateMs, period, offsetMinutes) {
  const offsetMs = offsetMinutes * 60000;
  const local = new Date(dateMs + offsetMs);

  let startLocal;

  if (period === "day") {
    startLocal = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
    );
  } else if (period === "week") {
    // Weeks start Monday. getUTCDay() is 0 for Sunday, so map it to 6.
    const weekday = (local.getUTCDay() + 6) % 7;
    startLocal =
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      weekday * 86400000;
  } else if (period === "month") {
    startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  } else {
    startLocal = Date.UTC(local.getUTCFullYear(), 0, 1);
  }

  return startLocal - offsetMs;
}

/** Start of the bucket `steps` periods before the one containing `fromMs`. */
function stepBack(fromMs, period, offsetMinutes, steps) {
  if (period === "day" || period === "week") {
    const span = PERIODS[period].seconds * 1000;
    return periodStart(fromMs - steps * span, period, offsetMinutes);
  }

  // Months and years vary in length, so walk the calendar rather than
  // subtracting a fixed span.
  const offsetMs = offsetMinutes * 60000;
  const local = new Date(periodStart(fromMs, period, offsetMinutes) + offsetMs);

  if (period === "month") {
    return (
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - steps, 1) - offsetMs
    );
  }

  return Date.UTC(local.getUTCFullYear() - steps, 0, 1) - offsetMs;
}

/** PocketBase compares datetimes as `YYYY-MM-DD HH:MM:SS.sssZ` strings. */
function toFilterTime(ms) {
  return new Date(ms).toISOString().replace("T", " ");
}

/**
 * Parse a `YYYY-MM-DD` range bound into a UTC instant.
 *
 * The date is read in the shop's timezone, not UTC: an owner asking for
 * "Sep 1 to Sep 12" means their own calendar days. `end` moves to the last
 * millisecond of that local day so the final day is included — a range whose
 * two bounds are the same date still covers that whole day.
 */
function parseRangeBound(text, offsetMinutes, isEnd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || "").trim());

  if (!match) {
    return NaN;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const startLocal = Date.UTC(year, month, day);

  // Reject a date the calendar rolled over (2026-02-31 becoming March 3).
  const check = new Date(startLocal);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day
  ) {
    return NaN;
  }

  const localMs = isEnd ? startLocal + 86400000 - 1 : startLocal;

  return localMs - offsetMinutes * 60000;
}

/**
 * Bucket starts covering `fromMs`..`toMs` inclusive, oldest first.
 *
 * Walks forward from the period containing `from` rather than counting back
 * from now, because a custom range may end in the past. Capped at
 * MAX_BUCKETS so a wide range with a narrow period cannot ask the server for
 * thousands of buckets.
 */
function bucketStartsInRange(fromMs, toMs, period, offsetMinutes) {
  const starts = [];
  let cursor = periodStart(fromMs, period, offsetMinutes);

  while (cursor <= toMs && starts.length < MAX_BUCKETS) {
    starts.push(cursor);

    // Step forward by one period the same way stepBack goes back, so month
    // and year lengths stay honest.
    cursor = stepBack(cursor, period, offsetMinutes, -1);
  }

  return starts;
}

module.exports = {
  PERIODS,
  MAX_BUCKETS,
  periodStart,
  stepBack,
  toFilterTime,
  parseRangeBound,
  bucketStartsInRange,
};
