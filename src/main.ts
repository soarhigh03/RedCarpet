import './style.css';
import './console-theme.css';
import { appearanceFromStorage, type SceneAppearance } from './presentation';
import { mountImageMapEditor } from './image-map-editor';
import { AirfieldScene } from './scene';
import { makeScenario, makeVehicle, presets } from './scenarios';
import { csv, escapeHtml as html, loadRun, saveRun, validateRun, validateScenario } from './data';
import { clone, isActive, SIMULATOR_VERSION, type MapKind, type RunRecord, type ScenarioDocument, type ScriptEvent, type Snapshot, type Vec3, type Vehicle, type WorkerMessage, type WorkerCommand } from './types';

const icons: Record<string, string> = {
  play: '<path d="m8 5 11 7-11 7Z"/>', pause: '<path d="M8 5v14M16 5v14"/>', reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>', step: '<path d="m5 5 10 7-10 7ZM19 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', folder: '<path d="M3 7h7l2-3h8a1 1 0 0 1 1 1v14H3Z"/>', save: '<path d="M4 3h13l4 4v14H3V3ZM7 3v6h10V3M7 21v-8h10v8"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>', redo: '<path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a20 20 0 0 1 0 18 20 20 0 0 1 0-18"/>', map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9ZM2 13l10 6 10-6M2 17l10 6 10-6"/>', chart: '<path d="M3 3v18h18M6 15l4-6 4 3 7-8"/>', settings: '<path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"/>',
  jet: '<path d="m12 2 2 8 7 5v2l-8-2v5l3 2H8l3-2v-5l-8 2v-2l7-5Z"/>', drone: '<path d="m8 8 8 8m0-8-8 8M9 9h6v6H9Z"/><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/>',
  building: '<path d="M4 21V8l8-5 8 5v13ZM9 21v-7h6v7M8 9h1M15 9h1"/>', wind: '<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 17h5a2 2 0 1 1-2 2"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', cross: '<path d="M6 6l12 12M6 18 18 6"/>', edit: '<path d="m4 16 12-12 4 4L8 20H4ZM14 6l4 4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>', chevron: '<path d="m9 5 7 7-7 7"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>', replay: '<path d="M3 9a9 9 0 1 1 0 6M3 3v6h6m1-1 6 4-6 4Z"/>', bolt: '<path d="m13 2-8 12h7l-1 8 8-13h-7Z"/>',
};
const icon = (name: string, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.info}</svg>`;
const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const roleName = (role: string) => ({ friendly: 'Friendly', hostile: 'Intruder', aircraft: 'Aircraft' }[role] ?? role);
const isShahedVisual = (vehicle: Vehicle) => vehicle.role === 'hostile' && vehicle.kind === 'fixed-wing';
const actionName = (action: string) => ({ stop: 'Intruder stopped', expend: 'Defender expended', continue: 'Intruder continues', launch: 'Launch vehicle', delay: 'Delay departure' }[action] ?? action);
const $ = <ElementType extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<ElementType>(selector)!;
let scenario = makeScenario();
let storageWarning = '';
let appearance: SceneAppearance = 'holographic';
try { appearance = appearanceFromStorage(localStorage.getItem('airfield.appearance.v1')); } catch {}
document.documentElement.dataset.appearance = appearance;
try { const saved = localStorage.getItem('airfield.scenario.v1'); if (saved) scenario = validateScenario(JSON.parse(saved)); } catch { storageWarning = 'The previous local project could not be loaded. A demo is ready.'; }
let selected = scenario.vehicles[0].id;
let sceneTab = 'vehicles'; let search = ''; let panel = 'workspace'; let logTab = 'script';
let playing = false; let playbackSpeed = 1; let snapshot: Snapshot | undefined; let lastRun: RunRecord | undefined;
let replayRecord: RunRecord | undefined; let replayTime = 0; let replayPlaying = false; let lastReplayTick = performance.now();
let routeEditing = false; let recordIntent: 'save' | 'replay' | 'json' | 'csv' | undefined;
let undoStack: ScenarioDocument[] = []; let redoStack: ScenarioDocument[] = [];
let liveHistory: { time: number; battery: number; speed: number; altitude: number }[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let world: AirfieldScene;
const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
const send = (command: WorkerCommand) => worker.postMessage(command);

$('#app').innerHTML = `
  <header class="app-header">
    <a class="brand" href="#" aria-label="Project RedCarpet home"><span class="brand-mark"><i></i><i></i><i></i></span><span>Project RedCarpet<small>SIMULATION ENVIRONMENT</small></span></a>
    <nav class="main-nav" aria-label="Main navigation"><button class="active" data-action="panel" data-value="workspace">${icon('map')} Workspace</button><button data-action="panel" data-value="analysis">${icon('chart')} Analysis</button><a href="./lab-report.html" target="_blank" rel="noopener">${icon('layers')} Hardware lab <span class="external">↗</span></a></nav>
    <div class="header-end"><span class="version-tag">FICTIONAL SIMULATION</span><button class="icon-button header-help" data-action="help" aria-label="Help">${icon('info')}</button><span class="system-indicator"><i></i> LOCAL ENGINE</span></div>
  </header>
  <section class="project-bar"><div class="project-heading"><span class="project-icon">${icon('folder', 21)}</span><div><div class="eyebrow">WORKSPACE / SCENARIO EDITOR</div><button class="project-name" data-action="settings"><span id="project-name"></span>${icon('edit', 13)}</button></div><span class="saved-badge" id="save-status">Saved locally</span></div><div class="project-actions"><button class="button quiet" data-action="image-map">${icon('map')} Image to 3D</button><button class="button quiet" data-action="library">${icon('folder')} Scenarios</button><button class="button quiet" data-action="import">${icon('download')} Import</button><button class="button quiet" data-action="export">${icon('download')} Export</button><button class="button primary" data-action="save">${icon('save')} Save project</button></div></section>
  <main class="workspace">
    <aside class="sidebar"><div class="sidebar-heading"><h2>SCENE ENTITIES</h2><button class="icon-button" data-action="add" aria-label="Add scene entity">${icon('plus')}</button></div><div class="segmented scene-tabs"><button class="active" data-action="scene-tab" data-value="vehicles">Vehicles <span id="vehicle-count"></span></button><button data-action="scene-tab" data-value="objects">Objects <span id="object-count"></span></button></div><div class="search-wrap"><input id="scene-search" aria-label="Search scene" placeholder="Find in scene…"><span>⌕</span></div><div id="scene-list" class="scene-list"></div><div class="sidebar-bottom"><button class="add-entity" data-action="add">${icon('plus')} Add to scene</button><div class="scenario-note">${icon('info', 15)}<p>Authored encounters.<br>Educational flight models.</p></div><button class="weather-summary" data-action="weather"><span class="weather-symbol">${icon('sun', 25)}</span><span><b id="weather-title">Clear conditions</b><small id="weather-line"></small></span>${icon('chevron', 15)}</button></div></aside>
    <section class="center-column">
      <div class="viewport-wrap"><div id="viewport" class="viewport"></div><div class="viewport-toolbar"><div class="view-switch"><button class="active" data-action="camera" data-value="orbit">${icon('globe', 15)} 3D view</button><button data-action="camera" data-value="overhead">${icon('map', 15)} Top view</button><button data-action="camera" data-value="follow">${icon('eye', 15)} Follow</button></div><div class="view-tools"><button class="icon-button" data-action="reference-map" id="reference-map-toggle" aria-label="Toggle reference image" title="Toggle reference image" hidden>${icon('map', 16)}</button><button class="icon-button" data-action="undo" id="undo" aria-label="Undo edit">${icon('undo', 16)}</button><button class="icon-button" data-action="redo" id="redo" aria-label="Redo edit">${icon('redo', 16)}</button><span></span><button class="icon-button active" data-action="routes" aria-label="Toggle route lines">${icon('layers', 16)}</button><button class="icon-button active" data-action="labels" aria-label="Toggle vehicle labels">${icon('eye', 16)}</button></div></div>
      <div class="render-switch" role="group" aria-label="Scene appearance"><span>RENDER MODE</span><button data-action="appearance" data-value="realistic" aria-pressed="false">${icon('globe', 14)} Realistic</button><button data-action="appearance" data-value="holographic" aria-pressed="false">${icon('layers', 14)} Holographic</button></div><div class="viewport-corners" aria-hidden="true"></div><div class="scene-caption"><span class="tiny-label">NORTHSTAR TEST RANGE</span><h1>Every scenario starts here.</h1><p id="scene-description"></p></div>
      <div class="viewport-status"><span class="status-pill" id="run-status"><i></i> READY</span><span class="seed-tag" id="seed-label"></span></div><span id="asset-status" class="asset-status" role="status" data-state="loading">Loading scenery…</span>
      <div class="compass"><span>N</span><svg viewBox="0 0 40 40"><path d="m20 5 6 25-6-5-6 5Z" fill="#40575c"/><path d="m20 5 0 20-6 5Z" fill="#91a59c"/></svg></div>
      <div class="viewport-footer"><span class="map-scale"><i></i> 500 m reference</span><span id="view-hint">Drag to orbit · Scroll to zoom · Click to inspect</span><span id="fps">— FPS</span></div>
      <div class="scene-key"><span><i class="friendly-dot"></i> Friendly</span><span><i class="hostile-dot"></i> Intruder</span><span><i class="aircraft-dot"></i> Aircraft</span></div>
      <div id="analytics" class="analytics-view" hidden></div></div>
      <section class="timeline"><div class="transport"><div class="transport-buttons"><button class="play-button" data-action="play" id="play" aria-label="Play simulation">${icon('play', 18)}</button><button class="icon-button" data-action="step" aria-label="Advance one simulation step">${icon('step', 18)}</button><button class="icon-button" data-action="reset" aria-label="Reset simulation">${icon('reset', 17)}</button><div class="transport-time"><b id="current-time">00:00</b><span>/ <span id="duration">03:00</span></span></div></div><div class="playback-actions"><button class="text-button" data-action="replay">${icon('replay', 15)} Replay</button><label class="speed-label">Speed<select id="speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label></div></div>
      <div class="scrubber"><input id="scrub" type="range" min="0" max="180" value="0" step="0.05" aria-label="Replay timeline" disabled><div class="time-ruler" id="time-ruler"></div><div class="event-markers" id="event-markers"></div></div>
      <div class="timeline-heading"><div class="timeline-tabs"><button class="active" data-action="log-tab" data-value="script">Scripted events <span id="event-count"></span></button><button data-action="log-tab" data-value="log">Flight log <span id="log-count">0</span></button></div><button class="text-button" data-action="event-add">${icon('plus', 14)} Add event</button></div><div id="event-list" class="event-list"></div></section>
    </section>
    <aside class="inspector"><div class="inspector-heading"><span>ENTITY INSPECTOR</span>${icon('settings', 16)}</div><div id="inspector-content"></div></aside>
  </main>
  <footer class="app-footer"><span><i class="connection-dot"></i> Local simulation <span class="footer-divider">/</span> <span id="entity-summary"></span></span><span>Scenario seed <b id="footer-seed"></b><span class="footer-divider">/</span> v${SIMULATOR_VERSION}</span></footer>
  <dialog id="dialog"><div id="dialog-content"></div></dialog><div class="toast" id="toast" role="status" aria-live="polite"></div><input type="file" id="file-input" accept="application/json,.json" hidden>
