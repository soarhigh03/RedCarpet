import { AIRBASE_RUNWAY, airbaseObjects, airbasePoint, coverPost, COVER_POSTS, PATROL } from './airbase';
import { COUNTER_UAS, DEFAULT_THREAT, rollThreats } from './defence';
import { clone, type MapKind, type MapObject, type ScenarioDocument, type ThreatPlan, type Vehicle } from './types';

function object(id: string, label: string, kind: MapKind, x: number, z: number, width: number, height: number, depth: number, rotation = 0): MapObject {
  return { id, label, kind, position: { x, y: 0, z }, size: { x: width, y: height, z: depth }, rotation };
}
/**
 * F-35A Lightning II departure profile, from published figures.
 *
 * Rotation is widely reported at about 165 kt. Eurocontrol's aircraft performance database gives
 * the initial climb to 5,000 ft as 190 kt at 40,000 ft/min and MTOW as 31,751 kg, and lists both V2
 * and the take-off ground roll as "no data" — the roll is simply not published. The acceleration
 * here is therefore derived from thrust to weight rather than quoted: one F135 at roughly 191 kN
 * against a light internal-fuel load gives about 0.85 g of net accelerating force, which puts the
 * roll near 440 m and near 720 m at MTOW. USAF wing policy avoids planned operations on runways
 * under 8,000 ft (2,438 m), which the 2,700 m runway here clears.
 *
 * These are open figures for the real aircraft. Everything the simulation then does with them is
 * its own simplified flight model, and the supplied jet artwork is a generic airframe, not an F-35.
 */
