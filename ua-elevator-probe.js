#!/usr/bin/env node
'use strict';

/*
 * UniFi Access Elevator Floor Probe
 * Read only. Safe to run against a live controller.
 *
 * What it does:
 *   Calls documented UniFi Access developer endpoints (GET only) and prints a
 *   clean map of floors and the door/relay endpoints on each, with live lock
 *   and position state. It also writes the raw JSON responses plus a normalized
 *   snapshot to files, so you can eyeball exactly what a client's elevator kit
 *   exposes and diff two runs to pin a floor to a relay.
 *
 *   Endpoints used (all GET, all covered by the view:space token scope):
 *     GET /api/v1/developer/doors                  every door with floor_id + status
 *     GET /api/v1/developer/door_groups/topology   floors + doors per floor (best effort)
 *     GET /api/v1/developer/door_groups            flat door groups (fallback / extra)
 *
 *   The topology endpoint is treated as best effort. If the controller does not
 *   expose it, the probe reconstructs floors from each door's floor_id, so you
 *   still get a floor to relay map. It never sends unlock or write commands.
 *
 * Requirements:
 *   Node 16+ (built-in modules only, no npm install), a machine that can reach
 *   the controller on the API port, and a UniFi Access API token.
 *
 * Usage:
 *   UA_HOST=192.168.1.10 UA_TOKEN=xxxx node ua-elevator-probe.js
 *   UA_HOST=192.168.1.10 UA_TOKEN=xxxx node ua-elevator-probe.js --diff
 *   node ua-elevator-probe.js --diff-files baseline.json current.json
 *   node ua-elevator-probe.js --help
 *
 * Environment:
 *   UA_HOST          controller IP or hostname (required)
 *   UA_TOKEN         API token, view:space scope is enough (required)
 *                    falls back to UNIFI_API_TOKEN if UA_TOKEN is unset
 *   UA_PORT          API port (default 12445)
 *   UA_TIMEOUT_MS    per request timeout in ms (default 10000)
 *   UA_OUT_DIR       where to write JSON dumps (default current directory)
 *   UA_VERIFY_SSL    set to "true" to verify the TLS cert (default off, the
 *                    controller uses a self signed cert)
 *
 * Pinning a floor to a relay:
 *   Run it once to capture a baseline. Have someone authenticate at the
 *   elevator reader and select a floor. Run it again with --diff. The endpoint
 *   whose door_lock_relay_status or door_position_status flipped is that
 *   floor's relay.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE_PATH = '/api/v1/developer';

// ---------------------------------------------------------------------------
// Config (CLI flags override environment variables)
// ---------------------------------------------------------------------------

// Populated in main() by merging CLI flags over environment variables. The
// pure functions below (normalize/diff) never read this; only the HTTP and
// file helpers do, and only after main() has resolved it.
let cfg = resolveConfig({});

// Set true once we prompt interactively (double click with no config), and
// used to keep the console window open at the end so the output is readable.
let promptedInteractively = false;
let noPause = String(process.env.UA_NO_PAUSE || '').toLowerCase() === 'true';

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host': flags.host = args[++i]; break;
      case '--token': flags.token = args[++i]; break;
      case '--port': flags.port = args[++i]; break;
      case '--out-dir': flags.outDir = args[++i]; break;
      case '--timeout': flags.timeoutMs = Number(args[++i]); break;
      case '--verify-ssl': flags.verifySsl = true; break;
      case '--no-pause': flags.noPause = true; break;
      default: break;
    }
  }
  return flags;
}

function resolveConfig(flags) {
  flags = flags || {};
  return {
    host: flags.host || process.env.UA_HOST || null,
    port: flags.port || process.env.UA_PORT || '12445',
    token: flags.token || process.env.UA_TOKEN || process.env.UNIFI_API_TOKEN || null,
    timeoutMs: flags.timeoutMs || Number(process.env.UA_TIMEOUT_MS || 10000),
    outDir: flags.outDir || process.env.UA_OUT_DIR || '.',
    verifySsl: flags.verifySsl || String(process.env.UA_VERIFY_SSL || '').toLowerCase() === 'true'
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function apiGet(reqPath) {
  return new Promise((resolve, reject) => {
    const options = {
      host: cfg.host,
      port: cfg.port,
      path: BASE_PATH + reqPath,
      method: 'GET',
      rejectUnauthorized: cfg.verifySsl,
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        Accept: 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* leave raw */ }
        resolve({ status: res.statusCode, json: json, raw: body });
      });
    });

    req.on('error', reject);
    req.setTimeout(cfg.timeoutMs, () => {
      req.destroy(new Error('Request timed out after ' + cfg.timeoutMs + ' ms'));
    });
    req.end();
  });
}

