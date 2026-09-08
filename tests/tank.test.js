/**
 * Tests for the tank estimator.
 * @file tank.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { TankEstimator } = require("../plugin/tank.js");

const HOUR = 3600 * 1000;
const T0 = 1700000000000;

/**
 * Creates an estimator with the default fresh water paths.
 *
 * @param {object} [opts] - Overrides for the estimator options
 * @returns {TankEstimator}
 */
function makeEstimator(opts = {}) {
  return new TankEstimator({
    id: "freshWater",
    name: "Fresh water",
    levelPath: "tanks.freshWater.water.currentLevel",
    remainingPath: "tanks.freshWater.water.remaining",
    predictionBase: "tanks.freshWater.water.prediction",
    ...opts,
  });
}

test.describe("TankEstimator capacity", () => {
  test("infers capacity from coincident level/remaining pairs", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(est.capacityEstimate, 250);
    assert.strictEqual(est.capacity, 250);
  });

  test("smooths capacity estimates with an EMA", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    // 190 l at 0.76 → observed capacity 250 (no movement)
    est.processSample({
      remaining: 190,
      level: 0.76,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, 250);
    // 100 l at 0.5 → observed capacity 200 → EMA: 0.1*200 + 0.9*250
    est.processSample({
      remaining: 100,
      level: 0.5,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, 245);
  });

  test("infers capacity across separate remaining/level deltas", () => {
    const est = makeEstimator();
    // Only remaining arrives first
    est.processSample({
      remaining: 200,
      level: null,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(est.capacityEstimate, null);
    // Later, only level arrives — capacity is inferred from the remembered
    // remaining paired with the new level (200 / 0.8 = 250)
    est.processSample({
      remaining: null,
      level: 0.8,
      crewCount: 2,
      timestamp: T0 + 6 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, 250);
    assert.strictEqual(est.capacity, 250);
  });

  test("ignores level/remaining pairs at the sensor extremes", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 250,
      level: 1,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 5,
      level: 0.01,
      crewCount: 2,
      timestamp: T0 + 6 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, null);
  });

  test("capacity from the tank's capacity path wins over the inferred estimate", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      capacity: 300,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(est.capacity, 300);
    assert.strictEqual(est.capacityEstimate, 250);
  });
});

