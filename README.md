# UniFi Access Elevator Floor Probe

A read only diagnostic for [Ubiquiti UniFi Access](https://ui.com/door-access). Point it at a controller and it prints a clean map of floors and the door/relay endpoints on each, with live lock and position state. It also writes the raw controller responses and a normalized snapshot to disk, and it can diff two snapshots so you can positively pin a physical floor to its relay.

Built for the field: one file, zero runtime dependencies, and it never sends an unlock or any other write command. A `view:space` token cannot change anything on the controller. It runs directly with Node, and it also ships as a standalone Windows `.exe` and an installer so a tech can run it on a machine with no Node installed.

This tool reuses the API conventions proven in the [UniFi Access Orchestrator](https://github.com/ajbcloud/UniFi-Access-Orchestrator): the `https://<host>:12445/api/v1/developer` base URL, bearer token auth, and the `{ code, msg, data }` response envelope.

---

## Table of Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Windows exe and installer](#windows-exe-and-installer)
- [Pinning a floor to a relay](#pinning-a-floor-to-a-relay)
- [Configuration reference](#configuration-reference)
- [Output files](#output-files)
- [Endpoints used](#endpoints-used)
- [Build and release](#build-and-release)
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

Common to every way of running it:

- A machine that can reach the controller on the API port (default `12445`).
- A UniFi Access API token with the `view:space` scope. Create one in **Access > Settings > General > Advanced > API Token**.
- UniFi Access with the developer API enabled. The API is not available on deployments migrated to Identity Enterprise.

Extra, depending on how you run it:

- **From source:** Node 16 or later. The probe uses only built in modules, so there is nothing to `npm install` to run it.
- **Windows exe or installer:** nothing. Node is bundled into the binary.

---

## Quick start

Run it from source with flags:

```bash
# Snapshot the controller and print the floor/relay map
node ua-elevator-probe.js --host 192.168.1.10 --token <view:space token>
```

Environment variables work too, and the npm scripts are shortcuts:

```bash
UA_HOST=192.168.1.10 UA_TOKEN=<token> node ua-elevator-probe.js
npm run probe          # node ua-elevator-probe.js
npm run diff           # node ua-elevator-probe.js --diff
node ua-elevator-probe.js --help
```

If you run it in a terminal with no host or token supplied, it prompts for the controller IP and token (the token input is hidden).

---

## Windows exe and installer

Two Windows artifacts are published on each release (see [Build and release](#build-and-release)):

- `ua-elevator-probe.exe` - a portable console tool. Download it, open a terminal in the download folder, and run it. No install, no admin rights.

  ```bat
  ua-elevator-probe.exe --host 192.168.1.10 --token <view:space token>
  ua-elevator-probe.exe --diff
  ```

  Double-clicking it opens a console and prompts for the controller IP and token, then writes its dumps next to the exe.

- `ua-elevator-probe-setup-<version>.exe` - an installer. It copies the tool to Program Files and, if you tick the option, adds it to the system PATH so you can run `ua-elevator-probe` from any terminal. Installing is machine-wide and needs admin rights.

The binaries are unsigned unless a signing certificate is configured for the build, so Windows SmartScreen may warn the first time. Choose **More info** then **Run anyway**, or sign them with your own certificate.

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

There is no config file to create. Each setting can come from a CLI flag or an environment variable, and a flag always wins over the matching variable. If host or token is still missing in an interactive terminal, you are prompted.

| Flag | Environment variable | Default | What it controls |
| --- | --- | --- | --- |
| `--host <ip>` | `UA_HOST` | none | Controller IP or hostname |
| `--token <token>` | `UA_TOKEN`, then `UNIFI_API_TOKEN` | none | API token, `view:space` scope is enough |
| `--port <port>` | `UA_PORT` | `12445` | Controller API port |
| `--timeout <ms>` | `UA_TIMEOUT_MS` | `10000` | Per request timeout in milliseconds |
| `--out-dir <dir>` | `UA_OUT_DIR` | `.` | Directory for the JSON dumps |
| `--verify-ssl` | `UA_VERIFY_SSL=true` | off | Verify the TLS certificate |

Host and token are required for live modes (default and `--diff`). TLS verification is off by default because the controller uses a self signed certificate.

---

## Output files

Each run writes timestamped files into the output directory (`--out-dir` or `UA_OUT_DIR`, default the current directory):

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

## Build and release

The Windows binaries are built by GitHub Actions in `.github/workflows/release.yml`, on a `windows-latest` runner. The workflow runs the tests, packages the script into `ua-elevator-probe.exe` with [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg), builds the installer from `installer/ua-elevator-probe.iss` with Inno Setup, and uploads both as build artifacts.

To cut a release, push a version tag. The same run then publishes a GitHub Release with both binaries attached:

```bash
git tag v0.1.0
git push origin v0.1.0
```

You can also trigger the workflow manually (Actions > Build and Release > Run workflow) to produce the artifacts without publishing a release.

To build locally on a Windows machine with Node installed:

```bash
npm ci
npm run build:exe      # writes dist/ua-elevator-probe.exe
```

Then build the installer with Inno Setup (`iscc installer\ua-elevator-probe.iss`).

**Code signing (optional).** To sign the binaries, add two repository secrets: `WINDOWS_CERT_PFX_BASE64` (your code-signing certificate as base64 encoded PFX) and `WINDOWS_CERT_PASSWORD`. When they are present the workflow signs both the exe and the installer; when they are absent it skips signing and ships unsigned binaries.

A separate `ci.yml` workflow runs the syntax check and tests on every push and pull request.

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
