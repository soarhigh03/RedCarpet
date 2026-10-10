import { makeScenario } from '../src/scenarios';

const scenario = makeScenario('airbase');
const trees = scenario.objects.filter(object => object.kind === 'trees');
const density = (w: number, d: number) => Math.max(12, Math.min(60, Math.round(w * d / 8000)));
const total = trees.reduce((sum, item) => sum + density(item.size.x, item.size.z) * 2, 0);
console.log('objects', scenario.objects.length, '| groves', trees.length, '| trees', total);
console.log('largest grove trees', Math.max(...trees.map(item => density(item.size.x, item.size.z) * 2)));
console.log('far-level triangles ~', (total * 34 / 1000).toFixed(0), 'k | nearest-grove full-detail triangles ~', (Math.max(...trees.map(item => density(item.size.x, item.size.z) * 2)) * 34 / 1000).toFixed(0), 'k');

const W = 96, H = 64, SPAN = 5600;
const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => ' '));
const mark: Record<string, string> = { runway: '#', taxiway: '.', hangar: 'H', building: 'B', tower: 'T', trees: '^', zone: 'o' };
const order = ['trees', 'taxiway', 'runway', 'zone', 'building', 'hangar', 'tower'];
for (const kind of order) for (const item of scenario.objects.filter(object => object.kind === kind)) {
  const angle = item.rotation * Math.PI / 180;
  for (let a = -item.size.x / 2; a <= item.size.x / 2; a += 4) for (let b = -item.size.z / 2; b <= item.size.z / 2; b += 4) {
    const x = item.position.x + a * Math.cos(angle) + b * Math.sin(angle);
    const z = item.position.z - a * Math.sin(angle) + b * Math.cos(angle);
    const column = Math.round((x + SPAN / 2) / SPAN * (W - 1));
    const row = Math.round((z + SPAN / 2) / SPAN * (H - 1));
    if (column >= 0 && column < W && row >= 0 && row < H) grid[row][column] = mark[kind];
  }
}
console.log(`North is up. ${SPAN} m square. ground edge is 6200 x 6000 m.`);
console.log(grid.map(row => row.join('')).join('\n'));
const extent = scenario.objects.reduce((acc, item) => {
  const angle = item.rotation * Math.PI / 180; const sin = Math.abs(Math.sin(angle)); const cos = Math.abs(Math.cos(angle));
  const spanX = item.size.x / 2 * cos + item.size.z / 2 * sin; const spanZ = item.size.x / 2 * sin + item.size.z / 2 * cos;
  return { x: Math.max(acc.x, Math.abs(item.position.x) + spanX), z: Math.max(acc.z, Math.abs(item.position.z) + spanZ) };
}, { x: 0, z: 0 });
console.log('max |x|', extent.x.toFixed(0), '(limit 3100) max |z|', extent.z.toFixed(0), '(limit 3000)');
