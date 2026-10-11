import type { MapKind, MapObject, Vec3 } from './types';

/**
 * A fictional single-runway tactical air base.
 *
 * The plan follows the general form of a coastal tactical field: one runway with full-length
 * parallel taxiways, combed rows of aircraft shelters hanging off a dispersal lane, a maintenance
 * apron, a support area, and a perimeter road through wooded ground. Every dimension is an
 * illustrative choice for the simulation. Nothing here is surveyed, and the layout does not
 * reconstruct any real installation.
 */

/** Degrees the base axis leans east of north. The layout is authored in runway-local metres, then rotated. */
export const AIRBASE_HEADING = 20;
const radians = (AIRBASE_HEADING * Math.PI) / 180;

/** u: metres along the runway toward its north end. v: metres across the runway, positive to the east. */
export function airbasePoint(u: number, v: number, y = 0): Vec3 {
  return { x: u * Math.sin(radians) + v * Math.cos(radians), y, z: -u * Math.cos(radians) + v * Math.sin(radians) };
}

export const AIRBASE_RUNWAY = { length: 2700, width: 60, usable: 2400 };

/**
 * The screen is a vault, not two lines and not a ring.
 *
 * Take the runway centreline as an axis and arch the posts over it on a half cylinder of radius
 * 150 m: the runway sits at the bottom of the arch and nothing ever stands on it. Sweeping the arc
 * from one flank, over the top, to the other covers every bearing a run-in can arrive on without
 * a horizontal orbit having to cross the strip.
 *
 * The arch spans the roll, from the threshold to just past rotation, and stops there. That is the
 * only stretch where a 40 m/s drone can reach an aircraft at all, and keeping to it is what lets
 * the radius come down: the jet is still under 10 m through all of it, so a 120 m arch clears it by
 * more than 110 m everywhere. Carrying the vault on into the climb-out would need 145 m to hold the
 * same margin over a jet already at 45 m, and 145 m is further than a sentry can dash in the five
 * seconds its radar buys — the screen would be clear of the aeroplane and useless at the same time.
 *
 * 120 m also sits inside the sensor and inside the airframe: the longest slant down to the
 * centreline is 118 m, and 45 m/s reaches 174 m in five seconds, leaving the dash real margin.
 *
 * The twenty posts take the twenty angles of a regular polygon around that arc, but stepped by a
 * number coprime with twenty so consecutive posts along the runway land on opposite parts of the
 * arch. Nobody is beside a neighbour; the nearest pair is over a hundred metres apart.
 */
export const COVER_RADIUS = 120;
export const COVER_SLOTS = 10;
const ARC_FROM = 21, ARC_TO = 159;          // degrees, measured up from the east flank
const ARC_STEP = 3;                           // coprime with the slot count, which scatters the angles
export const COVER_POSTS = Array.from({ length: COVER_SLOTS }, (_, index) => {
  const turn = ARC_FROM + ((index * ARC_STEP) % COVER_SLOTS) / COVER_SLOTS * (ARC_TO - ARC_FROM);
  const radians = turn * Math.PI / 180;
  return {
    u: -1250 + index * (550 / (COVER_SLOTS - 1)),
    v: Math.cos(radians) * COVER_RADIUS,
    height: Math.sin(radians) * COVER_RADIUS,
    turn,
    side: Math.cos(radians) < 0 ? -1 : 1,
  };
});
export const COVER_OFFSET = COVER_RADIUS;
export const COVER_ALTITUDE = Math.round(Math.sin(ARC_FROM * Math.PI / 180) * COVER_RADIUS);
/**
 * Aim. A ±5° elevation band is measured about wherever the boresight points, so a post arched over
 * the strip has to tilt down onto it — pointed at the horizon it would only ever see things at its
 * own height, which is the one place a run-in diving at the runway never is. Each post looks across
 * and down at the centreline beneath it; near the crown that is very nearly straight down.
 */
const AIM_AT = 10;   // m, the height on the centreline each boresight is laid on
const sectorFor = (_index: number, post: { v: number; turn: number }) => 90 - post.turn;
const tiltFor = (_post: { v: number; height: number }) => -20;
/** Pods sit out in the clear bands either side; a sentry's home does not have to be under its post. */
const podAt = (index: number, post: { side: number }) => ({ u: -1210 + Math.floor(index / 2) * 58, v: post.side < 0 ? -215 : 360 });

/**
 * The pre-departure rotation.
 *
 * Closing the ring is a ratio, not a radius. A drone crossing a ring of radius r at speed w takes
 * r/w to reach the middle; n patrollers at speed v revisit a bearing every 2πr/(v·n). Setting one
 * against the other cancels r entirely, leaving n ≥ 2πw/v, which would be six here. But that
 * is the condition for a ring with gaps in it; once each patroller's own envelope reaches as far as
 * the ring is wide the gaps close instead, and the condition becomes n ≥ πr/R — four, for a 300 m
 * sensor on a 300 m ring. Radius buys warning: 300 m is 7.5 s against a 40 m/s run-in. The lap is flown above
 * the crown of the vault, so the one part of the pattern that is a horizontal circle still never
 * crosses the strip at a height anything else is using.
 *
 * Four up is also exactly what the batteries allow. A 40 minute pack against a 60 minute charge
 * sustains 40% of a fleet in the air, so four flying wants ten on strength: four on the ring, six
 * on pods, and all ten on station when a departure is called.
 */