`;

function toast(message: string) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
function persist() { try { localStorage.setItem('airfield.scenario.v1', JSON.stringify(scenario)); $('#save-status').textContent = 'Saved locally'; } catch { $('#save-status').textContent = 'Export to save'; toast('Browser storage is unavailable or full. Export your scenario to keep a copy.'); } }
function resetRun() { replayRecord = undefined; replayPlaying = false; playing = false; liveHistory = []; send({ type: 'load', scenario }); world?.setRunning(false); $('#scrub').removeAttribute('style'); ($('#scrub') as HTMLInputElement).disabled = true; ($('#scrub') as HTMLInputElement).max = String(scenario.duration); }
function commit(change: (draft: ScenarioDocument) => void, message = 'Scenario updated. Run reset.') {
  try {
    const draft = clone(scenario); change(draft); validateScenario(draft); undoStack.push(clone(scenario)); if (undoStack.length > 40) undoStack.shift(); redoStack = []; scenario = draft;
    if (!scenario.vehicles.some(vehicle => vehicle.id === selected) && !scenario.objects.some(object => object.id === selected)) selected = scenario.vehicles[0].id;
    resetRun(); world?.setScenario(scenario); renderProject(); persist(); if (message) toast(message);
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); throw error; }
}
function choose(id: string) { if (routeEditing && id !== selected) { routeEditing = false; world?.routeMode(false); } selected = id; liveHistory = []; world?.select(id); renderList(); renderInspector(); renderAnalytics(); }
function renderAppearance() {
  document.documentElement.dataset.appearance = appearance;
  document.querySelectorAll<HTMLElement>('[data-action="appearance"]').forEach(button => { const active = button.dataset.value === appearance; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('#reference-map-toggle').title = appearance === 'holographic' ? 'Reference image is displayed in Realistic mode' : 'Toggle reference image';
}
function renderProject() {
  renderAppearance();
  $('#reference-map-toggle').hidden = !scenario.referenceMap;
  $('#reference-map-toggle').classList.toggle('active', Boolean(scenario.referenceMap?.visible));
  $('#reference-map-toggle').setAttribute('aria-pressed', String(Boolean(scenario.referenceMap?.visible)));
  $('.scene-caption .tiny-label').textContent = scenario.referenceMap ? 'FICTIONAL COAST · IMAGE STUDY' : 'NORTHSTAR TEST RANGE';
  $('.scene-caption h1').textContent = scenario.referenceMap ? 'COASTAL ENVIRONMENT' : 'AIRFIELD SIMULATION';
  $('#project-name').textContent = scenario.name; $('#scene-description').textContent = scenario.description;
  $('#vehicle-count').textContent = String(scenario.vehicles.length); $('#object-count').textContent = String(scenario.objects.length);
  $('#duration').textContent = time(scenario.duration); ($('#scrub') as HTMLInputElement).max = String(scenario.duration);
  $('#time-ruler').innerHTML = Array.from({ length: 7 }, (_, index) => `<span>${time(index * scenario.duration / 6)}</span>`).join('');
  $('#event-markers').innerHTML = scenario.events.map(event => `<button style="left:${event.time / scenario.duration * 100}%" data-action="event-edit" data-id="${html(event.id)}" title="${html(event.label)} · ${time(event.time)}" aria-label="Edit ${html(event.label)}"></button>`).join('');
  $('#seed-label').textContent = `SEED ${scenario.seed}`; $('#footer-seed').textContent = String(scenario.seed);
  $('#entity-summary').textContent = `${scenario.vehicles.length} vehicles · ${scenario.objects.length} objects`;
  $('#weather-title').textContent = scenario.weather.rain > 0.2 ? 'Rain & low visibility' : scenario.weather.windSpeed > 8 ? 'Windy conditions' : 'Clear conditions';
  $('#weather-line').textContent = `${scenario.weather.temperature}°C · Wind ${scenario.weather.windSpeed} m/s`;
  ($('#undo') as HTMLButtonElement).disabled = !undoStack.length; ($('#redo') as HTMLButtonElement).disabled = !redoStack.length;
  renderList(); renderInspector(); renderEvents(); renderAnalytics();
}
function renderList() {
  document.querySelectorAll('[data-action="scene-tab"]').forEach(button => button.classList.toggle('active', (button as HTMLElement).dataset.value === sceneTab));
  if (sceneTab === 'vehicles') {
    $('#scene-list').innerHTML = (['aircraft', 'friendly', 'hostile'] as const).map(role => {
      const entities = scenario.vehicles.filter(vehicle => vehicle.role === role && vehicle.label.toLowerCase().includes(search));
      return `<div class="list-group-title">${roleName(role)} <span>${entities.length}</span></div>${entities.map(vehicle => `<button class="entity-item ${selected === vehicle.id ? 'selected' : ''}" data-action="select" data-id="${html(vehicle.id)}"><span class="entity-icon ${vehicle.role}">${icon(vehicle.kind === 'jet' ? 'jet' : 'drone', 20)}</span><span class="entity-text"><b>${html(vehicle.label)}</b><small>${vehicle.kind === 'jet' ? 'Military jet · Conventional' : isShahedVisual(vehicle) ? 'Shahed-style · Fixed-wing' : vehicle.kind === 'multirotor' ? 'Multirotor · Electric' : 'Fixed-wing · Electric'}</small></span><i class="entity-status" data-unit-status="${html(vehicle.id)}"></i></button>`).join('')}`;
    }).join('');
  } else {
    $('#scene-list').innerHTML = `<div class="list-group-title">Airfield objects <span>${scenario.objects.length}</span></div>` + scenario.objects.filter(object => object.label.toLowerCase().includes(search)).map(object => `<button class="entity-item ${selected === object.id ? 'selected' : ''}" data-action="select" data-id="${html(object.id)}"><span class="entity-icon object">${icon(object.kind === 'runway' || object.kind === 'taxiway' ? 'map' : 'building', 20)}</span><span class="entity-text"><b>${html(object.label)}</b><small>${html(object.kind)} · ${Math.round(object.size.x)} × ${Math.round(object.size.z)} m</small></span></button>`).join('');
  }
}
const field = (label: string, name: string, value: string | number, type = 'number', extra = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${html(value)}" ${type === 'number' ? 'step="any"' : ''} ${extra}></label>`;
const selectField = (label: string, name: string, value: string, choices: [string, string][]) => `<label class="field"><span>${label}</span><select name="${name}" aria-label="${label}">${choices.map(([key, text]) => `<option value="${html(key)}" ${key === value ? 'selected' : ''}>${html(text)}</option>`).join('')}</select></label>`;
function renderInspector() {
  const vehicle = scenario.vehicles.find(item => item.id === selected); const object = scenario.objects.find(item => item.id === selected);
  if (!vehicle && !object) { $('#inspector-content').innerHTML = '<div class="empty-state">Select an object to inspect it.</div>'; return; }
  const item = (vehicle ?? object)!;
  $('#inspector-content').innerHTML = `<div class="inspector-identity"><div class="large-entity-icon ${vehicle?.role ?? 'object'}">${icon(vehicle ? vehicle.kind === 'jet' ? 'jet' : 'drone' : 'building', 26)}</div><h2>${html(item.label)}</h2><span class="type-badge ${vehicle?.role ?? ''}">${vehicle ? roleName(vehicle.role) : html(object!.kind)}</span><p>${vehicle?.kind === 'jet' ? 'Military jet / Fictional flight profile' : vehicle ? isShahedVisual(vehicle) ? 'Shahed-style model / Fictional profile' : `${vehicle.kind} / Fictional profile` : 'Editable airfield geometry'}</p></div>
    ${vehicle ? `<div class="live-metrics"><div><span>GROUND SPEED</span><b id="metric-speed">0<small> m/s</small></b></div><div><span>ALTITUDE</span><b id="metric-altitude">${vehicle.position.y}<small> m</small></b></div><div class="battery-metric"><span>ENERGY REMAINING <b id="metric-battery">100%</b></span><div class="battery-track"><i id="battery-fill"></i></div><small id="metric-status">Waiting for departure</small></div></div>` : ''}
    <form id="entity-form" class="inspector-form"><details open><summary>Properties</summary>${field('Label', 'label', item.label, 'text', 'maxlength="160" required')}
    ${vehicle ? selectField('Role', 'role', vehicle.role, [['friendly', 'Friendly defender'], ['hostile', 'Hostile intruder'], ['aircraft', 'Aircraft']]) + (vehicle.kind !== 'jet' ? selectField('Airframe', 'kind', vehicle.kind, [['multirotor', 'Multirotor'], ['fixed-wing', 'Fixed-wing']]) : '') : ''}
    <div class="form-grid three">${field('X · m', 'x', item.position.x)}${field('Altitude · m', 'y', item.position.y)}${field('Z · m', 'z', item.position.z)}</div>
    ${object ? `<div class="form-grid three">${field('Width · m', 'width', object.size.x)}${field('Height · m', 'height', object.size.y)}${field('Depth · m', 'depth', object.size.z)}</div>${field('Rotation · degrees', 'rotation', object.rotation)}` : ''}</details>
    ${vehicle ? `<details open><summary>Flight profile</summary><div class="form-grid">${field('Departure · s', 'departAt', vehicle.departAt)}${field('Cruise · m/s', 'speed', vehicle.speed)}${field('Limit · m/s', 'maxSpeed', vehicle.maxSpeed)}${field('Climb · m/s', 'climbRate', vehicle.climbRate)}</div>${vehicle.kind === 'jet' ? `<div class="form-grid">${field('Accel. · m/s²', 'acceleration', vehicle.acceleration)}${field('Takeoff · m/s', 'takeoffSpeed', vehicle.takeoffSpeed)}</div>${field('Usable runway · m', 'runwayLength', vehicle.runwayLength)}` : ''}</details><details><summary>Energy model</summary>${field('Energy capacity · Wh', 'batteryWh', vehicle.batteryWh)}<label class="field"><span>Power curve · speed:watts</span><input name="powerCurve" value="${vehicle.powerCurve.map(point => `${point.speed}:${point.watts}`).join(', ')}" required></label><p class="field-help">Interpolated power in watts at each airspeed in m/s. Cold weather reduces available capacity.</p></details><details><summary>Route · ${vehicle.route.length} waypoints</summary><label class="field"><span>One waypoint per line: X, altitude, Z (m)</span><textarea name="route" rows="5" required>${vehicle.route.map(point => `${point.x}, ${point.y}, ${point.z}`).join('\n')}</textarea></label><button class="button route-button ${routeEditing ? 'active' : ''}" type="button" data-action="route-edit">${icon('map', 15)} ${routeEditing ? 'Finish placing waypoints' : 'Add waypoints on map'}</button><p class="field-help">Map clicks append waypoints at 150 m. Edit coordinates here for other altitudes.</p></details>` : ''}
    <div class="inspector-actions"><button class="button primary" type="submit">Apply changes</button><button class="icon-button danger" type="button" data-action="delete" aria-label="Delete selected entity">${icon('trash', 17)}</button></div><p class="edit-note">Edits reset the current run.</p></form>`;
  $('#entity-form').addEventListener('submit', event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement); const number = (key: string) => Number(form.get(key));
    try { commit(draft => {
      const entity = [...draft.vehicles, ...draft.objects].find(item => item.id === selected)!; entity.label = String(form.get('label')); entity.position = { x: number('x'), y: number('y'), z: number('z') };
      if (vehicle) {
        const target = entity as Vehicle; const newRole = String(form.get('role')) as Vehicle['role']; target.role = newRole;
        target.kind = newRole === 'aircraft' ? 'jet' : String(form.get('kind') ?? 'multirotor') as Vehicle['kind'];
        for (const key of ['departAt', 'speed', 'maxSpeed', 'climbRate', 'batteryWh'] as const) target[key] = number(key);
        if (form.has('acceleration')) for (const key of ['acceleration', 'takeoffSpeed', 'runwayLength'] as const) target[key] = number(key);
        target.powerCurve = String(form.get('powerCurve')).split(',').map(pair => { const parts = pair.trim().split(':').map(Number); return { speed: parts[0], watts: parts[1] }; });
        target.route = String(form.get('route')).trim().split('\n').map(line => { const parts = line.split(',').map(Number); if (parts.length !== 3) throw new Error('Each waypoint needs X, altitude, Z.'); return { x: parts[0], y: parts[1], z: parts[2] }; });
      } else { const target = draft.objects.find(item => item.id === selected)!; target.size = { x: number('width'), y: number('height'), z: number('depth') }; target.rotation = number('rotation'); }
    }); } catch {}
  });
  if (routeEditing) $('#inspector-content').querySelectorAll('details').forEach(detail => { if (detail.querySelector('textarea[name="route"]')) detail.open = true; });
  if (snapshot) updateMetrics(snapshot);
}
function renderEvents() {
  $('#event-count').textContent = String(scenario.events.length); $('#log-count').textContent = String(snapshot?.logs.length ?? 0);
  document.querySelectorAll('[data-action="log-tab"]').forEach(button => button.classList.toggle('active', (button as HTMLElement).dataset.value === logTab));
  if (logTab === 'log') {
    $('#event-list').innerHTML = snapshot?.logs.length ? [...snapshot.logs].reverse().map(entry => `<div class="log-row ${entry.kind}"><time>${time(entry.time)}</time><i></i><span>${html(entry.label)}</span><small>${entry.kind}</small></div>`).join('') : '<div class="timeline-empty">Your flight log will appear when the simulation starts.</div>'; return;
  }
  $('#event-list').innerHTML = scenario.events.length ? [...scenario.events].sort((first, second) => first.time - second.time).map(event => {
    const result = snapshot?.logs.find(entry => entry.eventId === event.id); const vehicle = scenario.vehicles.find(item => item.id === event.actorId);
    return `<button class="event-row ${result?.kind ?? ''}" data-action="event-edit" data-id="${html(event.id)}"><time>${time(event.time)}</time><span class="event-dot ${event.action}"></span><span class="event-row-title">${html(event.label)}<small>${html(vehicle?.label ?? 'Missing participant')} · ${actionName(event.action)}</small></span><span class="event-state">${result?.kind ?? 'Scheduled'}</span>${icon('edit', 13)}</button>`;
  }).join('') : '<div class="timeline-empty">Add an event to author your first encounter.</div>';
}
function updateMetrics(state: Snapshot) {
  const unit = state.units.find(item => item.id === selected);
  if ($('#metric-speed') && unit) {
    $('#metric-speed').innerHTML = `${unit.groundSpeed.toFixed(1)}<small> m/s</small>`; $('#metric-altitude').innerHTML = `${Math.round(unit.position.y)}<small> m</small>`;
    $('#metric-battery').textContent = `${unit.battery.toFixed(0)}%`; $('#battery-fill').style.width = `${unit.battery}%`; $('#battery-fill').classList.toggle('low', unit.battery < 20);
    $('#metric-status').textContent = `${unit.status.toUpperCase()} · ${unit.airspeed.toFixed(1)} m/s airspeed`;
  }
  document.querySelectorAll<HTMLElement>('[data-unit-status]').forEach(element => { const status = state.units.find(unit => unit.id === element.dataset.unitStatus)?.status; element.classList.toggle('active', Boolean(status && isActive(status))); });
}
function updateSnapshot(state: Snapshot, isPlaying: boolean) {
  const previousLogCount = snapshot?.logs.length; snapshot = state; playing = isPlaying; world?.update(state); world?.setRunning(isPlaying || Boolean(replayRecord));
  $('#current-time').textContent = time(state.time); ($('#scrub') as HTMLInputElement).value = String(state.time); $('#scrub').style.setProperty('--progress', `${state.time / scenario.duration * 100}%`);
  const active = replayRecord ? replayPlaying : playing; $('#play').innerHTML = icon(active ? 'pause' : 'play', 18); $('#play').setAttribute('aria-label', active ? 'Pause simulation' : 'Play simulation');
  $('#run-status').innerHTML = `<i></i> ${replayRecord ? 'REPLAY' : state.finished ? 'COMPLETE' : playing ? 'RUNNING' : state.time > 0 ? 'PAUSED' : 'READY'}`; $('#run-status').classList.toggle('running', active);
  $('.scene-caption').classList.toggle('minimized', state.time > 0);
  const unit = state.units.find(item => item.id === selected);
  if (unit && (!liveHistory.length || state.time - liveHistory[liveHistory.length - 1].time >= 0.95)) liveHistory.push({ time: state.time, battery: unit.battery, speed: unit.groundSpeed, altitude: unit.position.y });
  updateMetrics(state); if (previousLogCount !== state.logs.length || state.time === 0) renderEvents(); if (panel === 'analysis') renderAnalytics();
}
function chart(values: number[], color: string, maximum: number) { const points = values.length ? values.map((value, index) => `${index / Math.max(1, values.length - 1) * 500},${95 - value / Math.max(1, maximum) * 85}`).join(' ') : '0,95 500,95'; return `<svg class="chart-svg" viewBox="0 0 500 110" preserveAspectRatio="none" aria-label="Time series chart"><path d="M0 10H500M0 52H500M0 95H500" stroke="#1b3349" fill="none"/><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>`; }
function renderAnalytics() {
  if (panel !== 'analysis') return;
  const unit = snapshot?.units.find(item => item.id === selected); const name = scenario.vehicles.find(item => item.id === selected)?.label ?? 'Select a vehicle';
  const history = replayRecord ? replayRecord.telemetry.filter(row => row.id === selected && row.time <= replayTime).map(row => ({ time: row.time, battery: row.battery, speed: row.groundSpeed, altitude: row.y })) : liveHistory;
  $('#analytics').innerHTML = `<div class="analysis-heading"><div class="eyebrow">FLIGHT ANALYSIS</div><h1>The story behind the scenario.</h1><p>Inspect motion, energy, and authored outcomes as your run unfolds.</p></div><div class="stat-grid"><div><span>ACTIVE VEHICLES</span><strong>${snapshot?.units.filter(unit => isActive(unit.status)).length ?? 0}<small> / ${scenario.vehicles.length}</small></strong></div><div><span>OBSERVATIONS</span><strong>${snapshot?.observationCount ?? 0}</strong></div><div><span>RESOLVED EVENTS</span><strong>${snapshot?.logs.filter(entry => entry.kind === 'resolved').length ?? 0}<small> / ${scenario.events.length}</small></strong></div><div><span>SKIPPED EVENTS</span><strong>${snapshot?.logs.filter(entry => entry.kind === 'skipped').length ?? 0}</strong></div></div><div class="analysis-subhead"><h3>${html(name)}</h3><button class="text-button" data-action="csv">${icon('download', 15)} Export telemetry</button></div><div class="chart-card"><div><span>Remaining energy</span><b>${unit?.battery.toFixed(1) ?? '100'}<small>%</small></b></div>${chart(history.map(row => row.battery), '#42c8ff', 100)}<footer><span>00:00</span><span>Simulation time · ${time(snapshot?.time ?? 0)}</span></footer></div><div class="chart-card"><div><span>Ground speed</span><b>${unit?.groundSpeed.toFixed(1) ?? '0'}<small> m/s</small></b></div>${chart(history.map(row => row.speed), '#929dff', Math.max(50, ...history.map(row => row.speed)))}<footer><span>00:00</span><span>Simulation time · ${time(snapshot?.time ?? 0)}</span></footer></div><p class="analysis-footnote">Synthetic observations · ${scenario.observations.noise} m noise · ${(scenario.observations.missRate * 100).toFixed(0)}% base miss rate · ${scenario.observations.latency} s delay</p>`;
}

