/**
 * Signal K Consumption Estimator plugin.
 *
 * Learns tank consumption (liters/day) binned by crew count from Signal K
 * tank paths, and publishes 24-hour predictions as deltas:
 *
 * - `<tank>.prediction.consumption24h` - estimated consumption rate (m3/s)
 * - `<tank>.prediction.remaining24h`   - predicted remaining volume (m3)
 * - `<tank>.prediction.level24h`       - predicted level (ratio 0-1)
 *
 * Optionally raises a notification when observed consumption runs well
 * above the learned prediction. No UI: configuration, deltas, and plugin
 * status only.
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const { TankEstimator } = require("./tank.js");
const { loadTankState, saveTankState } = require("./store.js");

/**
 * Path providing the crew on board (array of names).
 */
const CREW_PATH = "communication.crewNames";

/**
 * Path providing the boat's navigation state.
 */
const NAV_STATE_PATH = "navigation.state";

/**
 * Signal K tank volumes (`remaining`, `capacity`) are in m3; the
 * estimator works in liters.
 */
const M3_TO_LITERS = 1000;
const SECONDS_PER_DAY = 86400;

/**
 * Liters of precision to keep when converting m3 tank volumes (milliliter
 * resolution, well beyond tank sensor accuracy, avoids float drift).
 */
const VOLUME_DECIMALS = 3;

/**
 * Default tank configuration: a single fresh water tank on the standard
 * Signal K paths.
 */
const DEFAULT_TANK = {
  id: "freshWater",
  name: "Fresh water",
  levelPath: "tanks.freshWater.water.currentLevel",
  remainingPath: "tanks.freshWater.water.remaining",
  predictionBase: "tanks.freshWater.water.prediction",
  defaultPerCrewLitersPerDay: 6,
  defaultCrewCount: 2,
};

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG = {
  updateIntervalMinutes: 15,
  saveIntervalMinutes: 15,
  learning: {
    emaAlpha: 0.05,
    minSamples: 3,
  },
  notification: {
    enabled: true,
    factor: 2,
    minCycles: 4,
  },
  tanks: [DEFAULT_TANK],
};

/**
 * Navigation states that indicate the boat is under way and
 * learning should be skipped (motion causes tank sensor fluctuation).
 */
const UNDER_WAY_STATES = ["sailing", "motoring", "under way"];

/**
 * Delay before the first cycle after start, so subscribed providers have
 * a moment to deliver their first values.
 */
const INITIAL_CYCLE_DELAY_MS = 5000;

/**
 * Unwraps a Signal K value that may be a plain number or wrapped in an
 * object with a `value` field.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (
    value != null &&
    typeof value === "object" &&
    typeof (/** @type {{value?: unknown}} */ (value).value) === "number"
  ) {
    const inner = /** @type {{value: number}} */ (value).value;
    return Number.isFinite(inner) ? inner : null;
  }
  return null;
}

/**
 * Unwraps a Signal K value that may be a plain array or wrapped in an
 * object with a `value` field.
 *
 * @param {unknown} value
 * @returns {Array|null}
 */
function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    value != null &&
    typeof value === "object" &&
    Array.isArray(/** @type {{value?: unknown}} */ (value).value)
  ) {
    return /** @type {{value: Array}} */ (value).value;
  }
  return null;
}

/**
 * Rounds to a given number of decimals.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Formats a duration in days for the status line.
 *
 * @param {number|null} days
 * @returns {string|null}
 */
function formatDurationDays(days) {
  if (days == null || !Number.isFinite(days)) {
    return null;
  }
  if (days <= 0) {
    return "empty";
  }
  if (days < 1) {
    return `${Math.max(1, Math.round(days * 24))} h`;
  }
  if (days < 10) {
    return `${days.toFixed(1)} d`;
  }
  return `${Math.round(days)} d`;
}

/**
 * Derives the prediction base path from a level path:
 * `tanks.freshWater.water.currentLevel` → `tanks.freshWater.water.prediction`.
 *
 * @param {string} levelPath
 * @returns {string}
 */
function predictionBaseFromLevelPath(levelPath) {
  const idx = levelPath.lastIndexOf(".");
  if (idx <= 0) {
    return `${levelPath}.prediction`;
  }
  return `${levelPath.slice(0, idx)}.prediction`;
}

