import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Simulation, powerAt, temperatureFactor } from '../src/simulation';
import { makeScenario } from '../src/scenarios';
import { buildImageScenario, exampleFootprints, objectOutline } from '../src/image-map';
import { AIRBASE_HEADING, AIRBASE_RUNWAY, airbasePoint, COVER_POSTS, COVER_RADIUS, PATROL } from '../src/airbase';
import { AIRBASE_AIM, F35A, FORM_UP_LEAD, rollWave } from '../src/scenarios';
import { AWR2944P, closestApproach, contact, COUNTER_UAS, crossingPoint, DEFAULT_THREAT, URAD_INDUSTRIAL_V2 } from '../src/defence';
import { csv, validateRun, validateScenario } from '../src/data';
import { clone, STEP, type ScenarioDocument } from '../src/types';

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
check('Departures fly the F-35A figures and rotate inside the runway', () => {
  const knots = (speed: number) => speed / 0.514444;
  const feetPerMinute = (speed: number) => speed * 60 / 0.3048;
  assert.equal(Math.round(knots(F35A.takeoffSpeed)), 165, 'rotation near the reported 165 kt');
  assert.equal(Math.round(feetPerMinute(F35A.climbRate) / 1000), 40, 'climb capability of 40,000 ft/min');
  assert.equal(Math.round(F35A.maxSpeed / 335 * 100) / 100, 1.6, 'Mach 1.6 maximum');
  // The real ground roll is unpublished; the derived acceleration has to land somewhere sane.
  const roll = F35A.takeoffSpeed ** 2 / (2 * F35A.acceleration);
  assert(roll > 350 && roll < 600, `derived ground roll ${Math.round(roll)} m`);
  assert(F35A.usableRunway < 2700 && F35A.usableRunway > 2438, 'inside the runway and above the 8,000 ft policy floor');
  const scenario = makeScenario('airbase');
  const jet = scenario.vehicles.find(vehicle => vehicle.kind === 'jet')!;
  assert.equal(jet.takeoffSpeed, F35A.takeoffSpeed); assert.equal(jet.climbRate, F35A.climbRate);
  // Rolling into wind, not downwind: a departure on 02 wants wind travelling toward 200.
  assert.equal(scenario.weather.windDirection, 200);
  const simulation = new Simulation(scenario);
  let rotation = 0;
  while (!simulation.snapshot.finished && !rotation) {
    simulation.step(1);
    const unit = simulation.snapshot.units.find(item => item.id === jet.id)!;
    if (unit.status === 'airborne') rotation = unit.distance;
  }
  assert(rotation > 0 && rotation < jet.runwayLength, `rotates after ${Math.round(rotation)} m, inside the usable runway`);
  assert(Math.abs(rotation - roll) < 120, 'headwind shortens the roll rather than transforming it');
});
check('Radar envelope follows the published uRAD Industrial v2.0 figures', () => {
  const origin = { x: 0, y: 20, z: 0 };
  const north = (metres: number, height = 20) => ({ x: 0, y: height, z: -metres });
  assert.equal(URAD_INDUSTRIAL_V2.range, 50); assert.equal(URAD_INDUSTRIAL_V2.horizontalFov, 160);
  assert.equal(URAD_INDUSTRIAL_V2.verticalFov, 160); assert.equal(URAD_INDUSTRIAL_V2.velocityRange, 45);
  assert(contact(origin, 0, URAD_INDUSTRIAL_V2, north(49)).seen);
  assert(!contact(origin, 0, URAD_INDUSTRIAL_V2, north(51)).seen, 'beyond the measurement range');
  assert(!contact(origin, 0, URAD_INDUSTRIAL_V2, north(0.2)).seen, 'inside the minimum range');
  // +/-80 degrees: nearly hemispherical, blind only in a 20 degree wedge directly behind.
  assert(contact(origin, 0, URAD_INDUSTRIAL_V2, { x: 28, y: 20, z: -10 }).seen, 'wide of the boresight but inside 80 degrees');
  assert(!contact(origin, 0, URAD_INDUSTRIAL_V2, { x: 3, y: 20, z: 30 }).seen, 'behind the sensor');
  assert(contact(origin, 0, URAD_INDUSTRIAL_V2, north(10, 20 + 30)).seen, 'steep elevation is inside 80 degrees');
  // Reported range is quantised to the resolution cell rather than reported exactly.
  const reading = contact(origin, 0, URAD_INDUSTRIAL_V2, north(30));
  assert.equal(reading.measured, Math.round(30 / URAD_INDUSTRIAL_V2.rangeResolution) * URAD_INDUSTRIAL_V2.rangeResolution);
  // A contact closing faster than the module measures is held, but its motion is not resolved.
  const quick = contact(origin, 0, URAD_INDUSTRIAL_V2, north(40), { x: 0, y: 0, z: 60 });
  assert(quick.seen && !quick.solvable, 'seen at 60 m/s closing, past the 45 m/s limit');
  const steady = contact(origin, 0, URAD_INDUSTRIAL_V2, north(40), { x: 0, y: 0, z: 30 });
  assert(steady.seen && steady.solvable);
  assert.equal(Math.round(steady.closing), 30);
});
check('The square-on crossing point is solved, and a late dash is refused', () => {
  const origin = { x: 30, y: 20, z: 0 };
  // A target flying due north past a sentry 30 m to its east: the square-on point is abeam.
  const crossing = crossingPoint(origin, 42, 45, { x: 0, y: 20, z: 40 }, { x: 0, y: 0, z: -20 });
  assert(crossing, 'a target still approaching has a crossing');
  assert.equal(Math.round(crossing!.point.z), 0, 'abeam the sentry');
  assert.equal(Math.round(crossing!.dash), 30, 'the dash is the perpendicular, not the range');
  assert.equal(Math.round(crossing!.targetTime * 10) / 10, 2);
  assert(crossing!.reachable, '30 m at 45 m/s² inside 2 s');
  // Straight overhead: the shortest way onto the track is a vertical climb.
  const above = crossingPoint({ x: 0, y: 0, z: 0 }, 42, 45, { x: 0, y: 40, z: 60 }, { x: 0, y: 0, z: -20 });
  assert.equal(Math.round(above!.point.x), 0); assert.equal(Math.round(above!.point.z), 0);
  assert.equal(Math.round(above!.dash), 40, 'a vertical dash');
  assert.equal(crossingPoint(origin, 42, 45, { x: 0, y: 20, z: -40 }, { x: 0, y: 0, z: -20 }), undefined, 'already past');
  assert(!crossingPoint({ x: 400, y: 20, z: 0 }, 42, 45, { x: 0, y: 20, z: 40 }, { x: 0, y: 0, z: -20 })!.reachable, '400 m in 2 s is not on');
  // Swept over the step, a fast pass cannot slip between two position samples.
  const slip = closestApproach({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: -4, y: 0, z: 0 }, { x: 160, y: 0, z: 0 }, STEP);
  assert.equal(Math.round(slip), 0, 'passes straight through, and is caught');
});
check('The screen covers the centreline, with the fleet split between ring and pods', () => {
  const scenario = makeScenario('airbase');
  const sentries = scenario.vehicles.filter(vehicle => vehicle.defence);
  const pods = new Set(scenario.objects.filter(object => object.kind === 'pod').map(object => object.id));
  assert.equal(sentries.length, COVER_POSTS.length);
  assert.equal(pods.size, COVER_POSTS.length, 'a pod each');
  const flying = sentries.filter(sentry => sentry.defence!.patrol);
  assert.equal(flying.length, PATROL.flying, 'the rest wait on their pads');
  assert(flying.length < sentries.length, 'not everyone is up before a departure');
  const axis = AIRBASE_HEADING * Math.PI / 180;
  const departure = scenario.vehicles.find(vehicle => vehicle.kind === 'jet')!.departAt;
  for (const sentry of sentries) {
    const defence = sentry.defence!;
    assert.equal(sentry.departAt, 0);
    assert.deepEqual(defence.sensor, COUNTER_UAS);
    assert(pods.has(defence.podId));
    assert.equal(defence.readyAt, departure - FORM_UP_LEAD, 'takes station ahead of the roll');
    // The centreline abeam each post has to be inside the envelope for the post to be worth having.
    const east = defence.station.x - AIRBASE_AIM.x; const north = defence.station.z - AIRBASE_AIM.z;
    const across = Math.abs(east * Math.cos(axis) + north * Math.sin(axis));
    assert(Math.hypot(across, defence.station.y - AIRBASE_AIM.y) <= defence.sensor.range);
    // 200 m of warning against 40 m/s is 5 s; the dash it buys has to be worth more than the post.
    const warning = defence.sensor.range / 40;
    const ramp = sentry.speed / sentry.acceleration;
    const dash = sentry.speed ** 2 / (2 * sentry.acceleration) + sentry.speed * (warning - ramp);
    assert(dash > 100, `a ${sentry.speed} m/s post reaches ${Math.round(dash)} m inside the warning`);
  }
  // The screen is an arch over the strip, not a ring through it and not a line beside it.
  const axisOf = AIRBASE_HEADING * Math.PI / 180;
  let nearestPair = Infinity;
  for (let a = 0; a < sentries.length; a++) for (let b = a + 1; b < sentries.length; b++) {
    const one = sentries[a].defence!.station; const two = sentries[b].defence!.station;
    nearestPair = Math.min(nearestPair, Math.hypot(one.x - two.x, one.y - two.y, one.z - two.z));
  }
  assert(nearestPair > 80, `posts spread like a polygon, nearest pair ${Math.round(nearestPair)} m`);
  for (const sentry of sentries) {
    const defence = sentry.defence!;
    const east = defence.station.x - AIRBASE_AIM.x; const north = defence.station.z - AIRBASE_AIM.z;
    const across = east * Math.cos(axisOf) + north * Math.sin(axisOf);
    // Every post sits on the half cylinder, so none of them is ever over the runway itself.
    assert(Math.abs(Math.hypot(across, defence.station.y) - COVER_RADIUS) < 2, 'on the arch');
    assert(defence.station.y > 30, 'above the strip, not beside it on the deck');
  }
  // Mirrored angles share a height by construction, so identity is the whole station, not the height.
  assert.equal(new Set(sentries.map(sentry => Object.values(sentry.defence!.station).map(Math.round).join())).size, sentries.length, 'no two posts in one place');
  // The datasheet parts stay in the file and stay honest: neither can look down off the arch.
  assert(AWR2944P.verticalFov < 30 && URAD_INDUSTRIAL_V2.range < 100);
  assert(COUNTER_UAS.verticalFov >= 60 && COUNTER_UAS.range >= 250, 'the flown head is a wide-field one');
});
check('The fleet patrols and charges, then takes station before the roll', () => {
  const scenario = makeScenario('airbase');
  const sentries = scenario.vehicles.filter(vehicle => vehicle.defence).map(vehicle => vehicle.id);
  const readyAt = scenario.vehicles.find(vehicle => vehicle.defence)!.defence!.readyAt;
  const simulation = new Simulation(scenario);
  const sample = (at: number) => {
    while (simulation.snapshot.time < at && !simulation.snapshot.finished) simulation.step(1);
    const units = simulation.snapshot.units.filter(unit => sentries.includes(unit.id));
    return (task: string) => units.filter(unit => unit.task === task).length;
  };
  const early = sample(10);
  assert.equal(early('patrol'), PATROL.flying);
  assert.equal(early('charge'), COVER_POSTS.length - PATROL.flying);
  assert.equal(early('hold') + early('intercept'), 0, 'nobody is on station yet');
  // A drone on a pod is taking charge, not spending it, while one on the ring is working.
  const parked = simulation.snapshot.units.filter(unit => unit.task === 'charge');
  const ringed = simulation.snapshot.units.filter(unit => unit.task === 'patrol');
  assert(parked.every(unit => unit.battery === 100), 'pods hold them full');
  assert(ringed.every(unit => unit.battery < 100), 'the ring costs energy');
  const formed = sample(readyAt + 12);
  assert.equal(formed('patrol') + formed('charge'), 0, 'everyone leaves the rotation at readyAt');
  assert(formed('hold') + formed('return') + formed('intercept') === COVER_POSTS.length);
  // The ring is sized so a bearing is revisited inside the time an inbound drone needs to cross it.
  const patrolSpeed = scenario.vehicles.find(vehicle => vehicle.defence)!.speed;
  const lap = 2 * Math.PI * PATROL.radius / patrolSpeed;
  assert.equal(Math.round(lap), PATROL.lap);
  // A ring with gaps needs n >= 2*pi*w/v to sweep them before anything crosses. Once each envelope
  // reaches as far as the ring is wide there are no gaps at all, and n >= pi*r/R is what binds.
  const sensor = scenario.vehicles.find(vehicle => vehicle.defence)!.defence!.sensor;
  assert(PATROL.flying >= Math.PI * PATROL.radius / sensor.range, 'enough on the ring to leave no gap in it');
  // And the lap is flown above the crown of the vault, so the one circular part of the pattern
  // never crosses the strip at a height anything else is working at.
  assert(PATROL.altitude > COVER_RADIUS, 'the lap clears the arch');
  assert.equal(Math.round(lap / PATROL.flying * 10) / 10, PATROL.revisit);
  // And four up is what a 40 min pack against a 60 min charge sustains from a fleet this size.
  assert(Math.abs(PATROL.flying / COVER_POSTS.length - 40 / (40 + 60)) < 0.02, 'the split matches the duty cycle');
});
check('A hostile wave is guided onto the departure, not flown on a fixed course', () => {
  const scenario = makeScenario('airbase');
  const jet = scenario.vehicles.find(vehicle => vehicle.kind === 'jet')!;
  const hostiles = scenario.vehicles.filter(vehicle => vehicle.role === 'hostile');
  assert(hostiles.length > 0);
  assert(hostiles.every(hostile => hostile.guidance?.targetId === jet.id), 'every one chases the jet');
  // Move the jet and the wave has to follow: an open-loop route would land in the same place.
  const moved = clone(scenario);
  moved.vehicles.find(vehicle => vehicle.id === jet.id)!.route = [airbasePoint(1250, 900, 400), airbasePoint(2400, 1600, 800)];
  const where = (document: typeof scenario) => {
    const simulation = run(document, 20);
    return simulation.snapshot.units.find(unit => unit.id === hostiles[0].id)!.position;
  };
  assert.notDeepEqual(where(scenario), where(moved), 'the run-in tracks where the jet actually went');
  const straight = clone(scenario);
  straight.vehicles.filter(vehicle => vehicle.role === 'hostile').forEach(vehicle => { delete vehicle.guidance; });
  assert.notDeepEqual(where(scenario), where(validateScenario(straight)), 'guidance changes the outcome');
});
check('Each drone decides for itself, dashes square on, and takes the target down', () => {
  const simulation = run(makeScenario('airbase'), 20);
  const scenario = makeScenario('airbase');
  const hostiles = scenario.vehicles.filter(vehicle => vehicle.role === 'hostile').map(vehicle => vehicle.id);
  const threats = simulation.snapshot.units.filter(unit => hostiles.includes(unit.id));
  const stopped = threats.filter(unit => unit.status === 'stopped').length;
  assert(stopped > 0, 'the screen takes some of the wave');
  const shooters = simulation.snapshot.units.filter(unit => unit.kills > 0);
  assert.equal(shooters.reduce((sum, unit) => sum + unit.kills, 0), stopped);
  assert(shooters.length >= 2, 'more than one drone is drawn in');
  // Every takedown resolves inside the engagement range, and the drone goes back to its post.
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
  assert.equal(rolled.vehicles.filter(vehicle => vehicle.defence).length, COVER_POSTS.length, 'the screen is left alone');
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
