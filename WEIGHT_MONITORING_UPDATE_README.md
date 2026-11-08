# CrabTrack Weight Monitoring Update

## Included changes
- Adds a **Weight Monitoring** navigation page to the existing CrabTrack dashboard.
- Shows C01–C10 live weights only when a recent heartbeat is available.
- Reads scheduled captures read-only from `/crab_monitor/weight_history/Cxx/YYYY-MM-DD`.
- Adds date-range and compartment filters, latest saved capture per compartment, and a full capture table.
- Leaves the existing dashboard pages, calibration, actuator controls, MQTT topic names, Firebase paths, and database schema intact.
- Adds an additive `updated_at` Unix timestamp to the universal weight-node firmware so Firebase-only live readings can be freshness-checked.

## Install
1. Back up the current `crabtrack` website folder and your ESP32 sketch.
2. Copy the contents of this package's `crabtrack/` folder into the deployed website's `crabtrack/` folder, replacing the existing `index.html` and adding `weight-monitor.js`. Keep all other existing files.
3. For reliable Firebase-only live/offline status, flash the updated `firmware/crabtrack_weight_compartment.ino` to each compartment ESP32. Change only `COMP_NUM` to the correct compartment number (1–10), as described in the sketch.
4. Keep the existing Firebase anonymous authentication and database rules. The page uses the existing CrabTrack Firebase SDK/configuration.
5. Hard-refresh the website after deployment.

## Data behavior
- Pi live mode uses the existing `/api/data` response and its `nodes[].lastSeen`, `nodes[].online`, and `nodes[].lastPayload` fields. It does not rely on cached dashboard weights.
- If the Pi API is unavailable, the page checks `/crab_monitor/weights/Cxx` and accepts a value as live only if `updated_at` is present, recent (30 seconds), and `online` is not false. Older firmware does not publish `updated_at`, so its persisted Firebase value is deliberately shown as offline rather than falsely live.
- Captured records are read only. The page never creates a capture, fills a missing capture from live data, or writes to the history path.
- The existing schedule-capture firmware is responsible for writing scheduled records. This ZIP did not contain `CrabTrack_WeightNode_ScheduledHistory.ino`, so its capture-write/idempotency implementation could not be changed or audited here. The UI deduplicates repeated reads of the same Firebase path/key but does not alter stored records.

## Verification checklist
- Confirm all ten ESP32s have the correct compartment number and synchronized network time.
- Confirm each `/crab_monitor/weights/Cxx` value includes `weight`, `online`, and `updated_at`.
- Confirm scheduled records exist under `/crab_monitor/weight_history/Cxx/YYYY-MM-DD`.
- Test Pi API mode and Firebase mode, then disconnect one weight node: its card should become OFFLINE after the node's heartbeat timeout / 30-second Firebase freshness window.
- Select a date range with known history and compare displayed capture dates, timestamps, and weights with Firebase. A missing record must remain `—` / NO RECORD.

## Important limitation
I cannot verify physical sensor readings, Firebase security rules, scheduled capture behavior, or all ten live nodes from the supplied files alone. Those require the deployed Raspberry Pi, Firebase database, and powered hardware.


## Analytics captured-weight chart update

The Analytics page now reads its weight trend and daily growth-rate charts from the existing Firebase scheduled-capture records at `/crab_monitor/weight_history/C01` through `/C10`. It does not use current/live sensor values or local demonstration history for these two charts. The selected Analytics date range is applied to the saved records; days without a saved capture are left blank, and growth rate is left blank unless at least two captures on different dates exist. Firebase reads are cached for up to 30 seconds to avoid repeated reads while other dashboard telemetry refreshes. The service-worker cache version was incremented so browsers request the updated dashboard shell.

After deployment, reload the site (or close and reopen the installed PWA) and check that Firebase rules/authentication allow read access to the existing `weight_history` path. If no capture records exist in the selected period, the charts remain empty rather than showing live or sample weights.

## Analytics readability update (C01–C10)

The Analytics page now includes a ten-compartment latest-capture summary and a focused, individually scaled weight graph. Select or click C01–C10 to inspect its saved scheduled captures without the heavier compartments compressing the vertical scale. Compartments with no saved record in the selected date range are explicitly labelled; no live values or demonstration records are substituted. The all-compartment trend remains available. Chart date labels and point visibility have also been improved.
