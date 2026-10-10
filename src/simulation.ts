import { bearingOf, contact, interceptPoint } from './defence';
import { clone, isActive, SIMULATOR_VERSION, STEP, type ScenarioDocument, type Snapshot, type UnitState, type RunRecord, type Vehicle, type Vec3, type Observation } from './types';

const separation = (first: Vec3, second: Vec3) => Math.hypot(second.x - first.x, second.y - first.y, second.z - first.z);

export function temperatureFactor(temperature: number) { return Math.max(0.55, Math.min(1, 1 - Math.max(0, 20 - temperature) * 0.008)); }
export function powerAt(vehicle: Vehicle, speed: number) {
  const curve = vehicle.powerCurve;
  if (speed <= curve[0].speed) return curve[0].watts;
  for (let index = 1; index < curve.length; index++) {
    if (speed <= curve[index].speed) {
      const previous = curve[index - 1]; const next = curve[index];
      return previous.watts + (next.watts - previous.watts) * (speed - previous.speed) / (next.speed - previous.speed);
    }
  }
  return curve[curve.length - 1].watts;
}
export class Simulation {
  scenario: ScenarioDocument;
  snapshot: Snapshot;
  record: RunRecord;
  private randomState: number;
  private nextEvent = 0;
  private pending: Observation[] = [];
  constructor(scenario: ScenarioDocument) {
    this.scenario = clone(scenario); this.scenario.events.sort((first, second) => first.time - second.time || first.id.localeCompare(second.id));
    this.randomState = scenario.seed >>> 0;
    const units: UnitState[] = scenario.vehicles.map(vehicle => {
      const capacity = vehicle.batteryWh * temperatureFactor(scenario.weather.temperature);
      // A covering sentry is already up when the run starts; it was never waiting in a garage.
      const covering = Boolean(vehicle.defence) && vehicle.departAt <= 0;
      return {
        id: vehicle.id, position: clone(vehicle.position), velocity: { x: 0, y: 0, z: 0 }, airspeed: 0, groundSpeed: 0,
        energy: capacity, capacity, battery: 100, status: covering ? 'airborne' : 'waiting', waypoint: 0, distance: 0, departureAt: vehicle.departAt,
        task: vehicle.defence ? 'hold' : 'none', targetId: '', tracking: '', trackCount: 0, kills: 0, heading: vehicle.defence?.heading ?? 0,
      };
    });
    this.snapshot = { tick: 0, time: 0, units, logs: [], observations: [], observationCount: 0, finished: false };
    this.record = { schemaVersion: 1, simulatorVersion: SIMULATOR_VERSION, createdAt: new Date().toISOString(), scenario: clone(scenario), frames: [], telemetry: [], logs: [], observations: [] };
    this.capture();
  }
  private random() {
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let value = this.randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  private log(kind: Snapshot['logs'][number]['kind'], label: string, actorId?: string, eventId?: string) {
    const entry = { time: this.snapshot.time, kind, label, ...(actorId ? { actorId } : {}), ...(eventId ? { eventId } : {}) };
    this.snapshot.logs.push(entry); this.record.logs.push(clone(entry));
  }
  private scripts() {
    while (this.nextEvent < this.scenario.events.length && this.scenario.events[this.nextEvent].time <= this.snapshot.time + 1e-8) {
      const event = this.scenario.events[this.nextEvent++];
      const actor = this.snapshot.units.find(unit => unit.id === event.actorId);
      const partner = event.partnerId ? this.snapshot.units.find(unit => unit.id === event.partnerId) : undefined;
      const waitingAction = event.action === 'launch' || event.action === 'delay';
      let reason = !actor ? 'participant is missing' : waitingAction ? actor.status !== 'waiting' ? 'participant has already departed or is inactive' : '' : !isActive(actor.status) ? `participant is ${actor.status}` : '';
      if (event.partnerId && (!partner || !isActive(partner.status))) reason = !partner ? 'supporting participant is missing' : `supporting participant is ${partner.status}`;
      if (reason || !actor) { this.log('skipped', `${event.label}: skipped — ${reason}`, event.actorId, event.id); continue; }
      if (event.action === 'launch') actor.departureAt = this.snapshot.time;
      if (event.action === 'delay') actor.departureAt += event.delaySeconds;
      if (event.action === 'stop') actor.status = 'stopped';
      if (event.action === 'expend') actor.status = 'expended';
      if (!isActive(actor.status) && !waitingAction) { actor.velocity = { x: 0, y: 0, z: 0 }; actor.airspeed = 0; actor.groundSpeed = 0; }
      this.log('resolved', event.label, actor.id, event.id);
    }
  }
  step(count = 1): Snapshot {
    for (let index = 0; index < count && !this.snapshot.finished; index++) {
      this.snapshot.tick++; this.snapshot.time = Math.min(this.scenario.duration, this.snapshot.tick * STEP);
      this.scripts();
      const weather = this.scenario.weather;
      const gust = weather.gusts * Math.sin(this.snapshot.time * 0.8 + this.scenario.seed * 0.01);
      const angle = weather.windDirection * Math.PI / 180;
      const wind: Vec3 = { x: Math.sin(angle) * (weather.windSpeed + gust), y: 0, z: -Math.cos(angle) * (weather.windSpeed + gust) };
      this.snapshot.units.forEach((unit, unitIndex) => {
        const vehicle = this.scenario.vehicles[unitIndex];
        if (unit.status === 'waiting' && this.snapshot.time + 1e-8 >= unit.departureAt) {
          unit.status = vehicle.kind === 'jet' ? 'rolling' : 'airborne';
          this.log('flight', `${vehicle.label} departed`, unit.id);
        }
        if (!isActive(unit.status)) return;
        if (unit.status === 'rolling') this.roll(unit, vehicle, wind);
        else if (vehicle.defence) this.cover(unit, vehicle, wind);
        else this.fly(unit, vehicle, wind);
        if (!isActive(unit.status)) return;
        unit.energy = Math.max(0, unit.energy - powerAt(vehicle, unit.airspeed) * STEP / 3600);
        unit.battery = unit.capacity ? unit.energy / unit.capacity * 100 : 0;
        if (unit.energy <= 0) {
          unit.status = 'depleted'; unit.velocity = { x: 0, y: 0, z: 0 }; unit.airspeed = 0; unit.groundSpeed = 0;
          this.log('warning', `${vehicle.label}: battery exhausted, flight ended`, unit.id);
        }
      });
      this.engage();
      if (this.snapshot.tick % 20 === 0) this.observe();
      const delivered = this.pending.filter(observation => observation.deliveredAt <= this.snapshot.time);
      this.pending = this.pending.filter(observation => observation.deliveredAt > this.snapshot.time);
      this.snapshot.observationCount += delivered.length; this.record.observations.push(...clone(delivered));
      this.snapshot.observations = [...this.snapshot.observations, ...delivered].filter(observation => observation.deliveredAt > this.snapshot.time - 4);
      this.snapshot.finished = this.snapshot.time >= this.scenario.duration;
      if (this.snapshot.tick % 10 === 0 || this.snapshot.finished) this.capture();
    }
    return this.snapshot;
  }
  private roll(unit: UnitState, vehicle: Vehicle, wind: Vec3) {
    const destination = vehicle.route[0];
    const headingX = destination.x - vehicle.position.x; const headingZ = destination.z - vehicle.position.z;
    const length = Math.hypot(headingX, headingZ) || 1;
    unit.airspeed = Math.min(vehicle.maxSpeed, unit.airspeed + vehicle.acceleration * STEP);
    const windAlong = wind.x * headingX / length + wind.z * headingZ / length;
    unit.groundSpeed = Math.max(0, unit.airspeed + windAlong);
    unit.velocity = { x: headingX / length * unit.groundSpeed, y: 0, z: headingZ / length * unit.groundSpeed };
    unit.position.x += unit.velocity.x * STEP; unit.position.z += unit.velocity.z * STEP;
    unit.distance += unit.groundSpeed * STEP;
    if (unit.distance >= vehicle.runwayLength && unit.airspeed < vehicle.takeoffSpeed) {
      unit.status = 'overrun'; unit.groundSpeed = 0; unit.airspeed = 0; unit.velocity = { x: 0, y: 0, z: 0 };
      this.log('warning', `${vehicle.label}: runway overrun`, unit.id);
    } else if (unit.airspeed >= vehicle.takeoffSpeed) {
      unit.status = 'airborne'; this.log('flight', `${vehicle.label}: takeoff complete`, unit.id);
    }
  }
  private fly(unit: UnitState, vehicle: Vehicle, wind: Vec3) {
    const destination = vehicle.route[unit.waypoint];
    if (!destination) {
      unit.status = 'complete'; unit.velocity = { x: 0, y: 0, z: 0 }; unit.airspeed = 0; unit.groundSpeed = 0;
      // A hostile that runs its course out was never stopped: it reached what it was aimed at.
      if (vehicle.role === 'hostile') this.log('warning', `${vehicle.label}: reached its aim point unengaged`, unit.id);
      else this.log('flight', `${vehicle.label}: route complete`, unit.id);
      return;
    }
    const offset = { x: destination.x - unit.position.x, y: destination.y - unit.position.y, z: destination.z - unit.position.z };
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    const targetSpeed = Math.min(vehicle.speed, vehicle.maxSpeed);
    unit.airspeed = Math.min(targetSpeed, unit.airspeed + (vehicle.kind === 'jet' ? vehicle.acceleration : 12) * STEP);
    if (distance < Math.max(12, (unit.airspeed + Math.hypot(wind.x, wind.z)) * STEP * 2)) { unit.waypoint++; return; }
    const vertical = Math.max(-vehicle.climbRate, Math.min(vehicle.climbRate, offset.y / distance * unit.airspeed));
    const horizontalDistance = Math.hypot(offset.x, offset.z);
    const horizontalSpeed = Math.sqrt(Math.max(0, unit.airspeed ** 2 - vertical ** 2));
    unit.velocity = { x: horizontalDistance ? offset.x / horizontalDistance * horizontalSpeed + wind.x : 0, y: vertical, z: horizontalDistance ? offset.z / horizontalDistance * horizontalSpeed + wind.z : 0 };
    unit.groundSpeed = Math.hypot(unit.velocity.x, unit.velocity.z);
    unit.position.x += unit.velocity.x * STEP; unit.position.y = Math.max(3, unit.position.y + unit.velocity.y * STEP); unit.position.z += unit.velocity.z * STEP;
    unit.distance += Math.hypot(unit.velocity.x, unit.velocity.y, unit.velocity.z) * STEP;
  }
  /**
   * A covering sentry flies to one point: its station while it waits, its assigned target while it
   * runs an intercept. Holding costs the hover end of the power curve, so station time still drains.
   */
  private cover(unit: UnitState, vehicle: Vehicle, wind: Vec3) {
    const defence = vehicle.defence!;
    const chase = unit.task === 'intercept' ? this.snapshot.units.find(item => item.id === unit.targetId) : undefined;
    // Lead the target. Flying at where it is now loses every tail chase against a comparable speed.
    const lead = chase && interceptPoint(unit.position, Math.min(vehicle.speed, vehicle.maxSpeed), chase.position, chase.velocity);
    const destination = chase ? lead?.point ?? chase.position : defence.station;
    const offset = { x: destination.x - unit.position.x, y: destination.y - unit.position.y, z: destination.z - unit.position.z };
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    const horizontal = Math.hypot(offset.x, offset.z);
    const arrived = Math.max(3, unit.airspeed * STEP * 2);
    if (!chase && distance <= arrived) {
      unit.position = clone(defence.station); unit.heading = defence.heading;
      unit.velocity = { x: 0, y: 0, z: 0 }; unit.airspeed = 0; unit.groundSpeed = 0;
      if (unit.task === 'return') { unit.task = 'hold'; this.log('flight', `${vehicle.label}: back on station`, unit.id); }
      return;
    }
    // A multirotor can yaw independently of its track, so the radar stays on the target while the
    // airframe translates toward the meeting point. The hard kill needs the target inside the cone.
    if (chase) unit.heading = bearingOf(chase.position.x - unit.position.x, chase.position.z - unit.position.z);
    else if (horizontal > 0.5) unit.heading = bearingOf(offset.x, offset.z);
    const targetSpeed = Math.min(vehicle.speed, vehicle.maxSpeed);
    unit.airspeed = Math.min(targetSpeed, unit.airspeed + 14 * STEP);
    const vertical = Math.max(-vehicle.climbRate, Math.min(vehicle.climbRate, distance ? offset.y / distance * unit.airspeed : 0));
    const horizontalSpeed = Math.sqrt(Math.max(0, unit.airspeed ** 2 - vertical ** 2));
    unit.velocity = {
      x: horizontal ? offset.x / horizontal * horizontalSpeed + wind.x : 0, y: vertical,
      z: horizontal ? offset.z / horizontal * horizontalSpeed + wind.z : 0,
    };
    unit.groundSpeed = Math.hypot(unit.velocity.x, unit.velocity.z);
    unit.position.x += unit.velocity.x * STEP; unit.position.y = Math.max(3, unit.position.y + unit.velocity.y * STEP); unit.position.z += unit.velocity.z * STEP;
    unit.distance += Math.hypot(unit.velocity.x, unit.velocity.y, unit.velocity.z) * STEP;
  }
  private label(id: string) { return this.scenario.vehicles.find(vehicle => vehicle.id === id)?.label ?? id; }
  /**
   * Detect, assign, engage. Every sentry reports what its own radar sees; a detected intruder is
   * handed to the nearest sentry that is not already committed, and the hard kill resolves only
   * when that sentry has the intruder inside its own envelope at engagement range.
   */
  private engage() {
    const vehicles = this.scenario.vehicles;
    const sentries: { unit: UnitState; vehicle: Vehicle }[] = [];
    const threats: UnitState[] = [];
    this.snapshot.units.forEach((unit, index) => {
      const vehicle = vehicles[index];
      if (vehicle.defence && isActive(unit.status)) sentries.push({ unit, vehicle });
      else if (vehicle.role === 'hostile' && isActive(unit.status)) threats.push(unit);
    });
    if (!sentries.length) return;
    const detected = new Set<string>();
    for (const { unit, vehicle } of sentries) {
      const sensor = vehicle.defence!.sensor;
      let nearest = ''; let shortest = Infinity; let count = 0;
      for (const threat of threats) {
        const reading = contact(unit.position, unit.heading, sensor, threat.position);
        if (!reading.seen) continue;
        count++; detected.add(threat.id);
        if (reading.measured < shortest) { shortest = reading.measured; nearest = threat.id; }
      }
      unit.tracking = nearest; unit.trackCount = count;
    }
    for (const { unit } of sentries) {
      if (unit.task !== 'intercept') continue;
      const target = this.snapshot.units.find(item => item.id === unit.targetId);
      if (!target || !isActive(target.status)) { unit.targetId = ''; unit.task = 'return'; }
    }
    const committed = new Set(sentries.map(sentry => sentry.unit.targetId).filter(Boolean));
    for (const threat of threats) {
      if (!detected.has(threat.id) || committed.has(threat.id)) continue;
      // Nearest sentry goes, but a sentry with no intercept solution would only tail chase, so one
      // that can actually meet the run-in wins over a closer one that cannot.
      let chosen: { unit: UnitState; vehicle: Vehicle } | undefined; let shortest = Infinity;
      let fallback: { unit: UnitState; vehicle: Vehicle } | undefined; let nearest = Infinity;
      for (const sentry of sentries) {
        if (sentry.unit.task === 'intercept') continue;
        const gap = separation(sentry.unit.position, threat.position);
        if (gap < nearest) { nearest = gap; fallback = sentry; }
        const speed = Math.min(sentry.vehicle.speed, sentry.vehicle.maxSpeed);
        if (!interceptPoint(sentry.unit.position, speed, threat.position, threat.velocity)) continue;
        if (gap < shortest) { shortest = gap; chosen = sentry; }
      }
      if (!chosen) { chosen = fallback; shortest = nearest; }
      if (!chosen) break;
      chosen.unit.task = 'intercept'; chosen.unit.targetId = threat.id; committed.add(threat.id);
      this.log('flight', `${chosen.vehicle.label}: committed to ${this.label(threat.id)}, ${Math.round(shortest)} m`, chosen.unit.id);
    }
    for (const { unit, vehicle } of sentries) {
      if (unit.task !== 'intercept') continue;
      const defence = vehicle.defence!;
      const target = this.snapshot.units.find(item => item.id === unit.targetId);
      if (!target) continue;
      const reading = contact(unit.position, unit.heading, defence.sensor, target.position);
      if (!reading.seen || reading.measured > defence.engageRange) continue;
      target.status = 'stopped'; target.velocity = { x: 0, y: 0, z: 0 }; target.airspeed = 0; target.groundSpeed = 0;
      unit.kills++; unit.targetId = '';
      this.log('resolved', `${vehicle.label} stopped ${this.label(target.id)} at ${reading.measured.toFixed(1)} m`, unit.id);
      if (defence.expendOnKill) { unit.status = 'expended'; unit.task = 'none'; unit.velocity = { x: 0, y: 0, z: 0 }; unit.airspeed = 0; unit.groundSpeed = 0; }
      else unit.task = 'return';
    }
  }
  private observe() {
    const settings = this.scenario.observations; const weather = this.scenario.weather;
    const missRate = Math.min(0.95, settings.missRate + weather.rain * 0.2 + Math.max(0, 1 - weather.visibility / 10000) * 0.15);
    this.snapshot.units.filter(unit => isActive(unit.status)).forEach(unit => {
      if (this.random() < missRate) return;
      const noise = () => (this.random() - 0.5) * 2 * settings.noise;
      this.pending.push({ observedAt: this.snapshot.time, deliveredAt: this.snapshot.time + settings.latency, actorId: unit.id, position: { x: unit.position.x + noise(), y: unit.position.y + noise(), z: unit.position.z + noise() } });
    });
  }
  private capture() {
    this.record.frames.push({ tick: this.snapshot.tick, time: this.snapshot.time, units: clone(this.snapshot.units), observationCount: this.snapshot.observationCount });
    if (this.snapshot.tick % 20 === 0 || this.snapshot.finished) this.snapshot.units.forEach(unit => this.record.telemetry.push({ time: this.snapshot.time, id: unit.id, x: unit.position.x, y: unit.position.y, z: unit.position.z, airspeed: unit.airspeed, groundSpeed: unit.groundSpeed, battery: unit.battery, energy: unit.energy, status: unit.status }));
  }
  getRecord() {
    const record = clone(this.record);
    if (record.frames.at(-1)?.tick !== this.snapshot.tick) record.frames.push({ tick: this.snapshot.tick, time: this.snapshot.time, units: clone(this.snapshot.units), observationCount: this.snapshot.observationCount });
    return record;
  }
}
