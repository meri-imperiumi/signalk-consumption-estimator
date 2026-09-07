/**
 * Tests for the Consumption Estimator plugin.
 * @file plugin.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EventEmitter } = require("node:events");

const makePlugin = require("../plugin/index.js");

const HOUR = 3600 * 1000;
const T0 = 1700000000000;

// --- Fakes so the plugin can be started without a Signal K server -------

class FakeSubscriptionManager {
  constructor() {
    this.subscriptions = [];
  }

  subscribe(subscription, unsubscribes, errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, errorHandler, deltaHandler });
    const unsubscribe = () => {
      const idx = this.subscriptions.findIndex(
        (s) => s.subscription === subscription,
      );
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
    unsubscribes.push(unsubscribe);
  }

  emitDelta(delta) {
    for (const { deltaHandler } of this.subscriptions) {
      deltaHandler(delta);
    }
  }
}

class FakeSignalKApp extends EventEmitter {
  constructor() {
    super();
    this.selfId = "urn:mrn:imo:mmsi:123456789";
    this.subscriptionmanager = new FakeSubscriptionManager();
    this.dataPath = null;
    this.pathValues = new Map();
    this.setPluginStatusCalls = [];
    this.handleMessageCalls = [];
    this.errors = [];
  }

  getSelfPath(path) {
    return this.pathValues.get(path);
  }

  getDataDirPath() {
    return this.dataPath;
  }

  setPluginStatus(message) {
    this.setPluginStatusCalls.push(message);
  }

  setProviderStatus(message) {
    this.setPluginStatusCalls.push(message);
  }

  handleMessage(source, message) {
    this.handleMessageCalls.push({ source, message });
  }

  debug() {}

  warn() {}

  error(msg) {
    this.errors.push(msg);
  }
}

/**
 * Emits a tank + crew delta through the subscription manager. Tank
 * volumes are in m3 per the Signal K spec, as a real provider would
 * send them.
 *
 * @param {FakeSignalKApp} app
 * @param {number} timestamp - Epoch ms for the delta
 * @param {{remaining?: number|null, level?: number|null, capacity?: number|null, crew?: string[]|null}} values
 * @returns {void}
 */
function emitSample(app, timestamp, { remaining, level, capacity, crew }) {
  const values = [];
  if (remaining !== undefined) {
    values.push({ path: "tanks.freshWater.water.remaining", value: remaining });
  }
  if (level !== undefined) {
    values.push({ path: "tanks.freshWater.water.currentLevel", value: level });
  }
  if (capacity !== undefined) {
    values.push({ path: "tanks.freshWater.water.capacity", value: capacity });
  }
  if (crew !== undefined) {
    values.push({ path: "communication.crewNames", value: crew });
  }
  app.subscriptionmanager.emitDelta({
    context: "vessels.self",
    updates: [
      {
        timestamp: new Date(timestamp).toISOString(),
        values,
      },
    ],
  });
}

/**
 * Collects the value deltas the plugin has published, as
 * `{path: value}` maps.
 *
 * @param {FakeSignalKApp} app
 * @returns {Array<Record<string, unknown>>}
 */
function valueDeltas(app) {
  return app.handleMessageCalls
    .filter(({ message }) =>
      message?.updates?.some((u) => Array.isArray(u.values)),
    )
    .map(({ message }) => {
      const out = {};
      for (const update of message.updates) {
        for (const v of update.values ?? []) {
          out[v.path] = v.value;
        }
      }
      return out;
    });
}

/**
 * Collects the meta updates the plugin has published.
 *
 * @param {FakeSignalKApp} app
 * @returns {Array<{path: string, value: object}>}
 */
function metaUpdates(app) {
  return app.handleMessageCalls.flatMap(({ message }) =>
    (message?.updates ?? []).flatMap((u) => u.meta ?? []),
  );
}

/**
 * Finds the last published value for a path.
 *
 * @param {FakeSignalKApp} app
 * @param {string} path
 * @returns {unknown}
 */
