# PitWall UDP Agent

Lightweight Windows background service that listens to F1 23 / 24 / 25 UDP
telemetry, captures full sessions automatically while you drive, and syncs
them to the PitWall API when each session ends. No interaction needed —
the system tray icon is the only UI.

## How it works

```
F1 game ──UDP──▶ listener ──▶ version-routed parser (2023/2024/2025)
                                   │
                                   ▼
                       session lifecycle state machine
              IDLE → CONNECTED → SESSION_ACTIVE → SYNCING → IDLE
                                   │
                                   ▼
                    SQLite buffer (%APPDATA%\PitWall Agent\)
                                   │
                                   ▼
              POST /api/sessions/udp-ingest  (retry w/ backoff)
```

- **Session start**: `SSTA` event packet, or lap-data flow while on track.
- **Session end**: `SEND` event, final classification, finished/DNF result
  status, or 60 s of UDP silence (marked `abandoned`).
- **Per lap**: time, sectors (S3 derived), validity, per-corner tyre wear,
  compound, pit flag, safety-car flag.
- **Per session**: setup snapshot, stints, fuel start/end, damage log every
  5 laps, grid/finish position, weather.
- **Offline-safe**: sessions queue in SQLite (max 50) and retry
  30 s → 2 min → 10 min → 30 min → hourly until synced. `409` (duplicate)
  counts as synced; `422` (invalid) is failed permanently.

## Development

```bash
npm install
npm run dev          # runs from source with tsx
npm run typecheck
```

Config lives at `%APPDATA%\PitWall Agent\.env` (created on first run —
see `.env.example`). Environment variables override the file, e.g.
`UDP_PORT=20778 npm run dev` to avoid clashing with another listener.

### Simulating a session

Any tool that replays F1 UDP packets to the configured port works. The
parser routes on the `packetFormat` header field (2023/2024/2025) and
discards unknown formats with a single warning.

## Production install

```bash
npm run build              # tsc → dist/
npm run package            # pkg → build/PitWallAgent.exe
npm run service:install    # register "PitWall Agent" Windows service (elevated)
npm run service:uninstall
```

The service auto-starts with Windows and restarts on crash (node-windows).

## F1 game settings (one-time)

F1 25: **Settings → Telemetry Settings**
1. UDP Telemetry: **On**
2. UDP Broadcast Mode: **Off**
3. UDP IP Address: **127.0.0.1**
4. UDP Port: **20777** (must match `UDP_PORT`)
5. UDP Send Rate: **20 Hz** or higher
6. UDP Format: **2025** (F1 24 → 2024, F1 23 → 2023)

## Coexisting with Moza Pit House / SimHub / other UDP tools

F1's telemetry output is **unicast to exactly one configured IP:port** —
it cannot send to two destinations at once, and Windows delivers each
incoming datagram to whichever bound socket is most specific (a tool bound
to `127.0.0.1:20777` wins over PitWall's `0.0.0.0:20777`, silently starving
it). Two apps genuinely cannot both "just listen" on the game's port.

The fix (same approach TrackTitan/SimHub use): make PitWall the **single
exclusive receiver**, then have it **relay** an unmodified copy of every
packet on to the other tool's own port.

1. Point F1 25's UDP output at PitWall's port only (`20777` by default).
2. In the other tool (Moza Pit House, etc.), change its listening port to
   something else — e.g. `20778` — if it supports that. Most telemetry
   tools do; check its own settings.
3. Add that port to `FORWARD_TARGETS` in `%APPDATA%\PitWall Agent\.env`:
   ```
   FORWARD_TARGETS=127.0.0.1:20778
   ```
   Comma-separate multiple targets for more tools.
4. Restart the agent. Tray log will show:
   `Telemetry relay active — forwarding to: 127.0.0.1:20778`

The agent detects the reverse problem too — if another app is already
squatting on the port before PitWall starts (so PitWall receives nothing),
it polls every 30 s and raises a tray warning naming the offending process,
with these same instructions.

## Server-side

The PitWall server exposes `POST /api/sessions/udp-ingest`
(`pitwall/server/routes/udp-ingest.ts`):

- Auth: `Authorization: Bearer <AGENT_TOKEN>` when the server has
  `AGENT_TOKEN` set (matches `PITWALL_AGENT_TOKEN` in the agent config).
- Dedup on `agent_session_id` → `409`.
- Manual-entry conflicts (same track/type/date) flag the manual session
  with `conflict = 1` for review in the UI; nothing is auto-deleted.

## Logs

`%APPDATA%\PitWall Agent\logs\agent.log` — 10 MB rotation, 3 files.
Tray → "View logs" opens it in Notepad. Set `LOG_LEVEL=debug` to log
per-packet detail when troubleshooting.
