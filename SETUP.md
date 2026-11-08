# CrabTrack — setup guide (v2)

```
ESP32 Nodes ─┬─ HTTP ──┐
             └─ MQTT ──┴─► Raspberry Pi ─► SQLite ─► HTTP API ─┬─► Website / installable app
                              (offline, always running)         ├─► Telegram messages
                                                                └─► Firebase mirror (optional)
```

---

## 1. Raspberry Pi

```bash
sudo apt update && sudo apt install -y nodejs npm build-essential python3
cd CrabTrack_Website/pi-server
cp .env.example .env        # edit it — every line is optional
npm install
npm start
```

Find the Pi's address with `hostname -I`, then open
`http://<pi-ip>:3000/` on any device on the same Wi-Fi. The dashboard is
served by the Pi itself, so there's no separate web host to run.

To keep it running after reboot, see the systemd unit in
[`docs/ONLINE_ACCESS.md`](docs/ONLINE_ACCESS.md).

---

## 2. Adding nodes

Copy `firmware/crabtrack_node.ino`, change `NODE_ID`, flash. Full detail in
[`docs/ADD_A_NODE.md`](docs/ADD_A_NODE.md).

Manage them at `http://<pi-ip>:3000/nodes.html`.

---

## 3. Feeding alerts

On **nodes.html → Feeding Schedule**, add the times crabs should be fed
(e.g. 07:00 and 17:00). The Pi checks every 5 minutes. When a feeding time
passes with no FED entry logged for a compartment, it:

1. writes an alert to the database,
2. shows it in the dashboard's Alerts page and as a browser notification,
3. sends a message to your phone if a channel is configured.

After the grace period (default 60 min) a gentle reminder becomes urgent.
Tapping **FED ✓** on the Due Right Now list logs the feeding and clears it.

The old "hasn't been fed in 24h / 48h" interval rule still runs as a backstop,
so you get reminders even with no schedule configured.

**Everything above runs on the Pi**, not in the browser. Alerts fire with no
phone and no browser open.

---

## 4. Messages to your phone

Easiest channel is Telegram — free, no SIM, no server:

1. Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts,
   copy the token it gives you.
2. Send any message to your new bot.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and find
   `"chat":{"id":123456789` in the JSON.
4. Put both into `pi-server/.env`:

```env
TELEGRAM_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=123456789
```

5. `sudo systemctl restart crabtrack`

The **Send Message** button on nodes.html uses the same channel. Messages are
written to an outbox table before delivery, so if the Pi's internet is down the
message queues and goes out automatically when the link returns.

For a group, create a Telegram group, add the bot, and use the group's chat id
(it starts with a `-`) — then everyone on the team gets the alerts.

---

## 5. Installing it as an app

The dashboard is a PWA, so it installs from the browser with no app store:

- **Android (Chrome):** open `http://<pi-ip>:3000/`, tap **⬇ Install App** in
  the top bar, or ⋮ → *Install app*.
- **iPhone/iPad (Safari):** Share → *Add to Home Screen*. (Safari doesn't show
  an install button; this is the only route.)
- **Desktop (Chrome/Edge):** the ⊕ icon in the address bar.

Once installed it opens fullscreen with its own icon, and the service worker
caches the interface so it still opens when the Pi is unreachable — showing the
last readings it saw rather than an error page.

**One catch:** service workers require `http://localhost` or **HTTPS**. Over a
plain LAN IP like `http://10.193.219.111:3000`, Chrome on Android will let you
install but may refuse to register the worker. If you want full offline app
behaviour, put the Pi behind Tailscale or a Cloudflare Tunnel (both give you
HTTPS for free) — see [`docs/ONLINE_ACCESS.md`](docs/ONLINE_ACCESS.md).

Opening the files directly with `file://` will *not* work — the service worker
and the API calls both need the Pi serving them over HTTP.

---

## 6. Online access

Read [`docs/ONLINE_ACCESS.md`](docs/ONLINE_ACCESS.md) — it compares Tailscale,
Cloudflare Tunnel and the Firebase mirror, and includes the Firebase security
rules you should set before going live.

---

## What's in the package

