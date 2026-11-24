# 🛰️ mcp-network-tracker

Continuous local-network monitor with SQLite history, device → person presence tracking, optional
WhatsApp alerts and a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server.

## Features

- **Zero npm dependencies** — plain Node.js 24 (`node:sqlite`, `node:child_process`, …).
- **Fast scans** — async ping sweep of the local /24 + kernel ARP cache (macOS `arp -an`, Linux `/proc/net/arp`), ~1 s per scan.
- **Vendor detection** — recognizes Apple, Samsung, Xiaomi, Espressif (IoT), TP-Link, Tuya, Google, etc., and flags randomized/private MACs (iOS/Android).
- **Per-person presence** — assign several devices to a person (e.g. "Alice" → laptop + phone) and know when they're home.
- **Full history** — every connect, disconnect and IP change with exact timestamps.
- **MCP server** — JSON-RPC 2.0 over stdio, optionally querying other machines over SSH.
- **Optional WhatsApp alerts** — new-device and once-a-day arrival alerts through any HTTP WhatsApp bridge.

> CLI and daemon log output is currently in Spanish.

## Requirements

- Node.js **24+**
- macOS or Linux with `ping` and `arp` (or `ip neighbor`)
- Data is stored in `./data/network_tracker.db` (git-ignored)

## Configuration

Everything is optional. Copy [`.env.example`](.env.example) to `.env`; it's loaded automatically by the
`pnpm`/`npm` scripts and the LaunchAgent (via `node --env-file-if-exists`).

| Variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `SCAN_INTERVAL_SEC` | `60` | daemon | Seconds between scans |
| `TOLERANCE_SCANS` | `2` | daemon | Missed scans before a device is marked offline |
| `NETWORK_TRACKER_REMOTES_JSON` | *(unset → local only)* | MCP | Remote networks reachable over SSH (see below) |
| `DEFAULT_NETWORK` | `local` | MCP | Network used when a tool call omits `network` |
| `WHATSAPP_API_URL` | `http://127.0.0.1:3333` | daemon | Base URL of a bridge exposing `POST /api/send-message` |
| `WHATSAPP_TARGET_CHAT` | *(unset → alerts disabled)* | daemon | Chat/JID that receives alerts |
| `WHATSAPP_ACCOUNT` | *(unset)* | daemon | Optional `account` field for multi-account bridges |
| `NETWORK_TRACKER_ARRIVAL_ALERTS` | *(unset)* | daemon | Comma-separated person names that trigger a once-per-day arrival alert |
| `NETWORK_TRACKER_TIMEZONE` | system | daemon | IANA timezone for alert timestamps |

## CLI

```bash
pnpm status                                   # live status: people present + connected devices
pnpm scan                                     # force a scan now
pnpm people                                   # registered people and their presence

pnpm cli devices                              # all devices
pnpm cli person add "Alice" "Roommate"        # create a person
pnpm cli assign "aa:bb:cc:dd:ee:ff" "Alice"   # assign a device (MAC) to a person
pnpm cli rename "aa:bb:cc:dd:ee:ff" "Alice's phone"
pnpm cli person history "Alice"               # a person's presence history
pnpm cli history                              # whole-network history
pnpm cli history "aa:bb:cc:dd:ee:ff"          # one device's history
```

(`npm run <script>` works too.)

## Background daemon

```bash
pnpm start                         # scan every SCAN_INTERVAL_SEC seconds
SCAN_INTERVAL_SEC=30 pnpm start
```

### macOS LaunchAgent

`com.antigravity.network-tracker.plist` is a **template** (`__PROJECT_DIR__`, `__NODE_BIN__`).
The install script fills in this checkout's path and your `node` binary:

```bash
pnpm service:install     # renders the plist into ~/Library/LaunchAgents and loads it
pnpm service:uninstall
```

Logs go to `data/daemon.log` and `data/daemon_error.log`.

## MCP server

```bash
pnpm mcp      # node src/mcp_server.mjs
```

Client config template ([`mcp_config.json`](mcp_config.json)):

```json
{
  "mcpServers": {
    "network-tracker": {
      "command": "node",
      "args": [
        "--no-warnings",
        "--env-file-if-exists=/ABSOLUTE/PATH/TO/mcp-network-tracker/.env",
        "/ABSOLUTE/PATH/TO/mcp-network-tracker/src/mcp_server.mjs"
      ]
    }
  }
}
```

### Tools

Every tool accepts an optional `network` argument (default `local`).

| Tool | Description |
| --- | --- |
| `network_get_status` | People present/absent and connected/disconnected devices (`filter`: online/offline/all) |
| `network_scan_now` | Force a scan and report changes |
| `network_list_people` | People, their devices and presence |
| `network_add_person` | Register a person |
| `network_assign_device` | Link a MAC to a person |
| `network_rename_device` | Give a device a friendly name |
| `network_get_device_history` | History for one device or the whole network |
| `network_get_person_history` | Presence history for a person |

### Remote networks (optional)

Out of the box the server only queries the machine it runs on. To also query trackers running on
other machines, define them in `NETWORK_TRACKER_REMOTES_JSON`:

```bash
NETWORK_TRACKER_REMOTES_JSON='{"office":{"ssh":"user@office-host","path":"/opt/network-tracker","aliases":["work"]},"cabin":"cabin-host"}'
```

- `ssh` — any host/alias accepted by `ssh` (a bare string value is shorthand for `{"ssh": ...}`).
- `path` — where this project is checked out on the remote (default `/opt/network-tracker`).
- `aliases` — extra names accepted in the `network` argument.

The server runs `ssh -o BatchMode=yes <host> node <path>/src/tool_runner.mjs <tool> <base64-args>`,
so key-based SSH auth must already work non-interactively and `node` must be on the remote `PATH`.
The configured names show up in the tools' `network` enum.

## WhatsApp alerts (optional)

When `WHATSAPP_TARGET_CHAT` is set, the daemon posts `{ "account"?, "to", "text" }` as JSON to
`{WHATSAPP_API_URL}/api/send-message` for:

1. **New devices** seen for the first time on the network.
2. **Arrivals** of people listed in `NETWORK_TRACKER_ARRIVAL_ALERTS` (at most once per person per day).

Alert state is kept in `data/alerts_state.json`.

## Privacy

This tool records which devices — and therefore which people — are on your network and when.
Only run it on networks you administer, and let the people you track know.
