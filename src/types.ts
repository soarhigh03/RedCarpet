export type Vec3 = { x: number; y: number; z: number };
export type MapKind = 'runway' | 'taxiway' | 'hangar' | 'building' | 'tower' | 'trees' | 'zone';
export type MapObject = { id: string; label: string; kind: MapKind; position: Vec3; size: Vec3; rotation: number };
export type Role = 'friendly' | 'hostile' | 'aircraft';
export type VehicleKind = 'multirotor' | 'fixed-wing' | 'jet';
export type PowerPoint = { speed: number; watts: number };
export type Vehicle = {
  id: string; label: string; role: Role; kind: VehicleKind; position: Vec3; route: Vec3[];
  departAt: number; speed: number; maxSpeed: number; batteryWh: number; powerCurve: PowerPoint[];
  acceleration: number; takeoffSpeed: number; climbRate: number; runwayLength: number;
};
export type EventAction = 'launch' | 'stop' | 'expend' | 'continue' | 'delay';
export type ScriptEvent = { id: string; time: number; action: EventAction; actorId: string; partnerId: string; delaySeconds: number; label: string };
export type Weather = { windSpeed: number; windDirection: number; gusts: number; temperature: number; rain: number; visibility: number };
export type ScenarioDocument = {
  schemaVersion: 1; name: string; description: string; seed: number; duration: number;
  objects: MapObject[]; vehicles: Vehicle[]; events: ScriptEvent[]; weather: Weather;
  observations: { noise: number; missRate: number; latency: number };
};
export type UnitStatus = 'waiting' | 'rolling' | 'airborne' | 'complete' | 'depleted' | 'stopped' | 'expended' | 'overrun';
export type UnitState = {
  id: string; position: Vec3; velocity: Vec3; airspeed: number; groundSpeed: number;
  energy: number; capacity: number; battery: number; status: UnitStatus; waypoint: number;
  distance: number; departureAt: number;
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