function modal(title: string, subtitle: string, content: string, wide = false) {
  const dialog = $('#dialog') as HTMLDialogElement; dialog.classList.toggle('wide', wide); dialog.classList.remove('image-map-dialog');
  $('#dialog-content').innerHTML = `<div class="dialog-heading"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="icon-button" data-action="close" aria-label="Close dialog">${icon('cross')}</button></div>${content}`;
  if (!dialog.open) dialog.showModal();
}
const close = () => ($('#dialog') as HTMLDialogElement).close();
function formFooter(label = 'Apply changes') { return `<p class="form-error" id="form-error" role="alert"></p><div class="dialog-footer"><button type="button" class="button quiet" data-action="close">Cancel</button><button class="button primary" type="submit">${label}</button></div>`; }
function formError(error: unknown) { $('#form-error').textContent = error instanceof Error ? error.message : String(error); }
function settingsDialog(weatherOnly = false) {
  const weather = scenario.weather;
  modal(weatherOnly ? 'Weather & observations' : 'Scenario settings', 'All environmental effects are adjustable educational approximations.', `<form id="settings-form" class="dialog-form">${weatherOnly ? '' : `${field('Project name', 'name', scenario.name, 'text', 'required maxlength="100"')}<label class="field"><span>Description</span><textarea name="description" rows="2" maxlength="600">${html(scenario.description)}</textarea></label><div class="form-grid">${field('Duration · seconds', 'duration', scenario.duration)}${field('Random seed', 'seed', scenario.seed)}</div>`}<h3>Weather</h3><div class="form-grid">${field('Wind speed · m/s', 'windSpeed', weather.windSpeed)}${field('Wind heading · degrees', 'windDirection', weather.windDirection)}${field('Gust amplitude · m/s', 'gusts', weather.gusts)}${field('Temperature · °C', 'temperature', weather.temperature)}${field('Rain intensity · 0–1', 'rain', weather.rain)}${field('Visibility · metres', 'visibility', weather.visibility)}</div><p class="field-help">Heading is the direction the wind travels toward, clockwise from north.</p><h3>Synthetic observations</h3><div class="form-grid three">${field('Noise · m', 'noise', scenario.observations.noise)}${field('Miss rate · 0–1', 'missRate', scenario.observations.missRate)}${field('Latency · s', 'latency', scenario.observations.latency)}</div>${formFooter()}</form>`);
  $('#settings-form').onsubmit = event => { event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement); try { commit(draft => { if (!weatherOnly) { draft.name = String(form.get('name')); draft.description = String(form.get('description')); draft.duration = Number(form.get('duration')); draft.seed = Number(form.get('seed')); } for (const key of ['windSpeed', 'windDirection', 'gusts', 'temperature', 'rain', 'visibility'] as const) draft.weather[key] = Number(form.get(key)); for (const key of ['noise', 'missRate', 'latency'] as const) draft.observations[key] = Number(form.get(key)); }); close(); } catch (error) { formError(error); } };
}
function eventDialog(id?: string) {
  const existing = scenario.events.find(event => event.id === id);
  const event: ScriptEvent = existing ?? { id: crypto.randomUUID(), time: Math.min(30, scenario.duration), action: 'stop', actorId: scenario.vehicles.find(vehicle => vehicle.role === 'hostile')?.id ?? scenario.vehicles[0].id, partnerId: '', delaySeconds: 10, label: 'New scripted encounter' };
  const actors = scenario.vehicles.map(vehicle => [vehicle.id, `${vehicle.label} · ${roleName(vehicle.role)}`] as [string, string]);
  if (!actors.some(([key]) => key === event.actorId)) actors.push([event.actorId, 'Missing participant']);
  modal(existing ? 'Edit scripted event' : 'Author an encounter', 'You choose when the event happens and what its outcome is.', `<form id="event-form" class="dialog-form">${field('Event label', 'label', event.label, 'text', 'required maxlength="160"')}<div class="form-grid">${field('Event time · seconds', 'time', event.time)}${selectField('Outcome / action', 'action', event.action, ['stop', 'expend', 'continue', 'launch', 'delay'].map(action => [action, actionName(action)]))}</div>${selectField('Participant', 'actorId', event.actorId, actors)}${selectField('Supporting participant', 'partnerId', event.partnerId, [['', 'None required'], ...actors])}${field('Additional delay · seconds (delay only)', 'delaySeconds', event.delaySeconds)}<div class="dialog-note">${icon('info', 17)}<p>Encounters are authored game events. Active participants are required for outcomes; launch and delay events require a waiting vehicle.</p></div>${existing ? `<button class="text-button danger" type="button" data-action="event-delete" data-id="${html(existing.id)}">${icon('trash', 14)} Delete event</button>` : ''}${formFooter(existing ? 'Save event' : 'Add event')}</form>`);
  $('#event-form').onsubmit = submit => { submit.preventDefault(); const form = new FormData(submit.currentTarget as HTMLFormElement); try { commit(draft => { const next: ScriptEvent = { id: event.id, label: String(form.get('label')), time: Number(form.get('time')), action: String(form.get('action')) as ScriptEvent['action'], actorId: String(form.get('actorId')), partnerId: String(form.get('partnerId')), delaySeconds: Number(form.get('delaySeconds')) }; const index = draft.events.findIndex(item => item.id === next.id); if (index >= 0) draft.events[index] = next; else draft.events.push(next); }); close(); } catch (error) { formError(error); } };
}
function imageMapDialog() {
  modal('Image to 3D', 'Outline an invented landscape. Give it shape.', '<div id="image-map-editor"></div>', true);
  $('#dialog').classList.add('image-map-dialog');
  mountImageMapEditor($('#image-map-editor'), scenario, next => {
    commit(draft => Object.assign(draft, next), 'Image map applied. Edit objects in the inspector or reopen Image to 3D.');
    sceneTab = 'objects'; choose(scenario.objects.find(object => object.kind === 'hangar')?.id ?? scenario.objects[0].id);
    world?.setCamera('orbit'); document.querySelectorAll('[data-action="camera"]').forEach(item => item.classList.toggle('active', (item as HTMLElement).dataset.value === 'orbit'));
    close();
  });
}
function libraryDialog() {
  modal('Scenario library', 'Start from an authored example, then make it your own.', `<div class="preset-grid">${presets.map(([id, title, description], index) => `<button class="preset-card preset-${id}" data-action="preset" data-value="${id}"><div class="preset-art"><i></i><span>${String(index + 1).padStart(2, '0')}</span>${icon(index === 3 ? 'wind' : index === 2 ? 'bolt' : index === 4 ? 'layers' : 'map', 36)}</div><h3>${title}</h3><p>${description}</p><span class="preset-open">Open scenario ${icon('arrow', 15)}</span></button>`).join('')}<button class="preset-card recorded" data-action="load-record"><div class="preset-art">${icon('replay', 36)}</div><h3>Last saved run</h3><p>Replay the latest recorded session</p><span class="preset-open">Load recording ${icon('arrow', 15)}</span></button></div><p class="library-note">Your current scenario is saved locally. Switching examples can be undone.</p>`, true);
}
function addDialog() {
  modal('Add to your airfield', 'Choose a vehicle or a piece of the scene.', `<div class="add-options"><h3>Vehicles</h3>${(['friendly', 'hostile', 'aircraft'] as const).map(role => `<button data-action="add-vehicle" data-value="${role}"><span class="entity-icon ${role}">${icon(role === 'aircraft' ? 'jet' : 'drone', 24)}</span><span><b>${role === 'friendly' ? 'Friendly defender' : role === 'hostile' ? 'Hostile intruder' : 'Aircraft'}</b><small>${role === 'aircraft' ? 'Conventional takeoff profile' : 'Editable route & energy profile'}</small></span>${icon('plus', 16)}</button>`).join('')}<h3>Airfield objects</h3><div class="object-options">${(['hangar', 'building', 'tower', 'runway', 'taxiway', 'trees', 'zone'] as const).map(kind => `<button data-action="add-object" data-value="${kind}">${icon(kind === 'runway' || kind === 'taxiway' ? 'map' : 'building', 17)} ${kind}</button>`).join('')}</div></div>`);
}
function exportDialog() { modal('Export your work', 'Keep a portable copy of a scenario or a recorded run.', `<div class="export-options"><button data-action="scenario-json">${icon('map', 24)}<span><b>Scenario document</b><small>Editable map, profiles, weather, and event script · JSON</small></span>${icon('download')}</button><button data-action="run-json">${icon('replay', 24)}<span><b>Recorded run</b><small>Scenario, replay frames, observations, and event history · JSON</small></span>${icon('download')}</button><button data-action="csv">${icon('chart', 24)}<span><b>Flight telemetry</b><small>Time, position, speed, energy, and status for every vehicle · CSV</small></span>${icon('download')}</button></div>`); }
function download(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast(`${name} downloaded`); }
function capture(intent: NonNullable<typeof recordIntent>) { if (replayRecord) handleRecord(replayRecord, intent); else { recordIntent = intent; send({ type: 'record' }); } }
function handleRecord(record: RunRecord, intent: NonNullable<typeof recordIntent>) {
  lastRun = record;
  if (intent === 'save') saveRun(record).then(() => toast('Project and current run saved on this browser.')).catch(() => toast('Scenario saved. Run storage is full; export the recording instead.'));
  if (intent === 'replay') startReplay(record);
  if (intent === 'json') download('airfield-run.json', JSON.stringify(record), 'application/json');
  if (intent === 'csv') download('airfield-telemetry.csv', csv(record), 'text/csv;charset=utf-8');
}
function startReplay(record: RunRecord) {
  send({ type: 'pause' }); replayRecord = record; replayTime = 0; replayPlaying = false; liveHistory = [];
  if (JSON.stringify(scenario) !== JSON.stringify(record.scenario)) { undoStack.push(clone(scenario)); scenario = clone(record.scenario); selected = scenario.vehicles[0].id; world?.setScenario(scenario); renderProject(); }
  ($('#scrub') as HTMLInputElement).disabled = false; ($('#scrub') as HTMLInputElement).max = String(record.frames.at(-1)!.time); renderReplay(); toast('Replay ready. Scrub the timeline or press play.');
}
function renderReplay() {
  if (!replayRecord) return;
  const frames = replayRecord.frames; let frameIndex = Math.floor(replayTime * 2);
  frameIndex = Math.max(0, Math.min(frameIndex, frames.length - 1)); while (frameIndex > 0 && frames[frameIndex].time > replayTime) frameIndex--;
  while (frameIndex + 1 < frames.length && frames[frameIndex + 1].time <= replayTime) frameIndex++;
  const frame = clone(frames[frameIndex]); const next = frames[frameIndex + 1];
  if (next && next.time > frame.time) {
    const fraction = (replayTime - frame.time) / (next.time - frame.time);
    frame.units.forEach((unit, index) => { const after = next.units[index]; if (after?.id !== unit.id) return; for (const axis of ['x', 'y', 'z'] as const) unit.position[axis] += (after.position[axis] - unit.position[axis]) * fraction; });
  }
  updateSnapshot({ ...frame, time: replayTime, logs: replayRecord.logs.filter(entry => entry.time <= replayTime), observations: replayRecord.observations.filter(entry => entry.deliveredAt <= replayTime && entry.deliveredAt > replayTime - 4), finished: replayTime >= frames.at(-1)!.time }, false);
}

