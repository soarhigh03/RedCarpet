import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Simulation, powerAt, temperatureFactor } from '../src/simulation';
import { makeScenario } from '../src/scenarios';
import { buildImageScenario, exampleFootprints, objectOutline } from '../src/image-map';
import { csv, validateRun, validateScenario } from '../src/data';
import { clone, type ScenarioDocument } from '../src/types';

const checks: { name: string; milliseconds: number }[] = [];
function check(name: string, task: () => void) { const started = performance.now(); task(); checks.push({ name, milliseconds: Math.round((performance.now() - started) * 100) / 100 }); console.log(`PASS ${name}`); }
function run(scenario: ScenarioDocument, batch = 1) { const simulation = new Simulation(scenario); while (!simulation.snapshot.finished) simulation.step(batch); return simulation; }
check('All five example scenarios validate and survive JSON round trips', () => { for (const preset of ['successful', 'unsuccessful', 'battery', 'weather', 'stress']) { const scenario = makeScenario(preset); assert.deepEqual(validateScenario(JSON.parse(JSON.stringify(scenario))), scenario); } });
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
