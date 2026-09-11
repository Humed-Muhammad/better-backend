/// <reference path="../pb_data/types.d.ts" />

/**
 * GET /api/pos/analytics — revenue and sale counts, bucketed by period.
 *
 * Server-side because the alternative is downloading every sale the shop has
 * ever made and adding it up on a cheap phone. A year of sales is thousands of
 * records; this returns at most a few dozen numbers.
 *
 * Query: ?period=day|week|month|year&buckets=<n>&offset=<minutes>
 *
 * `offset` is the client's timezone offset in minutes, as
 * `-new Date().getTimezoneOffset()` gives it (Addis Ababa = 180). The bucket
 * maths lives in utils/analytics.js — handlers run in an isolated context and
 * cannot see anything declared beside them in this file, so it is required
 * here inside the handler rather than at the top.
 */
routerAdd("GET", "/api/pos/analytics", (e) => {
  const {
    PERIODS,
    MAX_BUCKETS,
    periodStart,
    stepBack,
    toFilterTime,
    parseRangeBound,
    bucketStartsInRange,
  } = require(`${__hooks}/utils/analytics.js`);

  const auth = e.auth;

  if (!auth) {
    throw new UnauthorizedError("Sign in to view analytics.");
  }

  const shopId = auth.getString("shop");

  if (!shopId) {
    throw new BadRequestError("This account is not attached to a shop.");
  }

  const period = e.request.url.query().get("period") || "day";

  if (!PERIODS[period]) {
    throw new BadRequestError(
      "period must be one of day, week, month, year.",
    );
  }

  const requested = parseInt(
    e.request.url.query().get("buckets") || "0",
    10,
  );
  const bucketCount =
    requested > 0 ? Math.min(requested, MAX_BUCKETS) : PERIODS[period].count;

  // Offsets range from -12:00 to +14:00. Anything else is a bad request
  // rather than something to silently clamp.
  const rawOffset = e.request.url.query().get("offset");
  const offsetMinutes = rawOffset ? parseInt(rawOffset, 10) : 0;

  if (isNaN(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840) {
    throw new BadRequestError("offset must be minutes between -720 and 840.");
  }

  // An explicit from/to range overrides the rolling "last N periods" window.
  // Both bounds are required together: one alone is ambiguous about which
  // end is open, and silently guessing would report the wrong span.
  const rawFrom = e.request.url.query().get("from");
  const rawTo = e.request.url.query().get("to");

  if (Boolean(rawFrom) !== Boolean(rawTo)) {
    throw new BadRequestError("from and to must be provided together.");
  }

  let starts;
  let windowEnd = 0;

  if (rawFrom) {
    const fromMs = parseRangeBound(rawFrom, offsetMinutes, false);
    const toMs = parseRangeBound(rawTo, offsetMinutes, true);

    if (isNaN(fromMs) || isNaN(toMs)) {
      throw new BadRequestError("from and to must be YYYY-MM-DD dates.");
    }

    if (fromMs > toMs) {
      throw new BadRequestError("from must not be after to.");
    }

    starts = bucketStartsInRange(fromMs, toMs, period, offsetMinutes);
    windowEnd = toMs;
  } else {
    const now = Date.now();
    starts = [];

    for (let index = 0; index < bucketCount; index++) {
      starts.push(stepBack(now, period, offsetMinutes, bucketCount - 1 - index));
    }
  }

  const windowStart = starts.length > 0 ? starts[0] : Date.now();

  // Build empty buckets first, so periods with no sales still appear. A gap in
  // a trend is information; a missing row just looks like a shorter report.
  const buckets = starts.map((start) => ({
    start: new Date(start).toISOString(),
    startMs: start,
    paid: 0,
    debt: 0,
    sales: 0,
  }));

  /**
   * `soldAt` is when the sale happened; `created` is when it reached the
   * server. They differ for offline sales, sometimes by days, so analytics
   * must use `soldAt` and fall back only when it is empty.
   */
  // A custom range is bounded on both sides; the rolling window runs to now,
  // so it only needs a lower bound.
  const params = { shop: shopId, from: toFilterTime(windowStart) };
  let filter =
    "shop = {:shop} && (soldAt >= {:from} || (soldAt = '' && created >= {:from}))";

  if (windowEnd) {
    filter =
      "shop = {:shop} && ((soldAt >= {:from} && soldAt <= {:to}) || " +
      "(soldAt = '' && created >= {:from} && created <= {:to}))";
    params.to = toFilterTime(windowEnd);
  }

  const rows = $app.findRecordsByFilter("sales", filter, "soldAt", 0, 0, params);

  for (const row of rows) {
    const soldAt = row.getString("soldAt") || row.getString("created");
    const soldMs = new Date(soldAt.replace(" ", "T")).getTime();

    if (isNaN(soldMs)) {
      continue;
    }

    const bucketStart = periodStart(soldMs, period, offsetMinutes);
    const bucket = buckets.find((entry) => entry.startMs === bucketStart);

    if (!bucket) {
      continue;
    }

    const total = row.getFloat("total");

    // A debt sale is revenue only once it is settled, so the two are counted
    // separately and never summed into one "revenue" figure.
    if (row.getString("status") === "paid") {
      bucket.paid += total;
    } else {
      bucket.debt += total;
    }

    bucket.sales++;
  }

  const totals = { paid: 0, debt: 0, sales: 0 };

  for (const bucket of buckets) {
    totals.paid += bucket.paid;
    totals.debt += bucket.debt;
    totals.sales += bucket.sales;
    delete bucket.startMs;
  }

  return e.json(200, { period: period, buckets: buckets, totals: totals });
});
