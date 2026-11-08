# CrabTrack Website + Admin

Files:
- index.html  = main dashboard
- style.css   = shared dashboard styling
- script.js   = main dashboard logic
- admin.html  = administration/diagnostics page
- admin.js    = admin page logic

Architecture:
ESP32 Nodes -> Wi-Fi/MQTT -> Raspberry Pi -> SQLite -> HTTP API -> Website

Current API default:
http://10.193.219.111:3000

Dashboard endpoint:
GET /api/data

Open admin.html from the same folder to check the Raspberry Pi API and node health.
The Admin page only performs browser-side diagnostics and local settings. It does not claim to delete SQLite data or control hardware unless a matching server endpoint is actually implemented.


Current Raspberry Pi routes:
- GET /api/status
- GET /api/data
- GET /api/history

The dashboard and Admin page use /api/data. Automatic node discovery reads node1_ok, node2_ok, and node3_ok from the API response.

──────────────────────────────────────────────────────────
UPDATE: Raspberry Pi backend + offline sync + feeding alerts
──────────────────────────────────────────────────────────
- The actual Raspberry Pi server (SQLite database + HTTP API) now ships in
  ../pi-server/ — see pi-server/README.md to install and run it. Previously
  this website expected something listening at the Pi's IP but no such
  server was included in the package.
- The Config modal's "Raspberry Pi API URL" field is now fully wired up —
  it was present in the HTML before but never connected to any JavaScript.
- Weight/feed/observation entries you log in the dashboard save locally
  first (as before, so nothing is lost offline), then automatically sync
  to the Pi's database once it's reachable. A "N PENDING" badge in the top
  bar shows queued items; click it to force a sync.
- New feeding alerts: configurable on the Alerts page ("FEEDING ALERT"
  card) — a reminder after N hours since a compartment was last fed, and
  an urgent alert after a longer threshold. Optional browser notifications
  toggle sits next to "Sound alerts".
- script.js is now kept in sync with index.html's logic (it previously
  referenced an undefined function and wasn't actually loaded by the page).


MULTI-PAGE NAVIGATION UPDATE
- Dashboard: index.html
- Admin home and internal admin sections: admin.html
- Nodes and feeding: nodes.html
- Bare remote calibration page: calibration_bare.html
All subpages now include links back to Dashboard and Admin Home. The bare calibration page still uses Firebase path /calib_test/Cxx and requires its matching calibration_bare.ino firmware and Firebase rules; it is not automatically compatible with production /crab_scale/ firmware.
