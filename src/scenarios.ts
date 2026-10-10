import { AIRBASE_RUNWAY, airbaseObjects, airbasePoint, coverPost, COVER_POSTS } from './airbase';
import { DEFAULT_THREAT, I79_RADAR, rollThreats } from './defence';
import { clone, type MapKind, type MapObject, type ScenarioDocument, type ThreatPlan, type Vehicle } from './types';

function object(id: string, label: string, kind: MapKind, x: number, z: number, width: number, height: number, depth: number, rotation = 0): MapObject {
  return { id, label, kind, position: { x, y: 0, z }, size: { x: width, y: height, z: depth }, rotation };
}
export function makeVehicle(id: string, role: Vehicle['role'], index = 0): Vehicle {
  const aircraft = role === 'aircraft';
  const hostile = role === 'hostile';
  const position = { x: aircraft ? 0 : hostile ? 900 + index * 100 : -690 - index * 55, y: aircraft ? 5 : hostile ? 180 : 8, z: aircraft ? 830 : hostile ? -1250 : 400 + index * 60 };
  return {
    id, label: aircraft ? 'Falcon 01' : hostile ? `Intruder ${String(index + 1).padStart(2, '0')}` : `Sentry ${String(index + 1).padStart(2, '0')}`,
    role, kind: aircraft ? 'jet' : hostile ? 'fixed-wing' : 'multirotor', position,
    route: aircraft ? [{ x: 0, y: 400, z: -1400 }, { x: 500, y: 650, z: -2100 }] : hostile ? [{ x: 250, y: 180, z: -400 }, { x: -700, y: 100, z: 200 }] : [{ x: -300, y: 180, z: -300 }, { x: 250, y: 180, z: -550 }, { x: -600, y: 100, z: 500 }],
    departAt: aircraft ? 4 : hostile ? index * 12 : 8 + index * 6,
    speed: aircraft ? 110 : hostile ? 32 : 28, maxSpeed: aircraft ? 160 : 45,
    batteryWh: aircraft ? 6000 : 180,
    powerCurve: aircraft ? [{ speed: 0, watts: 20000 }, { speed: 160, watts: 100000 }] : [{ speed: 0, watts: 200 }, { speed: 20, watts: 320 }, { speed: 45, watts: 850 }],
    acceleration: 7, takeoffSpeed: 70, climbRate: 18, runwayLength: 1750,
  };
}
export function makeScenario(preset = 'successful'): ScenarioDocument {
  const scenario: ScenarioDocument = {
    schemaVersion: 1, name: 'Northstar Airfield', description: 'A clear morning. One departure. Two scripted defensive encounters.', seed: 4301, duration: 180,
    objects: [
      object('runway', 'Runway 18 / 36', 'runway', 0, 0, 95, 1, 1900),
      object('taxi-main', 'Taxiway Alpha', 'taxiway', -210, 50, 36, 1, 1680),
      object('taxi-north', 'North connector', 'taxiway', -105, -690, 220, 1, 36),
      object('taxi-south', 'South connector', 'taxiway', -105, 730, 220, 1, 36),
      object('apron', 'West apron', 'taxiway', -460, 90, 440, 1, 800),
      object('hangar-a', 'Hangar A', 'hangar', -690, -190, 180, 75, 160, 90),
      object('hangar-b', 'Hangar B', 'hangar', -690, 60, 180, 75, 160, 90),
      object('hangar-c', 'Hangar C', 'hangar', -690, 310, 180, 75, 160, 90),
      object('tower', 'Control tower', 'tower', -380, 650, 45, 125, 45),
      object('ops', 'Operations', 'building', -580, 650, 180, 32, 85),
      object('lab', 'Research annex', 'building', -870, 640, 180, 26, 110),
      object('depot', 'Utility building', 'building', -1000, 350, 80, 22, 110),
      object('trees-a', 'North grove', 'trees', 550, -780, 300, 30, 240),
      object('trees-b', 'East grove', 'trees', 650, 450, 340, 35, 650),
      object('trees-c', 'West grove', 'trees', -1100, -700, 300, 28, 350),
      object('zone-a', 'Launch area', 'zone', -830, 460, 170, 1, 140),
    ],
    vehicles: [makeVehicle('falcon-01', 'aircraft'), makeVehicle('sentry-01', 'friendly'), makeVehicle('sentry-02', 'friendly', 1), makeVehicle('intruder-01', 'hostile'), makeVehicle('intruder-02', 'hostile', 1)],
    events: [
      { id: 'evt-1', time: 36, action: 'stop', actorId: 'intruder-01', partnerId: 'sentry-01', delaySeconds: 0, label: 'First intruder stopped' },
      { id: 'evt-2', time: 37, action: 'expend', actorId: 'sentry-01', partnerId: '', delaySeconds: 0, label: 'Sentry 01 expended' },
      { id: 'evt-3', time: 49, action: 'stop', actorId: 'intruder-02', partnerId: 'sentry-02', delaySeconds: 0, label: 'Second intruder stopped' },
    ],
    weather: { windSpeed: 3, windDirection: 240, gusts: 1, temperature: 18, rain: 0, visibility: 10000 },
    observations: { noise: 8, missRate: 0.08, latency: 0.25 },
  };
  if (preset === 'unsuccessful') {
    scenario.name = 'Open Corridor'; scenario.description = 'An authored pass-through event and a delayed aircraft departure.';
    scenario.events = [
      { id: 'evt-delay', time: 1, action: 'delay', actorId: 'falcon-01', partnerId: '', delaySeconds: 25, label: 'Hold aircraft departure' },
      { id: 'evt-pass', time: 36, action: 'continue', actorId: 'intruder-01', partnerId: '', delaySeconds: 0, label: 'Intruder continues through corridor' },
    ];
  }
  if (preset === 'battery') {
    scenario.name = 'Last Reserve'; scenario.description = 'A low-energy departure demonstrates exhaustion and skipped encounters.';
    scenario.vehicles.filter(vehicle => vehicle.role === 'friendly').forEach(vehicle => { vehicle.batteryWh = 1.5; });
  }
  if (preset === 'weather') {
    scenario.name = 'Storm Front'; scenario.description = 'Compare the same script under gusts, rain, and reduced visibility.';
    scenario.weather = { windSpeed: 12, windDirection: 90, gusts: 6, temperature: -5, rain: 0.7, visibility: 2400 };
  }
  if (preset === 'stress') {
    scenario.name = 'Flight Lab · 53 vehicles'; scenario.description = 'Ten minutes, fifty drones, three jets. A repeatability and performance exercise.'; scenario.duration = 600; scenario.events = [];
    scenario.vehicles = Array.from({ length: 50 }, (_, index) => {
      const vehicle = makeVehicle(`drone-${index}`, index % 2 ? 'hostile' : 'friendly', index);
      vehicle.departAt = index * 0.2; vehicle.batteryWh = 500;
      vehicle.position = { x: (index % 10) * 180 - 800, y: 120 + Math.floor(index / 10) * 30, z: 1200 };
      vehicle.route = Array.from({ length: 40 }, (_, waypoint) => ({ x: waypoint % 2 ? 1000 : -1000, y: 180 + index * 3, z: waypoint % 4 < 2 ? -1000 : 1000 }));
      return vehicle;
    });
    for (let index = 0; index < 3; index++) { const jet = makeVehicle(`jet-${index}`, 'aircraft'); jet.label = `Falcon 0${index + 1}`; jet.departAt = index * 30; scenario.vehicles.push(jet); }
  }
  if (preset === 'airbase') Object.assign(scenario, makeAirbaseScenario());
  return clone(scenario);
}
/** The point the wave is aimed at: the runway where the departures start their roll. */
export const AIRBASE_AIM = airbasePoint(-500, 0, 10);

