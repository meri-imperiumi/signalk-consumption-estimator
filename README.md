# signalk-consumption-estimator

A Signal K server plugin that learns your freshwater tank consumption rate (liters/day) per crew count from the `communication.crewNames` roster, then publishes 24-hour predictions as Signal K deltas — estimated consumption (`consumption24h`, m3/s), predicted remaining volume (`remaining24h`, m3), and predicted tank level (`level24h`, ratio) — with units carried in path metadata, optional anomaly notifications when observed consumption runs well above the learned rate, and learned state persisted to the plugin data directory so it survives restarts.

Learning, configuration, stored state, and status messages continue to use liters and liters/day. Only published predictions are converted: liters/day ÷ (1000 × 86400) to m3/s, and liters ÷ 1000 to m3, after the existing rounding. Prediction paths and the 24-hour forecast horizon are unchanged.