test.describe("TankEstimator processSample", () => {
  test("learns consumption from a decreasing remaining series", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    // First sample below the noise band: awaits confirmation
    const pending = est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(pending.status, "pending");
    assert.strictEqual(pending.learned, false);
    // Second sample confirms: 48 l over 48 h → 24 l/day
    const res = est.processSample({
      remaining: 152,
      level: 0.608,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    assert.strictEqual(res.status, "learned");
    assert.strictEqual(res.observedRate, 24);
    assert.strictEqual(res.learned, true);
    assert.strictEqual(est.learner.bins.get(2)?.rate, 24);
    assert.strictEqual(est.shortRate, 24);
  });

  test("detects refills and does not learn from them", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 100,
      level: 0.4,
      crewCount: 2,
      timestamp: T0,
    });
    // Rise beyond the band: first sample pending…
    const pending = est.processSample({
      remaining: 180,
      level: 0.72,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    assert.strictEqual(pending.status, "pending");
    // …second sample confirms the refill
    const res = est.processSample({
      remaining: 178,
      level: 0.712,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(res.status, "refill");
    assert.strictEqual(res.observedRate, null);
    assert.strictEqual(res.learned, false);
    assert.strictEqual(est.learner.bins.size, 0);
    // Anchor moved to the post-fill level: the next confirmed drop
    // learns again (20 l over 24 h → 20 l/day)
    est.processSample({
      remaining: 168,
      level: 0.672,
      crewCount: 2,
      timestamp: T0 + 36 * HOUR,
    });
    const res2 = est.processSample({
      remaining: 158,
      level: 0.632,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    assert.strictEqual(res2.status, "learned");
    assert.strictEqual(res2.observedRate, 20);
  });

  test("skips intervals that are too short", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    const res = est.processSample({
      remaining: 190,
      level: 0.76,
      crewCount: 2,
      timestamp: T0 + 60 * 1000,
    });
    assert.strictEqual(res.status, "skipped");
    assert.strictEqual(est.learner.bins.size, 0);
    // Anchor is held so the measurement is not fragmented
    assert.strictEqual(est.anchor?.liters, 200);
  });

  test("skips learning when the source switches mid-interval", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      capacity: 250,
      crewCount: 2,
      timestamp: T0,
    });
    // remaining goes away; level + capacity-path capacity (250) takes over
    const res = est.processSample({
      remaining: null,
      level: 0.7,
      capacity: 250,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(res.status, "skipped");
    assert.strictEqual(est.learner.bins.size, 0);
    // Now stable on the level source: first drop is pending…
    est.processSample({
      remaining: null,
      level: 0.6,
      capacity: 250,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    // …and the second confirms: 50 l over 48 h → 25 l/day
    const res2 = est.processSample({
      remaining: null,
      level: 0.5,
      capacity: 250,
      crewCount: 2,
      timestamp: T0 + 72 * HOUR,
    });
    assert.strictEqual(res2.status, "learned");
    assert.strictEqual(res2.observedRate, 25);
  });

  test("returns insufficient when neither source resolves", () => {
    const est = makeEstimator();
    const res = est.processSample({
      remaining: null,
      level: null,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(res.status, "insufficient");
  });

  test("holds the anchor inside the noise band and learns accumulated use", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    // 0.02 l is well inside the band (max(0.5, 3% of 250) = 7.5 l):
    // nothing learned, anchor held so the sip accumulates
    const res = est.processSample({
      remaining: 199.98,
      level: 0.8,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    assert.strictEqual(res.status, "noise");
    assert.strictEqual(res.observedRate, 0);
    assert.strictEqual(res.learned, false);
    assert.strictEqual(est.anchor?.liters, 200);
    assert.strictEqual(est.shortRate, null);
    // Accumulated sub-band consumption crosses the band and is learned
    // in full over the whole elapsed time
    est.processSample({
      remaining: 192,
      level: 0.768,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    const res2 = est.processSample({
      remaining: 184,
      level: 0.736,
      crewCount: 2,
      timestamp: T0 + 36 * HOUR,
    });
    assert.strictEqual(res2.status, "learned");
    // 16 l over 36 h
    assert.ok(Math.abs((res2.observedRate ?? 0) - (16 / 36) * 24) < 1e-9);
  });

  test("updates the short-term rate with the fast EMA", () => {
    const est = makeEstimator({ shortAlpha: 0.3 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    est.processSample({
      remaining: 152,
      level: 0.608,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    assert.strictEqual(est.shortRate, 24);
    est.processSample({
      remaining: 104,
      level: 0.416,
      crewCount: 2,
      timestamp: T0 + 60 * HOUR,
    });
    est.processSample({
      remaining: 80,
      level: 0.32,
      crewCount: 2,
      timestamp: T0 + 72 * HOUR,
    });
    // Observed 72 l/day (72 l over 24 h); short = 0.3*72 + 0.7*24
    assert.ok(Math.abs((est.shortRate ?? 0) - 38.4) < 1e-9);
  });

  test("ignores sloshing oscillation around a stable level", () => {
    const est = makeEstimator();
    // 120 l tank → band max(0.5, 3% of 120) = 3.6 l
    est.processSample({
      remaining: 100,
      level: null,
      capacity: 120,
      crewCount: 2,
      timestamp: T0,
    });
    // Square wave ±6 l: every swing flips the pending direction before it
    // can be confirmed, so nothing is ever learned
    const wave = [106, 99, 106, 99, 105, 98, 106, 99];
    wave.forEach((remaining, i) => {
      est.processSample({
        remaining,
        level: null,
        capacity: 120,
        crewCount: 2,
        timestamp: T0 + (i + 1) * HOUR,
      });
    });
    assert.strictEqual(est.learner.bins.size, 0);
    assert.strictEqual(est.shortRate, null);
    assert.strictEqual(est.anchor?.liters, 100);
    assert.strictEqual(est.pending, null);
  });

  test("ignores single-sample spikes", () => {
    const est = makeEstimator();
    // 120 l tank → band 3.6 l
    est.processSample({
      remaining: 100,
      level: null,
      capacity: 120,
      crewCount: 2,
      timestamp: T0,
    });
    // Spikes are never confirmed by a second sample in the same direction
    const spikes = [80, 99, 78, 100, 79, 101];
    spikes.forEach((remaining, i) => {
      est.processSample({
        remaining,
        level: null,
        capacity: 120,
        crewCount: 2,
        timestamp: T0 + (i + 1) * HOUR,
      });
    });
    assert.strictEqual(est.learner.bins.size, 0);
    assert.strictEqual(est.shortRate, null);
    assert.strictEqual(est.anchor?.liters, 100);
  });

  test("decays the short-term rate after a quiet day", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    est.processSample({
      remaining: 152,
      level: 0.608,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    assert.strictEqual(est.shortRate, 24);
    // No measurable movement for a day: rate decays toward zero
    est.processSample({
      remaining: 151,
      level: 0.604,
      crewCount: 2,
      timestamp: T0 + 72 * HOUR,
    });
    assert.ok(Math.abs((est.shortRate ?? 0) - 0.7 * 24) < 1e-9);
    est.processSample({
      remaining: 151,
      level: 0.604,
      crewCount: 2,
      timestamp: T0 + 96 * HOUR,
    });
    assert.ok(Math.abs((est.shortRate ?? 0) - 0.7 * 0.7 * 24) < 1e-9);
  });

  test("skipLearning freezes learning and the short-term rate", () => {
    const est = makeEstimator({ minSamples: 0.1 });

    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 180,
      level: 0.72,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    est.processSample({
      remaining: 160,
      level: 0.64,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });

    // First confirmed interval learns 40 l/day
    assert.strictEqual(est.learner.getRate(2), 40);
    assert.strictEqual(est.shortRate, 40);

    // Confirmed drop while learning is skipped: observed rate is still
    // computed, but neither the learner nor the short-term rate move
    est.processSample({
      remaining: 120,
      level: 0.48,
      crewCount: 2,
      timestamp: T0 + 36 * HOUR,
      skipLearning: true,
    });
    const res = est.processSample({
      remaining: 100,
      level: 0.4,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
      skipLearning: true,
    });
    assert.strictEqual(res.status, "learned");
    assert.strictEqual(res.observedRate, 60);
    assert.strictEqual(res.learned, false);
    assert.strictEqual(est.learner.getRate(2), 40);
    assert.strictEqual(est.shortRate, 40);

    // Learning normally again with higher consumption moves the estimate
    est.processSample({
      remaining: 60,
      level: 0.24,
      crewCount: 2,
      timestamp: T0 + 72 * HOUR,
    });
    est.processSample({
      remaining: 20,
      level: 0.08,
      crewCount: 2,
      timestamp: T0 + 84 * HOUR,
    });
    const rate = est.learner.getRate(2);
    assert(
      rate > 40 && rate < 80,
      `rate should be between 40 and 80, got ${rate}`,
    );
  });

  test("treats a canister-sized rise as a refill without inferring consumption", () => {
    const est = makeEstimator({ minSamples: 0.1 });

    est.processSample({
      remaining: 100,
      level: null,
      capacity: 120,
      crewCount: 2,
      timestamp: T0,
    });
    // +7 l confirmed: a real refill (or consumption during it) is not
    // guessed at — nothing is learned from the rise
    const pending = est.processSample({
      remaining: 107,
      level: null,
      capacity: 120,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    assert.strictEqual(pending.status, "pending");
    const res = est.processSample({
      remaining: 106,
      level: null,
      capacity: 120,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });

    assert.strictEqual(res.status, "refill");
    assert.strictEqual(res.observedRate, null);
    assert.strictEqual(res.learned, false);
    assert.strictEqual(est.learner.bins.size, 0);
    assert.strictEqual(est.shortRate, null);
  });

  test("skips learning for large refills that exceed typical canister", () => {
    const est = makeEstimator({ minSamples: 0.1 });

    est.processSample({
      remaining: 50,
      level: null,
      capacity: 200,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 130,
      level: null,
      capacity: 200,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    // Large refill (delta = +78 l): pending first, confirmed on the
    // next sample, never learned
    const res = est.processSample({
      remaining: 128,
      level: null,
      capacity: 200,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });

    assert.strictEqual(res.status, "refill");
    assert.strictEqual(res.observedRate, null);
    assert.strictEqual(res.learned, false);
  });
});

test.describe("TankEstimator predict", () => {
  test("predicts from a learned rate", () => {
    const est = makeEstimator({ minSamples: 0.1 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      capacity: 250,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 176,
      level: 0.704,
      capacity: 250,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    est.processSample({
      remaining: 152,
      level: 0.608,
      capacity: 250,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    const pred = est.predict({ remaining: 152, level: 0.608, crewCount: 2 });
    assert.strictEqual(pred.rateSource, "learned");
    assert.strictEqual(pred.rate, 24);
    assert.strictEqual(pred.remaining24h, 128);
    assert.strictEqual(pred.level24h, (152 - 24) / 250);
    assert.strictEqual(pred.timeToEmptyDays, 152 / 24);
  });

  test("falls back to per-crew default when nothing is learned", () => {
    const est = makeEstimator({
      defaultPerCrewLitersPerDay: 25,
      defaultCrewCount: 3,
    });
    const pred = est.predict({ remaining: 100, level: 0.4, crewCount: 2 });
    assert.strictEqual(pred.rateSource, "default");
    assert.strictEqual(pred.rate, 50);
    assert.strictEqual(pred.remaining24h, 50);
    // Uses the default crew count when the crew is unknown
    const predUnknown = est.predict({
      remaining: 100,
      level: 0.4,
      crewCount: null,
    });
    assert.strictEqual(predUnknown.rate, 75);
  });

  test("floors remaining at zero and clamps level", () => {
    const est = makeEstimator({ minSamples: 0.1 });
    est.processSample({
      remaining: 100,
      level: 0.9,
      capacity: 100,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 20,
      level: 0.2,
      capacity: 100,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    est.processSample({
      remaining: 0,
      level: 0,
      capacity: 100,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    // Learned rate is 100 l/day (100 l over 48 h → 50... see below)
    const pred = est.predict({ remaining: 20, level: 0.2, crewCount: 2 });
    assert.strictEqual(pred.rate, 50);
    assert.strictEqual(pred.remaining24h, 0);
    assert.strictEqual(pred.level24h, 0);
    assert.strictEqual(pred.timeToEmptyDays, 0.4);
  });

  test("returns nulls when the tank state cannot be resolved", () => {
    const est = makeEstimator();
    const pred = est.predict({ remaining: null, level: null, crewCount: 2 });
    assert.strictEqual(pred.liters, null);
    assert.strictEqual(pred.remaining24h, null);
    assert.strictEqual(pred.level24h, null);
    assert.strictEqual(pred.timeToEmptyDays, null);
    // Rate still resolves (default fallback) for consumers of the rate alone
    assert.strictEqual(pred.rate, 12);
  });

  test("estimates liters from level when remaining is absent", () => {
    const est = makeEstimator({ minSamples: 0.1 });
    // Establish the capacity from the tank's capacity path
    est.processSample({
      remaining: null,
      level: null,
      capacity: 200,
      crewCount: 2,
      timestamp: T0,
    });
    const pred = est.predict({ remaining: null, level: 0.5, crewCount: 2 });
    assert.strictEqual(pred.liters, 100);
    assert.strictEqual(pred.remaining24h, Math.max(0, 100 - 12));
    assert.strictEqual(pred.level24h, Math.max(0, (100 - 12) / 200));
  });
});

test.describe("TankEstimator persistence", () => {
  test("survives a JSON round-trip", () => {
    const est = makeEstimator({ minSamples: 0.1 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    est.processSample({
      remaining: 152,
      level: 0.608,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    // Leave a pending confirmation to verify it round-trips too
    est.processSample({
      remaining: 130,
      level: 0.52,
      crewCount: 2,
      timestamp: T0 + 60 * HOUR,
    });

    const restored = makeEstimator({ minSamples: 0.1 });
    restored.fromJSON(JSON.parse(JSON.stringify(est.toJSON())));

    assert.strictEqual(restored.capacityEstimate, est.capacityEstimate);
    assert.strictEqual(restored.capacitySamples, est.capacitySamples);
    assert.strictEqual(restored.shortRate, est.shortRate);
    assert.deepStrictEqual(restored.anchor, est.anchor);
    assert.deepStrictEqual(restored.pending, { kind: "drop" });
    assert.strictEqual(restored.learner.getRate(2), est.learner.getRate(2));
  });

  test("fromJSON tolerates junk", () => {
    const est = makeEstimator();
    est.fromJSON(null);
    est.fromJSON("nope");
    est.fromJSON({
      capacityEstimate: -5,
      anchor: { liters: 1 },
      shortRate: "x",
      pending: "wat",
    });
    assert.strictEqual(est.capacityEstimate, null);
    assert.strictEqual(est.anchor, null);
    assert.strictEqual(est.shortRate, null);
    assert.strictEqual(est.pending, null);
  });
});