document.addEventListener('click', async event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]'); if (!button) return;
  const action = button.dataset.action; const value = button.dataset.value!; const id = button.dataset.id;
  try {
    if (action === 'appearance') { appearance = value === 'realistic' ? 'realistic' : 'holographic'; world?.setAppearance(appearance); renderAppearance(); try { localStorage.setItem('airfield.appearance.v1', appearance); } catch {} }
    if (action === 'select') choose(id!);
    if (action === 'scene-tab') { sceneTab = value; renderList(); }
    if (action === 'panel') { panel = value; $('#analytics').hidden = panel !== 'analysis'; document.querySelectorAll('[data-action="panel"]').forEach(item => item.classList.toggle('active', (item as HTMLElement).dataset.value === panel)); renderAnalytics(); }
    if (action === 'camera') { world?.setCamera(value); document.querySelectorAll('[data-action="camera"]').forEach(item => item.classList.toggle('active', (item as HTMLElement).dataset.value === value)); }
    if (action === 'routes' || action === 'labels') { button.classList.toggle('active'); if (action === 'routes') world?.setRoutes(button.classList.contains('active')); else world?.setLabels(button.classList.contains('active')); }
    if (action === 'settings') settingsDialog(); if (action === 'weather') settingsDialog(true);
    if (action === 'event-add') eventDialog(); if (action === 'event-edit') eventDialog(id);
    if (action === 'event-delete') { commit(draft => { draft.events = draft.events.filter(event => event.id !== id); }); close(); }
    if (action === 'log-tab') { logTab = value; renderEvents(); }
    if (action === 'play') {
      if (replayRecord) { if (replayTime >= replayRecord.frames.at(-1)!.time) replayTime = 0; replayPlaying = !replayPlaying; lastReplayTick = performance.now(); renderReplay(); }
      else if (snapshot?.finished) { resetRun(); send({ type: 'play' }); } else send({ type: playing ? 'pause' : 'play' });
    }
    if (action === 'step') { if (replayRecord) { replayPlaying = false; replayTime = Math.min(replayRecord.frames.at(-1)!.time, replayTime + 0.05); renderReplay(); } else send({ type: 'step' }); }
    if (action === 'reset') { resetRun(); toast('Run reset to the original scenario.'); }
    if (action === 'save') { persist(); capture('save'); }
    if (action === 'replay') capture('replay');
    if (action === 'image-map') imageMapDialog();
    if (action === 'reference-map') commit(draft => { if (draft.referenceMap) draft.referenceMap.visible = !draft.referenceMap.visible; }, 'Reference image visibility updated.');
    if (action === 'library') libraryDialog();
    if (action === 'preset') { const replacement = makeScenario(value); commit(draft => { delete draft.referenceMap; Object.assign(draft, replacement); }, 'Example loaded. Your previous scene is available with Undo.'); selected = scenario.vehicles[0].id; choose(selected); close(); }
    if (action === 'load-record') { const record = await loadRun(); if (!record) toast('No saved recording yet. Run a scenario, then save the project.'); else { close(); startReplay(record); } }
    if (action === 'add') addDialog();
    if (action === 'add-vehicle') { const id = crypto.randomUUID(); commit(draft => { const count = draft.vehicles.filter(vehicle => vehicle.role === value).length; draft.vehicles.push(makeVehicle(id, value as Vehicle['role'], count)); }); sceneTab = 'vehicles'; choose(id); close(); }
    if (action === 'add-object') { const id = crypto.randomUUID(); commit(draft => { const kind = value as MapKind; draft.objects.push({ id, label: `New ${kind}`, kind, position: { x: 400, y: 0, z: 100 }, size: kind === 'runway' ? { x: 90, y: 1, z: 1800 } : kind === 'taxiway' ? { x: 30, y: 1, z: 350 } : kind === 'trees' ? { x: 250, y: 35, z: 250 } : { x: 140, y: kind === 'tower' ? 120 : kind === 'zone' ? 1 : 45, z: 110 }, rotation: 0 }); }); sceneTab = 'objects'; choose(id); close(); }
    if (action === 'delete') commit(draft => { draft.objects = draft.objects.filter(item => item.id !== selected); draft.vehicles = draft.vehicles.filter(item => item.id !== selected); }, 'Entity deleted. Events with missing participants will be skipped.');
    if (action === 'route-edit') { routeEditing = !routeEditing; world?.routeMode(routeEditing); renderInspector(); $('#view-hint').textContent = routeEditing ? 'Click on the ground to append a waypoint · Finish in inspector' : 'Drag to orbit · Scroll to zoom · Click to inspect'; }
    if (action === 'undo' || action === 'redo') {
      const source = action === 'undo' ? undoStack : redoStack; const destination = action === 'undo' ? redoStack : undoStack;
      if (source.length) { destination.push(clone(scenario)); scenario = source.pop()!; if (![...scenario.vehicles, ...scenario.objects].some(item => item.id === selected)) selected = scenario.vehicles[0].id; resetRun(); world?.setScenario(scenario); renderProject(); persist(); }
    }
    if (action === 'export') exportDialog(); if (action === 'scenario-json') { download('airfield-scenario.json', JSON.stringify(scenario, null, 2), 'application/json'); close(); }
    if (action === 'run-json') { capture('json'); close(); } if (action === 'csv') { capture('csv'); close(); }
    if (action === 'import') ($('#file-input') as HTMLInputElement).click();
    if (action === 'close') close();
    if (action === 'help') modal('Your airfield, your scenario', 'An editable 3D workspace for fictional, scripted encounters.', `<div class="help-content"><h3>1. Shape the scene</h3><p>Select an entity in the explorer or the 3D view. Use its inspector to edit properties. Drag the arrows on selected map objects to move them.</p><h3>2. Author the story</h3><p>Set departure times and routes. Add timeline events to launch vehicles, delay aircraft, or choose an encounter outcome. Events require eligible participants; conflicts appear in the flight log.</p><h3>3. Run, inspect, repeat</h3><p>Press Play, then open Analysis. Save captures the current run. Replay enables timeline scrubbing. Exports preserve your scenario and results outside this browser.</p><h3>Model boundaries</h3><p>Aircraft profiles, wind response, power curves, and observations are educational approximations. The scene is fictional. Encounter outcomes are authored, with no interception guidance or device control.</p><div class="keyboard-hints"><kbd>Space</kbd> Play / pause <kbd>⌘ / Ctrl Z</kbd> Undo <kbd>Shift Z</kbd> Redo</div><a class="button" href="./lab-report.html" target="_blank" rel="noopener">Read the separate hardware lab report ↗</a></div>`);
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
});
$('#scene-search').addEventListener('input', event => { search = (event.target as HTMLInputElement).value.toLowerCase(); renderList(); });
$('#speed').addEventListener('change', event => { playbackSpeed = Number((event.target as HTMLSelectElement).value); send({ type: 'speed', speed: playbackSpeed }); });
$('#scrub').addEventListener('input', event => { if (!replayRecord) return; replayPlaying = false; replayTime = Number((event.target as HTMLInputElement).value); renderReplay(); });
$('#file-input').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 40 * 1024 * 1024) throw new Error('Choose a JSON file smaller than 40 MB.');
    const value = JSON.parse(await file.text());
    if (value.frames) { const record = validateRun(value); startReplay(record); }
    else { const imported = validateScenario(value); commit(draft => { delete draft.referenceMap; Object.assign(draft, imported); }, 'Scenario imported successfully.'); selected = scenario.vehicles[0].id; choose(selected); }
  } catch (error) { toast(`Import rejected. ${error instanceof Error ? error.message : String(error)}`); }
  input.value = '';
});
document.addEventListener('keydown', event => {
  if ((event.target as HTMLElement).closest('input, textarea, select') || ($('#dialog') as HTMLDialogElement).open) return;
  if (event.code === 'Space') { event.preventDefault(); $('#play').click(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $(event.shiftKey ? '#redo' : '#undo').click(); }
});
worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === 'snapshot' && !replayRecord) { updateSnapshot(message.snapshot, message.playing); if (message.snapshot.finished) { recordIntent = 'save'; send({ type: 'record' }); } }
  if (message.type === 'record') { const intent = recordIntent; recordIntent = undefined; if (intent) handleRecord(message.record, intent); }
  if (message.type === 'error') toast(`Simulation error: ${message.message}`);
};
worker.onerror = () => toast('The simulation worker could not start. Reload the page to try again.');
try {
  world = new AirfieldScene($('#viewport')); world.setScenario(scenario); world.select(selected); world.setAppearance(appearance);
  world.assetsReady.then(failed => {
    $('#asset-status').dataset.state = failed.length ? 'partial' : 'ready';
    $('#asset-status').textContent = failed.length ? 'Some scenery could not load. Reload to retry.' : 'Detailed scenery ready';
    $('#asset-status').title = failed.length ? `Unavailable: ${failed.join(', ')}` : 'Your jet, hostile drone, two tree models, grass texture, and fictional reference image are loaded.';
  });
  world.onSelect = choose;
  world.onMove = (id, position) => { try { commit(draft => { const object = draft.objects.find(item => item.id === id); if (object) object.position = position; }, 'Object moved.'); } catch {} };
  world.onWaypoint = (position: Vec3) => { try { commit(draft => { const vehicle = draft.vehicles.find(item => item.id === selected); if (vehicle) vehicle.route.push(position); }, 'Waypoint added.'); } catch {} };
} catch {
  $('#viewport').innerHTML = '<div class="graphics-error"><h2>3D graphics could not start</h2><p>This workspace needs WebGL2. Enable browser graphics acceleration and reload in desktop Chrome or Edge.</p><p>You can still edit profiles and export scenarios.</p></div>';
}
renderProject(); resetRun(); if (storageWarning) toast(storageWarning);
setInterval(() => { if (world) $('#fps').textContent = `${Math.round(world.fps)} FPS`; }, 1000);
setInterval(() => {
  const now = performance.now();
  if (replayRecord && replayPlaying) { replayTime = Math.min(replayRecord.frames.at(-1)!.time, replayTime + (now - lastReplayTick) / 1000 * playbackSpeed); if (replayTime >= replayRecord.frames.at(-1)!.time) replayPlaying = false; renderReplay(); }
  lastReplayTick = now;
}, 50);
document.addEventListener('visibilitychange', () => { if (document.hidden && (playing || replayPlaying)) { send({ type: 'pause' }); replayPlaying = false; toast('Paused while the tab is in the background.'); } });