/** A covering sentry: already on station, radar envelope from the I-79 figures, pod on the ground. */
export function makeSentry(index: number): Vehicle {
  const post = coverPost(index);
  const sentry = makeVehicle(`sentry-${String(index + 1).padStart(2, '0')}`, 'friendly', index);
  sentry.label = `Sentry ${String(index + 1).padStart(2, '0')}`;
  sentry.position = clone(post.station);
  sentry.route = [clone(post.station)];
  sentry.departAt = 0;
  sentry.speed = 42; sentry.maxSpeed = 60; sentry.climbRate = 16; sentry.batteryWh = 420;
  sentry.powerCurve = [{ speed: 0, watts: 240 }, { speed: 20, watts: 380 }, { speed: 42, watts: 760 }, { speed: 60, watts: 1450 }];
  sentry.defence = { station: clone(post.station), heading: post.heading, sensor: { ...I79_RADAR }, engageRange: 12, podId: post.podId, expendOnKill: false };
  return sentry;
}
/** One ramming drone of a rolled wave. Course, speed, altitude and release time come from the plan. */
export function makeIntruder(index: number): Vehicle {
  const intruder = makeVehicle(`intruder-${String(index + 1).padStart(2, '0')}`, 'hostile', index);
  intruder.label = `Intruder ${String(index + 1).padStart(2, '0')}`;
  intruder.batteryWh = 300; intruder.climbRate = 22;
  intruder.powerCurve = [{ speed: 0, watts: 220 }, { speed: 20, watts: 340 }, { speed: 45, watts: 880 }, { speed: 60, watts: 1500 }];
  return intruder;
}
/** Replaces a scenario's hostile vehicles with a freshly rolled wave, leaving everything else alone. */
export function rollWave(scenario: ScenarioDocument, plan: ThreatPlan, aim = AIRBASE_AIM): ScenarioDocument {
  const next = clone(scenario);
  next.threat = { ...plan };
  next.vehicles = [...next.vehicles.filter(vehicle => vehicle.role !== 'hostile'), ...rollThreats(plan, aim, makeIntruder)];
  next.events = next.events.filter(event => next.vehicles.some(vehicle => vehicle.id === event.actorId));
  return next;
}
/**
 * A fictional tactical air base: one runway on a 020° axis, parallel taxiways, two shelter rows,
 * a maintenance apron and support area, inside a wooded perimeter. Eight sentries cover the runway
 * at 100 m while three departures roll, and a rolled wave of ramming drones runs in at them.
 */
