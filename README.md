# UniFi Access Elevator Floor Probe

A read only diagnostic for [Ubiquiti UniFi Access](https://ui.com/door-access). Point it at a controller and it prints a clean map of floors and the door/relay endpoints on each, with live lock and position state. It also writes the raw controller responses and a normalized snapshot to disk, and it can diff two snapshots so you can positively pin a physical floor to its relay.

Built for the field: one file, zero npm dependencies, and it never sends an unlock or any other write command. A `view:space` token cannot change anything on the controller.

This tool reuses the API conventions proven in the [UniFi Access Orchestrator](https://github.com/ajbcloud/UniFi-Access-Orchestrator): the `https://<host>:12445/api/v1/developer` base URL, bearer token auth, and the `{ code, msg, data }` response envelope.

---

## Table of Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Pinning a floor to a relay](#pinning-a-floor-to-a-relay)
- [Configuration reference](#configuration-reference)
- [Output files](#output-files)
- [Endpoints used](#endpoints-used)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)

---

## What you get

- A floors and doors tree. It comes from the `door_groups/topology` endpoint when the controller exposes it, and otherwise it is reconstructed from each door's `floor_id`, so you get a floor map either way.
- A flat table of every door/relay endpoint with its floor, live `door_lock_relay_status`, `door_position_status`, hub binding, and id.
- Raw JSON dumps of each endpoint response plus a normalized snapshot, written next to the script so you can see every field the kit returns.
- A built in diff that shows exactly which endpoint flipped between two runs.

---

## Prerequisites

- Node 16 or later. The probe uses only built in modules, so there is nothing to install.
- A machine that can reach the controller on the API port (default `12445`).
- A UniFi Access API token with the `view:space` scope. Create one in **Access > Settings > General > Advanced > API Token**.
- UniFi Access with the developer API enabled. The API is not available on deployments migrated to Identity Enterprise.

---

## Quick start

```bash
# Snapshot the controller and print the floor/relay map
UA_HOST=192.168.1.10 UA_TOKEN=<view:space token> node ua-elevator-probe.js
```

You can also install it and use the npm scripts:

```bash
npm run probe          # same as node ua-elevator-probe.js
npm run diff           # same as node ua-elevator-probe.js --diff
node ua-elevator-probe.js --help
```

---

## Pinning a floor to a relay

The relay endpoints are not always labeled with a human floor name, so the reliable way to identify one is to watch which endpoint changes when a floor is called.

```bash
# 1. Capture a baseline
UA_HOST=192.168.1.10 UA_TOKEN=<token> node ua-elevator-probe.js

# 2. Have someone authenticate at the elevator reader and select a floor.

# 3. Snapshot again and diff against the baseline
UA_HOST=192.168.1.10 UA_TOKEN=<token> node ua-elevator-probe.js --diff
```

`--diff` takes a fresh snapshot and compares it to the most recent `ua-probe-snapshot-*.json` in the output directory (or a file you name, `--diff <baseline.json>`). The endpoint whose `door_lock_relay_status` or `door_position_status` changed is that floor's relay.

To compare two saved snapshots later, without touching the controller:

```bash
node ua-elevator-probe.js --diff-files ua-probe-snapshot-BEFORE.json ua-probe-snapshot-AFTER.json
```

---

## Configuration reference

All configuration is through environment variables, so there is no file to create.

| Variable | Required | Default | What it controls |
| --- | --- | --- | --- |
| `UA_HOST` | yes (live modes) | none | Controller IP or hostname |
| `UA_TOKEN` | yes (live modes) | `UNIFI_API_TOKEN` | API token, `view:space` scope is enough |
| `UA_PORT` | no | `12445` | Controller API port |
| `UA_TIMEOUT_MS` | no | `10000` | Per request timeout in milliseconds |
| `UA_OUT_DIR` | no | `.` | Directory for the JSON dumps |
| `UA_VERIFY_SSL` | no | off | Set to `true` to verify the TLS certificate |

`UA_TOKEN` falls back to `UNIFI_API_TOKEN` if it is unset, which matches the Orchestrator. TLS verification is off by default because the controller uses a self signed certificate.

---

## Output files

Each run writes timestamped files into `UA_OUT_DIR`:

| File | Contents |
| --- | --- |
| `ua-probe-doors-<stamp>.json` | Combined `/doors` payload across all pages |
| `ua-probe-topology-<stamp>.json` | Raw `door_groups/topology` response (only if the endpoint responded) |
| `ua-probe-door_groups-<stamp>.json` | Raw flat `door_groups` response (only if the endpoint responded) |
| `ua-probe-snapshot-<stamp>.json` | Normalized snapshot used for diffing |

These dumps contain live door names and ids, so they are ignored by git and should not be committed.

---

## Endpoints used

All calls are GET and are covered by the `view:space` scope.

| Endpoint | Role |
| --- | --- |
| `GET /api/v1/developer/doors` | Every door with `floor_id` and live status. Always used. |
| `GET /api/v1/developer/door_groups/topology` | Floors and doors per floor. Best effort, may be absent. |
| `GET /api/v1/developer/door_groups` | Flat door groups. Fallback and extra context. |

If the topology endpoint is not available, the probe reconstructs the floor map from each door's `floor_id`, which the flat API always carries.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `HTTP 401` | Token is missing or invalid. Regenerate it in Access > Settings > General > Advanced > API Token. |
| `HTTP 403` | Token lacks the `view:space` scope. Add it to the token. |
| `Request timed out` | Wrong host or port, or the controller is not reachable. Confirm `UA_HOST`/`UA_PORT` and network access. Try `curl -k https://<host>:12445/api/v1/developer/doors`. |
| `CERT_HAS_EXPIRED` or similar | Leave `UA_VERIFY_SSL` unset. The controller uses a self signed certificate. |
| topology endpoint unavailable | Expected on some firmware. The floor map is reconstructed from `floor_id` instead, and the run still succeeds. |
| No baseline snapshot found | Run once without `--diff` first, then re-run with `--diff` after triggering a floor. |

---

## Security

The probe issues GET requests only. It cannot unlock a door or change any controller state. Give the token the `view:space` scope and nothing more. Treat the JSON dumps as sensitive because they contain live door names and ids.

---

## License

Source Available License. See [LICENSE](LICENSE). Free for personal and internal business use, including MSPs managing their own clients. Contact the author for commercial licensing.
