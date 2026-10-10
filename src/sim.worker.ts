import { Simulation } from './simulation';
import { STEP, type WorkerCommand, type WorkerMessage } from './types';
let simulation: Simulation | undefined;
let playing = false;
let speed = 1;
let accumulated = 0;
let previous = performance.now();
let lastPosted = 0;
function send(message: WorkerMessage) { self.postMessage(message); }
function snapshot() { if (simulation) send({ type: 'snapshot', snapshot: simulation.snapshot, playing }); }
self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  try {
    const message = event.data;
    if (message.type === 'load') { simulation = new Simulation(message.scenario); playing = false; accumulated = 0; snapshot(); }
    if (message.type === 'play' && simulation && !simulation.snapshot.finished) { playing = true; previous = performance.now(); snapshot(); }
    if (message.type === 'pause') { playing = false; snapshot(); }
    if (message.type === 'step') { playing = false; simulation?.step(); snapshot(); }
    if (message.type === 'speed') speed = message.speed;
    if (message.type === 'record' && simulation) send({ type: 'record', record: simulation.getRecord() });
  } catch (error) { playing = false; send({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
setInterval(() => {
  const now = performance.now();
  if (playing && simulation) {
    accumulated += Math.min((now - previous) / 1000, 0.25) * speed;
    const ticks = Math.floor(accumulated / STEP);
    if (ticks > 0) { simulation.step(ticks); accumulated -= ticks * STEP; }
    if (simulation.snapshot.finished) playing = false;
    if (now - lastPosted >= 50 || !playing) { snapshot(); lastPosted = now; }
  }
  previous = now;
}, 16);