```
CrabTrack_Website/
├── crabtrack/              the website / app
│   ├── index.html          main dashboard  (+ PWA + feeding notifications)
│   ├── nodes.html          NEW — add nodes, feeding schedule, message button
│   ├── admin.html          diagnostics
│   ├── manifest.json       NEW — app metadata
│   ├── sw.js               NEW — service worker (offline app shell)
│   └── icons/              NEW — app icons
├── pi-server/              the Raspberry Pi backend
│   ├── server.js           HTTP API + background jobs
│   ├── db.js               SQLite, now with a dynamic node registry
│   ├── mqtt-bridge.js      wildcard MQTT subscriber
│   ├── notify.js           NEW — Telegram / webhook / log outbox
│   ├── cloud-sync.js       NEW — optional one-way Firebase mirror
│   └── .env.example        NEW — all configuration
├── firmware/
│   ├── crabtrack_node.ino              template sketch for a new node
│   ├── crabtrack_node4_weight.ino      HX711 weight node
│   ├── crabtrack_node5_solenoids.ino   4-channel solenoid node
│   └── crabtrack_node6_pump.ino        NEW — pump node (separate board)
└── docs/
    ├── ADD_A_NODE.md
    ├── ONLINE_ACCESS.md
    ├── SOLENOID_AUTOMATION.md
    ├── PUMP_DRAIN_CYCLE.md             NEW — pump + drain/weigh cycle
    └── TROUBLESHOOTING.md
```


## 7. Admin pages and linked solenoids

The Admin page is split into tabs: Overview, Calibration, Raspberry Pi, Solenoids & Pump, Feeding & Notifications, and Maintenance. Calibration uses the existing online Firebase command path (`/crab_scale/cmd/Cxx`) first, with the Pi command API as a fallback. Use one compartment sketch per ESP32 and change only `COMP_NUM` (1–10).

**Solenoids 1 and 2 are linked to the pump in this build.** The updated API does NOT tie solenoids 1 and 2 to the pump. At 06:00 daily, the seeded drain/weigh cycle turns the pump OFF, opens solenoids 1 and 2 for 2 minutes, closes them, waits 20 seconds, records available C01–C10 weights, then returns the pump to automatic operation. The pump and valve ESP32s poll independently, so exact millisecond simultaneity is not guaranteed. Verify valve direction and water flow with the pump disabled before live operation.

Feeding reminders are configured in Admin → Feeding & Notifications. For Telegram, set `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` in `pi-server/.env`, restart the server, then use “Send test notification”. The Pi must have internet access for Telegram delivery; local alerts/outbox still work on the LAN.


## Updated node status and scheduled water control

- Open `node-status.html` for live ONLINE/OFFLINE cards for sensor nodes, weight nodes C01–C10, solenoid controller (node5), and pump controller (node6). It refreshes every 5 seconds.
- The database seeds a daily 06:00 drain/weigh cycle for solenoids 1+2 (2 minutes open, 20 seconds settling, then records available weights for all compartments). The schedule is added only if its label is not already present; existing schedules are not overwritten.
- Two salinity-rule drafts are seeded disabled: valve 3 below 15 closes at 18; valve 4 above 25 closes at 22. Keep them disabled until you confirm whether the API's `salinity` value is true ppt or EC mS/cm and set thresholds accordingly. The current EC sensor value must not be treated as ppt without a validated conversion.
- To keep the existing MQTT topics flowing in this Node backend, set `MQTT_BROKER=mqtt://localhost:1883` in `pi-server/.env`. The bridge subscribes to `crabtrack/#`, including `crabtrack/node2/data` and `crabtrack/weight1`…`weight10`.
- Important: your currently running Pi setup uses Python Flask on port 3000. This ZIP's automation routes are implemented in the included Node.js backend, not the Flask `server.py`. Do not run both servers on port 3000. Before enabling this automation on the live Pi, back up your current `~/crab-monitor` and its database, then either migrate to this Node backend with MQTT enabled or port the actuator routes into your Flask app. The ZIP alone does not patch your live Pi.


The included solenoid and pump firmware now resolve `crabtrackpi.local` via mDNS instead of embedding a changing DHCP address. This works only when the ESP32s and Pi are on the same local Wi-Fi and the Pi's Avahi/mDNS service is running. The web dashboard can still be reached remotely only through your separately configured secure remote-access method.