export const PATROL = {
  radius: 300, altitude: COVER_RADIUS + 60, flying: 4,
  lap: Math.round(2 * Math.PI * 300 / 45),
  revisit: Math.round(2 * Math.PI * 300 / 45 / 4 * 10) / 10,
};
export function coverPost(index: number) {
  const post = COVER_POSTS[index];
  const pod = podAt(index, post);
  return {
    podId: `ab-pod-${index}`,
    station: airbasePoint(post.u, post.v, post.height),
    pod: airbasePoint(pod.u, pod.v),
    heading: (AIRBASE_HEADING + sectorFor(index, post) + 360) % 360,
    tilt: Math.max(-90, Math.min(90, tiltFor(post))),
    /** The first eight fly the ring; the rest wait on their pads. */
    patrol: index < PATROL.flying
      ? { centre: airbasePoint(-980, 0, 0), radius: PATROL.radius, altitude: PATROL.altitude, phase: index / PATROL.flying * 360 }
      : undefined,
  };
}

/** Repeatable 0–1 scatter for the generated woodland belt, so the layout is identical on every load. */
const scatter = (value: number) => { const noise = Math.sin(value * 127.1 + 311.7) * 43758.5453; return noise - Math.floor(noise); };

/** Shelter rows are generated; each entry is a [along-runway, across-runway] centre in local metres. */
const SHELTER_ROW_A = [-1000, -800, -600, -400, -200, 0, 200, 400, 600, 800, 1000, 1200];
const SHELTER_ROW_B = [-1000, -800, -600, -400, 400, 600, 800, 1000];