export const F35A = {
  type: 'F-35A Lightning II',
  takeoffSpeed: 85,    // m/s — about 165 kt rotation
  acceleration: 8.3,   // m/s² — from thrust to weight; the ground roll is unpublished
  climbRate: 203,      // m/s — 40,000 ft/min
  cruise: 250,         // m/s — high subsonic
  maxSpeed: 536,       // m/s — Mach 1.6, the published maximum
  usableRunway: 2500,  // m — inside the 2,700 m runway, above the 8,000 ft policy floor
};
export function makeVehicle(id: string, role: Vehicle['role'], index = 0): Vehicle {
  const aircraft = role === 'aircraft';
  const hostile = role === 'hostile';
  const position = { x: aircraft ? 0 : hostile ? 900 + index * 100 : -690 - index * 55, y: aircraft ? 5 : hostile ? 180 : 8, z: aircraft ? 830 : hostile ? -1250 : 400 + index * 60 };
  return {
    id, label: aircraft ? 'Falcon 01' : hostile ? `Intruder ${String(index + 1).padStart(2, '0')}` : `Sentry ${String(index + 1).padStart(2, '0')}`,
    role, kind: aircraft ? 'jet' : hostile ? 'fixed-wing' : 'multirotor', position,
    route: aircraft ? [{ x: 0, y: 400, z: -1400 }, { x: 500, y: 650, z: -2100 }] : hostile ? [{ x: 250, y: 180, z: -400 }, { x: -700, y: 100, z: 200 }] : [{ x: -300, y: 180, z: -300 }, { x: 250, y: 180, z: -550 }, { x: -600, y: 100, z: 500 }],
    departAt: aircraft ? 4 : hostile ? index * 12 : 8 + index * 6,
    speed: aircraft ? F35A.cruise : hostile ? 32 : 28, maxSpeed: aircraft ? F35A.maxSpeed : 45,
    batteryWh: aircraft ? 20000 : 180,
    powerCurve: aircraft
      ? [{ speed: 0, watts: 25000 }, { speed: 85, watts: 90000 }, { speed: 250, watts: 320000 }, { speed: 536, watts: 900000 }]
      : [{ speed: 0, watts: 200 }, { speed: 20, watts: 320 }, { speed: 45, watts: 850 }],
    acceleration: aircraft ? F35A.acceleration : 7,
    takeoffSpeed: aircraft ? F35A.takeoffSpeed : 70,
    climbRate: aircraft ? F35A.climbRate : 18,
    runwayLength: aircraft ? F35A.usableRunway : 1750,
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

/** When the screen leaves the ring and the pods and takes station, ahead of the first departure. */
export const FORM_UP_LEAD = 25;
/**
 * A covering sentry. 35 m/s and about 1.5 g: fast enough that 200 m of warning converts into a
 * 134 m dash, which is what makes two posts a layer enough. Endurance is the Aurelia X4 LE figure,
 * 40 minutes, against a pod that returns a pack in about an hour.
 */
export function makeSentry(index: number, readyAt = FORM_UP_LEAD): Vehicle {
  const post = coverPost(index);
  const sentry = makeVehicle(`sentry-${String(index + 1).padStart(2, '0')}`, 'friendly', index);
  sentry.label = `Sentry ${String(index + 1).padStart(2, '0')}`;
  const start = post.patrol
    ? airbasePoint(-500 + Math.cos(post.patrol.phase * Math.PI / 180) * post.patrol.radius, Math.sin(post.patrol.phase * Math.PI / 180) * post.patrol.radius, post.patrol.altitude)
    : post.pod;
  sentry.position = clone(start);
  sentry.route = [clone(post.station)];
  sentry.departAt = 0;
  // 45 m/s, not 35. The vault stands 150 m off the runway to stay clear of the aeroplane, and a
  // dash has to cross that before it reaches anything: five seconds of warning at 35 m/s buys
  // 134 m and falls short of its own standoff, at 45 m/s it buys 174 m and clears it.
  sentry.speed = 45; sentry.maxSpeed = 45; sentry.climbRate = 22; sentry.acceleration = 20;
  sentry.batteryWh = 1400;   // 40 min of patrol at the cruise point of the curve below
  sentry.powerCurve = [{ speed: 0, watts: 1000 }, { speed: 22, watts: 1500 }, { speed: 45, watts: 2900 }];
  sentry.defence = {
    station: clone(post.station), heading: post.heading, tilt: post.tilt, sensor: { ...COUNTER_UAS },
    engageRange: 10, podId: post.podId, expendOnKill: false,
    // Left off entirely rather than set undefined, so the document survives a JSON round trip.
    ...(post.patrol ? { patrol: { ...post.patrol, centre: clone(post.patrol.centre) } } : {}),
    readyAt, chargeWatts: 1100,   // a pack back in about an hour
  };
  return sentry;
}
/**
 * One ramming drone of a rolled wave. The rolled course is its run-in, but once the departure is
 * moving it steers at the aircraft every step: leading it by the time to close, limited to a 3 g
 * turn. A precomputed path cannot do this — against a target accelerating from 85 to 250 m/s any
 * open-loop route is metres off within seconds.
 */
export function makeIntruder(index: number, chases = ''): Vehicle {
  const intruder = makeVehicle(`intruder-${String(index + 1).padStart(2, '0')}`, 'hostile', index);
  intruder.label = `Intruder ${String(index + 1).padStart(2, '0')}`;
  intruder.batteryWh = 300; intruder.climbRate = 30; intruder.acceleration = 14;
  intruder.powerCurve = [{ speed: 0, watts: 220 }, { speed: 20, watts: 340 }, { speed: 45, watts: 880 }, { speed: 60, watts: 1500 }];
  if (chases) intruder.guidance = { targetId: chases, lead: 10, turnRate: 55 };
  return intruder;
}
/** Replaces a scenario's hostile vehicles with a freshly rolled wave, leaving everything else alone. */
export function rollWave(scenario: ScenarioDocument, plan: ThreatPlan, aim = AIRBASE_AIM): ScenarioDocument {
  const next = clone(scenario);
  next.threat = { ...plan };
  // Every drone in the wave is guided onto the first departure it can find.
  const quarry = next.vehicles.find(vehicle => vehicle.kind === 'jet')?.id ?? '';
  next.vehicles = [...next.vehicles.filter(vehicle => vehicle.role !== 'hostile'), ...rollThreats(plan, aim, index => makeIntruder(index, quarry))];
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
    jet.departAt = 70 + index * 90;   // leaves a visible patrol-and-charge phase before the first roll
    jet.runwayLength = AIRBASE_RUNWAY.usable;
    return jet;
  });
  const base: ScenarioDocument = {
    schemaVersion: 1,
    name: '서해 전술비행단 (가상)',
    description: 'A fictional tactical air base. Eight sentries cover the runway at 100 m with I-79 class imaging radar while three departures roll. A rolled wave of ramming drones runs in on random courses; the nearest free sentry is sent to each one it detects.',
    seed: 7742, duration: 380,
    objects: airbaseObjects(),
    vehicles: [...aircraft, ...COVER_POSTS.map((_, index) => makeSentry(index, aircraft[0].departAt - FORM_UP_LEAD))],
    events: [],
    // Wind travels toward 200, so a departure on runway 02 rolls into it, as it would be planned.
    weather: { windSpeed: 4, windDirection: 200, gusts: 2, temperature: 14, rain: 0, visibility: 14000 },
    threat: { ...DEFAULT_THREAT },
    observations: { noise: 10, missRate: 0.1, latency: 0.3 },
  };
  return rollWave(base, base.threat!);
}
export const presets = [
  ['airbase', 'Tactical air base', 'Covering screen · guided wave · hard kill'],
  ['successful', 'Successful defense', 'Two authored encounters'], ['unsuccessful', 'Open corridor', 'Pass-through & departure hold'],
  ['battery', 'Last reserve', 'Battery exhaustion'], ['weather', 'Storm front', 'Adverse weather'], ['stress', 'Performance lab', '50 drones · 3 aircraft · 10 min'],
] as const;
