# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Tank delta subscriptions are now rate-limited: the plugin asks the
  Signal K server for at most one delivery per third of the update
  interval (minimum 30 s) per tank path, instead of receiving every
  sensor update. Tank senders often publish at 1 Hz or faster, but the
  estimator only samples on its update cycle and needs just the
  freshest value — a 1 Hz stream is cut by more than 99%, reducing the
  plugin's per-delta footprint on loaded servers. Crew and navigation
  state changes are rare and stay unthrottled

## [0.4.0] - 2026-09-08

### Fixed

- Sensor noise (sloshing, heel, temperature) is no longer learned as
  consumption or fed to the anomaly notification. Tank changes within a
  symmetric noise band of `max(0.5 l, 3% of capacity)` hold the
  measurement anchor in either direction, so sub-band consumption
  accumulates and is learned in full once it crosses the band, and a
  change beyond the band only counts once the next sample confirms the
  same direction — single-sample spikes are discarded. Previously a
  single ~8 l bounce in one 15-minute cycle could spike the short-term
  rate to hundreds of liters per day and trigger notifications like
  "115 l/day" on a half-full 200 l tank
- The anomaly notification no longer reacts to data gathered while
  under way: the short-term rate is frozen during skip-learning cycles
  and the anomaly check is suppressed, matching the learning skip that
  exists precisely because tank readings fluctuate under way
- The short-term rate is clamped to the learner's sanity ceiling
  (1000 l/day) and decays toward zero after a full day without a
  confirmed tank movement, so notifications also clear reliably

### Changed

- Refills no longer infer consumption: any confirmed rise is treated as
  a refill and skipped. The old heuristic assumed rises came in 10 l
  canister increments and learned up to 5 l of phantom "consumption"
  from upward sensor noise in the 6–10 l range

## [0.3.1] - 2026-08-25

### Fixed

- Tank volumes are now read in **m3** (the Signal K unit for standard tank
  `remaining`/`capacity` paths) and converted to liters internally.
  Previously the raw m3 value was treated as liters, which scaled all
  volumes by 1/1000: capacity inference produced ~0.2 "liters" from a
  200 l tank, `remaining24h` collapsed to 0 l and `level24h` to 0.00%

### Changed

- Tank capacity is now read from the standard sibling `capacity` path
  (e.g. `tanks.freshWater.water.capacity`), which the plugin subscribes
  to. The `capacity` tank configuration option has been removed — the
  capacity path wins, with the level/remaining inference kept only as a
  fallback for providers that publish no capacity

## [0.2.0] - 2026-08-25

### Added

- Initial implementation of the consumption estimator Signal K plugin
  - Crew-binned EMA learning of tank consumption rates from
    `tanks.<id>.water.remaining` / `currentLevel`, binned by
    `communication.crewNames` count
  - Per-tank capacity inference from coincident level/remaining pairs
  - 24-hour prediction deltas with units metadata:
    `consumption24h` (l/day), `remaining24h` (l), `level24h` (ratio)
  - Optional notification when observed consumption runs well above the
    learned prediction (sustained threshold with hysteresis)
  - JSON persistence of learned state in the plugin data directory
  - Multi-tank support via configuration; no UI — config schema, deltas,
    and plugin status only
- Learning is skipped while the boat is under way (sailing, motoring),
  where tank sensor readings fluctuate
- Plugin subscribes to `navigation.state` for the under-way check

### Changed

- Default consumption per crew member lowered from 30 to **6 l/day**
  (freshwater), a realistic conservative estimate

### Fixed

- `consumption24h` is now always published (learned or default rate) even
  when the tank volume can't be resolved; only the volume-dependent
  `remaining24h` and `level24h` go null in that case
- Capacity is now inferred from `remaining`/`level` pairs that arrive in
  separate deltas (different senders), not only from coincident pairs
- Plugin status explains why tank volume is unresolved (`no tank data`,
  `level only, capacity unknown`) and shows the rate-only value when
  applicable
- Per-cycle debug log of the resolved remaining/level/capacity/crew
  values for diagnostics
- Plugin status distinguishes a learned crew bin from one still
  warming up (`Learning: warming up (N/M samples)` vs
  `Learning: N crew-bins learned`), so a default rate while a bin
  exists is no longer surprising
- An empty tank now shows `→ empty` instead of the misleading
  `→ empty in 1 h`
- Plugin status now describes crew bins by their crew count and rate
  (e.g. `Learning: crew 2 @ 24 l/day` or `Learning: crew 2 warming up
  (1/3)`), making clear that a bin is per crew *count*, not per crew
  member
