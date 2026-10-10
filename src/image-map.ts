import footprints from './fictional-footprints.json';
import { clone, type MapKind, type MapObject, type ScenarioDocument } from './types';
import { makeVehicle } from './scenarios';

export const IMAGE_MAP_ID = 'fictional-coast-v1' as const;
export const IMAGE_MAP_WIDTH = 3000;
export const IMAGE_MAP_DEPTH = 2000;
export const IMAGE_MAP_PATH = 'maps/fictional-coast.png';
const scale = IMAGE_MAP_WIDTH / footprints.width;

// This is an artistic scale for the generated concept, not a surveyed dimension.
export function footprintObject(id: string, label: string, kind: MapKind, x: number, y: number, width: number, depth: number, height: number): MapObject {
  const runway = kind === 'runway' && width > depth;
  return {
    id, label, kind,
    position: { x: (x + width / 2) * scale - IMAGE_MAP_WIDTH / 2, y: 0, z: (y + depth / 2) * scale - IMAGE_MAP_DEPTH / 2 },
    size: { x: (runway ? depth : width) * scale, y: height, z: (runway ? width : depth) * scale },
    rotation: runway ? -90 : 0,
  };
}
export function exampleFootprints(): MapObject[] {
  return footprints.rectangles.map(rect => {
    const kind: MapKind = rect.id === 'runway' ? 'runway' : rect.id.startsWith('hangar') ? 'hangar' : rect.id.startsWith('tower') ? 'tower' : rect.id.startsWith('grove') ? 'trees' : rect.id === 'terminal' ? 'building' : 'taxiway';
    const height = kind === 'hangar' ? 50 : kind === 'tower' ? 95 : kind === 'trees' ? 40 : kind === 'building' ? 28 : 1;
    const label = rect.id === 'runway' ? 'Coastal runway' : rect.id === 'tower-roof' ? 'Control tower' : rect.id.replaceAll('-', ' ').replace(/^./, value => value.toUpperCase());
    return footprintObject(`coast-${rect.id}`, label, kind, rect.x, rect.y, rect.width, rect.height, height);
  });
}
export function objectOutline(object: MapObject) {
  return { x: object.position.x + IMAGE_MAP_WIDTH / 2, y: object.position.z + IMAGE_MAP_DEPTH / 2, width: object.size.x, height: object.size.z, rotation: -object.rotation };
}
export function buildImageScenario(base: ScenarioDocument, objects: MapObject[]): ScenarioDocument {
  if (!objects.some(object => object.kind === 'runway')) throw new Error('Keep at least one runway in this demo.');
  const scenario = clone(base);
  scenario.objects = clone(objects);
  // Reopening the editor preserves the current routes, weather and event script.
  if (base.referenceMap?.id === IMAGE_MAP_ID) return scenario;
  scenario.name = '서산공군기지(가상)';
  scenario.description = 'An invented coastal airfield. Outlined from an AI concept, with illustrative dimensions and heights.';
  scenario.referenceMap = { id: IMAGE_MAP_ID, visible: true };
  scenario.duration = 180;
  scenario.events = [];
  scenario.weather = { windSpeed: 0, windDirection: 0, gusts: 0, temperature: 20, rain: 0, visibility: 16000 };
  const runway = objects.find(object => object.kind === 'runway')!;
  const angle = runway.rotation * Math.PI / 180;
  const point = (distance: number, y: number) => ({ x: runway.position.x - Math.sin(angle) * distance, y, z: runway.position.z - Math.cos(angle) * distance });
  const aircraft = makeVehicle('coast-demo-aircraft', 'aircraft');
  aircraft.label = 'Coastal demo flight';
  aircraft.position = point(-runway.size.z * 0.4, 5);
  aircraft.route = [point(runway.size.z * 0.65, 400), point(runway.size.z * 0.9, 650)];
  aircraft.runwayLength = Math.min(10000, runway.size.z * 0.8);
  scenario.vehicles = [aircraft];
  return scenario;
}
