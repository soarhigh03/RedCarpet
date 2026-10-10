import type { Sensor, ThreatPlan, Vec3, Vehicle } from './types';

/**
 * Sensor envelope from the published uRAD Industrial v2.0 figures (Anteral): a 60–64 GHz module
 * with a 160° × 160° field, ±1 mm distance accuracy, 1° angle accuracy, and velocity measured to
 * 45 m/s at ±0.15 m/s. The datasheet quotes maximum distance by target type — 70 m for a car,
 * 40 m for a person — so 50 m is used here for a small drone, between the two.
 *
 * The velocity limit is not decoration. The intercept works out where a target's track crosses the
 * sentry, which needs the target's velocity, so a contact closing faster than the module can
 * measure is seen but cannot be solved for.
 *
 * These numbers describe what the radar can see. Everything the simulation does with a contact
 * after that is a teaching abstraction, not a guidance or fire-control model, and the hardware is
 * an industrial sensing module, not a counter-drone product.
 */
export const URAD_INDUSTRIAL_V2: Sensor = {
  range: 50,              // m, on a small drone; datasheet quotes 70 m car / 40 m person
  minRange: 0.5,
  horizontalFov: 160,     // degrees, azimuth
  verticalFov: 160,       // degrees, elevation
  rangeResolution: 0.04,  // m, not published separately; taken at the order of the accuracy figure
  rangeAccuracy: 0.001,   // m, +/-1 mm
  velocityRange: 45,      // m/s, beyond which a closing rate is not measured
};

export const DEGREES = 180 / Math.PI;
/** Compass bearing of an east/north offset, in degrees, where north is -Z. */
export const bearingOf = (east: number, north: number) => (Math.atan2(east, -north) * DEGREES + 360) % 360;
/** Shortest signed turn from one bearing to another, in degrees. */
export const bearingDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;

export type Contact = { seen: boolean; range: number; measured: number; offBoresight: number; elevation: number; closing: number; solvable: boolean };
/**
 * Where a target sits in a sensor's envelope. `measured` is the range quantised to the sensor's
 * resolution cell, which is what the engagement reads instead of the exact distance. `closing` is
 * the radial rate; when it runs past the module's velocity range the contact is held but its
 * motion is not resolved, so no crossing can be worked out from it.
 */
export function contact(origin: Vec3, heading: number, sensor: Sensor, target: Vec3, velocity?: Vec3): Contact {
  const east = target.x - origin.x; const north = target.z - origin.z; const up = target.y - origin.y;
  const ground = Math.hypot(east, north);
  const range = Math.hypot(ground, up);
  const offBoresight = Math.abs(bearingDelta(heading, bearingOf(east, north)));
  const elevation = Math.atan2(up, ground) * DEGREES;
  const measured = Math.round(range / sensor.rangeResolution) * sensor.rangeResolution;
  const seen = range >= sensor.minRange && range <= sensor.range
    && offBoresight <= sensor.horizontalFov / 2 && Math.abs(elevation) <= sensor.verticalFov / 2;
  const closing = velocity && range > 1e-6
    ? -(velocity.x * east + velocity.y * up + velocity.z * north) / range
    : 0;
  return { seen, range, measured, offBoresight, elevation, closing, solvable: Math.abs(closing) <= sensor.velocityRange };
}

/** How long an airframe takes to cover a distance from rest, ramping at its acceleration. */
export function travelTime(distance: number, speed: number, acceleration: number) {
  const ramp = speed ** 2 / (2 * acceleration);
  return distance <= ramp ? Math.sqrt(2 * distance / acceleration) : speed / acceleration + (distance - ramp) / speed;
}
export type Crossing = { point: Vec3; dash: number; targetTime: number; dashTime: number; reachable: boolean };
/**
 * Where a sentry meets a mover if it dashes square onto the mover's track — the foot of the
 * perpendicular from the sentry to the line the target is flying. The dash is the shortest path
 * onto that track, and when the target is passing directly overhead or underneath it is straight
 * up or down. Returns nothing when the target has already passed the square-on point.
 */
export function crossingPoint(origin: Vec3, speed: number, acceleration: number, target: Vec3, velocity: Vec3): Crossing | undefined {
  const pace = Math.hypot(velocity.x, velocity.y, velocity.z);
  if (pace < 1e-6) return;
  const track = { x: velocity.x / pace, y: velocity.y / pace, z: velocity.z / pace };
  const behind = { x: origin.x - target.x, y: origin.y - target.y, z: origin.z - target.z };
  const along = behind.x * track.x + behind.y * track.y + behind.z * track.z;
  if (along <= 0) return;
  const point = { x: target.x + track.x * along, y: target.y + track.y * along, z: target.z + track.z * along };
  const dash = Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z);
  const targetTime = along / pace;
  const dashTime = travelTime(dash, speed, acceleration);
  return { point, dash, targetTime, dashTime, reachable: dashTime <= targetTime };
}
/** Closest the two come during one step of straight motion, so a fast pass cannot slip between samples. */
export function closestApproach(first: Vec3, firstVelocity: Vec3, second: Vec3, secondVelocity: Vec3, span: number) {
  const gap = { x: second.x - first.x, y: second.y - first.y, z: second.z - first.z };
  const rate = { x: secondVelocity.x - firstVelocity.x, y: secondVelocity.y - firstVelocity.y, z: secondVelocity.z - firstVelocity.z };
  const square = rate.x ** 2 + rate.y ** 2 + rate.z ** 2;
  const at = square < 1e-9 ? 0 : Math.max(0, Math.min(span, -(gap.x * rate.x + gap.y * rate.y + gap.z * rate.z) / square));
  return Math.hypot(gap.x + rate.x * at, gap.y + rate.y * at, gap.z + rate.z * at);
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
