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
 * The covering screen. Sentries hold 100 m either side of the runway centreline, spaced along it,
 * already airborne before a departure rather than launching from a pod when something shows up.
 * Each post has a charging pod on the ground behind it, clear of the pavement.
 */
export const COVER_OFFSET = 100;
export const COVER_ALTITUDE = 60;
export const COVER_POSTS = [-1100, -700, -300, 100].flatMap(u => [{ u, side: -1 }, { u, side: 1 }]);
/**
 * Each post looks outward from its own flank, and the end posts are angled to close the approaches
 * along the runway. A 120° sensor on each of the eight leaves the screen with no blind bearing,
 * while keeping whoever owns a bearing close to the ground it covers. One post still sees only its
 * own sector, which is what makes where you put them matter.
 */
const SECTORS = [225, 135, 270, 90, 270, 90, 315, 45];
const podAt = (post: { u: number; side: number }) => ({ u: post.u + 60, v: post.side < 0 ? -215 : 360 });
export function coverPost(index: number) {
  const post = COVER_POSTS[index];
  return {
    podId: `ab-pod-${index}`,
    station: airbasePoint(post.u, post.side * COVER_OFFSET, COVER_ALTITUDE),
    pod: airbasePoint(podAt(post).u, podAt(post).v),
    heading: (AIRBASE_HEADING + SECTORS[index] + 360) % 360,
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

  // Charging pods for the covering screen, one behind each post and clear of the pavement.
  COVER_POSTS.forEach((post, index) => {
    const pod = podAt(post);
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