function lastValue(app, path) {
  const deltas = valueDeltas(app);
  for (let i = deltas.length - 1; i >= 0; i--) {
    if (path in deltas[i]) {
      return deltas[i][path];
    }
  }
  return undefined;
}

/**
 * Base config for tests: fast learning gate so bins count as learned
 * quickly, snappy notification thresholds.
 */
const TEST_CONFIG = {
  updateIntervalMinutes: 15,
  saveIntervalMinutes: 15,
  learning: { emaAlpha: 0.05, minSamples: 0.1 },
  notification: { enabled: true, factor: 2, minCycles: 2 },
  tanks: [
    {
      id: "freshWater",
      name: "Fresh water",
      levelPath: "tanks.freshWater.water.currentLevel",
      remainingPath: "tanks.freshWater.water.remaining",
    },
  ],
};

test.describe("Plugin basics", () => {
  test("creates a plugin object", () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    assert.strictEqual(plugin.id, "signalk-consumption-estimator");
    assert.strictEqual(plugin.name, "Consumption Estimator");
    assert.ok(plugin.description);
  });

  test("has required methods", () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    assert.strictEqual(typeof plugin.start, "function");
    assert.strictEqual(typeof plugin.stop, "function");
    assert.strictEqual(typeof plugin.schema, "function");
  });

  test("schema is a valid object with tank configuration", () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const schema = plugin.schema();
    assert.strictEqual(schema.type, "object");
    assert.ok(Array.isArray(schema.properties.tanks.items.required));
    assert.deepStrictEqual(schema.properties.tanks.default.length, 1);
  });
});

