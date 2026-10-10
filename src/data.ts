import { clone, type ScenarioDocument, type RunRecord } from './types';

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function record(value: unknown, path: string): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object'); return value as Record<string, any>; }
function text(value: unknown, path: string, maximum = 160, empty = false) { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum) fail(path, `enter text up to ${maximum} characters`); }
function number(value: unknown, path: string, minimum: number, maximum: number) { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(path, `must be between ${minimum} and ${maximum}`); }
function choice(value: unknown, path: string, values: string[]) { if (typeof value !== 'string' || !values.includes(value)) fail(path, `expected ${values.join(', ')}`); }
function list(value: unknown, path: string, minimum: number, maximum: number): any[] { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(path, `expected ${minimum}–${maximum} items`); return value; }
function vector(value: unknown, path: string, size = false) { const point = record(value, path); number(point.x, `${path}.x`, size ? 1 : -20000, 20000); number(point.y, `${path}.y`, 0, 5000); number(point.z, `${path}.z`, size ? 1 : -20000, 20000); }
export function validateScenario(input: unknown): ScenarioDocument {
  const value = record(input, 'Scenario');
  if (value.schemaVersion !== 1) fail('Scenario', 'unsupported schema version; expected 1');
  text(value.name, 'Name', 100); text(value.description, 'Description', 600, true); number(value.seed, 'Seed', 0, 4294967295);
  if (!Number.isInteger(value.seed)) fail('Seed', 'must be a whole number');
  number(value.duration, 'Duration', 1, 1200);
  const identifiers = new Set<string>();
  function identifier(id: unknown, path: string) { text(id, path, 80); if (identifiers.has(id as string)) fail(path, 'duplicate identifier'); identifiers.add(id as string); }
  list(value.objects, 'Map objects', 0, 300).forEach((raw, index) => {
    const item = record(raw, `Object ${index + 1}`); identifier(item.id, 'Object ID'); text(item.label, 'Object label');
    choice(item.kind, 'Object type', ['runway', 'taxiway', 'hangar', 'building', 'tower', 'trees', 'zone', 'pod']);
    vector(item.position, 'Object position'); vector(item.size, 'Object size', true); number(item.rotation, 'Rotation', -3600, 3600);
  });
  list(value.vehicles, 'Vehicles', 1, 75).forEach((raw, index) => {
    const item = record(raw, `Vehicle ${index + 1}`); identifier(item.id, 'Vehicle ID'); text(item.label, 'Vehicle label');
    choice(item.role, 'Role', ['friendly', 'hostile', 'aircraft']); choice(item.kind, 'Vehicle type', ['multirotor', 'fixed-wing', 'jet']);
    if ((item.role === 'aircraft') !== (item.kind === 'jet')) fail('Vehicle type', 'aircraft use the jet model; drones use multirotor or fixed-wing');
    vector(item.position, 'Start position'); list(item.route, 'Waypoints', 1, 256).forEach(point => vector(point, 'Waypoint'));
    number(item.departAt, 'Departure time', 0, 2400); number(item.speed, 'Cruise speed', 0.1, 300); number(item.maxSpeed, 'Speed limit', 0.1, 300);
    if (item.speed > item.maxSpeed) fail('Cruise speed', 'must not exceed the speed limit');
    number(item.batteryWh, 'Battery capacity', 0.01, 100000); number(item.acceleration, 'Acceleration', 0.01, 50); number(item.takeoffSpeed, 'Takeoff speed', 1, 300);
    number(item.climbRate, 'Climb rate', 0.1, 100); number(item.runwayLength, 'Runway length', 1, 10000);
    let previous = -1;
    list(item.powerCurve, 'Power curve', 1, 20).forEach(rawPoint => { const point = record(rawPoint, 'Power point'); number(point.speed, 'Curve speed', 0, 300); number(point.watts, 'Curve power', 0, 1000000); if (point.speed <= previous) fail('Power curve', 'speeds must be strictly increasing'); previous = point.speed; });
    if (item.defence !== undefined) {
      const defence = record(item.defence, 'Defence profile');
      if (item.role !== 'friendly') fail('Defence profile', 'only friendly drones can cover a station');
      vector(defence.station, 'Station'); number(defence.heading, 'Station heading', 0, 360);
      number(defence.engageRange, 'Engagement range', 0.5, 2000); text(defence.podId, 'Charging pod', 80, true);
      if (typeof defence.expendOnKill !== 'boolean') fail('Expend on kill', 'expected a boolean');
      const sensor = record(defence.sensor, 'Sensor');
      number(sensor.range, 'Sensor range', 1, 20000); number(sensor.minRange, 'Sensor minimum range', 0, 1000);
      if (sensor.minRange >= sensor.range) fail('Sensor minimum range', 'must be shorter than the measurement range');
      number(sensor.horizontalFov, 'Horizontal field of view', 1, 360); number(sensor.verticalFov, 'Vertical field of view', 1, 180);
      number(sensor.rangeResolution, 'Range resolution', 0.001, 1000); number(sensor.rangeAccuracy, 'Range accuracy', 0, 1000);
    }
  });
  const eventIds = new Set<string>();
  list(value.events, 'Events', 0, 300).forEach(raw => {
    const item = record(raw, 'Event'); text(item.id, 'Event ID', 80); if (eventIds.has(item.id)) fail('Event ID', 'duplicate identifier'); eventIds.add(item.id);
    text(item.label, 'Event label'); text(item.actorId, 'Participant', 80); text(item.partnerId, 'Supporting participant', 80, true);
    if (item.actorId === item.partnerId) fail('Supporting participant', 'must be a different vehicle');
    number(item.time, 'Event time', 0, value.duration); number(item.delaySeconds, 'Delay', 0, 1200);
    choice(item.action, 'Event action', ['launch', 'stop', 'expend', 'continue', 'delay']);
  });
  const weather = record(value.weather, 'Weather');
  number(weather.windSpeed, 'Wind speed', 0, 50); number(weather.windDirection, 'Wind direction', 0, 360); number(weather.gusts, 'Gusts', 0, 30);
  number(weather.temperature, 'Temperature', -40, 50); number(weather.rain, 'Rain', 0, 1); number(weather.visibility, 'Visibility', 200, 20000);
  const observations = record(value.observations, 'Observations');
  number(observations.noise, 'Observation noise', 0, 200); number(observations.missRate, 'Miss rate', 0, 1); number(observations.latency, 'Latency', 0, 10);
  if (value.threat !== undefined) {
    const threat = record(value.threat, 'Threat plan');
    number(threat.count, 'Threat count', 0, 60); number(threat.seed, 'Threat seed', 0, 4294967295);
    if (!Number.isInteger(threat.seed)) fail('Threat seed', 'must be a whole number');
    number(threat.speedMin, 'Slowest threat', 1, 300); number(threat.speedMax, 'Fastest threat', 1, 300);
    if (threat.speedMin > threat.speedMax) fail('Slowest threat', 'must not exceed the fastest threat');
    number(threat.altitudeMin, 'Lowest run-in', 1, 5000); number(threat.altitudeMax, 'Highest run-in', 1, 5000);
    if (threat.altitudeMin > threat.altitudeMax) fail('Lowest run-in', 'must not exceed the highest run-in');
    number(threat.standoff, 'Release distance', 50, 20000); number(threat.window, 'Release window', 0, 1200); number(threat.weave, 'Weave', 0, 5000);
  }
  if (value.referenceMap !== undefined) {
    const reference = record(value.referenceMap, 'Reference map');
    choice(reference.id, 'Reference map ID', ['fictional-coast-v1']);
    if (typeof reference.visible !== 'boolean') fail('Reference visibility', 'expected a boolean');
  }
  return clone(value) as ScenarioDocument;
}
export function validateRun(input: unknown): RunRecord {
  const value = record(input, 'Run');
  if (value.schemaVersion !== 1) fail('Run', 'unsupported schema version');
  validateScenario(value.scenario); text(value.simulatorVersion, 'Simulator version'); text(value.createdAt, 'Created time');
  let previous = -1;
  list(value.frames, 'Replay frames', 1, 2402).forEach(raw => {
    const frame = record(raw, 'Replay frame'); number(frame.time, 'Frame time', 0, 1200); number(frame.tick, 'Frame tick', 0, 24000); number(frame.observationCount, 'Observation count', 0, 1000000);
    if (frame.time < previous) fail('Replay frames', 'must be ordered by time'); previous = frame.time;
    list(frame.units, 'Frame vehicles', 1, 75).forEach(rawUnit => {
      const unit = record(rawUnit, 'Frame vehicle'); text(unit.id, 'Vehicle ID', 80); outputPosition(unit.position); vectorVelocity(unit.velocity);
      choice(unit.status, 'Status', ['waiting', 'rolling', 'airborne', 'complete', 'depleted', 'stopped', 'expended', 'overrun']);
      number(unit.battery, 'Battery', 0, 100); number(unit.energy, 'Energy', 0, 100000); number(unit.capacity, 'Capacity', 0, 100000); number(unit.airspeed, 'Airspeed', 0, 500); number(unit.groundSpeed, 'Ground speed', 0, 500);
    });
  });
  list(value.telemetry, 'Telemetry', 0, 100000).forEach(raw => {
    const row = record(raw, 'Telemetry row'); text(row.id, 'Vehicle ID', 80); text(row.status, 'Status', 30);
    for (const key of ['time', 'x', 'y', 'z', 'airspeed', 'groundSpeed', 'battery', 'energy']) number(row[key], `Telemetry ${key}`, -1000000, 1000000);
  });
  list(value.logs, 'Event log', 0, 10000).forEach(raw => { const entry = record(raw, 'Log entry'); text(entry.label, 'Log label', 500); number(entry.time, 'Log time', 0, 1200); choice(entry.kind, 'Log kind', ['resolved', 'skipped', 'flight', 'warning']); });
  list(value.observations, 'Observations', 0, 100000).forEach(raw => { const entry = record(raw, 'Observation'); text(entry.actorId, 'Observation actor', 80); number(entry.observedAt, 'Observation time', 0, 1200); number(entry.deliveredAt, 'Delivery time', 0, 1210); outputPosition(entry.position); });
  return clone(value) as RunRecord;
}
function vectorVelocity(value: unknown) { const point = record(value, 'Velocity'); for (const key of ['x', 'y', 'z']) number(point[key], `Velocity ${key}`, -500, 500); }
function outputPosition(value: unknown) { const point = record(value, 'Recorded position'); for (const key of ['x', 'y', 'z']) number(point[key], `Recorded position ${key}`, -1000000, 1000000); }
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
export function csv(record: RunRecord) {
  const columns = ['time', 'id', 'x', 'y', 'z', 'airspeed', 'groundSpeed', 'battery', 'energy', 'status'] as const;
  const cell = (value: string | number) => typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : `"${value.replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;
  return [columns.join(','), ...record.telemetry.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n');
}
function database(): Promise<IDBDatabase> { return new Promise((resolve, reject) => { const request = indexedDB.open('airfield-sandbox', 1); request.onupgradeneeded = () => request.result.createObjectStore('runs'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
export async function saveRun(value: RunRecord) { const db = await database(); await new Promise<void>((resolve, reject) => { const transaction = db.transaction('runs', 'readwrite'); transaction.objectStore('runs').put(value, 'latest'); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); db.close(); }
export async function loadRun(): Promise<RunRecord | undefined> { const db = await database(); return new Promise((resolve, reject) => { const request = db.transaction('runs').objectStore('runs').get('latest'); request.onsuccess = () => { db.close(); resolve(request.result ? validateRun(request.result) : undefined); }; request.onerror = () => { db.close(); reject(request.error); }; }); }