export function airbaseObjects(): MapObject[] {
  const objects: MapObject[] = [];
  const field = { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity };
  /**
   * across = footprint across the runway, along = footprint parallel to it, both in metres.
   * facing turns the mesh a quarter turn without changing that footprint, so shelter and hangar
   * doors open toward the runway instead of along it.
   */
  const add = (id: string, label: string, kind: MapKind, u: number, v: number, across: number, height: number, along: number, facing: 0 | -90 = 0) => {
    const turned = facing === -90;
    objects.push({
      id: `ab-${id}`, label, kind, position: airbasePoint(u, v),
      size: { x: turned ? along : across, y: height, z: turned ? across : along }, rotation: -AIRBASE_HEADING + facing,
    });
    if (kind === 'trees') return;
    field.minU = Math.min(field.minU, u - along / 2); field.maxU = Math.max(field.maxU, u + along / 2);
    field.minV = Math.min(field.minV, v - across / 2); field.maxV = Math.max(field.maxV, v + across / 2);
  };

  // Runway, the taxiways that parallel it end to end, and the links between them.
  add('runway', 'Runway 02 / 20', 'runway', 0, 0, AIRBASE_RUNWAY.width, 1, AIRBASE_RUNWAY.length);
  add('twy-alpha', 'Taxiway Alpha', 'taxiway', 0, 140, 28, 1, 2560);
  add('twy-bravo', 'Taxiway Bravo', 'taxiway', -80, -140, 26, 1, 2240);
  add('twy-charlie', 'Dispersal lane Charlie', 'taxiway', -60, 420, 24, 1, 2300);
  add('link-north', 'North turn pad', 'taxiway', 1350, 0, 320, 1, 30);
  add('link-south', 'South turn pad', 'taxiway', -1350, 0, 320, 1, 30);
  for (const [index, u] of [900, -100, -900].entries()) add(`link-${index}`, `Crossover ${index + 1}`, 'taxiway', u, 280, 280, 1, 22);
  add('pad-north', 'North alert pad', 'taxiway', 1300, 330, 180, 1, 160);
  add('pad-south', 'South arming pad', 'taxiway', -1300, 330, 180, 1, 160);

  // Shelter rows. Each shelter hangs off its own stub so the rows read as combs from the air.
  for (const [index, u] of SHELTER_ROW_A.entries()) {
    add(`stub-a-${index}`, `Shelter stub A${index + 1}`, 'taxiway', u, 205, 130, 1, 14);
    add(`shelter-a-${index}`, `Shelter A${String(index + 1).padStart(2, '0')}`, 'hangar', u, 290, 40, 14, 32, -90);
  }
  for (const [index, u] of SHELTER_ROW_B.entries()) {
    add(`stub-b-${index}`, `Shelter stub B${index + 1}`, 'taxiway', u, 488, 115, 1, 14);
    add(`shelter-b-${index}`, `Shelter B${String(index + 1).padStart(2, '0')}`, 'hangar', u, 560, 40, 14, 32, -90);
  }

  // Charging pods for the covering screen, one per post and clear of the pavement.
  COVER_POSTS.forEach((post, index) => {
    const pod = podAt(index, post);
    add(`pod-${index}`, `Charging pod ${String(index + 1).padStart(2, '0')}`, 'pod', pod.u, pod.v, 18, 3, 18);
  });

  // Maintenance apron and its hangar line, with the hangar doors onto the apron.
  add('apron', 'Main apron', 'taxiway', -100, 760, 320, 1, 760);
  add('apron-link', 'Apron entry', 'taxiway', -100, 590, 140, 1, 60);
  for (const [index, u] of [-300, -60, 180].entries()) add(`hangar-${index}`, `Maintenance hangar ${'ABC'[index]}`, 'hangar', u, 1010, 72, 34, 92, -90);

  // Support area east of the apron.
  add('tower', 'Control tower', 'tower', 340, 1070, 42, 88, 42);
  add('ops', 'Base operations', 'building', 150, 1160, 120, 26, 70);
  add('fire', 'Fire & rescue station', 'building', 480, 1130, 84, 18, 52);
  add('hq', 'Wing headquarters', 'building', -70, 1270, 150, 30, 80);
  add('sq-a', 'Squadron operations A', 'building', -300, 1170, 92, 20, 60);
  add('sq-b', 'Squadron operations B', 'building', -450, 1170, 92, 20, 60);
  add('shops', 'Maintenance shops', 'building', -630, 1210, 160, 22, 82);
  add('supply', 'Supply warehouse', 'building', -830, 1160, 180, 24, 92);
  add('helipad', 'Rescue helipad', 'zone', 570, 1020, 90, 1, 90);
  for (const [index, u] of [-150, -300, -450].entries()) add(`barracks-${index}`, `Barracks ${'ABC'[index]}`, 'building', u, 1420, 130, 24, 50);
  add('dining', 'Dining facility', 'building', 60, 1430, 110, 18, 62);
  add('clinic', 'Base clinic', 'building', 260, 1400, 92, 20, 56);

  // Fuel and munitions storage, kept clear of the flight line in the south.
  add('pol', 'POL tank farm', 'building', -1220, 720, 140, 18, 120);
  for (const [index, u] of [-1380, -1480, -1580].entries()) add(`igloo-${index}`, `Munitions igloo ${index + 1}`, 'building', u, 950, 70, 14, 46);

  // Perimeter road.
  add('fence-west', 'West perimeter road', 'taxiway', 0, -600, 16, 1, 3300);
  add('fence-east', 'East perimeter road', 'taxiway', 0, 1560, 16, 1, 3300);
  add('fence-north', 'North perimeter road', 'taxiway', 1650, 480, 2160, 1, 16);
  add('fence-south', 'South perimeter road', 'taxiway', -1650, 480, 2160, 1, 16);

  // Wooded ground inside the fence.
  add('grove-inner', 'West tree line', 'trees', 300, -390, 220, 26, 1500);
  add('grove-inner-south', 'Southwest tree line', 'trees', -1150, -350, 220, 24, 700);
  add('grove-inner-north', 'North tree line', 'trees', 1480, 900, 420, 24, 240);

  // Woodland outside the perimeter: a jittered belt that wraps the base, clipped to clear the built
  // field and to stop at the edge of the modelled ground. Groves are ordinary map objects, so any
  // of them can be moved, resized, or deleted.
  const clearance = 50;
  /** Half-extent a grove may keep on one axis without reaching into the field, or -1 if it straddles it. */
  const clip = (centre: number, half: number, low: number, high: number) =>
    centre <= low ? Math.min(half, low - centre) : centre >= high ? Math.min(half, centre - high) : -1;
  let stand = 0;
  for (let column = 0; column < 13; column++) for (let row = 0; row < 12; row++) {
    const seed = column * 31 + row;
    const u = Math.round(-2850 + column * 475 + (scatter(seed) - 0.5) * 180);
    const v = Math.round(-2400 + row * 460 + (scatter(seed + 71) - 0.5) * 180);
    const point = airbasePoint(u, v);
    if (Math.abs(point.x) > 2650 || Math.abs(point.z) > 2550) continue;
    let along = 360 + Math.round(scatter(seed + 17) * 260);
    let across = 360 + Math.round(scatter(seed + 41) * 260);
    const roomU = clip(u, along / 2, field.minU - clearance, field.maxU + clearance);
    const roomV = clip(v, across / 2, field.minV - clearance, field.maxV + clearance);
    if (roomU >= roomV) along = roomU * 2; else across = roomV * 2;
    if (Math.min(along, across) < 120) continue;
    stand++;
    add(`wood-${column}-${row}`, `Outer woodland ${String(stand).padStart(2, '0')}`, 'trees',
      u, v, Math.round(across), 24 + Math.round(scatter(seed + 5) * 16), Math.round(along));
  }

  return objects;
}