test.describe("Plugin lifecycle", () => {
  /** @type {string|null} */
  let tempBase = null;
  /** @type {string[]} */
  const dataDirs = [];

  test.before(async () => {
    tempBase = await mkdtemp(join(tmpdir(), "consumption-test-"));
  });

  test.after(async () => {
    if (tempBase) {
      await rm(tempBase, { recursive: true, force: true });
    }
  });

  /**
   * Creates an isolated data directory per test so persisted state
   * never leaks between tests.
   *
   * @returns {Promise<string>}
   */
  async function newDataDir() {
    const dir = await mkdtemp(join(tempBase, "data-"));
    dataDirs.push(dir);
    return dir;
  }

  test("subscribes to tank and crew paths and sends meta", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);

    const subscription = app.subscriptionmanager.subscriptions[0]?.subscription;
    assert.ok(subscription);
    const paths = subscription.subscribe.map((s) => s.path);
    assert.ok(paths.includes("tanks.freshWater.water.currentLevel"));
    assert.ok(paths.includes("tanks.freshWater.water.remaining"));
    assert.ok(paths.includes("tanks.freshWater.water.capacity"));
    assert.ok(paths.includes("communication.crewNames"));

    const meta = metaUpdates(app);
    const units = Object.fromEntries(meta.map((m) => [m.path, m.value.units]));
    assert.strictEqual(
      units["tanks.freshWater.water.prediction.consumption24h"],
      "m3/s",
    );
    assert.strictEqual(
      units["tanks.freshWater.water.prediction.remaining24h"],
      "m3",
    );
    assert.strictEqual(
      units["tanks.freshWater.water.prediction.level24h"],
      "ratio",
    );

    await plugin.stop();
  });

  test("preserves publication precision and zero values in SI units", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    const internals = plugin.__getInternals();
    const est = internals.estimators[0];
    const base = "tanks.freshWater.water.prediction";

    // Isolate publication from learning with a fractional liters-based prediction.
    for (const liters of [100, null]) {
      est.predict = () => ({
        liters,
        rate: 1.234,
        remaining24h: liters == null ? null : 98.766,
        level24h: liters == null ? null : 0.395064,
      });
      internals.runCycle();
      assert.strictEqual(
        lastValue(app, `${base}.consumption24h`),
        1.23 / 86400000,
      );
      assert.strictEqual(
        lastValue(app, `${base}.remaining24h`),
        liters == null ? null : 0.0988,
      );
      assert.strictEqual(
        lastValue(app, `${base}.level24h`),
        liters == null ? null : 0.395,
      );
    }

    est.predict = () => ({ liters: 0, rate: 0, remaining24h: 0, level24h: 0 });
    internals.runCycle();
    assert.strictEqual(lastValue(app, `${base}.consumption24h`), 0);
    assert.strictEqual(lastValue(app, `${base}.remaining24h`), 0);
    assert.strictEqual(lastValue(app, `${base}.level24h`), 0);
    assert.deepStrictEqual(app.errors, []);
    await plugin.stop();
  });

  test("learns consumption and publishes predictions", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    const internals = plugin.__getInternals();

    // Anchor sample: 200 l (0.2 m3) at 80% with 2 crew, 250 l tank
    emitSample(app, T0, {
      remaining: 0.2,
      level: 0.8,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();

    // 24 h later: 24 l consumed → 24 l/day
    emitSample(app, T0 + 24 * HOUR, {
      remaining: 0.176,
      level: 0.704,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();

    const base = "tanks.freshWater.water.prediction";
    assert.strictEqual(lastValue(app, `${base}.consumption24h`), 24 / 86400000);
    assert.strictEqual(lastValue(app, `${base}.remaining24h`), 0.152);
    // capacity 250 l from the capacity path
    assert.strictEqual(lastValue(app, `${base}.level24h`), 0.608);
    assert.strictEqual(internals.resolveCrewCount(), 2);
    assert.strictEqual(internals.estimators[0].learner.getRate(2), 24);

    const status = app.setPluginStatusCalls.at(-1);
    assert.ok(status.includes("Fresh water"));
    assert.ok(status.includes("24 l/day"));
    assert.ok(status.includes("crew 2 @ 24 l/day"));

    await plugin.stop();
  });

  test("reads tank volumes in m3 and capacity from the capacity path", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    const internals = plugin.__getInternals();

    // 50 l remaining at level 0.5 (inference would say 100 l), but the
    // capacity path says 200 l and wins
    emitSample(app, T0, {
      remaining: 0.05,
      level: 0.5,
      capacity: 0.2,
      crew: ["a"],
    });
    internals.runCycle();

    const est = internals.estimators[0];
    assert.strictEqual(est.capacityEstimate, 100);
    assert.strictEqual(est.capacity, 200);

    const base = "tanks.freshWater.water.prediction";
    // 50 l remaining, default rate 6 l/day for 1 crew
    assert.strictEqual(lastValue(app, `${base}.consumption24h`), 6 / 86400000);
    assert.strictEqual(lastValue(app, `${base}.remaining24h`), 0.044);
    assert.strictEqual(lastValue(app, `${base}.level24h`), 0.22);

    await plugin.stop();
  });

  test("publishes rate-only while no tank data has arrived", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    plugin.__getInternals().runCycle();

    const base = "tanks.freshWater.water.prediction";
    // Volume-dependent predictions stay null, but the rate (default fallback
    // for the default 2 crew) is still published
    assert.strictEqual(lastValue(app, `${base}.consumption24h`), 12 / 86400000);
    assert.strictEqual(lastValue(app, `${base}.remaining24h`), null);
    assert.strictEqual(lastValue(app, `${base}.level24h`), null);
    const status = app.setPluginStatusCalls.at(-1);
    assert.ok(status.includes("no tank data"));

    await plugin.stop();
  });

  test("level-only tank without capacity reports the cause in status", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    const internals = plugin.__getInternals();

    // Tank streams level only; no remaining, no configured capacity →
    // volume can't be derived but the rate is still published
    emitSample(app, T0, { level: 0.8, crew: ["a", "b"] });
    internals.runCycle();

    const base = "tanks.freshWater.water.prediction";
    assert.strictEqual(lastValue(app, `${base}.consumption24h`), 12 / 86400000);
    assert.strictEqual(lastValue(app, `${base}.remaining24h`), null);
    assert.strictEqual(lastValue(app, `${base}.level24h`), null);
    const status = app.setPluginStatusCalls.at(-1);
    assert.ok(status.includes("level only, capacity unknown"));

    await plugin.stop();
  });

  test("shows warming-up status until a crew bin reaches min samples", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    // Default minSamples (3) — not overridden like in TEST_CONFIG
    const plugin = makePlugin(app);
    await plugin.start({
      ...TEST_CONFIG,
      learning: { emaAlpha: 0.05 },
      tanks: [TEST_CONFIG.tanks[0]],
    });
    const internals = plugin.__getInternals();

    let t = T0;
    emitSample(app, t, {
      remaining: 0.2,
      level: 0.8,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();
    t += 24 * HOUR;
    emitSample(app, t, {
      remaining: 0.176,
      level: 0.704,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();

    // One learning sample so far: bin exists but below minSamples (3),
    // so the rate is still the default and the status shows warming up
    const base = "tanks.freshWater.water.prediction";
    assert.strictEqual(lastValue(app, `${base}.consumption24h`), 12 / 86400000);
    const status = app.setPluginStatusCalls.at(-1);
    assert.ok(status.includes("crew 2 warming up (1/3)"));

    await plugin.stop();
  });

  test("empty tank shows ‘→ empty’ rather than ‘→ empty in 1 h’", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start({
      ...TEST_CONFIG,
      tanks: [TEST_CONFIG.tanks[0]],
    });
    const internals = plugin.__getInternals();

    emitSample(app, T0, {
      remaining: 0,
      level: 0,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();

    const status = app.setPluginStatusCalls.at(-1);
    assert.ok(status.includes("0 l (0%)"));
    assert.ok(status.includes("→ empty"));
    assert.ok(!status.includes("→ empty in 1 h"));

    await plugin.stop();
  });

  test("raises and clears the anomaly notification", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    // Big tank (1000 l) so high consumption can run for days
    await plugin.start({
      ...TEST_CONFIG,
      tanks: [TEST_CONFIG.tanks[0]],
    });
    const internals = plugin.__getInternals();

    const notePath =
      "notifications.tanks.freshWater.water.prediction.consumption";

    // Anchor + learn a calm baseline of 24 l/day (volumes in m3)
    let t = T0;
    emitSample(app, t, { remaining: 1, capacity: 1, crew: ["a", "b"] });
    internals.runCycle();
    t += 24 * HOUR;
    emitSample(app, t, { remaining: 0.976, capacity: 1, crew: ["a", "b"] });
    internals.runCycle();
    assert.strictEqual(internals.estimators[0].shortRate, 24);

    // Sustained high consumption: 96 l/day (1000 → 976 → 880 → 784 → 688 → 592)
    for (const remaining of [0.88, 0.784, 0.688, 0.592]) {
      t += 24 * HOUR;
      emitSample(app, t, { remaining, capacity: 1, crew: ["a", "b"] });
      internals.runCycle();
    }
    const raised = lastValue(app, notePath);
    assert.ok(raised, "notification should have been raised");
    assert.strictEqual(raised.state, "warn");
    assert.ok(raised.message.includes("predicted"));

    // Recovery: back to 24 l/day until the short rate decays below
    // the clear threshold (factor / 1.5)
    let remaining = 592;
    for (let day = 0; day < 8; day++) {
      remaining -= 24;
      t += 24 * HOUR;
      emitSample(app, t, {
        remaining: remaining / 1000,
        capacity: 1,
        crew: ["a", "b"],
      });
      internals.runCycle();
    }
    const cleared = lastValue(app, notePath);
    assert.ok(cleared, "notification should have a cleared state");
    assert.strictEqual(cleared.state, "normal");

    await plugin.stop();
  });

  for (const volumeAvailable of [true, false]) {
    test(`anomaly rates stay in liters/day with volume ${volumeAvailable ? "available" : "unavailable"}`, async (t) => {
      const app = new FakeSignalKApp();
      app.dataPath = await newDataDir();
      const plugin = makePlugin(app);
      await plugin.start({
        ...TEST_CONFIG,
        tanks: [TEST_CONFIG.tanks[0]],
      });
      t.after(() => plugin.stop());
      const internals = plugin.__getInternals();
      const est = internals.estimators[0];
      const base = "tanks.freshWater.water.prediction";
      const notePath = `notifications.${base}.consumption`;
      // Seed a learned 15 l/day baseline. Reusing the timestamp below
      // prevents new learning while exercising publication and notifications.
      est.learner.update({ crewCount: 2, intervalHours: 24, liters: 15 });
      emitSample(app, T0, {
        ...(volumeAvailable ? { remaining: 1, capacity: 1 } : {}),
        crew: ["a", "b"],
      });
      est.shortRate = 15;
      internals.runCycle();
      assert.strictEqual(lastValue(app, notePath), undefined);
      assert.strictEqual(
        lastValue(app, `${base}.consumption24h`),
        15 / 86400000,
      );
      assert.strictEqual(
        lastValue(app, `${base}.remaining24h`),
        volumeAvailable ? 0.985 : null,
      );

      // Exactly 2x must persist for two cycles before raising.
      est.shortRate = 30;
      internals.runCycle();
      assert.strictEqual(lastValue(app, notePath), undefined);
      internals.runCycle();
      assert.strictEqual(lastValue(app, notePath).state, "warn");
      assert.strictEqual(
        lastValue(app, notePath).message,
        `${est.name} consumption 2.0x predicted (30 l/day vs 15 l/day)`,
      );

      // Hysteresis retains the warning at factor / 1.5, then clears below it.
      est.shortRate = 20;
      internals.runCycle();
      assert.strictEqual(lastValue(app, notePath).state, "warn");
      est.shortRate = 19;
      internals.runCycle();
      assert.strictEqual(lastValue(app, notePath).state, "normal");
      assert.strictEqual(est.learnedRate(2), 15);
      assert.strictEqual(
        lastValue(app, `${base}.consumption24h`),
        15 / 86400000,
      );
      assert.deepStrictEqual(app.errors, []);
    });
  }

  test("notification disabled in config raises nothing", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start({
      ...TEST_CONFIG,
      notification: { enabled: false, factor: 2, minCycles: 1 },
      tanks: [TEST_CONFIG.tanks[0]],
    });
    const internals = plugin.__getInternals();

    let t = T0;
    emitSample(app, t, { remaining: 1, capacity: 1, crew: ["a", "b"] });
    internals.runCycle();
    t += 24 * HOUR;
    emitSample(app, t, { remaining: 0.976, capacity: 1, crew: ["a", "b"] });
    internals.runCycle();
    t += 24 * HOUR;
    emitSample(app, t, { remaining: 0.88, capacity: 1, crew: ["a", "b"] });
    internals.runCycle();
    t += 24 * HOUR;
    emitSample(app, t, { remaining: 0.784, capacity: 1, crew: ["a", "b"] });
    internals.runCycle();

    const notePath =
      "notifications.tanks.freshWater.water.prediction.consumption";
    assert.strictEqual(lastValue(app, notePath), undefined);

    await plugin.stop();
  });

  test("persists learned state across restarts", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    const internals = plugin.__getInternals();

    emitSample(app, T0, {
      remaining: 0.2,
      level: 0.8,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();
    emitSample(app, T0 + 24 * HOUR, {
      remaining: 0.176,
      level: 0.704,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();
    await plugin.stop();

    // State file exists on disk
    const raw = await readFile(
      join(dataDirs.at(-1), "tank-freshWater.json"),
      "utf-8",
    );
    const saved = JSON.parse(raw);
    assert.strictEqual(saved.learner.bins["2"].rate, 24);
    assert.strictEqual(saved.pathCapacity, 250);
    assert.ok(saved.capacityEstimate > 0);

    // A fresh plugin instance restores the learned state
    const app2 = new FakeSignalKApp();
    app2.dataPath = dataDirs.at(-1);
    const plugin2 = makePlugin(app2);
    await plugin2.start(TEST_CONFIG);
    const est = plugin2.__getInternals().estimators[0];
    assert.strictEqual(est.learner.getRate(2), 24);
    assert.strictEqual(est.capacity, 250);
    assert.ok(est.capacityEstimate > 0);
    await plugin2.stop();
  });

  test("stop unsubscribes and clears timers", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    assert.strictEqual(app.subscriptionmanager.subscriptions.length, 1);
    await plugin.stop();
    assert.strictEqual(app.subscriptionmanager.subscriptions.length, 0);
    assert.strictEqual(plugin.__getInternals().unsubscribes.length, 0);
  });

  test("subscribes to navigation.state for learning control", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);

    const paths =
      app.subscriptionmanager.subscriptions[0].subscription.subscribe.map(
        (s) => s.path,
      );
    assert.ok(paths.includes("navigation.state"));

    await plugin.stop();
  });

  test("skips learning when boat is under way", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start(TEST_CONFIG);
    const internals = plugin.__getInternals();

    // First learning cycle (stationary)
    let t = T0;
    emitSample(app, t, {
      remaining: 0.2,
      level: 0.8,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();
    t += 24 * HOUR;
    emitSample(app, t, {
      remaining: 0.176,
      level: 0.704,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();

    const est = internals.estimators[0];
    // Learned 24 l/day for 2 crew
    assert.strictEqual(est.learner.getRate(2), 24);

    // Now set boat to "sailing" state
    app.pathValues.set("navigation.state", "sailing");
    app.subscriptionmanager.emitDelta({
      updates: [
        {
          values: [{ path: "navigation.state", value: "sailing" }],
          timestamp: new Date(t).toISOString(),
        },
      ],
    });

    // Emit a sample while sailing - should not learn
    t += 24 * HOUR;
    emitSample(app, t, {
      remaining: 0.152,
      level: 0.608,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();

    // Rate should still be 24 (unchanged because learning was skipped)
    assert.strictEqual(est.learner.getRate(2), 24);

    // Set boat back to stationary (anchored)
    app.pathValues.set("navigation.state", "anchored");
    app.subscriptionmanager.emitDelta({
      updates: [
        {
          values: [{ path: "navigation.state", value: "anchored" }],
          timestamp: new Date(t).toISOString(),
        },
      ],
    });

    // Now learning should work again
    t += 24 * HOUR;
    emitSample(app, t, {
      remaining: 0.128,
      level: 0.512,
      capacity: 0.25,
      crew: ["a", "b"],
    });
    internals.runCycle();

    // Rate should have updated (still near 24, with EMA smoothing)
    const rate = est.learner.getRate(2);
    assert(rate > 23 && rate < 25, `rate should be ~24, got ${rate}`);

    await plugin.stop();
  });

  test("supports multiple tanks with custom paths", async () => {
    const app = new FakeSignalKApp();
    app.dataPath = await newDataDir();
    const plugin = makePlugin(app);
    await plugin.start({
      ...TEST_CONFIG,
      tanks: [
        ...TEST_CONFIG.tanks,
        {
          id: "diesel",
          levelPath: "tanks.fuel.0.currentLevel",
          remainingPath: "tanks.fuel.0.remaining",
        },
      ],
    });
    const internals = plugin.__getInternals();
    assert.strictEqual(internals.estimators.length, 2);

    const paths =
      app.subscriptionmanager.subscriptions[0].subscription.subscribe.map(
        (s) => s.path,
      );
    assert.ok(paths.includes("tanks.fuel.0.remaining"));
    assert.ok(paths.includes("tanks.fuel.0.currentLevel"));
    assert.ok(paths.includes("tanks.fuel.0.capacity"));

    const meta = metaUpdates(app);
    assert.ok(
      meta.some((m) => m.path === "tanks.fuel.0.prediction.remaining24h"),
    );

    await plugin.stop();
  });
});