/**
 * Derives the capacity path from a level path:
 * `tanks.freshWater.water.currentLevel` → `tanks.freshWater.water.capacity`.
 *
 * @param {string} levelPath
 * @returns {string}
 */
function capacityPathFromLevelPath(levelPath) {
  const idx = levelPath.lastIndexOf(".");
  if (idx <= 0) {
    return `${levelPath}.capacity`;
  }
  return `${levelPath.slice(0, idx)}.capacity`;
}

/**
 * Derives a tank id from a level path: the segment after `tanks`.
 *
 * @param {string} levelPath
 * @returns {string}
 */
function tankIdFromLevelPath(levelPath) {
  const segments = levelPath.split(".");
  const idx = segments.indexOf("tanks");
  if (idx >= 0 && segments.length > idx + 1) {
    return segments[idx + 1];
  }
  return segments.length > 1 ? segments[segments.length - 2] : "tank";
}

/**
 * Prettifies a tank id into a display name: `freshWater` → `Fresh water`.
 *
 * @param {string} id
 * @returns {string}
 */
function nameFromTankId(id) {
  const spaced = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Reads a finite positive number option, or returns the fallback.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOption(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Normalizes plugin configuration against defaults.
 *
 * @param {object|null} config
 * @returns {object}
 */
function normalizeConfig(config) {
  const cfg = config && typeof config === "object" ? config : {};
  const learning =
    cfg.learning && typeof cfg.learning === "object" ? cfg.learning : {};
  const notification =
    cfg.notification && typeof cfg.notification === "object"
      ? cfg.notification
      : {};
  const tanks =
    Array.isArray(cfg.tanks) && cfg.tanks.length > 0
      ? cfg.tanks
      : [DEFAULT_TANK];

  return {
    updateIntervalMinutes: numberOption(cfg.updateIntervalMinutes, 15),
    saveIntervalMinutes: numberOption(cfg.saveIntervalMinutes, 15),
    learning: {
      emaAlpha: numberOption(
        learning.emaAlpha,
        DEFAULT_CONFIG.learning.emaAlpha,
      ),
      minSamples: numberOption(
        learning.minSamples,
        DEFAULT_CONFIG.learning.minSamples,
      ),
    },
    notification: {
      enabled: notification.enabled !== false,
      factor: numberOption(
        notification.factor,
        DEFAULT_CONFIG.notification.factor,
      ),
      minCycles: Math.round(
        numberOption(
          notification.minCycles,
          DEFAULT_CONFIG.notification.minCycles,
        ),
      ),
    },
    tanks,
  };
}

/**
 * Builds the JSON Schema for the plugin configuration.
 *
 * @returns {object} JSON Schema
 */
function buildPluginSchema() {
  return {
    type: "object",
    title: "Consumption Estimator Configuration",
    description:
      "Learns tank consumption per crew count and publishes 24-hour predictions as Signal K deltas",
    properties: {
      updateIntervalMinutes: {
        type: "number",
        title: "Update Interval",
        description:
          "How often to sample tanks, learn, and republish predictions (minutes)",
        default: 15,
        minimum: 5,
        maximum: 60,
      },
      saveIntervalMinutes: {
        type: "number",
        title: "Save Interval",
        description:
          "How often to persist learned consumption rates to disk (minutes)",
        default: 15,
        minimum: 5,
        maximum: 120,
      },
      learning: {
        type: "object",
        title: "Learning",
        properties: {
          emaAlpha: {
            type: "number",
            title: "EMA Alpha",
            description:
              "Smoothing factor per 24 h of observations (higher adapts faster)",
            default: 0.05,
            minimum: 0.01,
            maximum: 0.5,
          },
          minSamples: {
            type: "number",
            title: "Minimum Samples",
            description:
              "Weighted sample days before a crew bin counts as learned (a 24 h interval weighs 1.0)",
            default: 3,
            minimum: 0.5,
            maximum: 50,
          },
        },
      },
      notification: {
        type: "object",
        title: "Anomaly Notification",
        properties: {
          enabled: {
            type: "boolean",
            title: "Enabled",
            description:
              "Raise a notification when observed consumption runs well above the learned prediction",
            default: true,
          },
          factor: {
            type: "number",
            title: "Threshold Factor",
            description:
              "Observed consumption must exceed the learned prediction by this factor",
            default: 2,
            minimum: 1.5,
            maximum: 10,
          },
          minCycles: {
            type: "number",
            title: "Minimum Cycles",
            description:
              "Consecutive update cycles above the threshold before the notification fires",
            default: 4,
            minimum: 1,
            maximum: 24,
          },
        },
      },
      tanks: {
        type: "array",
        title: "Tanks",
        description: "Tanks to estimate consumption for",
        items: {
          type: "object",
          required: ["levelPath", "remainingPath"],
          properties: {
            id: {
              type: "string",
              title: "Tank ID",
              description: "Identifier used for persistence and status",
            },
            name: {
              type: "string",
              title: "Display Name",
              description:
                "Human-readable tank name for status and notifications",
            },
            levelPath: {
              type: "string",
              title: "Level Path",
              description: "Signal K path for tank level (ratio 0-1)",
              default: DEFAULT_TANK.levelPath,
            },
            remainingPath: {
              type: "string",
              title: "Remaining Path",
              description: "Signal K path for remaining volume (m3)",
              default: DEFAULT_TANK.remainingPath,
            },
            predictionBase: {
              type: "string",
              title: "Prediction Base Path",
              description:
                "Base path for prediction deltas (defaults to the level path's parent + .prediction)",
            },
            defaultPerCrewLitersPerDay: {
              type: "number",
              title: "Default Consumption Per Crew",
              description:
                "Liters per day per crew member used until enough has been learned",
              default: 6,
              minimum: 0,
            },
            defaultCrewCount: {
              type: "number",
              title: "Default Crew Count",
              description:
                "Crew count assumed for the default rate when the crew is unknown",
              default: 2,
              minimum: 0,
            },
          },
        },
        default: [DEFAULT_TANK],
      },
    },
  };
}

/**
 * Main plugin function.
 *
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin} Plugin instance
 */
module.exports = (app) => {
  const pluginId = "signalk-consumption-estimator";

  /** @type {TankEstimator[]} */
  let estimators = [];

  /** @type {Set<string>} */
  let subscribedPaths = new Set();

  /**
   * Cache of subscribed path values with their source timestamps.
   *
   * @type {Map<string, {raw: unknown, ts: number}>}
   */
  const pathCache = new Map();

  /** @type {number|null} */
  let updateIntervalId = null;

  /** @type {number|null} */
  let saveIntervalId = null;

  /** @type {ReturnType<typeof setTimeout>|null} */
  let initialCycleTimeout = null;

  /** @type {Function[]} */
  const unsubscribes = [];

  /** @type {object|null} */
  let pluginConfig = null;

  /**
   * Per-tank anomaly notification state.
   *
   * @type {Map<string, {cycles: number, active: boolean}>}
   */
  const noteStates = new Map();

  /**
   * Last prediction per tank id, for the status line.
   *
   * @type {Map<string, object>}
   */
  const lastPredictions = new Map();

  /** @type {Function} */
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);

  /**
   * Publishes a delta to the Signal K tree.
   *
   * @param {Record<string, unknown>} updates - Path → value map
   * @returns {void}
   */
  function publishDelta(updates) {
    const delta = {
      context: `vessels.${app.selfId}`,
      updates: [
        {
          source: {
            label: pluginId,
          },
          timestamp: new Date().toISOString(),
          values: Object.entries(updates).map(([path, value]) => ({
            path,
            value,
          })),
        },
      ],
    };
    app.handleMessage(pluginId, delta);
  }

  /**
   * Publishes metadata (units, labels) for the prediction paths of every
   * configured tank, once at startup.
   *
   * @returns {void}
   */
  function sendMeta() {
    const meta = [];
    for (const est of estimators) {
      meta.push(
        {
          path: `${est.predictionBase}.consumption24h`,
          value: {
            displayName: `${est.name} consumption`,
            description: `Estimated ${est.name.toLowerCase()} consumption rate in cubic meters per second, learned per crew count`,
            units: "m3/s",
          },
        },
        {
          path: `${est.predictionBase}.remaining24h`,
          value: {
            displayName: `${est.name} remaining in 24 h`,
            description: `Predicted ${est.name.toLowerCase()} remaining volume in 24 hours`,
            units: "m3",
          },
        },
        {
          path: `${est.predictionBase}.level24h`,
          value: {
            displayName: `${est.name} level in 24 h`,
            description: `Predicted ${est.name.toLowerCase()} tank level (0-1) in 24 hours`,
            units: "ratio",
          },
        },
      );
    }
    if (meta.length === 0) {
      return;
    }
    app.handleMessage(pluginId, {
      context: `vessels.${app.selfId}`,
      updates: [{ meta }],
    });
  }

  /**
   * Reads a cached (or server-side) path value as a number.
   *
   * @param {string} path
   * @returns {number|null}
   */
  function readNumber(path) {
    const cached = pathCache.get(path);
    if (cached != null) {
      return toNumber(cached.raw);
    }
    return toNumber(app.getSelfPath(path));
  }

  /**
   * Reads a cached (or server-side) tank volume path (m3 per the Signal K
   * spec) and converts it to liters.
   *
   * @param {string} path
   * @returns {number|null} Liters
   */
  function readTankVolume(path) {
    const m3 = readNumber(path);
    if (m3 == null) {
      return null;
    }
    const factor = 10 ** VOLUME_DECIMALS;
    return Math.round(m3 * M3_TO_LITERS * factor) / factor;
  }

  /**
   * Reads the freshest source timestamp among a tank's paths.
   *
   * @param {TankEstimator} est
   * @returns {number}
   */
  function sampleTimestamp(est) {
    const ts = [
      pathCache.get(est.remainingPath)?.ts,
      pathCache.get(est.levelPath)?.ts,
    ].filter((t) => typeof t === "number");
    if (ts.length > 0) {
      return Math.max(...ts);
    }
    return Date.now();
  }

  /**
   * Resolves the current crew count from `communication.crewNames`.
   * An empty array is a valid "nobody aboard" (0); a missing path is
   * unknown (null).
   *
   * @returns {number|null}
   */
  function resolveCrewCount() {
    const cached = pathCache.get(CREW_PATH);
    const raw = cached != null ? cached.raw : app.getSelfPath(CREW_PATH);
    const arr = toArray(raw);
    if (arr == null) {
      return null;
    }
    return arr.length;
  }

  /**
   * Checks if the boat is under way (sailing, motoring, or similar).
   * Learning is skipped when under way because motion causes tank
   * sensor fluctuations.
   *
   * @returns {boolean}
   */
  function isUnderWay() {
    const cached = pathCache.get(NAV_STATE_PATH);
    const raw = cached != null ? cached.raw : app.getSelfPath(NAV_STATE_PATH);
    const state = typeof raw === "string" ? raw.trim().toLowerCase() : null;
    return state != null && UNDER_WAY_STATES.includes(state);
  }

  /**
   * Handles a Signal K delta: caches values for paths we subscribe to.
   *
   * @param {object} delta
   * @returns {void}
   */
  function processDelta(delta) {
    for (const update of delta?.updates ?? []) {
      const ts = Date.parse(update?.timestamp ?? "");
      const time = Number.isFinite(ts) ? ts : Date.now();
      for (const entry of update?.values ?? []) {
        if (
          typeof entry?.path === "string" &&
          subscribedPaths.has(entry.path)
        ) {
          pathCache.set(entry.path, { raw: entry.value, ts: time });
        }
      }
    }
  }

  /**
   * Publishes or clears a tank's anomaly notification.
   *
   * @param {TankEstimator} est
   * @param {boolean} active
   * @param {string|null} message
   * @returns {void}
   */
  function publishNotification(est, active, message) {
    const path = `notifications.${est.predictionBase}.consumption`;
    if (!active) {
      publishDelta({
        [path]: { state: "normal", method: [], message: "OK" },
      });
      return;
    }
    publishDelta({
      [path]: {
        state: "warn",
        method: ["visual"],
        message: message ?? `${est.name} consumption above prediction`,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Compares short-term observed consumption against the learned rate and
   * manages the anomaly notification lifecycle (raise after sustained
   * excess, clear with hysteresis).
   *
   * @param {TankEstimator} est
   * @param {number|null} crewCount
   * @returns {void}
   */
  function checkAnomaly(est, crewCount) {
    const cfg = pluginConfig?.notification;
    const state = noteStates.get(est.id) ?? { cycles: 0, active: false };
    noteStates.set(est.id, state);

    if (!cfg || cfg.enabled === false) {
      return;
    }

    // Both anomaly rates stay in liters/day; SI conversion is publication-only.
    const learnedLitersPerDay = est.learnedRate(crewCount);
    const observedLitersPerDay = est.shortRate;

    if (
      learnedLitersPerDay == null ||
      learnedLitersPerDay <= 0 ||
      observedLitersPerDay == null
    ) {
      state.cycles = 0;
      if (state.active) {
        state.active = false;
        publishNotification(est, false, null);
      }
      return;
    }

    const factor = cfg.factor ?? DEFAULT_CONFIG.notification.factor;
    const ratio = observedLitersPerDay / learnedLitersPerDay;

    if (state.active) {
      // Hysteresis: clear once clearly back below the threshold
      if (ratio < factor / 1.5) {
        state.active = false;
        state.cycles = 0;
        publishNotification(est, false, null);
      }
      return;
    }

    if (ratio >= factor) {
      state.cycles += 1;
    } else {
      state.cycles = 0;
    }

    const minCycles = cfg.minCycles ?? DEFAULT_CONFIG.notification.minCycles;
    if (state.cycles >= minCycles) {
      state.active = true;
      state.cycles = 0;
      publishNotification(
        est,
        true,
        `${est.name} consumption ${ratio.toFixed(1)}x predicted (${Math.round(observedLitersPerDay)} l/day vs ${Math.round(learnedLitersPerDay)} l/day)`,
      );
    }
  }

  /**
   * Builds and updates the plugin status line.
   *
   * @returns {void}
   */
  function updateStatus() {
    if (!setStatus) {
      return;
    }
    try {
      const parts = estimators.map((est) => {
        const pred = lastPredictions.get(est.id);
        if (!pred || pred.liters == null) {
          // Explain why no volume could be resolved
          const remaining = readNumber(est.remainingPath);
          const level = readNumber(est.levelPath);
          const cap = est.capacity;
          let reason;
          if (remaining == null && level == null) {
            reason = "no tank data";
          } else if (remaining == null && level != null && cap == null) {
            reason = "level only, capacity unknown";
          } else {
            reason = "waiting for data";
          }
          const rate = pred?.rate;
          const ratePart =
            rate != null ? `, ${Math.round(rate)} l/day (rate only)` : "";
          return `${est.name}: ${reason}${ratePart}`;
        }
        const pct =
          pred.capacity != null && pred.capacity > 0
            ? Math.round((pred.liters / pred.capacity) * 100)
            : null;
        let line = `${est.name}: ${Math.round(pred.liters)} l`;
        if (pct != null) {
          line += ` (${pct}%)`;
        }
        line += `, ${pred.crewLabel ?? "?"} crew, ${Math.round(pred.rate)} l/day`;
        const until = formatDurationDays(pred.timeToEmptyDays);
        if (until) {
          line += ` → empty in ${until}`;
        }
        return line;
      });

      const totalBins = estimators.reduce(
        (sum, est) => sum + est.learner.bins.size,
        0,
      );
      if (totalBins > 0) {
        const minSamples = Math.round(estimators[0]?.learner.minSamples ?? 1);
        // Describe each crew-count bin: learned ones by their rate, warming-up
        // ones by sample progress. A bin is per crew *count* (e.g. one bin for
        // "2 crew"), not per crew member.
        const binDescs = estimators.flatMap((est) =>
          [...est.learner.bins.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([crew, bin]) => {
              const learned = bin.samples >= minSamples;
              const rate = Math.round(bin.rate);
              return learned
                ? `crew ${crew} @ ${rate} l/day`
                : `crew ${crew} warming up (${bin.samples}/${minSamples})`;
            }),
        );
        if (binDescs.length > 0) {
          parts.push(`Learning: ${binDescs.join(", ")}`);
        }
      }

      setStatus(parts.length > 0 ? parts.join(" · ") : "No tanks configured");
    } catch (error) {
      app.error(`Failed to update status: ${error?.message ?? error}`);
    }
  }

  /**
   * Runs one estimation cycle: sample tanks, learn, publish predictions
   * and notifications.
   *
   * @returns {void}
   */
  function runCycle() {
    if (estimators.length === 0) {
      return;
    }
    try {
      const crewCount = resolveCrewCount();
      const underWay = isUnderWay();
      for (const est of estimators) {
        // Tank volumes arrive in m3 per the Signal K spec; convert to liters
        const remaining = readTankVolume(est.remainingPath);
        const capacity = readTankVolume(est.capacityPath);
        const level = readNumber(est.levelPath);
        const timestamp = sampleTimestamp(est);

        const result = est.processSample({
          remaining,
          level,
          capacity,
          crewCount,
          timestamp,
          skipLearning: underWay,
        });
        app.debug(
          `Tank ${est.id}: sample ${result.status}` +
            (result.observedRate != null
              ? ` (${Math.round(result.observedRate)} l/day observed)`
              : "") +
            ` — remaining=${remaining ?? "null"}, level=${level ?? "null"}, ` +
            `capacity=${est.capacity ?? "null"} (path ${
              capacity ?? "null"
            }, estimate ${
              est.capacityEstimate == null
                ? "null"
                : Math.round(est.capacityEstimate)
            }, ${est.capacitySamples} samples), crew=${crewCount ?? "null"}`,
        );

        const pred = est.predict({ remaining, level, crewCount });
        lastPredictions.set(est.id, {
          ...pred,
          crewLabel: crewCount == null ? null : String(crewCount),
        });

        // Preserve liters-based rounding before converting published values to SI.
        if (pred.liters == null) {
          // Tank volume can't be resolved (no remaining, or no capacity to
          // convert level). The consumption rate is still useful on its own,
          // so publish it; clear the volume-dependent predictions.
          publishDelta({
            [`${est.predictionBase}.consumption24h`]:
              round(pred.rate, 2) / (M3_TO_LITERS * SECONDS_PER_DAY),
            [`${est.predictionBase}.remaining24h`]: null,
            [`${est.predictionBase}.level24h`]: null,
          });
        } else {
          publishDelta({
            [`${est.predictionBase}.consumption24h`]:
              round(pred.rate, 2) / (M3_TO_LITERS * SECONDS_PER_DAY),
            [`${est.predictionBase}.remaining24h`]:
              pred.remaining24h == null
                ? null
                : round(pred.remaining24h, 1) / M3_TO_LITERS,
            [`${est.predictionBase}.level24h`]:
              pred.level24h == null ? null : round(pred.level24h, 3),
          });
        }

        checkAnomaly(est, crewCount);
      }
      updateStatus();
    } catch (error) {
      app.error(`Estimation cycle failed: ${error?.message ?? error}`);
    }
  }

  /**
   * Persists all estimator state to disk.
   *
   * @returns {Promise<void>}
   */
  async function saveAll() {
    const dataDir = app.getDataDirPath();
    for (const est of estimators) {
      try {
        await saveTankState(dataDir, est.id, est.toJSON());
      } catch (error) {
        app.error(
          `Failed to save state for tank ${est.id}: ${error?.message ?? error}`,
        );
      }
    }
  }

  /**
   * Builds estimators from normalized configuration.
   *
   * @param {object} config - Normalized configuration
   * @returns {TankEstimator[]}
   */
  function buildEstimators(config) {
    const out = [];
    for (const tank of config.tanks) {
      if (
        !tank ||
        typeof tank.levelPath !== "string" ||
        tank.levelPath === "" ||
        typeof tank.remainingPath !== "string" ||
        tank.remainingPath === ""
      ) {
        app.warn("Skipping tank with missing levelPath/remainingPath");
        continue;
      }
      const id =
        typeof tank.id === "string" && tank.id !== ""
          ? tank.id
          : tankIdFromLevelPath(tank.levelPath);
      const name =
        typeof tank.name === "string" && tank.name !== ""
          ? tank.name
          : nameFromTankId(id);
      out.push(
        new TankEstimator({
          id,
          name,
          levelPath: tank.levelPath,
          remainingPath: tank.remainingPath,
          capacityPath: capacityPathFromLevelPath(tank.levelPath),
          predictionBase:
            typeof tank.predictionBase === "string" &&
            tank.predictionBase !== ""
              ? tank.predictionBase
              : predictionBaseFromLevelPath(tank.levelPath),
          defaultPerCrewLitersPerDay:
            typeof tank.defaultPerCrewLitersPerDay === "number" &&
            tank.defaultPerCrewLitersPerDay >= 0
              ? tank.defaultPerCrewLitersPerDay
              : DEFAULT_CONFIG.tanks[0].defaultPerCrewLitersPerDay,
          defaultCrewCount:
            typeof tank.defaultCrewCount === "number" &&
            tank.defaultCrewCount >= 0
              ? tank.defaultCrewCount
              : DEFAULT_CONFIG.tanks[0].defaultCrewCount,
          emaAlpha: config.learning.emaAlpha,
          minSamples: config.learning.minSamples,
        }),
      );
    }
    return out;
  }

  /**
   * Subscribes to the tank and crew paths.
   *
   * @returns {void}
   */
  function subscribeToDeltas() {
    const paths = new Set([CREW_PATH, NAV_STATE_PATH]);
    for (const est of estimators) {
      paths.add(est.levelPath);
      paths.add(est.remainingPath);
      paths.add(est.capacityPath);
    }
    subscribedPaths = paths;

    const subscription = {
      context: "vessels.self",
      subscribe: Array.from(paths).map((path) => ({ path })),
    };

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Subscription error: ${subscriptionError}`);
      },
      (delta) => {
        try {
          processDelta(delta);
        } catch (error) {
          app.error(`Delta processing error: ${error?.message ?? error}`);
        }
      },
    );
    app.debug(`Subscribed to ${paths.size} paths`);
  }

  /** @type {Plugin} */
  const plugin = {
    id: pluginId,
    name: "Consumption Estimator",
    description:
      "Learns tank consumption per crew count and predicts 24-hour usage",

    /**
     * Starts the plugin.
     *
     * @param {object} config - Plugin configuration
     * @param {Function} restart - Restart callback
     */
    async start(config, _restart) {
      app.debug("Starting Consumption Estimator");

      pluginConfig = normalizeConfig(config);
      pathCache.clear();
      noteStates.clear();
      lastPredictions.clear();

      estimators = buildEstimators(pluginConfig);
      if (estimators.length === 0) {
        setStatus?.("No valid tanks configured");
        return;
      }

      // Restore learned state from disk
      const dataDir = app.getDataDirPath();
      for (const est of estimators) {
        try {
          const saved = await loadTankState(dataDir, est.id);
          if (saved) {
            est.fromJSON(saved);
            app.debug(`Restored state for tank ${est.id}`);
          }
        } catch (error) {
          app.error(
            `Failed to load state for tank ${est.id}: ${error?.message ?? error}`,
          );
        }
      }

      sendMeta();
      subscribeToDeltas();

      updateIntervalId = setInterval(
        runCycle,
        pluginConfig.updateIntervalMinutes * 60000,
      );
      saveIntervalId = setInterval(() => {
        saveAll().catch((error) => {
          app.error(`Save cycle error: ${error?.message ?? error}`);
        });
      }, pluginConfig.saveIntervalMinutes * 60000);
      initialCycleTimeout = setTimeout(runCycle, INITIAL_CYCLE_DELAY_MS);

      const bins = estimators.reduce(
        (sum, est) => sum + est.learner.bins.size,
        0,
      );
      setStatus?.(
        `Started. Watching ${estimators.length} tank${estimators.length > 1 ? "s" : ""}` +
          (bins > 0
            ? `, ${bins} crew-count bin${bins > 1 ? "s" : ""} restored`
            : ""),
      );
      app.debug("Consumption Estimator started");
    },

    /**
     * Stops the plugin.
     */
    async stop() {
      app.debug("Stopping Consumption Estimator");

      if (updateIntervalId != null) {
        clearInterval(updateIntervalId);
        updateIntervalId = null;
      }
      if (saveIntervalId != null) {
        clearInterval(saveIntervalId);
        saveIntervalId = null;
      }
      if (initialCycleTimeout != null) {
        clearTimeout(initialCycleTimeout);
        initialCycleTimeout = null;
      }

      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;

      // Clear any active notifications before going away
      for (const [id, state] of noteStates.entries()) {
        if (state.active) {
          const est = estimators.find((e) => e.id === id);
          if (est) {
            publishNotification(est, false, null);
          }
        }
      }

      await saveAll();

      const bins = estimators.reduce(
        (sum, est) => sum + est.learner.bins.size,
        0,
      );
      setStatus?.(
        bins > 0
          ? `Stopped. Saved ${bins} crew-count bin${bins > 1 ? "s" : ""}`
          : "Stopped",
      );
      app.debug("Consumption Estimator stopped");
    },

    /**
     * Returns the JSON Schema for configuration.
     *
     * @returns {object} JSON Schema
     */
    schema() {
      return buildPluginSchema();
    },
  };

  // Expose internals for testing
  plugin.__getInternals = () => ({
    estimators,
    runCycle,
    resolveCrewCount,
    processDelta,
    pathCache,
    get unsubscribes() {
      return unsubscribes;
    },
    get pluginConfig() {
      return pluginConfig;
    },
  });

  return plugin;
};
