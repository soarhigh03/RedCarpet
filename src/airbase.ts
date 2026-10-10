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

/** Shelter rows are generated; each entry is a [along-runway, across-runway] centre in local metres. */
const SHELTER_ROW_A = [-1000, -800, -600, -400, -200, 0, 200, 400, 600, 800, 1000, 1200];
const SHELTER_ROW_B = [-1000, -800, -600, -400, 400, 600, 800, 1000];

export function airbaseObjects(): MapObject[] {
  const objects: MapObject[] = [];
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

  // Wooded ground: a strip inside the fence, hills outside it.
  add('grove-inner', 'West tree line', 'trees', 300, -390, 220, 26, 1500);
  add('grove-west-north', 'Northwest hills', 'trees', 1000, -950, 480, 34, 900);
  add('grove-west-south', 'Southwest hills', 'trees', -500, -1000, 560, 32, 1200);
  add('grove-north', 'North woodland', 'trees', 2050, 300, 900, 30, 520);
  add('grove-south', 'South woodland', 'trees', -2050, 250, 820, 28, 480);
  add('grove-east', 'East woodland', 'trees', -900, 1900, 480, 26, 900);

  return objects;
}
