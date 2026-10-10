import { escapeHtml as html, validateScenario } from './data';
import { buildImageScenario, exampleFootprints, IMAGE_MAP_DEPTH, IMAGE_MAP_PATH, IMAGE_MAP_WIDTH, objectOutline } from './image-map';
import { clone, type MapKind, type MapObject, type ScenarioDocument } from './types';

const kinds: [MapKind, string][] = [['building', 'Building'], ['hangar', 'Hangar'], ['tower', 'Tower'], ['runway', 'Runway'], ['taxiway', 'Pavement'], ['trees', 'Trees'], ['zone', 'Zone']];
export function mountImageMapEditor(host: HTMLElement, scenario: ScenarioDocument, onApply: (next: ScenarioDocument) => void) {
  let objects = scenario.referenceMap ? clone(scenario.objects) : exampleFootprints();
  let selected = objects.find(item => item.kind === 'hangar')?.id ?? objects[0]?.id;
  let drawing = false;
  let corner: { x: number; y: number } | undefined;
  let newKind: MapKind = 'building';
  let updateProperties: () => boolean = () => true;
  const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  host.innerHTML = `
    <div class="image-map-intro"><span class="image-map-badge">FICTIONAL COAST · 01</span><span>AI concept → outline → editable 3D</span></div>
    <div class="image-map-layout"><section class="image-map-canvas-column">
      <div class="image-map-tools"><label>New outline <select id="outline-kind" aria-label="New outline type">${kinds.map(([kind, label]) => `<option value="${kind}">${label}</option>`).join('')}</select></label><button type="button" class="button quiet" id="outline-draw">＋ Draw outline</button><button type="button" class="text-button" id="outline-restore">Restore example</button></div>
      <div class="image-map-stage"><svg id="outline-map" viewBox="0 0 ${IMAGE_MAP_WIDTH} ${IMAGE_MAP_DEPTH}" role="img" aria-label="Fictional airport image with editable object outlines"><image href="${import.meta.env.BASE_URL}${IMAGE_MAP_PATH}" width="${IMAGE_MAP_WIDTH}" height="${IMAGE_MAP_DEPTH}"/><g id="outline-shapes"></g><rect id="outline-preview" hidden/></svg><span class="image-map-north">↑ N</span></div>
      <p id="outline-instruction" class="image-map-instruction" aria-live="polite"></p>
      <div class="image-map-context"><b>One image. Your interpretation.</b><p>Outlines are editable estimates. Choose heights to create the scene; a single image does not supply measured geometry.</p><span>3,000 × 2,000 m canvas · illustrative scale</span></div>
    </section><aside class="image-map-sidebar"><div class="image-map-sidebar-heading"><b>Object outlines</b><span id="outline-count"></span></div><div id="outline-list" class="outline-list" role="group" aria-label="Select outline"></div><div id="outline-properties"></div></aside></div>
    <p id="image-map-error" class="form-error" role="alert"></p>
    <div class="image-map-footer"><span>${scenario.referenceMap ? 'Updates the map; existing flights and events stay as authored.' : 'Creates a new demo scene. Undo returns to your current project.'}</span><button type="button" class="button quiet" data-action="close">Cancel</button><button type="button" class="button primary" id="image-map-build">${scenario.referenceMap ? 'Apply to 3D scene' : 'Build 3D scene'} ↗</button></div>`;
  const svg = q<SVGSVGElement>('#outline-map');
  function renderOutlines() {
    q('#outline-count').textContent = String(objects.length);
    q('#outline-shapes').innerHTML = objects.map((object, index) => {
      const rect = objectOutline(object);
      return `<g class="outline-shape ${object.id === selected ? 'selected' : ''} ${object.kind}" data-outline="${html(object.id)}"><rect x="${rect.x - rect.width / 2}" y="${rect.y - rect.height / 2}" width="${rect.width}" height="${rect.height}" transform="rotate(${rect.rotation} ${rect.x} ${rect.y})"/><text x="${rect.x}" y="${rect.y}" text-anchor="middle" dominant-baseline="central">${index + 1}</text></g>`;
    }).join('');
    const listScroll = q('#outline-list').scrollTop;
    q('#outline-list').innerHTML = objects.map((object, index) => `<button type="button" data-outline="${html(object.id)}" aria-pressed="${object.id === selected}"><span>${String(index + 1).padStart(2, '0')}</span><b>${html(object.label)}</b><small>${object.kind === 'runway' || object.kind === 'taxiway' ? 'ground' : `${object.size.y} m`}</small></button>`).join('');
    q('#outline-list').scrollTop = listScroll;
    q('#outline-instruction').textContent = drawing ? corner ? 'Click the opposite corner to finish the rectangle. Escape cancels.' : 'Click two opposite corners on the image. Escape cancels.' : 'Select an outline on the image or in the list. Adjust its dimensions and height below.';
    q('#outline-draw').textContent = drawing ? 'Cancel drawing' : '＋ Draw outline';
    q('#outline-draw').setAttribute('aria-pressed', String(drawing));
    svg.classList.toggle('drawing', drawing);
  }
  function renderProperties() {
    const object = objects.find(item => item.id === selected);
    if (!object) { updateProperties = () => true; q('#outline-properties').innerHTML = '<p class="image-map-instruction">Draw an outline to begin.</p>'; return; }
    const numeric = (label: string, name: string, value: number, min: number, max: number) => `<label class="field"><span>${label}</span><input aria-label="${label}" name="${name}" type="number" step="any" min="${min}" max="${max}" value="${Number(value.toFixed(2))}" required></label>`;
    q('#outline-properties').innerHTML = `<form id="outline-form"><label class="field"><span>Label</span><input aria-label="Outline label" name="label" value="${html(object.label)}" maxlength="160" required></label><label class="field"><span>Type</span><select aria-label="Outline type" name="kind">${kinds.map(([kind, label]) => `<option value="${kind}" ${kind === object.kind ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="form-grid">${numeric('Height · m', 'height', object.size.y, 1, 5000)}${numeric('Rotation · °', 'rotation', object.rotation, -3600, 3600)}${numeric('Width · m', 'width', object.size.x, 1, 20000)}${numeric('Depth · m', 'depth', object.size.z, 1, 20000)}${numeric('Center X · m', 'x', object.position.x, -20000, 20000)}${numeric('Center Z · m', 'z', object.position.z, -20000, 20000)}</div><p class="image-map-field-note">Runways extend along local depth. Pavement stays at ground level. All heights are illustrative.</p><button type="button" class="text-button danger" id="outline-delete">Delete outline</button></form>`;
    const form = q<HTMLFormElement>('#outline-form');
    form.onsubmit = event => event.preventDefault();
    updateProperties = () => {
      if (!form.checkValidity()) return false;
      const values = new FormData(form);
      object.label = String(values.get('label')); object.kind = String(values.get('kind')) as MapKind;
      object.size = { x: Number(values.get('width')), y: Number(values.get('height')), z: Number(values.get('depth')) };
      object.position.x = Number(values.get('x')); object.position.z = Number(values.get('z')); object.rotation = Number(values.get('rotation'));
      renderOutlines(); return true;
    };
    form.oninput = form.onchange = () => { updateProperties(); };
    q('#outline-delete').onclick = () => { objects = objects.filter(item => item.id !== selected); selected = objects[0]?.id; renderOutlines(); renderProperties(); };
  }
  function cancelDrawing() { drawing = false; corner = undefined; q('#outline-preview').setAttribute('hidden', ''); renderOutlines(); }
  q<HTMLSelectElement>('#outline-kind').onchange = event => { newKind = (event.target as HTMLSelectElement).value as MapKind; };
  q('#outline-draw').onclick = () => { if (drawing) cancelDrawing(); else { drawing = true; corner = undefined; renderOutlines(); } };
  q('#outline-restore').onclick = () => { objects = exampleFootprints(); selected = objects[0]?.id; cancelDrawing(); renderProperties(); };
  const selectOutline = (event: MouseEvent) => {
    const id = (event.target as Element).closest('[data-outline]')?.getAttribute('data-outline');
    if (id && !drawing) { selected = id; renderOutlines(); renderProperties(); }
  };
  q('#outline-list').onclick = selectOutline;
  function point(event: MouseEvent) {
    const transform = svg.getScreenCTM(); if (!transform) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    return { x: Math.max(0, Math.min(IMAGE_MAP_WIDTH, p.x)), y: Math.max(0, Math.min(IMAGE_MAP_DEPTH, p.y)) };
  }
  svg.onclick = event => {
    if (!drawing) { selectOutline(event); return; }
    const p = point(event); if (!p) return;
    if (!corner) { corner = p; renderOutlines(); return; }
    const width = Math.abs(p.x - corner.x), depth = Math.abs(p.y - corner.y);
    if (width < 8 || depth < 8) { q('#image-map-error').textContent = 'Choose a rectangle at least 8 m wide and deep.'; return; }
    if (objects.length >= 200) { q('#image-map-error').textContent = 'The scene supports up to 200 map objects.'; return; }
    const horizontalRunway = newKind === 'runway' && width > depth;
    const object: MapObject = { id: crypto.randomUUID(), label: `New ${newKind}`, kind: newKind, position: { x: (p.x + corner.x) / 2 - IMAGE_MAP_WIDTH / 2, y: 0, z: (p.y + corner.y) / 2 - IMAGE_MAP_DEPTH / 2 }, size: { x: horizontalRunway ? depth : width, y: newKind === 'runway' || newKind === 'taxiway' || newKind === 'zone' ? 1 : 35, z: horizontalRunway ? width : depth }, rotation: horizontalRunway ? -90 : 0 };
    objects.push(object); selected = object.id; q('#image-map-error').textContent = ''; cancelDrawing(); renderProperties();
  };
  svg.onpointermove = event => {
    if (!drawing || !corner) return;
    const p = point(event); if (!p) return;
    const preview = q('#outline-preview'); preview.removeAttribute('hidden');
    for (const [key, value] of Object.entries({ x: Math.min(p.x, corner.x), y: Math.min(p.y, corner.y), width: Math.abs(p.x - corner.x), height: Math.abs(p.y - corner.y) })) preview.setAttribute(key, String(value));
  };
  host.onkeydown = event => { if (event.key === 'Escape' && drawing) { event.preventDefault(); event.stopPropagation(); cancelDrawing(); } };
  q('#image-map-build').onclick = () => {
    const form = q<HTMLFormElement>('#outline-form');
    if (form && !form.reportValidity()) return;
    if (!updateProperties()) return;
    try { onApply(validateScenario(buildImageScenario(scenario, objects))); } catch (error) { q('#image-map-error').textContent = error instanceof Error ? error.message : String(error); }
  };
  renderOutlines(); renderProperties();
}
