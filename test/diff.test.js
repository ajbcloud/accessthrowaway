'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeSnapshot, diffSnapshots, parseDoorGroups, coerceSnapshot } = require('../ua-elevator-probe.js');

// Raw /doors payload as the controller returns it.
const RAW_DOORS = [
  { id: 'd-1', name: 'Elevator Floor 1', full_name: 'Bldg / Elevator Floor 1', type: 'door', door_lock_relay_status: 'lock', door_position_status: 'close', floor_id: 'f-1', is_bind_hub: true },
  { id: 'd-2', full_name: 'Elevator Floor 2', type: 'door', door_lock_relay_status: 'lock', door_position_status: 'close', floor_id: 'f-2', is_bind_hub: true },
  { id: 'd-3', name: 'Lobby Door', type: 'door', door_lock_relay_status: 'lock', door_position_status: 'open', is_bind_hub: false }
];

// Raw door_groups/topology payload.
const RAW_TOPOLOGY = {
  code: 'SUCCESS',
  data: [
    {
      id: 'g-1',
      name: 'Elevator Bank A',
      type: 'elevator',
      resource_topologies: [
        { id: 'f-1', name: 'Floor 1', type: 'floor', resources: [{ id: 'd-1', name: 'Elevator Floor 1', type: 'door', is_bind_hub: true }] },
        { id: 'f-2', name: 'Floor 2', type: 'floor', resources: [{ id: 'd-2', name: 'Elevator Floor 2', type: 'door', is_bind_hub: true }] }
      ]
    }
  ]
};

const RAW_DOOR_GROUPS = {
  code: 'SUCCESS',
  data: [
    { id: 'g-1', name: 'Elevator Bank A', type: 'elevator', resources: [{ id: 'd-1' }, { id: 'd-2' }] },
    { id: 'g-2', name: 'Perimeter', doors: ['d-3'] }
  ]
};

test('normalizeSnapshot resolves floor names and door fields from topology', () => {
  const snap = normalizeSnapshot({ meta: {}, doorsData: RAW_DOORS, topologyData: RAW_TOPOLOGY, doorGroupsData: RAW_DOOR_GROUPS });

  assert.equal(snap.doors.length, 3);

  const d1 = snap.doors.find((d) => d.id === 'd-1');
  assert.equal(d1.name, 'Elevator Floor 1');
  assert.equal(d1.lock_relay, 'lock');
  assert.equal(d1.position, 'close');
  assert.equal(d1.floor_name, 'Floor 1');
  assert.equal(d1.bound_hub, true);

  // Falls back to full_name when name is absent.
  const d2 = snap.doors.find((d) => d.id === 'd-2');
  assert.equal(d2.name, 'Elevator Floor 2');
  assert.equal(d2.floor_name, 'Floor 2');

  // Door with no floor_id keeps floor_name null and bound_hub false.
  const d3 = snap.doors.find((d) => d.id === 'd-3');
  assert.equal(d3.floor_id, null);
  assert.equal(d3.floor_name, null);
  assert.equal(d3.bound_hub, false);

  // Topology floors are present with a topology source.
  const f1 = snap.floors.find((f) => f.id === 'f-1');
  assert.equal(f1.name, 'Floor 1');
  assert.equal(f1.source, 'topology');
  assert.ok(f1.doorIds.includes('d-1'));
});

test('normalizeSnapshot reconstructs floors from floor_id when topology is absent', () => {
  const snap = normalizeSnapshot({ meta: {}, doorsData: RAW_DOORS, topologyData: null, doorGroupsData: null });

  const f1 = snap.floors.find((f) => f.id === 'f-1');
  assert.ok(f1, 'floor f-1 should be reconstructed');
  assert.equal(f1.name, null);
  assert.equal(f1.source, 'floor_id');
  assert.deepEqual(f1.doorIds, ['d-1']);

  // The floor-less lobby door does not create a floor.
  assert.equal(snap.floors.length, 2);
  assert.equal(snap.doors.find((d) => d.id === 'd-3').floor_name, null);
});

test('parseDoorGroups reads members from resources or doors', () => {
  const groups = parseDoorGroups(RAW_DOOR_GROUPS);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((g) => g.id === 'g-1').doorIds, ['d-1', 'd-2']);
  assert.deepEqual(groups.find((g) => g.id === 'g-2').doorIds, ['d-3']);
});

test('diffSnapshots flags exactly the endpoint that flipped', () => {
  const base = normalizeSnapshot({ meta: {}, doorsData: RAW_DOORS, topologyData: RAW_TOPOLOGY, doorGroupsData: null });

  // Same controller, floor 2 relay now unlocked.
  const changedDoors = RAW_DOORS.map((d) => d.id === 'd-2' ? Object.assign({}, d, { door_lock_relay_status: 'unlock' }) : d);
  const current = normalizeSnapshot({ meta: {}, doorsData: changedDoors, topologyData: RAW_TOPOLOGY, doorGroupsData: null });

  const diff = diffSnapshots(base, current);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].id, 'd-2');
  assert.equal(diff.changed[0].changes.lock_relay.from, 'lock');
  assert.equal(diff.changed[0].changes.lock_relay.to, 'unlock');
  assert.equal(diff.changed[0].floor_name, 'Floor 2');
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
});

test('diffSnapshots reports added and removed doors', () => {
  const base = normalizeSnapshot({ meta: {}, doorsData: RAW_DOORS, topologyData: null, doorGroupsData: null });
  const fewer = RAW_DOORS.filter((d) => d.id !== 'd-3');
  const extra = fewer.concat([{ id: 'd-9', name: 'New Relay', door_lock_relay_status: 'lock', door_position_status: 'close', floor_id: 'f-9', is_bind_hub: true }]);
  const current = normalizeSnapshot({ meta: {}, doorsData: extra, topologyData: null, doorGroupsData: null });

  const diff = diffSnapshots(base, current);
  assert.deepEqual(diff.added.map((d) => d.id), ['d-9']);
  assert.deepEqual(diff.removed.map((d) => d.id), ['d-3']);
  assert.equal(diff.changed.length, 0);
});

test('coerceSnapshot accepts normalized snapshots and raw doors arrays', () => {
  const normalized = normalizeSnapshot({ meta: {}, doorsData: RAW_DOORS, topologyData: null, doorGroupsData: null });
  assert.strictEqual(coerceSnapshot(normalized), normalized);

  // Raw array of door objects.
  const fromArray = coerceSnapshot(RAW_DOORS);
  assert.equal(fromArray.doors.length, 3);
  assert.equal(fromArray.doors.find((d) => d.id === 'd-1').lock_relay, 'lock');

  // Raw envelope with a data array.
  const fromEnvelope = coerceSnapshot({ code: 'SUCCESS', data: RAW_DOORS });
  assert.equal(fromEnvelope.doors.length, 3);

  assert.throws(() => coerceSnapshot({ nope: true }), /Unrecognized/);
});
