import type { Sensor, ThreatPlan, Vec3, Vehicle } from './types';

/**
 * Sensor envelope taken from the published Ainstein I-79 automotive 4D imaging radar figures.
 *
 * Those numbers describe what the radar can see; everything the simulation does with a contact
 * after that — assignment, pursuit, the modelled outcome — is a teaching abstraction, not a
 * guidance or fire-control model, and the hardware is not a counter-drone product.
 */
export const I79_RADAR: Sensor = {
  range: 240,            // m, nominal measurement range (0.5–240 m)
  minRange: 0.5,
  horizontalFov: 120,    // degrees, +/-60
  verticalFov: 30,       // degrees, +/-15
  rangeResolution: 0.39, // m
  rangeAccuracy: 0.1,    // m
};

export const DEGREES = 180 / Math.PI;
/** Compass bearing of an east/north offset, in degrees, where north is -Z. */
export const bearingOf = (east: number, north: number) => (Math.atan2(east, -north) * DEGREES + 360) % 360;
/** Shortest signed turn from one bearing to another, in degrees. */
export const bearingDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;

export type Contact = { seen: boolean; range: number; measured: number; offBoresight: number; elevation: number };
/**
 * Where a target sits in a sensor's envelope. `measured` is the range quantised to the sensor's
 * resolution cell, which is what the engagement logic reads instead of the exact distance.
 */
export function contact(origin: Vec3, heading: number, sensor: Sensor, target: Vec3): Contact {
  const east = target.x - origin.x; const north = target.z - origin.z; const up = target.y - origin.y;
  const ground = Math.hypot(east, north);
  const range = Math.hypot(ground, up);
  const offBoresight = Math.abs(bearingDelta(heading, bearingOf(east, north)));
  const elevation = Math.atan2(up, ground) * DEGREES;
  const measured = Math.round(range / sensor.rangeResolution) * sensor.rangeResolution;
  const seen = range >= sensor.minRange && range <= sensor.range
    && offBoresight <= sensor.horizontalFov / 2 && Math.abs(elevation) <= sensor.verticalFov / 2;
  return { seen, range, measured, offBoresight, elevation };
}

/**
 * Where to fly to meet a mover, rather than where it is now. Solves |target + velocity·t − origin|
 * = speed·t for the first positive t. Returns nothing when the mover simply cannot be caught, which
 * is what tells the assignment pass to look for a better placed sentry.
 */
export function interceptPoint(origin: Vec3, speed: number, target: Vec3, velocity: Vec3) {
  const offset = { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z };
  const a = velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2 - speed ** 2;
  const b = 2 * (offset.x * velocity.x + offset.y * velocity.y + offset.z * velocity.z);
  const c = offset.x ** 2 + offset.y ** 2 + offset.z ** 2;
  let time = -1;
  if (Math.abs(a) < 1e-6) time = Math.abs(b) < 1e-6 ? 0 : -c / b;
  else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return;
    const root = Math.sqrt(discriminant);
    const first = (-b - root) / (2 * a); const second = (-b + root) / (2 * a);
    const positives = [first, second].filter(value => value > 0).sort((one, two) => one - two);
    if (!positives.length) return;
    time = positives[0];
  }
  if (!(time >= 0) || !Number.isFinite(time)) return;
  return {
    time,
    point: { x: target.x + velocity.x * time, y: Math.max(3, target.y + velocity.y * time), z: target.z + velocity.z * time },
  };
}

/** Repeatable 0–1 draw. The wave is rolled into the scenario document, so a run stays reproducible. */
const draw = (value: number) => { const noise = Math.sin(value * 12.9898 + 78.233) * 43758.5453; return noise - Math.floor(noise); };
const between = (value: number, low: number, high: number) => low + value * (high - low);

export const DEFAULT_THREAT: ThreatPlan = {
  count: 8, seed: 20482, speedMin: 24, speedMax: 58,
  altitudeMin: 40, altitudeMax: 110, standoff: 1500, window: 90, weave: 420,
};

/**
 * Rolls a wave of ramming drones around an aim point: random bearing, speed, altitude and release
 * time, each on a weaving run rather than a straight line. Same plan and seed, same wave.
 */
export function rollThreats(plan: ThreatPlan, aim: Vec3, base: (index: number) => Vehicle): Vehicle[] {
  return Array.from({ length: plan.count }, (_, index) => {
    const key = plan.seed * 9 + index * 37;
    const bearing = draw(key) * 360;
    const radians = bearing * Math.PI / 180;
    const standoff = between(draw(key + 3), plan.standoff * 0.75, plan.standoff * 1.25);
    const altitude = between(draw(key + 7), plan.altitudeMin, plan.altitudeMax);
    const speed = between(draw(key + 11), plan.speedMin, plan.speedMax);
    const vehicle = base(index);
    vehicle.position = { x: aim.x + Math.sin(radians) * standoff, y: altitude, z: aim.z - Math.cos(radians) * standoff };
    vehicle.speed = Math.round(speed * 10) / 10;
    vehicle.maxSpeed = Math.max(vehicle.speed, Math.round(speed * 1.2 * 10) / 10);
    vehicle.departAt = Math.round(between(draw(key + 13), 0, plan.window) * 10) / 10;
    // Two weaving legs, then the aim point itself: a run-in, not a straight line.
    const leg = (fraction: number, offset: number, height: number) => ({
      x: aim.x + Math.sin(radians) * standoff * fraction + Math.cos(radians) * offset,
      y: height,
      z: aim.z - Math.cos(radians) * standoff * fraction + Math.sin(radians) * offset,
    });
    // Each run-in picks its own impact point, so a wave arrives spread out rather than stacked.
    const impact = { x: aim.x + (draw(key + 29) - 0.5) * 180, y: Math.max(8, aim.y), z: aim.z + (draw(key + 31) - 0.5) * 180 };
    vehicle.route = [
      leg(0.62, (draw(key + 17) - 0.5) * 2 * plan.weave, Math.round(altitude)),
      leg(0.26, (draw(key + 19) - 0.5) * 2 * plan.weave, Math.round(between(draw(key + 23), plan.altitudeMin, altitude))),
      impact,
    ].map(point => ({ x: Math.round(point.x), y: Math.round(point.y), z: Math.round(point.z) }));
    vehicle.position = { x: Math.round(vehicle.position.x), y: Math.round(vehicle.position.y), z: Math.round(vehicle.position.z) };
    return vehicle;
  });
}
