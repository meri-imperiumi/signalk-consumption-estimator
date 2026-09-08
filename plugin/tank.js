/**
 * Per-tank consumption estimator.
 *
 * Watches a tank's `remaining` (liters, primary) and `currentLevel`
 * (ratio) paths, infers tank capacity from level/remaining pairs, detects
 * refills, and feeds observed consumption intervals into a crew-binned
 * learner. Produces the 24-hour prediction used for the Signal K deltas.
 *
 * A short-term EMA of the observed rate (fast alpha) is kept alongside
 * the learned long-term rate so consumers can compare "what is happening
 * now" against "what is expected" (anomaly notification).
 *
 * @file tank.js
 */

const { ConsumptionLearner } = require("./learning.js");

/**
 * Level range within which remaining/level pairs are used for capacity
 * inference. At the extremes the sensor resolution and geometry make the
 * ratio unreliable.
 */
const CAPACITY_LEVEL_MIN = 0.05;
const CAPACITY_LEVEL_MAX = 0.98;

/** EMA smoothing for capacity inference. */
const CAPACITY_ALPHA = 0.1;

/**
 * Minimum change (liters) treated as a real tank movement. Smaller
 * changes in either direction are sensor noise.
 */
const CHANGE_MIN_LITERS = 0.5;

/**
 * Noise band as a fraction of tank capacity: level senders bounce by a
 * few percent with heel, waves, and temperature. Changes within the
 * band (in either direction) hold the anchor, so sub-band consumption
 * accumulates and is learned once it crosses the band.
 */
const CHANGE_CAPACITY_FRACTION = 0.03;

/**
 * After this many hours without a confirmed tank movement the tank
 * demonstrably consumes less than the noise band per day, and the
 * short-term rate is decayed toward zero.
 */
const QUIET_DECAY_HOURS = 24;

/** Fast EMA for the short-term observed rate. */
const DEFAULT_SHORT_ALPHA = 0.3;

/**
 * Intervals outside this range are not learned (see learning.js for the
 * rationale; mirrored here for sample gating).
 */
const MIN_INTERVAL_HOURS = 5 / 60;
const MAX_INTERVAL_HOURS = 24 * 7;

/**
 * Clamps a value to [0, 1].
 *
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Tank consumption estimator with crew-binned learning.
 */
class TankEstimator {
  /**
   * @param {object} opts
   * @param {string} opts.id - Tank identifier (persistence filename)
   * @param {string} opts.name - Human-readable tank name
   * @param {string} opts.levelPath - Signal K level path (ratio)
   * @param {string} opts.remainingPath - Signal K remaining path (m3)
   * @param {string} opts.capacityPath - Signal K capacity path (m3)
   * @param {string} opts.predictionBase - Base path for prediction deltas
   * @param {number} [opts.defaultPerCrewLitersPerDay] - Fallback rate per crew member
   * @param {number} [opts.defaultCrewCount] - Crew count used when unknown
   * @param {number} [opts.emaAlpha] - Learner EMA alpha
   * @param {number} [opts.minSamples] - Learner minimum weighted samples
   * @param {number} [opts.shortAlpha] - Short-term rate EMA alpha
   */
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.levelPath = opts.levelPath;
    this.remainingPath = opts.remainingPath;
    this.capacityPath = opts.capacityPath;
    this.predictionBase = opts.predictionBase;
    this.defaultPerCrew =
      typeof opts.defaultPerCrewLitersPerDay === "number" &&
      opts.defaultPerCrewLitersPerDay >= 0
        ? opts.defaultPerCrewLitersPerDay
        : 6;
    this.defaultCrewCount =
      typeof opts.defaultCrewCount === "number" && opts.defaultCrewCount >= 0
        ? Math.round(opts.defaultCrewCount)
        : 2;
    this.shortAlpha =
      typeof opts.shortAlpha === "number" && opts.shortAlpha > 0
        ? opts.shortAlpha
        : DEFAULT_SHORT_ALPHA;

    /** @type {ConsumptionLearner} */
    this.learner = new ConsumptionLearner({
      emaAlpha: opts.emaAlpha,
      minSamples: opts.minSamples,
    });

    /** @type {number|null} */
    this.capacityEstimate = null;
    /** @type {number} */
    this.capacitySamples = 0;

