import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Simulation, powerAt, temperatureFactor } from '../src/simulation';
import { makeScenario } from '../src/scenarios';
import { buildImageScenario, exampleFootprints, objectOutline } from '../src/image-map';
import { AIRBASE_HEADING, AIRBASE_RUNWAY, airbasePoint } from '../src/airbase';
import { AIRBASE_AIM, rollWave } from '../src/scenarios';
import { contact, DEFAULT_THREAT, I79_RADAR, interceptPoint } from '../src/defence';
import { csv, validateRun, validateScenario } from '../src/data';
import { clone, type ScenarioDocument } from '../src/types';

const checks: { name: string; milliseconds: number }[] = [];
function check(name: string, task: () => void) { const started = performance.now(); task(); checks.push({ name, milliseconds: Math.round((performance.now() - started) * 100) / 100 }); console.log(`PASS ${name}`); }
function run(scenario: ScenarioDocument, batch = 1) { const simulation = new Simulation(scenario); while (!simulation.snapshot.finished) simulation.step(batch); return simulation; }
check('All six example scenarios validate and survive JSON round trips', () => { for (const preset of ['successful', 'unsuccessful', 'battery', 'weather', 'stress', 'airbase']) { const scenario = makeScenario(preset); assert.deepEqual(validateScenario(JSON.parse(JSON.stringify(scenario))), scenario); } });
check('Successful defense resolves both encounters and defender expenditure', () => { const simulation = run(makeScenario()); assert.equal(simulation.snapshot.logs.filter(entry => entry.kind === 'resolved').length, 3); assert.equal(simulation.snapshot.units.find(unit => unit.id === 'intruder-01')?.status, 'stopped'); assert.equal(simulation.snapshot.units.find(unit => unit.id === 'intruder-02')?.status, 'stopped'); assert.equal(simulation.snapshot.units.find(unit => unit.id === 'sentry-01')?.status, 'expended'); assert(simulation.snapshot.logs.some(entry => entry.label.includes('takeoff complete'))); });
check('Unsuccessful script continues an intruder and delays aircraft', () => { const simulation = run(makeScenario('unsuccessful')); assert.equal(simulation.snapshot.units.find(unit => unit.id === 'falcon-01')?.departureAt, 29); assert(simulation.snapshot.logs.some(entry => entry.label.includes('continues through'))); assert.equal(simulation.snapshot.units.find(unit => unit.id === 'intruder-01')?.status, 'complete'); });
check('Battery exhaustion terminates flights and skips conflicting encounters', () => { const simulation = run(makeScenario('battery')); assert.equal(simulation.snapshot.units.find(unit => unit.id === 'sentry-01')?.status, 'depleted'); assert.equal(simulation.snapshot.logs.filter(entry => entry.kind === 'skipped').length, 3); assert(simulation.snapshot.units.every(unit => unit.energy >= 0)); });
check('Missing participants create explanatory skipped events', () => { const scenario = makeScenario(); scenario.vehicles = scenario.vehicles.filter(vehicle => vehicle.id !== 'intruder-01'); const simulation = run(scenario); assert(simulation.snapshot.logs.some(entry => entry.eventId === 'evt-1' && entry.kind === 'skipped' && entry.label.includes('missing'))); });
check('Short runway reports overrun', () => { const scenario = makeScenario(); scenario.vehicles[0].runwayLength = 30; const simulation = run(scenario); assert.equal(simulation.snapshot.units[0].status, 'overrun'); });
check('Launch and delay require waiting participants', () => { const scenario = makeScenario(); scenario.events = [{ id: 'launch', time: 1, action: 'launch', actorId: 'sentry-01', partnerId: '', delaySeconds: 0, label: 'Early launch' }, { id: 'late-delay', time: 10, action: 'delay', actorId: 'sentry-01', partnerId: '', delaySeconds: 5, label: 'Invalid late delay' }]; const simulation = run(scenario); assert.equal(simulation.snapshot.units.find(unit => unit.id === 'sentry-01')?.departureAt, 1); assert(simulation.snapshot.logs.some(entry => entry.eventId === 'late-delay' && entry.kind === 'skipped')); });
check('Seeded run is independent of step batching and playback cadence', () => { const scenario = makeScenario('weather'); assert.deepEqual(run(scenario, 1).snapshot, run(scenario, 7).snapshot); assert.deepEqual(run(scenario, 4).snapshot, run(scenario, 20).snapshot); });
check('Different seeds change synthetic observations', () => { const first = makeScenario(); const second = clone(first); second.seed++; assert.notDeepEqual(run(first).record.observations, run(second).record.observations); });
check('Power curve interpolates and cold conditions reduce capacity', () => { const vehicle = makeScenario().vehicles[1]; assert.equal(powerAt(vehicle, 10), 260); assert.equal(temperatureFactor(20), 1); assert(temperatureFactor(-5) < 1); });
check('Weather changes routes, energy use, and observation availability', () => { const calm = run(makeScenario()); const storm = run(makeScenario('weather')); assert.notDeepEqual(calm.snapshot.units[1].position, storm.snapshot.units[1].position); assert(storm.snapshot.observationCount < calm.snapshot.observationCount); assert(storm.snapshot.units[1].capacity < calm.snapshot.units[1].capacity); });
check('Partial recordings preserve their latest exact state and import successfully', () => { const simulation = new Simulation(makeScenario()); simulation.step(17); const record = simulation.getRecord(); assert.equal(record.frames.at(-1)?.tick, 17); assert.deepEqual(validateRun(JSON.parse(JSON.stringify(record))), record); });
check('Completed recordings validate and telemetry exports include every vehicle', () => { const record = run(makeScenario()).getRecord(); validateRun(record); const output = csv(record); assert(output.startsWith('time,id,x,y,z,airspeed,groundSpeed,battery,energy,status')); assert(output.includes('"falcon-01"')); assert(output.includes('"intruder-02"')); });
check('Invalid values and incompatible versions fail before import', () => { for (const mutate of [(scenario: any) => { scenario.schemaVersion = 2; }, (scenario: any) => { scenario.vehicles[0].speed = -1; }, (scenario: any) => { scenario.objects[0].size.x = 0; }, (scenario: any) => { scenario.vehicles[0].route = []; }, (scenario: any) => { scenario.events[0].time = 900; }, (scenario: any) => { scenario.vehicles[1].powerCurve[1].speed = 0; }]) { const scenario = makeScenario(); mutate(scenario); assert.throws(() => validateScenario(scenario)); } });
check('50 drones and 3 aircraft complete ten simulated minutes with finite telemetry', () => { const simulation = run(makeScenario('stress'), 80); assert.equal(simulation.snapshot.time, 600); assert.equal(simulation.snapshot.units.length, 53); assert.equal(simulation.record.frames.length, 1201); assert.equal(simulation.record.telemetry.length, 601 * 53); assert(simulation.record.telemetry.every(row => [row.x, row.y, row.z, row.energy].every(Number.isFinite))); validateRun(simulation.getRecord()); });
check('Air base layout stays on its runway axis and inside the modelled ground', () => {
  const scenario = makeScenario('airbase');
  const runway = scenario.objects.find(object => object.kind === 'runway')!;
  assert.equal(runway.rotation, -AIRBASE_HEADING);
  assert.equal(runway.size.z, AIRBASE_RUNWAY.length);
  assert(scenario.objects.every(object => object.rotation === -AIRBASE_HEADING || object.rotation === -AIRBASE_HEADING - 90));
  assert(scenario.objects.some(object => object.rotation === -AIRBASE_HEADING - 90));
  assert(scenario.objects.every(object => Math.abs(object.position.x) < 3100 && Math.abs(object.position.z) < 3000));
  const corner = (object: typeof scenario.objects[number], axis: 'x' | 'z') => {
    const angle = object.rotation * Math.PI / 180; const sin = Math.abs(Math.sin(angle)); const cos = Math.abs(Math.cos(angle));
    return Math.abs(object.position[axis]) + (axis === 'x' ? object.size.x / 2 * cos + object.size.z / 2 * sin : object.size.x / 2 * sin + object.size.z / 2 * cos);
  };
  // Every grove has to stand on the modelled ground, which is 6200 x 6000 m.
  assert(scenario.objects.every(object => corner(object, 'x') <= 3100 && corner(object, 'z') <= 3000));
  const woods = scenario.objects.filter(object => object.id.startsWith('ab-wood-'));
  assert(woods.length > 60 && scenario.objects.length <= 200);
  // Everything is axis aligned in runway-local metres, so nothing growing on the field is a rectangle test.
  const turn = AIRBASE_HEADING * Math.PI / 180;
  const plan = (object: typeof scenario.objects[number]) => {
    const turned = object.rotation === -AIRBASE_HEADING - 90;
    return {
      u: object.position.x * Math.sin(turn) - object.position.z * Math.cos(turn), v: object.position.x * Math.cos(turn) + object.position.z * Math.sin(turn),
      halfU: (turned ? object.size.x : object.size.z) / 2, halfV: (turned ? object.size.z : object.size.x) / 2,
    };
  };
  const built = scenario.objects.filter(object => object.kind !== 'trees').map(plan);
  for (const grove of woods.map(plan)) {
    assert(built.every(item => Math.abs(grove.u - item.u) >= grove.halfU + item.halfU || Math.abs(grove.v - item.v) >= grove.halfV + item.halfV));
  }
  const north = airbasePoint(AIRBASE_RUNWAY.length / 2, 0); const south = airbasePoint(-AIRBASE_RUNWAY.length / 2, 0);
  assert.equal(Math.round(Math.hypot(north.x - south.x, north.z - south.z)), AIRBASE_RUNWAY.length);
  assert.equal(Math.round(Math.atan2(north.x - south.x, south.z - north.z) * 180 / Math.PI), AIRBASE_HEADING);
  assert.equal(new Set(scenario.objects.map(object => object.id)).size, scenario.objects.length);
});
check('Radar envelope follows the published I-79 figures', () => {
  const origin = { x: 0, y: 60, z: 0 };
  const north = (metres: number, height = 60) => ({ x: 0, y: height, z: -metres });
  assert.equal(I79_RADAR.range, 240); assert.equal(I79_RADAR.horizontalFov, 120); assert.equal(I79_RADAR.verticalFov, 30);
  assert(contact(origin, 0, I79_RADAR, north(239)).seen);
  assert(!contact(origin, 0, I79_RADAR, north(241)).seen, 'beyond the measurement range');
  assert(!contact(origin, 0, I79_RADAR, north(0.2)).seen, 'inside the minimum range');
  // +/-60 degrees horizontally: a contact due east is on the edge of a north-facing sensor.
  assert(contact(origin, 0, I79_RADAR, { x: 100, y: 60, z: -58 }).seen);
  assert(!contact(origin, 0, I79_RADAR, { x: 100, y: 60, z: 0 }).seen, 'past the horizontal edge');
  // +/-15 degrees vertically: 100 m out, anything above about 26.8 m of separation is missed.
  assert(contact(origin, 0, I79_RADAR, north(100, 60 + 26)).seen);
  assert(!contact(origin, 0, I79_RADAR, north(100, 60 + 28)).seen, 'above the elevation limit');
  assert(!contact(origin, 0, I79_RADAR, north(100, 60 - 28)).seen, 'below the elevation limit');
  // Reported range is quantised to the resolution cell rather than reported exactly.
  const reading = contact(origin, 0, I79_RADAR, north(100));
  assert.equal(reading.measured, Math.round(100 / 0.39) * 0.39);
  assert(Math.abs(reading.measured - 100) <= I79_RADAR.rangeResolution / 2);
});
check('A lead intercept is solved, and an uncatchable target reports none', () => {
  const origin = { x: 0, y: 50, z: 0 };
  const solution = interceptPoint(origin, 40, { x: 0, y: 50, z: -400 }, { x: 0, y: 0, z: 40 });
  assert(solution, 'a head-on closure has a solution');
  assert.equal(Math.round(solution!.time), 5);
  assert.equal(Math.round(solution!.point.z), -200);
  assert.equal(interceptPoint(origin, 20, { x: 0, y: 50, z: -400 }, { x: 0, y: 0, z: -80 }), undefined);
});
check('Sentries cover the runway at 100 m without ever waiting in a pod', () => {
  const scenario = makeScenario('airbase');
  const sentries = scenario.vehicles.filter(vehicle => vehicle.defence);
  assert.equal(sentries.length, 8);
  const pods = new Set(scenario.objects.filter(object => object.kind === 'pod').map(object => object.id));
  assert.equal(pods.size, 8);
  for (const sentry of sentries) {
    const defence = sentry.defence!;
    assert.equal(sentry.departAt, 0, 'already covering when the run starts');
    assert.deepEqual(sentry.position, defence.station);
    assert(pods.has(defence.podId), 'every sentry has a charging pod on the map');
    assert.deepEqual(defence.sensor, I79_RADAR);
    const offset = Math.hypot(defence.station.x - AIRBASE_AIM.x, defence.station.z - AIRBASE_AIM.z);
    assert(offset < defence.sensor.range * 4, 'posted within reach of the ground it covers');
  }
  // 100 m off the centreline: the station is that far from the runway axis through the aim point.
  const axis = AIRBASE_HEADING * Math.PI / 180;
  for (const sentry of sentries) {
    const east = sentry.defence!.station.x - AIRBASE_AIM.x; const north = sentry.defence!.station.z - AIRBASE_AIM.z;
    assert.equal(Math.round(Math.abs(east * Math.cos(axis) + north * Math.sin(axis))), 100);
  }
  const first = new Simulation(scenario);
  assert.equal(first.snapshot.units.find(unit => unit.id === sentries[0].id)?.status, 'airborne');
});
check('The screen detects, assigns the nearest free sentry, and hard kills', () => {
  const simulation = run(makeScenario('airbase'), 20);
  const scenario = makeScenario('airbase');
  const hostiles = scenario.vehicles.filter(vehicle => vehicle.role === 'hostile').map(vehicle => vehicle.id);
  const threats = simulation.snapshot.units.filter(unit => hostiles.includes(unit.id));
  assert.equal(threats.length, 8);
  assert.equal(threats.filter(unit => unit.status === 'stopped').length, 8, 'the default wave is held');
  assert.equal(threats.filter(unit => unit.status === 'complete').length, 0, 'nothing leaks through');
  const shooters = simulation.snapshot.units.filter(unit => unit.kills > 0);
  assert(shooters.length >= 3, 'more than one sentry is drawn in');
  assert.equal(shooters.reduce((sum, unit) => sum + unit.kills, 0), 8);
  // Every kill resolves inside the engagement range, and the sentry goes back to its post.
  const engageRange = scenario.vehicles.find(vehicle => vehicle.defence)!.defence!.engageRange;
  for (const entry of simulation.snapshot.logs.filter(log => log.kind === 'resolved')) {
    assert(Number(entry.label.match(/at ([\d.]+) m$/)![1]) <= engageRange);
  }
  assert(simulation.snapshot.units.filter(unit => unit.task === 'hold').length >= 3);
  for (const id of ['kestrel-01', 'kestrel-02', 'kestrel-03']) assert.equal(simulation.snapshot.units.find(unit => unit.id === id)?.status, 'complete');
  assert.deepEqual(run(makeScenario('airbase'), 1).snapshot, simulation.snapshot, 'repeatable under any batching');
});
check('A rolled wave is reproducible, and a faster swarm gets through', () => {
  const scenario = makeScenario('airbase');
  const plan = { ...DEFAULT_THREAT, seed: 4242, count: 12 };
  assert.deepEqual(rollWave(scenario, plan).vehicles, rollWave(scenario, plan).vehicles, 'same plan, same wave');
  assert.notDeepEqual(rollWave(scenario, plan).vehicles, rollWave(scenario, { ...plan, seed: 4243 }).vehicles);
  const rolled = validateScenario(rollWave(scenario, plan));
  assert.equal(rolled.vehicles.filter(vehicle => vehicle.role === 'hostile').length, 12);
  assert.equal(rolled.vehicles.filter(vehicle => vehicle.defence).length, 8, 'the screen is left alone');
  const swarm = run(validateScenario(rollWave(scenario, { ...DEFAULT_THREAT, seed: 555, count: 14, speedMin: 45, speedMax: 75, window: 40 })), 20);
  const leaked = swarm.snapshot.units.filter(unit => unit.status === 'complete' && unit.id.startsWith('intruder'));
  assert(leaked.length > 0, 'a saturating wave is not all held');
  assert(swarm.snapshot.logs.some(entry => entry.kind === 'warning' && entry.label.includes('aim point')));
});
check('Fictional outlines align with the image and preserve runway orientation', () => {
  const objects = exampleFootprints(); const runway = objects.find(object => object.kind === 'runway')!;
  const outline = objectOutline(runway); const scale = 3000 / 1536;
  assert.equal(runway.rotation, -90);
  assert.equal(outline.rotation, 90);
  assert.equal(outline.x, (91 + 1347 / 2) * scale);
  assert.equal(outline.y, (199 + 67 / 2) * scale);
  assert.equal(outline.height, 1347 * scale);
  assert.equal(outline.width, 67 * scale);
  assert.equal(objects.length, 15);
});
check('Image map edits and visibility survive JSON and recorded-run round trips', () => {
  const scenario = buildImageScenario(makeScenario(), exampleFootprints());
  const hangar = scenario.objects.find(object => object.kind === 'hangar')!;
  hangar.label = 'Edited hangar'; hangar.size.y = 82; hangar.rotation = 17; hangar.position.x += 50;
  scenario.referenceMap!.visible = false;
  assert.deepEqual(validateScenario(JSON.parse(JSON.stringify(scenario))), scenario);
  const simulation = new Simulation(scenario); simulation.step(20);
  assert.deepEqual(validateRun(JSON.parse(JSON.stringify(simulation.getRecord()))).scenario, scenario);
  for (const referenceMap of [null, { id: 'https://example.com/map.png', visible: true }, { id: 'fictional-coast-v1', visible: 'true' }]) {
    assert.throws(() => validateScenario({ ...scenario, referenceMap }));
  }
  assert.equal(validateScenario(makeScenario()).referenceMap, undefined);
});
check('Reopening the image editor preserves authored flights, events, and weather', () => {
  const original = buildImageScenario(makeScenario(), exampleFootprints());
  original.vehicles[0].route[0].x += 72; original.weather.windSpeed = 7;
  original.events = [{ id: 'delay', actorId: original.vehicles[0].id, partnerId: '', time: 0, action: 'delay', delaySeconds: 4, label: 'Authored delay' }];
  const objects = clone(original.objects); objects[1].size.x += 10;
  const updated = buildImageScenario(original, objects);
  assert.deepEqual(updated.vehicles, original.vehicles); assert.deepEqual(updated.events, original.events); assert.deepEqual(updated.weather, original.weather);
  assert.notDeepEqual(updated.objects, original.objects);
  assert.throws(() => buildImageScenario(original, []), /runway/);
});
check('Fictional coastal takeoff completes with repeatable playback results', () => {
  const scenario = buildImageScenario(makeScenario(), exampleFootprints());
  assert.equal(scenario.events.length, 0);
  const first = run(scenario, 1); const batched = run(scenario, 20);
  assert.deepEqual(first.snapshot, batched.snapshot);
  assert(first.snapshot.logs.some(entry => entry.label.includes('takeoff complete')));
  assert.equal(first.snapshot.units[0].status, 'complete');
});
const report = { checkedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, checks, passed: checks.length, note: 'Simulation and data acceptance checks. Browser rendering FPS is measured separately.' };
mkdirSync('../outputs', { recursive: true });
writeFileSync('../outputs/simulation-verification.json', JSON.stringify(report, null, 2));
console.log(`\n${checks.length} checks passed. Report written to outputs/simulation-verification.json.`);