function makeAirbaseScenario(): Partial<ScenarioDocument> {
  const aircraft = [0, 1, 2].map(index => {
    const jet = makeVehicle(`kestrel-0${index + 1}`, 'aircraft');
    jet.label = `Kestrel 0${index + 1}`;
    jet.position = airbasePoint(-1150 - index * 95, 0, 5);
    jet.route = [airbasePoint(1250, 0, 320), airbasePoint(2400, 200, 760), airbasePoint(2500, -1600, 1050)];
    jet.departAt = 20 + index * 90;
    jet.runwayLength = AIRBASE_RUNWAY.usable;
    return jet;
  });
  const base: ScenarioDocument = {
    schemaVersion: 1,
    name: '서해 전술비행단 (가상)',
    description: 'A fictional tactical air base. Eight sentries cover the runway at 100 m with I-79 class imaging radar while three departures roll. A rolled wave of ramming drones runs in on random courses; the nearest free sentry is sent to each one it detects.',
    seed: 7742, duration: 300,
    objects: airbaseObjects(),
    vehicles: [...aircraft, ...COVER_POSTS.map((_, index) => makeSentry(index))],
    events: [],
    weather: { windSpeed: 4, windDirection: 20, gusts: 2, temperature: 14, rain: 0, visibility: 14000 },
    threat: { ...DEFAULT_THREAT },
    observations: { noise: 10, missRate: 0.1, latency: 0.3 },
  };
  return rollWave(base, base.threat!);
}
export const presets = [
  ['successful', 'Successful defense', 'Two authored encounters'], ['unsuccessful', 'Open corridor', 'Pass-through & departure hold'],
  ['battery', 'Last reserve', 'Battery exhaustion'], ['weather', 'Storm front', 'Adverse weather'], ['stress', 'Performance lab', '50 drones · 3 aircraft · 10 min'],
  ['airbase', 'Tactical air base', 'Shelter rows · 3 departures · intrusion'],
] as const;