    /**
     * Latest capacity (liters) from the tank's `capacity` path, if the
     * provider publishes one. Wins over the inferred estimate.
     *
     * @type {number|null}
     */
    this.pathCapacity = null;

    /**
     * Last processed sample anchor.
     *
     * @type {{liters: number, time: number, source: "remaining"|"level"}|null}
     */
    this.anchor = null;

    /**
     * Most recently seen remaining (liters) and level (ratio), remembered
     * across cycles so capacity can be inferred even when the two arrive in
     * separate deltas from different senders.
     *
     * @type {{remaining: number|null, level: number|null, time: number}}
     */
    this.lastSeen = { remaining: null, level: null, time: 0 };

    /** @type {number|null} */
    this.shortRate = null;

    /**
     * First sample beyond the noise band awaiting confirmation by the
     * next sample: `{kind: "rise"|"drop"}|null`. Single-sample spikes
     * (sloshing) are discarded instead of learned.
     *
     * @type {{kind: "rise"|"drop"}|null}
     */
    this.pending = null;
  }

  /**
   * Capacity in liters: the tank's `capacity` path value wins, else the
   * inferred estimate.
   *
   * @returns {number|null}
   */
  get capacity() {
    return this.pathCapacity ?? this.capacityEstimate;
  }

  /**
   * Folds an observed rate into the short-term EMA.
   *
   * @param {number} observedRate
   * @returns {void}
   */
  updateShortRate(observedRate) {
    this.shortRate =
      this.shortRate == null
        ? observedRate
        : this.shortAlpha * observedRate +
          (1 - this.shortAlpha) * this.shortRate;
  }

  /**
   * Processes a tank sample: infers capacity, detects refills, and learns
   * the consumption over the interval since the previous confirmed
   * movement.
   *
   * Sensor noise is rejected with a symmetric deadband plus confirmation:
   * changes within `max(CHANGE_MIN_LITERS, CHANGE_CAPACITY_FRACTION ×
   * capacity)` hold the anchor (sub-band consumption accumulates until
   * it crosses the band), and a change beyond the band only counts once
   * the next sample confirms the same direction. This keeps sloshing and
   * single-sample spikes from being learned as consumption or refills.
   *
   * @param {object} sample
   * @param {number|null} sample.remaining - Remaining liters (primary source)
   * @param {number|null} sample.level - Current level (ratio 0-1)
   * @param {number|null} sample.capacity - Tank capacity in liters from the
   *        tank's `capacity` path, when the provider publishes one
   * @param {number|null} sample.crewCount - Crew on board at sample time
   * @param {number} sample.timestamp - Sample time (epoch ms)
   * @param {boolean} [sample.skipLearning=false] - Skip learning this sample
   *        (e.g. while under way); also freezes the short-term rate
   * @returns {{status: "learned"|"refill"|"noise"|"pending"|"skipped"|"insufficient",
   *            observedRate: number|null, learned: boolean}}
   */
  processSample({
    remaining,
    level,
    capacity,
    crewCount,
    timestamp,
    skipLearning = false,
  }) {
    if (capacity != null && Number.isFinite(capacity) && capacity > 0) {
      this.pathCapacity = capacity;
    }

    if (Number.isFinite(timestamp)) {
      if (remaining != null && Number.isFinite(remaining)) {
        this.lastSeen.remaining = remaining;
        this.lastSeen.time = timestamp;
      }
      if (level != null && Number.isFinite(level)) {
        this.lastSeen.level = level;
        this.lastSeen.time = timestamp;
      }
    }

    // Capacity inference from any known remaining/level pair, even if
    // they arrived in separate deltas (different senders). Uses the
    // freshest value of each seen so far.
    // Capacity inference from any known remaining/level pair, even if
    // they arrived in separate deltas (different senders). Uses the
    // freshest value of each seen so far. Only a fallback for tanks
    // whose provider does not publish the `capacity` path.
    {
      const r =
        remaining != null && Number.isFinite(remaining)
          ? remaining
          : this.lastSeen.remaining;
      const l =
        level != null && Number.isFinite(level) ? level : this.lastSeen.level;
      if (
        r != null &&
        l != null &&
        l >= CAPACITY_LEVEL_MIN &&
        l <= CAPACITY_LEVEL_MAX &&
        l > 0
      ) {
        const observedCap = r / l;
        if (Number.isFinite(observedCap) && observedCap > 0) {
          this.capacityEstimate =
            this.capacityEstimate == null
              ? observedCap
              : CAPACITY_ALPHA * observedCap +
                (1 - CAPACITY_ALPHA) * this.capacityEstimate;
          this.capacitySamples += 1;
        }
      }
    }

    const cap = this.capacity;

    let liters = null;
    /** @type {"remaining"|"level"|null} */
    let source = null;
    if (remaining != null && Number.isFinite(remaining)) {
      liters = remaining;
      source = "remaining";
    } else if (
      level != null &&
      Number.isFinite(level) &&
      cap != null &&
      cap > 0
    ) {
      liters = level * cap;
      source = "level";
    }

    if (liters == null || source == null || !Number.isFinite(timestamp)) {
      return { status: "insufficient", observedRate: null, learned: false };
    }

    const anchor = this.anchor;
    if (anchor == null || anchor.source !== source) {
      // First sample, or the volume source changed (e.g. `remaining` went
      // away and `level` took over): the liter scales are not comparable,
      // so re-anchor without learning
      this.anchor = { liters, time: timestamp, source };
      this.pending = null;
      return { status: "skipped", observedRate: null, learned: false };
    }

    const intervalHours = (timestamp - anchor.time) / 3600000;
    if (!Number.isFinite(intervalHours) || intervalHours < MIN_INTERVAL_HOURS) {
      // Too soon since the anchor to judge a change; keep anchor and any
      // pending confirmation so a fast sender cannot fragment intervals
      return { status: "skipped", observedRate: null, learned: false };
    }
    if (intervalHours > MAX_INTERVAL_HOURS) {
      // Interval too long (server off, tank unmonitored) to attribute to
      // current behavior; re-anchor without learning
      this.anchor = { liters, time: timestamp, source };
      this.pending = null;
      return { status: "skipped", observedRate: null, learned: false };
    }

    const band = Math.max(
      CHANGE_MIN_LITERS,
      cap != null && cap > 0 ? CHANGE_CAPACITY_FRACTION * cap : 0,
    );
    const delta = liters - anchor.liters;

    if (Math.abs(delta) <= band) {
      // Inside the noise band: hold the anchor so sub-band consumption
      // accumulates, and discard any pending confirmation. After a full
      // day without a confirmed movement the observed rate is by
      // definition below the band, so decay the short-term rate.
      this.pending = null;
      if (!skipLearning && intervalHours >= QUIET_DECAY_HOURS) {
        this.updateShortRate(0);
      }
      return { status: "noise", observedRate: 0, learned: false };
    }

    const kind = delta > 0 ? "rise" : "drop";
    if (this.pending == null || this.pending.kind !== kind) {
      // First sample beyond the band in this direction: wait for the next
      // sample to confirm, so single-sample spikes are not learned
      this.pending = { kind };
      return { status: "pending", observedRate: null, learned: false };
    }

    // Confirmed by two consecutive samples beyond the band in the same
    // direction: re-anchor and act on the full movement
    this.pending = null;
    this.anchor = { liters, time: timestamp, source };

    if (kind === "rise") {
      // Refill: consumption during the interval cannot be separated from
      // the amount added, so don't learn. Under-estimating is safer than
      // inventing consumption (the old canister-inference heuristic did
      // exactly that on upward sensor noise).
      return { status: "refill", observedRate: null, learned: false };
    }

    const consumed = -delta;
    const observedRate = Math.min(
      this.learner.maxRate,
      (consumed / intervalHours) * 24,
    );

    const learned =
      !skipLearning &&
      this.learner.update({
        crewCount,
        intervalHours,
        liters: consumed,
        timestamp,
      });

    if (!skipLearning) {
      this.updateShortRate(observedRate);
    }

    return { status: "learned", observedRate, learned };
  }

  /**
   * Predicts tank state 24 hours from now.
   *
   * @param {object} sample
   * @param {number|null} sample.remaining - Current remaining liters
   * @param {number|null} sample.level - Current level (ratio 0-1)
   * @param {number|null} sample.crewCount - Current crew count
   * @returns {{rate: number, rateSource: "learned"|"default",
   *            liters: number|null, capacity: number|null,
   *            remaining24h: number|null, level24h: number|null,
   *            timeToEmptyDays: number|null}}
   */
  predict({ remaining, level, crewCount }) {
    const cap = this.capacity;

    let liters = null;
    if (remaining != null && Number.isFinite(remaining)) {
      liters = remaining;
    } else if (
      level != null &&
      Number.isFinite(level) &&
      cap != null &&
      cap > 0
    ) {
      liters = level * cap;
    }

    let rate = this.learner.getRate(crewCount);
    let rateSource = "learned";
    if (rate == null) {
      const crew = crewCount ?? this.defaultCrewCount;
      rate = this.defaultPerCrew * (Number.isFinite(crew) ? crew : 0);
      rateSource = "default";
    }

    const remaining24h = liters == null ? null : Math.max(0, liters - rate);
    const level24h =
      liters != null && cap != null && cap > 0
        ? clamp01((liters - rate) / cap)
        : null;
    const timeToEmptyDays = liters != null && rate > 0 ? liters / rate : null;

    return {
      rate,
      rateSource,
      liters,
      capacity: cap,
      remaining24h,
      level24h,
      timeToEmptyDays,
    };
  }

  /**
   * Learned (long-term) rate for a crew count, without the default
   * fallback — used by the anomaly check so it never compares against a
   * default guess.
   *
   * @param {number|null} crewCount
   * @returns {number|null}
   */
  learnedRate(crewCount) {
    return this.learner.getRate(crewCount);
  }

  /**
   * Serializes the estimator state for persistence.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      version: 1,
      id: this.id,
      pathCapacity: this.pathCapacity,
      capacityEstimate: this.capacityEstimate,
      capacitySamples: this.capacitySamples,
      lastSeen: this.lastSeen,
      anchor: this.anchor,
      pending: this.pending,
      shortRate: this.shortRate,
      learner: this.learner.toJSON(),
    };
  }

  /**
   * Restores estimator state from a serialized object.
   *
   * @param {object} data
   * @returns {void}
   */
  fromJSON(data) {
    if (data == null || typeof data !== "object") {
      return;
    }
    if (
      typeof data.pathCapacity === "number" &&
      Number.isFinite(data.pathCapacity) &&
      data.pathCapacity > 0
    ) {
      this.pathCapacity = data.pathCapacity;
    }
    if (
      typeof data.capacityEstimate === "number" &&
      Number.isFinite(data.capacityEstimate) &&
      data.capacityEstimate > 0
    ) {
      this.capacityEstimate = data.capacityEstimate;
    }
    if (
      typeof data.capacitySamples === "number" &&
      Number.isFinite(data.capacitySamples)
    ) {
      this.capacitySamples = data.capacitySamples;
    }
    if (
      data.anchor != null &&
      typeof data.anchor === "object" &&
      Number.isFinite(data.anchor.liters) &&
      Number.isFinite(data.anchor.time) &&
      (data.anchor.source === "remaining" || data.anchor.source === "level")
    ) {
      this.anchor = {
        liters: data.anchor.liters,
        time: data.anchor.time,
        source: data.anchor.source,
      };
    }
    if (typeof data.shortRate === "number" && Number.isFinite(data.shortRate)) {
      this.shortRate = data.shortRate;
    }
    if (
      data.pending != null &&
      typeof data.pending === "object" &&
      (data.pending.kind === "rise" || data.pending.kind === "drop")
    ) {
      this.pending = { kind: data.pending.kind };
    } else {
      this.pending = null;
    }
    if (data.lastSeen != null && typeof data.lastSeen === "object") {
      const ls = data.lastSeen;
      if (ls.remaining == null || Number.isFinite(ls.remaining)) {
        this.lastSeen.remaining = ls.remaining == null ? null : ls.remaining;
      }
      if (ls.level == null || Number.isFinite(ls.level)) {
        this.lastSeen.level = ls.level == null ? null : ls.level;
      }
      if (Number.isFinite(ls.time)) {
        this.lastSeen.time = ls.time;
      }
    }
    if (data.learner != null && typeof data.learner === "object") {
      this.learner = ConsumptionLearner.fromJSON(data.learner);
    }
  }
}

module.exports = {
  TankEstimator,
  DEFAULT_SHORT_ALPHA,
  CHANGE_MIN_LITERS,
  CHANGE_CAPACITY_FRACTION,
  QUIET_DECAY_HOURS,
  MIN_INTERVAL_HOURS,
  MAX_INTERVAL_HOURS,
};