// Quiet success test used for best effort calls (no console output).
function isSuccess(resp) {
  return !!(resp && resp.json && resp.status === 200 && resp.json.code === 'SUCCESS');
}

// Loud success test used for the required /doors call. Prints a hint on failure.
function reportFailure(resp, label) {
  if (!resp.json) {
    console.error(label + ': HTTP ' + resp.status + ', non-JSON response: ' + String(resp.raw).slice(0, 300));
    return;
  }
  console.error(label + ': HTTP ' + resp.status + ', code=' + resp.json.code + ', msg=' + (resp.json.msg || ''));
  if (resp.status === 401) console.error('  Hint: token missing or invalid');
  if (resp.status === 403) console.error('  Hint: token lacks the view:space scope');
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

// Pages through GET /doors defensively. Some firmware ignores the paging query
// params and returns the whole list on every page, so we stop as soon as a page
// adds no new door ids (or returns a short page).
async function fetchAllDoors() {
  const pageSize = 100;
  const seen = new Set();
  const all = [];
  let lastResp = null;

  for (let page = 1; page <= 100; page++) {
    const resp = await apiGet('/doors?page_num=' + page + '&page_size=' + pageSize);
    lastResp = resp;
    if (!isSuccess(resp)) {
      reportFailure(resp, 'Doors');
      return { ok: false, doors: all, resp };
    }
    const data = Array.isArray(resp.json.data) ? resp.json.data : [];
    let added = 0;
    for (const d of data) {
      const id = d && d.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(d);
      added++;
    }
    if (data.length < pageSize || added === 0) break;
  }

  return { ok: true, doors: all, resp: lastResp };
}

async function collectSnapshot() {
  const meta = {
    host: cfg.host,
    port: cfg.port,
    time: new Date().toISOString(),
    base_url: 'https://' + cfg.host + ':' + cfg.port + BASE_PATH
  };

  const doorsResult = await fetchAllDoors();
  if (!doorsResult.ok) {
    throw new Error('Could not read /doors (see message above). Fix connectivity or the token first.');
  }

  const topoResp = await apiGet('/door_groups/topology');
  const topologyOk = isSuccess(topoResp);
  const topologyData = topologyOk ? topoResp.json : null;

  const groupsResp = await apiGet('/door_groups');
  const doorGroupsOk = isSuccess(groupsResp);
  const doorGroupsData = doorGroupsOk ? groupsResp.json : null;

  const snapshot = normalizeSnapshot({
    meta,
    doorsData: doorsResult.doors,
    topologyData,
    doorGroupsData
  });
  snapshot.endpoints = { topology_ok: topologyOk, door_groups_ok: doorGroupsOk };

  return {
    snapshot,
    topologyData,
    raw: {
      doors: doorsResult.doors,
      topology: topologyOk ? topoResp.json : (topoResp.json || topoResp.raw),
      door_groups: doorGroupsOk ? groupsResp.json : (groupsResp.json || groupsResp.raw)
    }
  };
}

// ---------------------------------------------------------------------------
// Normalization (pure, unit tested)
// ---------------------------------------------------------------------------

// Flat GET /door_groups membership. Members live under `resources` or `doors`
// depending on firmware, each an object with id/door_id or a bare string id.
function parseDoorGroups(doorGroupsData) {
  const out = [];
  const groups = doorGroupsData && Array.isArray(doorGroupsData.data) ? doorGroupsData.data : [];
  for (const g of groups) {
    if (!g || !g.id) continue;
    const members = Array.isArray(g.resources) ? g.resources
      : Array.isArray(g.doors) ? g.doors : [];
    const doorIds = [];
    for (const m of members) {
      const id = (m && (m.id || m.door_id)) || (typeof m === 'string' ? m : null);
      if (id) doorIds.push(String(id));
    }
    out.push({ id: String(g.id), name: g.name || g.full_name || null, type: g.type || null, doorIds });
  }
  return out;
}

// Builds a stable, diff friendly snapshot from the raw API payloads.
// input: { meta, doorsData[], topologyData|null, doorGroupsData|null }
function normalizeSnapshot(input) {
  input = input || {};
  const meta = input.meta || {};
  const doorsData = Array.isArray(input.doorsData) ? input.doorsData : [];
  const topologyData = input.topologyData || null;
  const doorGroupsData = input.doorGroupsData || null;

  // floor_id -> name from topology, and the topology floor definitions
  const floorNames = {};
  const topoFloors = [];
  if (topologyData && Array.isArray(topologyData.data)) {
    for (const group of topologyData.data) {
      const floors = group && Array.isArray(group.resource_topologies) ? group.resource_topologies : [];
      for (const floor of floors) {
        if (!floor || !floor.id) continue;
        floorNames[floor.id] = floor.name || null;
        const resources = Array.isArray(floor.resources) ? floor.resources : [];
        const resourceIds = resources.map((r) => r && r.id).filter(Boolean).map(String);
        topoFloors.push({ id: String(floor.id), name: floor.name || null, resourceIds });
      }
    }
  }

  const doors = doorsData.map((d) => ({
    id: d && d.id ? String(d.id) : null,
    name: (d && (d.name || d.full_name)) || null,
    floor_id: d && d.floor_id ? String(d.floor_id) : null,
    floor_name: (d && d.floor_id && floorNames[d.floor_id]) || null,
    lock_relay: (d && d.door_lock_relay_status) || null,
    position: (d && d.door_position_status) || null,
    bound_hub: d && d.is_bind_hub !== undefined ? d.is_bind_hub : null,
    type: (d && d.type) || null
  })).filter((d) => d.id);

  // Merge topology floors with floors reconstructed from door.floor_id.
  const floorsById = new Map();
  for (const tf of topoFloors) {
    floorsById.set(tf.id, { id: tf.id, name: tf.name, source: 'topology', doorIds: new Set(tf.resourceIds) });
  }
  for (const d of doors) {
    if (!d.floor_id) continue;
    if (!floorsById.has(d.floor_id)) {
      const name = floorNames[d.floor_id] || null;
      floorsById.set(d.floor_id, { id: d.floor_id, name, source: name ? 'topology' : 'floor_id', doorIds: new Set() });
    }
    floorsById.get(d.floor_id).doorIds.add(d.id);
  }
  const floors = [...floorsById.values()].map((f) => ({
    id: f.id, name: f.name, source: f.source, doorIds: [...f.doorIds]
  }));

  return {
    meta,
    doors,
    floors,
    door_groups: parseDoorGroups(doorGroupsData)
  };
}

// ---------------------------------------------------------------------------
// Diff (pure, unit tested)
// ---------------------------------------------------------------------------

function indexById(list) {
  const m = new Map();
  if (Array.isArray(list)) {
    for (const d of list) { if (d && d.id) m.set(String(d.id), d); }
  }
  return m;
}

// Compares two normalized snapshots. Reports doors whose lock_relay or position
// changed, plus doors that appeared or disappeared.
function diffSnapshots(baseline, current) {
  const baseDoors = indexById(baseline && baseline.doors);
  const curDoors = indexById(current && current.doors);

  const changed = [];
  const added = [];
  const removed = [];

  for (const [id, cur] of curDoors) {
    if (!baseDoors.has(id)) { added.push(cur); continue; }
    const base = baseDoors.get(id);
    const changes = {};
    if (base.lock_relay !== cur.lock_relay) changes.lock_relay = { from: base.lock_relay, to: cur.lock_relay };
    if (base.position !== cur.position) changes.position = { from: base.position, to: cur.position };
    if (Object.keys(changes).length > 0) {
      changed.push({ id: id, name: cur.name, floor_id: cur.floor_id, floor_name: cur.floor_name, changes: changes });
    }
  }
  for (const [id, base] of baseDoors) {
    if (!curDoors.has(id)) removed.push(base);
  }

  return { changed: changed, added: added, removed: removed };
}

// ---------------------------------------------------------------------------
// Snapshot file loading
// ---------------------------------------------------------------------------

// Accepts a normalized snapshot file, a raw /doors dump (array or {data:[]}),
// and returns something diffSnapshots can consume.
function coerceSnapshot(parsed) {
  if (parsed && Array.isArray(parsed.doors)) {
    const hasNormalizedDoors = parsed.doors.length === 0 || 'lock_relay' in parsed.doors[0];
    if (hasNormalizedDoors) return parsed;
  }
  const rawArr = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.data) ? parsed.data : null);
  if (rawArr) {
    return normalizeSnapshot({ meta: {}, doorsData: rawArr, topologyData: null, doorGroupsData: null });
  }
  throw new Error('Unrecognized snapshot or /doors file shape');
}

function loadSnapshotFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error('Could not read snapshot file ' + file + ': ' + e.message);
  }
  return coerceSnapshot(parsed);
}

function findLatestSnapshot(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^ua-probe-snapshot-.*\.json$/.test(f))
      .map((f) => path.join(dir, f));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length ? files[0] : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeRaw(name, payload) {
  try {
    if (!fs.existsSync(cfg.outDir)) fs.mkdirSync(cfg.outDir, { recursive: true });
    const file = path.join(cfg.outDir, 'ua-probe-' + name + '-' + stamp() + '.json');
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return file;
  } catch (e) {
    return '(failed to write ' + name + ' dump: ' + e.message + ')';
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function pad(v, n) {
  const s = (v === undefined || v === null || v === '') ? '-' : String(v);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printTree(snapshot, topologyData) {
  if (topologyData && Array.isArray(topologyData.data) && topologyData.data.length) {
    console.log('\n=== FLOORS AND DOORS (from door_groups/topology) ===');
    for (const group of topologyData.data) {
      const floors = Array.isArray(group.resource_topologies) ? group.resource_topologies : [];
      for (const floor of floors) {
        console.log('');
        console.log('  Group: ' + (group.name || '-') + '  [' + (group.type || '-') + ']');
        console.log('  Floor: ' + ((floor && floor.name) || '-') + '  (id ' + ((floor && floor.id) || '-') + ', type ' + ((floor && floor.type) || '-') + ')');
        const resources = (floor && Array.isArray(floor.resources)) ? floor.resources : [];
        if (!resources.length) {
          console.log('    (no door/relay resources listed under this floor)');
        }
        for (const r of resources) {
          console.log('    - ' + pad(r.name, 24) + ' id ' + pad(r.id, 38) + ' type ' + pad(r.type, 8) + ' bound_hub ' + r.is_bind_hub);
        }
      }
    }
    console.log('\n  Floors found: ' + snapshot.floors.length);
    return;
  }

  // Fallback: topology not available, group by door floor_id.
  console.log('\n=== FLOORS AND DOORS (reconstructed from /doors floor_id) ===');
  console.log('  Note: the door_groups/topology endpoint was not available, so floor');
  console.log('  names may be unknown. Floors below are grouped by each door floor_id.');
  const byId = indexById(snapshot.doors);
  const floors = snapshot.floors.slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  if (!floors.length) {
    console.log('\n  No floors could be derived. No doors carried a floor_id.');
  }
  for (const floor of floors) {
    console.log('');
    console.log('  Floor: ' + (floor.name || '(unnamed)') + '  (floor_id ' + floor.id + ', source ' + floor.source + ')');
    if (!floor.doorIds.length) {
      console.log('    (no doors reference this floor_id)');
    }
    for (const doorId of floor.doorIds) {
      const d = byId.get(doorId);
      if (d) {
        console.log('    - ' + pad(d.name, 24) + ' id ' + pad(d.id, 38) + ' lock ' + pad(d.lock_relay, 10) + ' position ' + d.position);
      } else {
        console.log('    - (endpoint ' + doorId + ' from topology, not present in /doors)');
      }
    }
  }
  const orphans = snapshot.doors.filter((d) => !d.floor_id);
  if (orphans.length) {
    console.log('\n  Doors with no floor_id (' + orphans.length + '):');
    for (const d of orphans) {
      console.log('    - ' + pad(d.name, 24) + ' id ' + d.id);
    }
  }
  console.log('\n  Floors found: ' + snapshot.floors.length);
}

function printTable(snapshot) {
  console.log('\n=== ALL DOOR / RELAY ENDPOINTS (from /doors) ===');
  console.log('  ' + pad('Name', 24) + ' | ' + pad('Floor', 16) + ' | ' + pad('Lock Relay', 10) + ' | ' + pad('Position', 10) + ' | ' + pad('Hub', 5) + ' | ID');
  console.log('  ' + '-'.repeat(110));
  for (const d of snapshot.doors) {
    const floor = d.floor_name || d.floor_id || '-';
    const hub = d.bound_hub === null ? '-' : String(d.bound_hub);
    console.log('  ' + pad(d.name, 24) + ' | ' + pad(floor, 16) + ' | ' + pad(d.lock_relay, 10) + ' | ' + pad(d.position, 10) + ' | ' + pad(hub, 5) + ' | ' + d.id);
  }
  console.log('\n  Endpoints found: ' + snapshot.doors.length);
}

function printDiff(diff) {
  console.log('\n=== CHANGED ENDPOINTS (baseline -> current) ===');
  console.log('  If exactly one door changed after you triggered a floor, that door is');
  console.log('  the relay for that floor.');

  if (!diff.changed.length && !diff.added.length && !diff.removed.length) {
    console.log('\n  No changes. Nothing flipped between the two snapshots.');
    return;
  }

  if (diff.changed.length) {
    console.log('');
    for (const c of diff.changed) {
      const floor = c.floor_name || c.floor_id || '-';
      console.log('  ' + (c.name || '(unnamed)') + '  [floor ' + floor + ']  id ' + c.id);
      if (c.changes.lock_relay) {
        console.log('      lock_relay: ' + (c.changes.lock_relay.from || '-') + ' -> ' + (c.changes.lock_relay.to || '-'));
      }
      if (c.changes.position) {
        console.log('      position:   ' + (c.changes.position.from || '-') + ' -> ' + (c.changes.position.to || '-'));
      }
    }
  }

  if (diff.added.length) {
    console.log('\n  Added since baseline:');
    for (const d of diff.added) console.log('    + ' + (d.name || '(unnamed)') + '  id ' + d.id);
  }
  if (diff.removed.length) {
    console.log('\n  Removed since baseline:');
    for (const d of diff.removed) console.log('    - ' + (d.name || '(unnamed)') + '  id ' + d.id);
  }

  console.log('\n  Summary: ' + diff.changed.length + ' changed, ' + diff.added.length + ' added, ' + diff.removed.length + ' removed');
}

function printUsage() {
  console.error([
    '',
    'UniFi Access Elevator Floor Probe (read only)',
    '',
    'Usage:',
    '  ua-elevator-probe --host <controller-ip> --token <view:space token>',
    '  ua-elevator-probe --host <controller-ip> --token <token> --diff [baseline.json]',
    '  ua-elevator-probe --diff-files <baseline.json> <current.json>',
    '  ua-elevator-probe --help',
    '',
    '  (env vars work too: UA_HOST=<ip> UA_TOKEN=<token> ua-elevator-probe)',
    '  (with no host/token in an interactive terminal, you are prompted)',
    '  (when run as node: node ua-elevator-probe.js <flags>)',
    '',
    'Modes:',
    '  (default)      snapshot the controller, print the floor/relay map, write dumps',
    '  --diff [file]  snapshot again and diff against a baseline (defaults to the most',
    '                 recent ua-probe-snapshot-*.json in the output directory)',
    '  --diff-files   diff two saved snapshots offline, no controller call',
    '',
    'Flags (override the matching environment variable):',
    '  --host <ip>        controller IP or hostname',
    '  --token <token>    API token, view:space scope',
    '  --port <port>      API port (default 12445)',
    '  --out-dir <dir>    where to write JSON dumps (default current directory)',
    '  --timeout <ms>     per request timeout in ms (default 10000)',
    '  --verify-ssl       verify the TLS cert (default off, self signed cert)',
    '  --no-pause         do not wait for Enter before closing (for scripts)',
    '',
    'Environment:',
    '  UA_HOST, UA_TOKEN (falls back to UNIFI_API_TOKEN), UA_PORT,',
    '  UA_TIMEOUT_MS, UA_OUT_DIR, UA_VERIFY_SSL',
    '',
    'Notes:',
    '  Only issues GET requests. Cannot unlock or change anything.',
    '  Generate the token in Access > Settings > General > Advanced > API Token,',
    '  and give it the view:space scope.',
    ''
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Interactive prompt (used when the exe is double clicked with no config)
// ---------------------------------------------------------------------------

function askVisible(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

// Reads a line without echoing it, so a token is not left on screen or in the
// terminal scrollback. Uses raw mode, which works in Windows consoles too.
function askHidden(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    const wasRaw = !!stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const finish = () => {
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { // Enter or Ctrl+D
        finish();
        resolve(value.trim());
      } else if (ch === '\u0003') { // Ctrl+C
        finish();
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') { // backspace
        value = value.slice(0, -1);
      } else if (ch >= ' ') { // ignore stray control sequences
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// Keeps a double clicked console window open so the output can be read before
// the window closes. Safe to await; resolves immediately if not interactive.
async function pause(message) {
  if (noPause || !process.stdin.isTTY) return;
  await askVisible('\n' + (message || 'Press Enter to close...'));
}

async function promptForConfig() {
  promptedInteractively = true;
  console.log('');
  console.log('No controller configured. Enter connection details (Ctrl+C to cancel).');
  if (!cfg.host) {
    const host = await askVisible('  Controller IP or hostname: ');
    if (host) cfg.host = host;
    const port = await askVisible('  API port [' + cfg.port + ']: ');
    if (port) cfg.port = port;
  }
  if (!cfg.token) {
    const token = await askHidden('  API token (view:space, input hidden): ');
    if (token) cfg.token = token;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Offline diff of two saved files. No controller needed.
  if (args.includes('--diff-files')) {
    const i = args.indexOf('--diff-files');
    const a = args[i + 1];
    const b = args[i + 2];
    if (!a || !b) {
      console.error('Usage: node ua-elevator-probe.js --diff-files <baseline.json> <current.json>');
      process.exit(1);
    }
    const baseline = loadSnapshotFile(a);
    const current = loadSnapshotFile(b);
    console.log('');
    console.log('UniFi Access elevator probe - offline snapshot diff');
    console.log('  baseline: ' + a);
    console.log('  current:  ' + b);
    printDiff(diffSnapshots(baseline, current));
    console.log('');
    process.exit(0);
  }

  // Live modes: flags override env vars, then prompt for anything still missing.
  const flags = parseArgs(args);
  cfg = resolveConfig(flags);
  if (flags.noPause) noPause = true;
  if ((!cfg.host || !cfg.token) && process.stdin.isTTY) {
    await promptForConfig();
  }
  if (!cfg.host || !cfg.token) {
    printUsage();
    process.exit(1);
  }

  const diffMode = args.includes('--diff');
  let baseline = null;
  let baselinePath = null;
  if (diffMode) {
    const i = args.indexOf('--diff');
    const next = args[i + 1];
    const explicit = next && next.charAt(0) !== '-' ? next : null;
    baselinePath = explicit || findLatestSnapshot(cfg.outDir);
    if (!baselinePath) {
      console.error('No baseline snapshot found in ' + cfg.outDir + '.');
      console.error('Run the probe once without --diff first, then trigger a floor and re-run with --diff.');
      process.exit(1);
    }
    baseline = loadSnapshotFile(baselinePath);
  }

  console.log('');
  console.log('UniFi Access elevator probe (read only)');
  console.log('Target: https://' + cfg.host + ':' + cfg.port + BASE_PATH);
  console.log('Time:   ' + new Date().toISOString());
  if (!cfg.verifySsl) console.log('TLS:    certificate verification off (self signed controller cert)');

  const collected = await collectSnapshot();
  const snapshot = collected.snapshot;

  printTree(snapshot, collected.topologyData);
  printTable(snapshot);

  console.log('\n=== RAW DUMPS ===');
  console.log('  Saved to: ' + path.resolve(cfg.outDir));
  console.log('  doors:        ' + writeRaw('doors', collected.raw.doors));
  if (snapshot.endpoints.topology_ok) {
    console.log('  topology:     ' + writeRaw('topology', collected.raw.topology));
  } else {
    console.log('  topology:     endpoint unavailable, floors reconstructed from floor_id');
  }
  if (snapshot.endpoints.door_groups_ok) {
    console.log('  door_groups:  ' + writeRaw('door_groups', collected.raw.door_groups));
  } else {
    console.log('  door_groups:  endpoint unavailable');
  }
  console.log('  snapshot:     ' + writeRaw('snapshot', snapshot));

  if (diffMode) {
    console.log('\nBaseline: ' + baselinePath);
    printDiff(diffSnapshots(baseline, snapshot));
  } else {
    console.log('\nNext: trigger a floor at the elevator panel, then run again with --diff');
    console.log('to see which relay endpoint changed:');
    console.log('  ua-elevator-probe --host ' + cfg.host + ' --token *** --diff');
  }

  console.log('');
  if (promptedInteractively) await pause('Done. Press Enter to close...');
  process.exit(0);
}

module.exports = {
  normalizeSnapshot,
  diffSnapshots,
  parseDoorGroups,
  coerceSnapshot
};

if (require.main === module) {
  main().catch(async (err) => {
    console.error('');
    console.error('Probe failed: ' + err.message);
    console.error('Check UA_HOST/UA_PORT reachability and that UA_TOKEN is valid.');
    console.error('');
    // Keep a double clicked window open so the error is readable.
    await pause('Press Enter to close...');
    process.exit(1);
  });
}
