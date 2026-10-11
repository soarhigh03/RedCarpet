export type Vec3 = { x: number; y: number; z: number };
export type MapKind = 'runway' | 'taxiway' | 'hangar' | 'building' | 'tower' | 'trees' | 'zone' | 'pod';
export type MapObject = { id: string; label: string; kind: MapKind; position: Vec3; size: Vec3; rotation: number };
export type Role = 'friendly' | 'hostile' | 'aircraft';
export type VehicleKind = 'multirotor' | 'fixed-wing' | 'jet';
export type PowerPoint = { speed: number; watts: number };
/**
 * Radar envelope. Angles are the full field of view in degrees, distances metres, and velocityRange
 * the fastest closing rate the module can measure — past it a contact is seen but not solvable.
 */
export type Sensor = { range: number; minRange: number; horizontalFov: number; verticalFov: number; rangeResolution: number; rangeAccuracy: number; velocityRange: number };
/** A patrol lap: where the ring is centred, how wide, how high, and where on it this drone sits. */
export type Patrol = { centre: Vec3; radius: number; altitude: number; phase: number };
/**
 * Turns a drone into a covering sentry: where it waits, what it can see, how close it must get, and
 * what it does with the time before a departure. A sentry with a patrol flies the ring until
 * readyAt; one without sits on its pod drawing charge. Both take station at readyAt.
 */
export type Defence = {
  station: Vec3; heading: number; sensor: Sensor; engageRange: number; podId: string; expendOnKill: boolean;
  patrol?: Patrol; readyAt: number; chargeWatts: number;
};
/** A hostile that steers at a target each step instead of flying a fixed course. */
export type Guidance = { targetId: string; lead: number; turnRate: number };
export type Vehicle = {
  id: string; label: string; role: Role; kind: VehicleKind; position: Vec3; route: Vec3[];
  departAt: number; speed: number; maxSpeed: number; batteryWh: number; powerCurve: PowerPoint[];
  acceleration: number; takeoffSpeed: number; climbRate: number; runwayLength: number;
  defence?: Defence;
  guidance?: Guidance;
};
/** The recipe a hostile wave was rolled from. Rolling again replaces the hostile vehicles. */
export type ThreatPlan = {
  count: number; seed: number; speedMin: number; speedMax: number;
  altitudeMin: number; altitudeMax: number; standoff: number; window: number; weave: number;
  /** When the wave should converge, in seconds. Release is worked back from each drone's run-in. */
  strikeAt: number;
};
export type EventAction = 'launch' | 'stop' | 'expend' | 'continue' | 'delay';
export type ScriptEvent = { id: string; time: number; action: EventAction; actorId: string; partnerId: string; delaySeconds: number; label: string };
export type Weather = { windSpeed: number; windDirection: number; gusts: number; temperature: number; rain: number; visibility: number };
export type ScenarioDocument = {
  schemaVersion: 1; name: string; description: string; seed: number; duration: number;
  objects: MapObject[]; vehicles: Vehicle[]; events: ScriptEvent[]; weather: Weather;
  referenceMap?: { id: 'fictional-coast-v1'; visible: boolean };
  threat?: ThreatPlan;
  observations: { noise: number; missRate: number; latency: number };
};
export type UnitStatus = 'waiting' | 'rolling' | 'airborne' | 'complete' | 'depleted' | 'stopped' | 'expended' | 'overrun';
/** What a sentry is doing right now. Vehicles without a defence profile stay on 'none'. */
export type UnitTask = 'none' | 'hold' | 'patrol' | 'charge' | 'intercept' | 'return';
export type UnitState = {
  id: string; position: Vec3; velocity: Vec3; airspeed: number; groundSpeed: number;
  energy: number; capacity: number; battery: number; status: UnitStatus; waypoint: number;
  distance: number; departureAt: number;
  task: UnitTask; targetId: string; tracking: string; trackCount: number; kills: number; heading: number;
};
export type LogEntry = { time: number; kind: 'resolved' | 'skipped' | 'flight' | 'warning'; label: string; actorId?: string; eventId?: string };
export type Observation = { observedAt: number; deliveredAt: number; actorId: string; position: Vec3 };
export type Snapshot = { tick: number; time: number; units: UnitState[]; logs: LogEntry[]; observations: Observation[]; observationCount: number; finished: boolean };
export type TelemetryRow = { time: number; id: string; x: number; y: number; z: number; airspeed: number; groundSpeed: number; battery: number; energy: number; status: UnitStatus };
export type ReplayFrame = { tick: number; time: number; units: UnitState[]; observationCount: number };
export type RunRecord = { schemaVersion: 1; simulatorVersion: string; createdAt: string; scenario: ScenarioDocument; frames: ReplayFrame[]; telemetry: TelemetryRow[]; logs: LogEntry[]; observations: Observation[] };
export type WorkerCommand = { type: 'load'; scenario: ScenarioDocument } | { type: 'play' } | { type: 'pause' } | { type: 'step' } | { type: 'speed'; speed: number } | { type: 'record' };
export type WorkerMessage = { type: 'snapshot'; snapshot: Snapshot; playing: boolean } | { type: 'record'; record: RunRecord } | { type: 'error'; message: string };
export const SIMULATOR_VERSION = '1.0.0';
export const STEP = 0.05;
export const isActive = (status: UnitStatus) => status === 'rolling' || status === 'airborne';
export const clone = <Value>(value: Value): Value => structuredClone(value);
