import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createHolographicGround, HolographicMaterials, type SceneAppearance } from './presentation';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { escapeHtml } from './data';
import { SceneAssets } from './assets';
import { Blasts } from './effects';
import { IMAGE_MAP_DEPTH, IMAGE_MAP_WIDTH } from './image-map';
import { type MapObject, type ScenarioDocument, type Snapshot, type Vec3, type Vehicle, type UnitState, isActive } from './types';

const colors = { friendly: 0x27c9ab, hostile: 0xf09266, aircraft: 0x8ea6e9 };
/** Accent, kept for the one trajectory you are looking at and the ring under it. */
const ACCENT = 0xccff33;
const TERRAIN = { width: 6200, depth: 6000 };
/** Runway end marking for a scene rotation, in the 01–36 convention. */
function designator(bearing: number) { const value = ((Math.round(bearing / 10) % 36) + 36) % 36; return String(value || 36).padStart(2, '0'); }
const material = (color: number, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
function box(width: number, height: number, depth: number, color: number) { const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material(color)); mesh.castShadow = true; mesh.receiveShadow = true; return mesh; }
function addBox(parent: THREE.Object3D, width: number, height: number, depth: number, color: number, x: number, y: number, z: number) { const mesh = box(width, height, depth, color); mesh.position.set(x, y, z); parent.add(mesh); return mesh; }
function dispose(root: THREE.Object3D) { root.traverse(object => { const mesh = object as THREE.Mesh; if (mesh instanceof THREE.InstancedMesh) mesh.dispose(); if (mesh.userData.sharedAsset) return; mesh.geometry?.dispose(); const materials = mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : []; materials.forEach(item => { const basic = item as THREE.MeshBasicMaterial; basic.map?.dispose(); item.dispose(); }); }); }

export class AirfieldScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(43, 1, 5, 25000);
  controls: OrbitControls;
  transform: TransformControls;
  private terrain = new THREE.Group();
  private appearance: SceneAppearance = 'realistic';
  private holographicMaterials = new HolographicMaterials();
  private holographicGround = createHolographicGround();
  private composer?: EffectComposer;
  private scenery = new THREE.Group();
  private terrainDetails = new THREE.Group();
  private referencePlane = new THREE.Mesh(new THREE.PlaneGeometry(IMAGE_MAP_WIDTH, IMAGE_MAP_DEPTH), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  private actors = new THREE.Group();
  private routes = new THREE.Group();
  private marks = new THREE.Group();
  /** Sensor envelopes live outside the actor tree so the appearance pass never restyles them. */
  private coverage = new THREE.Group();
  private envelopes = new Map<string, THREE.Group>();
  private tracks: THREE.LineSegments;
  private showCoverage = true;
  private blasts = new Blasts();
  /** Last status seen per unit, so a takedown can be spotted as a transition rather than a flag. */
  private wasActive = new Map<string, boolean>();
  private objects = new Map<string, THREE.Group>();
  private units = new Map<string, THREE.Group>();
  private labels = new Map<string, HTMLElement>();
  private unitStates: UnitState[] = [];
  private selected = '';
  private scenario?: ScenarioDocument;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private down = { x: 0, y: 0 };
  private labelLayer: HTMLDivElement;
  private mode = 'orbit';
  private editingRoute = false;
  private running = false;
  private frameCount = 0;
  private frameTime = performance.now();
  fps = 60;
  private selectedRing: THREE.Mesh;
  private sunlight: THREE.DirectionalLight;
  private sceneBounds = { centerX: -215, centerZ: 0, radius: 1405 };
  private rain: THREE.Points;
  private lastSnapshot?: Snapshot;
  private assets = new SceneAssets();
  private groundMaterial = new THREE.MeshStandardMaterial({ color: 0xb5bd9b, roughness: 1, metalness: 0 });
  readonly assetsReady: Promise<string[]>;
  onSelect: (id: string) => void = () => {};
  onMove: (id: string, position: Vec3) => void = () => {};
  onWaypoint: (position: Vec3) => void = () => {};
  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75)); this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D airfield. Use the scene list and inspector for keyboard editing.');
    this.host.append(this.renderer.domElement);
    this.labelLayer = document.createElement('div'); this.labelLayer.className = 'scene-labels'; this.host.append(this.labelLayer);
    this.scene.background = new THREE.Color(0xd9e4e6); this.scene.fog = new THREE.FogExp2(0xd9e4e6, 0.00007);
    this.scene.add(new THREE.HemisphereLight(0xf4fbff, 0x7a8563, 2.5));
    this.sunlight = new THREE.DirectionalLight(0xfff1dc, 3); this.sunlight.position.set(-900, 1800, 600); this.sunlight.castShadow = true;
    this.sunlight.shadow.mapSize.set(2048, 2048); this.sunlight.shadow.camera.left = -2000; this.sunlight.shadow.camera.right = 2000; this.sunlight.shadow.camera.top = 2000; this.sunlight.shadow.camera.bottom = -2000; this.sunlight.shadow.camera.far = 7200; this.sunlight.shadow.normalBias = 2;
    this.scene.add(this.sunlight, this.holographicGround, this.terrain, this.scenery, this.actors, this.routes, this.marks, this.coverage);
    const trackGeometry = new THREE.BufferGeometry();
    trackGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(75 * 6), 3));
    trackGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(75 * 6), 3));
    this.tracks = new THREE.LineSegments(trackGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    this.tracks.frustumCulled = false; this.coverage.add(this.tracks);
    this.scene.add(this.blasts.group);
    this.camera.position.set(1180, 1200, 1450); this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.target.set(-130, 0, 0); this.controls.enableDamping = true; this.controls.dampingFactor = 0.08; this.controls.maxPolarAngle = Math.PI / 2.1; this.controls.minDistance = 25; this.controls.maxDistance = 6500;
    this.transform = new TransformControls(this.camera, this.renderer.domElement); this.transform.setMode('translate'); this.transform.showY = false; this.transform.setSize(0.65); this.transform.setTranslationSnap(5); this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', event => { this.controls.enabled = !event.value; });
    this.transform.addEventListener('mouseUp', () => { const target = this.transform.object; if (target) this.onMove(this.selected, { x: Math.round(target.position.x), y: Math.round(target.position.y), z: Math.round(target.position.z) }); });
    this.selectedRing = new THREE.Mesh(new THREE.RingGeometry(30, 33, 64), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85, side: THREE.DoubleSide, toneMapped: false })); this.selectedRing.rotation.x = -Math.PI / 2; this.selectedRing.visible = false; this.marks.add(this.selectedRing);
    const rainGeometry = new THREE.BufferGeometry(); const rainPositions = new Float32Array(1800);
    for (let index = 0; index < 600; index++) { rainPositions[index * 3] = Math.sin(index * 13) * 1700; rainPositions[index * 3 + 1] = (index * 53) % 1100; rainPositions[index * 3 + 2] = Math.cos(index * 19) * 1700; }
    rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3)); this.rain = new THREE.Points(rainGeometry, new THREE.PointsMaterial({ color: 0xe0eeff, size: 3, transparent: true, opacity: 0.4 })); this.rain.visible = false; this.scene.add(this.rain);
    this.buildTerrain();
    this.referencePlane.rotation.x = -Math.PI / 2; this.referencePlane.position.y = 0.15; this.referencePlane.visible = false; this.scene.add(this.referencePlane);
    this.assetsReady = this.assets.load().then(failed => {
      if (this.assets.grass) { this.assets.grass.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.groundMaterial.map = this.assets.grass; this.groundMaterial.color.set(0xb7bba7); this.groundMaterial.needsUpdate = true; }
      if (this.assets.referenceMap) { this.assets.referenceMap.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.referencePlane.material.map = this.assets.referenceMap; this.referencePlane.material.needsUpdate = true; }
      if (this.scenario) this.setScenario(this.scenario);
      return failed;
    });
    this.renderer.domElement.addEventListener('pointerdown', event => { this.down = { x: event.clientX, y: event.clientY }; });
    this.renderer.domElement.addEventListener('pointerup', event => this.pick(event));
    new ResizeObserver(() => this.resize()).observe(this.host); this.resize();
    this.renderer.setAnimationLoop(() => this.draw());
  }
  private buildTerrain() {
    addBox(this.terrain, TERRAIN.width, 35, TERRAIN.depth, 0xafb798, 0, -24, 0);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(TERRAIN.width, TERRAIN.depth), this.groundMaterial); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.1; ground.receiveShadow = true; this.terrain.add(ground);
    this.terrain.add(this.terrainDetails);
  }
  /** Ground extent of the built scene, with each object's rotated footprint included. */
  private measure(objects: MapObject[]) {
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const item of objects) {
      const angle = item.rotation * Math.PI / 180; const sin = Math.abs(Math.sin(angle)); const cos = Math.abs(Math.cos(angle));
      const spanX = item.size.x / 2 * cos + item.size.z / 2 * sin; const spanZ = item.size.x / 2 * sin + item.size.z / 2 * cos;
      box.minX = Math.min(box.minX, item.position.x - spanX); box.maxX = Math.max(box.maxX, item.position.x + spanX);
      box.minZ = Math.min(box.minZ, item.position.z - spanZ); box.maxZ = Math.max(box.maxZ, item.position.z + spanZ);
    }
    if (!Number.isFinite(box.minX)) return { minX: -600, maxX: 600, minZ: -600, maxZ: 600 };
    return box;
  }
  /** The boundary and access roads follow the scene, so any field size keeps a readable surround. */
  private buildTerrainDetails(objects: MapObject[]) {
    dispose(this.terrainDetails); this.terrainDetails.clear();
    // Woodland is landscape rather than airfield, so the boundary follows the built field inside it.
    const field = objects.filter(item => item.kind !== 'trees');
    const box = this.measure(field.length ? field : objects);
    const limitX = TERRAIN.width / 2 - 60; const limitZ = TERRAIN.depth / 2 - 60;
    const minX = Math.max(-limitX, box.minX - 190); const maxX = Math.min(limitX, box.maxX + 190);
    const minZ = Math.max(-limitZ, box.minZ - 190); const maxZ = Math.min(limitZ, box.maxZ + 190);
    addBox(this.terrainDetails, 26, 1, Math.min(TERRAIN.depth - 120, maxZ - minZ + 620), 0x8a9184, Math.max(-limitX, minX - 230), 0, (minZ + maxZ) / 2);
    addBox(this.terrainDetails, Math.min(TERRAIN.width - 120, maxX - minX + 620), 1, 24, 0x8a9184, (minX + maxX) / 2, 0, Math.min(limitZ, maxZ + 230));
    const corners: [number, number][] = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ]];
    const perimeter = new THREE.Line(new THREE.BufferGeometry().setFromPoints(corners.map(([x, z]) => new THREE.Vector3(x, 1, z))), new THREE.LineDashedMaterial({ color: 0xe9eee0, dashSize: 14, gapSize: 10, transparent: true, opacity: 0.6 })); perimeter.computeLineDistances(); this.terrainDetails.add(perimeter);
  }
  /** Keeps the default camera distances, shadow extent, and zoom limits proportional to the field. */
  private frame(objects: MapObject[]) {
    const box = this.measure(objects);
    const centerX = (box.minX + box.maxX) / 2; const centerZ = (box.minZ + box.maxZ) / 2;
    const radius = Math.max(400, Math.hypot(box.maxX - box.minX, box.maxZ - box.minZ) / 2);
    const resized = Math.abs(radius - this.sceneBounds.radius) > this.sceneBounds.radius * 0.25;
    const moved = Math.hypot(centerX - this.sceneBounds.centerX, centerZ - this.sceneBounds.centerZ) > radius * 0.3;
    this.sceneBounds = { centerX, centerZ, radius };
    this.controls.maxDistance = Math.max(6500, radius * 3.2);
    const extent = Math.min(3200, Math.max(2000, radius + 300));
    const shadow = this.sunlight.shadow.camera; shadow.left = -extent; shadow.right = extent; shadow.top = extent; shadow.bottom = -extent; shadow.updateProjectionMatrix();
    if ((resized || moved) && this.mode !== 'follow') this.setCamera(this.mode);
  }
  private mapObject(item: MapObject) {
    const group = new THREE.Group(); const { x: width, y: height, z: depth } = item.size;
    if (item.kind === 'runway' || item.kind === 'taxiway') {
      addBox(group, width, 1.5, depth, item.kind === 'runway' ? 0x3c4950 : 0x747e7d, 0, 0.75, 0);
      if (item.kind === 'runway') {
        for (let index = 0; index < 15; index++) addBox(group, 3, 0.15, depth / 40, 0xe9e9d6, 0, 1.6, -depth * 0.4 + index * depth / 17.5);
        addBox(group, 1, 0.15, depth - 25, 0xc9d4c8, -width / 2 + 4, 1.6, 0); addBox(group, 1, 0.15, depth - 25, 0xc9d4c8, width / 2 - 4, 1.6, 0);
        for (const end of [-1, 1]) for (let index = -3; index <= 3; index++) if (index !== 0) addBox(group, 5, 0.2, 55, 0xeceede, index * width / 10, 1.6, end * (depth / 2 - 80));
        this.groundText(group, designator(180 - item.rotation), 0, -depth / 2 + 170, 65, 65); this.groundText(group, designator(-item.rotation), 0, depth / 2 - 170, 65, 65);
        for (const side of [-1, 1]) for (let index = 0; index <= 30; index++) addBox(group, 2, 2, 2, 0xd5f8dc, side * (width / 2 + 4), 1, -depth / 2 + index * depth / 30);
      } else if (width < 80 || depth < 80) addBox(group, width < depth ? 1 : width - 10, 0.2, width < depth ? depth - 10 : 1, 0xcbbf7a, 0, 1.6, 0);
    } else if (item.kind === 'hangar') {
      addBox(group, width, height * 0.7, depth, 0xd0d7ca, 0, height * 0.35, 0);
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(width / 2, width / 2, depth, 18, 1, false, 0, Math.PI), material(0x738b85)); roof.rotation.x = Math.PI / 2; roof.rotation.z = Math.PI / 2; roof.scale.set(0.65, 1, 1); roof.position.y = height * 0.7; group.add(roof); roof.castShadow = true;
      addBox(group, width * 0.86, height * 0.53, 2, 0x74847f, 0, height * 0.27, depth / 2 + 1);
      for (let index = -3; index <= 3; index++) addBox(group, 1, height * 0.53, 3, 0xaebfb1, index * width / 8, height * 0.27, depth / 2 + 2);
    } else if (item.kind === 'building') {
      addBox(group, width, height, depth, 0xd7d9cc, 0, height / 2, 0); addBox(group, width + 3, 3, depth + 3, 0x7e8d86, 0, height + 1, 0);
      for (let index = 0; index < 4; index++) addBox(group, width / 8, height / 3, 1, 0x53777c, -width * 0.35 + index * width * 0.23, height * 0.55, depth / 2 + 0.5);
      addBox(group, width / 6, 6, depth / 4, 0xaab4a8, width / 4, height + 5, 0);
    } else if (item.kind === 'tower') {
      addBox(group, width * 0.5, height * 0.75, depth * 0.5, 0xd5d8ca, 0, height * 0.375, 0);
      addBox(group, width, height * 0.18, depth, 0x42656b, 0, height * 0.82, 0); addBox(group, width * 1.1, 5, depth * 1.1, 0xd4dbd0, 0, height * 0.93, 0);
      addBox(group, 2, height / 5, 2, 0x8e9c98, 0, height * 1.04, 0);
    } else if (item.kind === 'trees') {
      const grove = this.assets.grove(width, height, depth);
      if (grove) group.add(grove);
      else for (let index = 0; index < 24; index++) {
        const x = Math.sin(index * 27.1) * width * 0.47; const z = Math.cos(index * 19.7) * depth * 0.47;
        const treeHeight = height * (0.65 + (Math.sin(index * 10) + 1) * 0.25);
        addBox(group, 3, treeHeight / 2, 3, 0x7b7761, x, treeHeight / 4, z);
        const crown = new THREE.Mesh(new THREE.ConeGeometry(treeHeight * 0.48, treeHeight, 6), material(index % 2 ? 0x66856d : 0x779277)); crown.position.set(x, treeHeight * 0.75, z); crown.castShadow = true; group.add(crown);
      }
    } else if (item.kind === 'pod') {
      const span = Math.min(width, depth);
      const deck = new THREE.Mesh(new THREE.CylinderGeometry(span / 2, span / 2 * 0.92, 1.6, 8), material(0x3d4f58, 0.6)); deck.position.y = 0.8; deck.castShadow = true; deck.receiveShadow = true; group.add(deck);
      const ring = new THREE.Mesh(new THREE.RingGeometry(span * 0.3, span * 0.37, 24), new THREE.MeshBasicMaterial({ color: 0x3fd6b4, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 1.7; group.add(ring);
      for (const corner of [-1, 1]) for (const side of [-1, 1]) addBox(group, 1.6, height, 1.6, 0x8d9aa0, corner * span * 0.34, height / 2, side * span * 0.34);
      addBox(group, span * 0.22, 0.6, span * 0.22, 0x25333a, 0, 1.75, 0);
    } else {
      const area = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ color: 0x46c9b4, transparent: true, opacity: 0.2, side: THREE.DoubleSide })); area.rotation.x = -Math.PI / 2; area.position.y = 2; group.add(area); this.groundText(group, 'H', 0, 0, Math.min(width, depth) * 0.55, Math.min(width, depth) * 0.55);
    }
    group.position.set(item.position.x, item.position.y, item.position.z); group.rotation.y = item.rotation * Math.PI / 180; group.userData.entityId = item.id;
    group.traverse(child => { child.userData.entityId = item.id; }); return group;
  }
  /**
   * The sensor envelope: the horizontal sector the radar covers out to its measurement range, plus
   * the two elevation limits along the boresight. Forward is local -Z, matching the vehicle models.
   */
  private envelope(vehicle: Vehicle) {
    const sensor = vehicle.defence!.sensor;
    const group = new THREE.Group();
    const fov = sensor.horizontalFov * Math.PI / 180;
    const sector = new THREE.Mesh(
      new THREE.CircleGeometry(sensor.range, 42, Math.PI / 2 - fov / 2, fov),
      new THREE.MeshBasicMaterial({ color: 0x3ec5f2, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }),
    );
    sector.rotation.x = -Math.PI / 2; group.add(sector);
    const edge = new THREE.LineBasicMaterial({ color: 0x6fdcff, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
    const rim: THREE.Vector3[] = [new THREE.Vector3()];
    for (let step = 0; step <= 42; step++) {
      const angle = -fov / 2 + fov * step / 42;
      rim.push(new THREE.Vector3(Math.sin(angle) * sensor.range, 0, -Math.cos(angle) * sensor.range));
    }
    rim.push(new THREE.Vector3());
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rim), edge));
    const lift = Math.tan(sensor.verticalFov / 2 * Math.PI / 180) * sensor.range;
    const climb: THREE.Vector3[] = [new THREE.Vector3(0, lift, -sensor.range), new THREE.Vector3(), new THREE.Vector3(0, -lift, -sensor.range)];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(climb), edge));
    group.renderOrder = 2;
    return group;
  }
  private groundText(parent: THREE.Group, value: string, x: number, z: number, width: number, depth: number) {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d')!; context.font = 'bold 85px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = '#eef1dc'; context.fillText(value, 64, 65);
    const texture = new THREE.CanvasTexture(canvas); const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })); mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, 2, z); parent.add(mesh);
  }
  private vehicleModel(vehicle: Vehicle) {
    const group = new THREE.Group(); const tint = colors[vehicle.role];
    const flightVisual = vehicle.kind === 'jet' ? this.assets.jet() : vehicle.role === 'hostile' && vehicle.kind === 'fixed-wing' ? this.assets.hostileDrone() : undefined;
    if (flightVisual) { group.add(flightVisual); group.userData.flightVisual = flightVisual; }
    else if (vehicle.kind === 'multirotor') {
      addBox(group, 12, 5, 16, 0x274c50, 0, 2, 0);
      const armA = addBox(group, 38, 2, 3, 0x435b5b, 0, 2, 0); armA.rotation.y = Math.PI / 4;
      const armB = addBox(group, 38, 2, 3, 0x435b5b, 0, 2, 0); armB.rotation.y = -Math.PI / 4;
      for (const x of [-13, 13]) for (const z of [-13, 13]) { const rotor = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 0.6, 18), new THREE.MeshStandardMaterial({ color: 0x223d3e, transparent: true, opacity: 0.65 })); rotor.position.set(x, 4, z); group.add(rotor); }
      addBox(group, 8, 2, 5, tint, 0, 5, -3);
    } else {
      const shape = new THREE.Shape(); const points = vehicle.kind === 'jet' ? [[0, 35], [5, 12], [25, -9], [10, -7], [9, -22], [17, -30], [2, -25], [-2, -25], [-17, -30], [-9, -22], [-10, -7], [-25, -9], [-5, 12]] : [[0, 24], [3, 5], [28, -5], [28, -10], [3, -5], [4, -18], [12, -21], [-12, -21], [-4, -18], [-3, -5], [-28, -10], [-28, -5], [-3, 5]];
      points.forEach(([x, y], index) => index ? shape.lineTo(x, y) : shape.moveTo(x, y)); shape.closePath();
      const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: true, bevelThickness: 1, bevelSize: 1, bevelSegments: 1 }), material(vehicle.kind === 'jet' ? 0x677986 : 0xbc9d80)); body.rotation.x = -Math.PI / 2; body.castShadow = true; group.add(body);
      const cockpit = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), material(0x294b5a, 0.3)); cockpit.scale.set(0.7, 0.5, 1.8); cockpit.position.set(0, 5, -9); group.add(cockpit);
      addBox(group, 2, 8, 11, tint, -6, 7, 18); addBox(group, 2, 8, 11, tint, 6, 7, 18);
    }
    if (!flightVisual) group.scale.setScalar(1.25); group.rotation.order = 'YXZ'; group.position.set(vehicle.position.x, vehicle.position.y, vehicle.position.z); group.userData.entityId = vehicle.id; group.traverse(child => { child.userData.entityId = vehicle.id; }); return group;
  }
  setScenario(scenario: ScenarioDocument) {
    this.holographicMaterials.dispose();
    this.holographicMaterials = new HolographicMaterials();
    this.scenario = scenario; this.transform.detach();
    this.buildTerrainDetails(scenario.objects); this.frame(scenario.objects);
    this.terrainDetails.visible = !scenario.referenceMap;
    this.referencePlane.visible = Boolean(scenario.referenceMap?.visible && this.assets.referenceMap);
    for (const group of [this.scenery, this.actors, this.routes]) { dispose(group); group.clear(); }
    for (const envelope of this.envelopes.values()) { dispose(envelope); this.coverage.remove(envelope); }
    this.envelopes.clear(); this.wasActive.clear();
    this.objects.clear(); this.units.clear(); this.labels.clear(); this.labelLayer.replaceChildren();
    scenario.objects.forEach(item => {
      const group = this.mapObject(item); this.scenery.add(group); this.objects.set(item.id, group);
      const label = document.createElement('button'); label.className = 'unit-label object-label'; label.textContent = item.label; label.setAttribute('aria-label', `Select ${item.label}`); label.onclick = () => this.onSelect(item.id); this.labelLayer.append(label); this.labels.set(item.id, label);
    });
    scenario.vehicles.forEach(vehicle => {
      const group = this.vehicleModel(vehicle); this.actors.add(group); this.units.set(vehicle.id, group);
      const label = document.createElement('button'); label.className = `unit-label ${vehicle.role}`; label.innerHTML = `<i></i><span>${escapeHtml(vehicle.label)}</span>`; label.setAttribute('aria-label', `Select ${vehicle.label}`); label.onclick = () => this.onSelect(vehicle.id); this.labelLayer.append(label); this.labels.set(vehicle.id, label);
      if (vehicle.defence) {
        const envelope = this.envelope(vehicle);
        envelope.position.set(vehicle.defence.station.x, vehicle.defence.station.y, vehicle.defence.station.z);
        envelope.rotation.y = -vehicle.defence.heading * Math.PI / 180;
        this.coverage.add(envelope); this.envelopes.set(vehicle.id, envelope);
      }
      const points = [vehicle.position, ...vehicle.route].map(point => new THREE.Vector3(point.x, Math.max(5, point.y), point.z));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({ color: colors[vehicle.role], dashSize: 16, gapSize: 12, transparent: true, opacity: 0.38 })); line.computeLineDistances(); line.userData.entityId = vehicle.id; line.userData.roleColor = colors[vehicle.role]; this.routes.add(line);
    });
    this.coverage.visible = this.showCoverage;
    const weather = scenario.weather; this.scene.fog = new THREE.FogExp2(weather.rain > 0.3 ? 0xb7c5ce : 0xd9e4e6, 1 / Math.max(800, weather.visibility) * 0.7); this.scene.background = new THREE.Color(weather.rain > 0.3 ? 0xb7c5ce : 0xd9e4e6); this.rain.visible = weather.rain > 0;
    this.setAppearance(this.appearance);
    this.select(this.selected);
  }
  select(id: string) {
    this.selected = id; this.transform.detach();
    const object = this.objects.get(id); if (object && !this.running && !this.editingRoute) this.transform.attach(object);
    this.labels.forEach((label, key) => label.classList.toggle('selected', key === id));
    this.routes.children.forEach(route => {
      const routeMaterial = (route as THREE.Line).material as THREE.LineDashedMaterial;
      const chosen = route.userData.entityId === id;
      routeMaterial.opacity = chosen ? 0.95 : 0.23;
      routeMaterial.color.setHex(chosen ? ACCENT : route.userData.roleColor);
      route.visible = this.routes.children.length <= 12 || chosen;
    });
  }
  setAppearance(appearance: SceneAppearance) {
    this.appearance = appearance;
    const hologram = appearance === 'holographic';
    this.holographicMaterials.restore();
    if (hologram) this.holographicMaterials.apply(this.scenery, this.actors);
    this.terrain.visible = !hologram;
    this.referencePlane.visible = !hologram && Boolean(this.scenario?.referenceMap?.visible && this.assets.referenceMap);
    this.holographicGround.visible = hologram;
    this.renderer.shadowMap.enabled = !hologram;
    const weather = this.scenario?.weather;
    const background = hologram ? 0x020912 : weather && weather.rain > 0.3 ? 0xb7c5ce : 0xd9e4e6;
    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.FogExp2(background, hologram ? Math.max(0.00008, 0.7 / Math.max(800, weather?.visibility ?? 10000)) : 0.7 / Math.max(800, weather?.visibility ?? 10000));
    if (hologram && !this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.host.clientWidth, this.host.clientHeight), 0.48, 0.5, 0.66));
      this.composer.addPass(new OutputPass());
    }
    this.host.dataset.appearance = appearance;
  }
  setRunning(running: boolean) { this.running = running; if (running) this.transform.detach(); else this.select(this.selected); }
  routeMode(enabled: boolean) { this.editingRoute = enabled; this.controls.enableRotate = !enabled; this.host.classList.toggle('placing-route', enabled); if (enabled) { this.transform.detach(); this.setCamera('overhead'); } else this.select(this.selected); }
  setCamera(mode: string) {
    this.mode = mode;
    this.host.closest('.viewport-wrap')?.classList.toggle('inspect-view', mode === 'follow');
    const { centerX, centerZ, radius } = this.sceneBounds;
    if (mode === 'overhead') { this.camera.position.set(centerX, radius * 2.42, centerZ + 1); this.controls.target.set(centerX, 0, centerZ); }
    if (mode === 'orbit') { const distance = radius * 1.62; this.camera.position.set(centerX + distance * 0.57, distance * 0.52, centerZ + distance * 0.63); this.controls.target.set(centerX, 0, centerZ); }
    this.controls.update();
  }
  update(snapshot: Snapshot) {
    this.lastSnapshot = snapshot; this.unitStates = snapshot.units;
    // A hostile that stops having been active was just taken down: light it off where it died.
    const now = performance.now() / 1000;
    for (const unit of snapshot.units) {
      const active = isActive(unit.status);
      if (this.wasActive.get(unit.id) && !active && unit.status === 'stopped') this.blasts.spawn(unit.position, now);
      this.wasActive.set(unit.id, active);
    }
  }
  setRoutes(visible: boolean) { this.routes.visible = visible; }
  setLabels(visible: boolean) { this.labelLayer.style.display = visible ? '' : 'none'; }
  setCoverage(visible: boolean) { this.showCoverage = visible; this.coverage.visible = visible; }
  private resize() { const width = this.host.clientWidth; const height = this.host.clientHeight; if (!width || !height) return; this.renderer.setSize(width, height); this.composer?.setSize(width, height); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); }
  private pick(event: PointerEvent) {
    if (Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5 || this.transform.dragging || this.transform.axis) return;
    const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.editingRoute) { const intersection = new THREE.Vector3(); const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); if (this.raycaster.ray.intersectPlane(plane, intersection)) this.onWaypoint({ x: Math.round(intersection.x), y: 150, z: Math.round(intersection.z) }); return; }
    const hit = this.raycaster.intersectObjects([...this.scenery.children, ...this.actors.children], true).find(result => result.object.userData.entityId);
    if (hit) this.onSelect(hit.object.userData.entityId);
  }
  /** One line per sentry that holds a contact: cool while it only watches, warm once it commits. */
  private drawTracks() {
    const position = this.tracks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colour = this.tracks.geometry.getAttribute('color') as THREE.BufferAttribute;
    let pairs = 0;
    for (const unit of this.unitStates) {
      if (unit.task === 'none' || !isActive(unit.status)) continue;
      const committed = unit.task === 'intercept' && Boolean(unit.targetId);
      const targetId = committed ? unit.targetId : unit.tracking;
      if (!targetId) continue;
      const target = this.unitStates.find(item => item.id === targetId);
      const source = this.units.get(unit.id); const sink = this.units.get(targetId);
      if (!target || !source || !sink || pairs * 2 + 1 >= position.count) continue;
      position.setXYZ(pairs * 2, source.position.x, source.position.y, source.position.z);
      position.setXYZ(pairs * 2 + 1, sink.position.x, sink.position.y, sink.position.z);
      const tone = committed ? [1, 0.52, 0.26] : [0.33, 0.8, 0.96];
      colour.setXYZ(pairs * 2, tone[0], tone[1], tone[2]);
      colour.setXYZ(pairs * 2 + 1, tone[0], tone[1], tone[2]);
      pairs++;
    }
    this.tracks.geometry.setDrawRange(0, pairs * 2);
    position.needsUpdate = true; colour.needsUpdate = true;
  }
  private draw() {
    const now = performance.now(); this.frameCount++;
    if (now - this.frameTime >= 1000) { this.fps = this.frameCount * 1000 / (now - this.frameTime); this.frameCount = 0; this.frameTime = now; }
    this.unitStates.forEach(unit => {
      const group = this.units.get(unit.id); if (!group) return;
      group.position.lerp(new THREE.Vector3(unit.position.x, unit.position.y, unit.position.z), this.running ? 0.32 : 1);
      // A sentry yaws to keep its radar on a contact, so its own heading wins over its track.
      if (unit.task !== 'none') group.rotation.y = -unit.heading * Math.PI / 180;
      else if (Math.hypot(unit.velocity.x, unit.velocity.z) > 0.1) group.rotation.y = Math.atan2(-unit.velocity.x, -unit.velocity.z);
      const envelope = this.envelopes.get(unit.id);
      if (envelope) { envelope.position.copy(group.position); envelope.rotation.y = group.rotation.y; envelope.visible = isActive(unit.status); }
      const flightVisual = group.userData.flightVisual as THREE.Group | undefined;
      if (flightVisual) { const pitch = unit.status === 'airborne' ? Math.atan2(unit.velocity.y, Math.max(1, Math.hypot(unit.velocity.x, unit.velocity.z))) : 0; flightVisual.rotation.x += (pitch - flightVisual.rotation.x) * 0.18; }
      group.visible = !['stopped', 'expended', 'complete'].includes(unit.status);
      const label = this.labels.get(unit.id); if (!label) return;
      label.classList.toggle('inactive', !isActive(unit.status) && unit.status !== 'waiting');
      label.dataset.status = unit.status;
    });
    this.drawTracks();
    this.blasts.update(now / 1000);
    const focused = this.units.get(this.selected) ?? this.objects.get(this.selected);
    this.selectedRing.visible = Boolean(focused && focused.visible);
    if (focused) {
      this.selectedRing.position.set(focused.position.x, 3, focused.position.z);
      const object = this.scenario?.objects.find(item => item.id === this.selected); this.selectedRing.scale.setScalar(object ? Math.max(object.size.x, object.size.z) / 50 : 1.5);
      if (this.mode === 'follow') { this.controls.target.lerp(focused.position.clone().add(new THREE.Vector3(0, object ? object.size.y / 2 : 10, 0)), 0.12); const distance = object ? Math.max(object.size.x, object.size.z, 100) : 95; const offset = new THREE.Vector3(distance, distance * 0.7, distance * 1.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), focused.rotation.y); this.camera.position.lerp(focused.position.clone().add(offset), 0.08); }
    }
    this.controls.update();
    const occupied: { x: number; y: number }[] = [];
    const orderedLabels = [...this.labels].sort(([first], [second]) => Number(second === this.selected) - Number(first === this.selected));
    orderedLabels.forEach(([id, label]) => {
      const group = this.units.get(id) ?? this.objects.get(id)!; const vector = group.position.clone(); vector.y += this.scenario?.objects.find(item => item.id === id)?.size.y ?? 36; vector.project(this.camera);
      const x = (vector.x * 0.5 + 0.5) * this.host.clientWidth; const y = (-vector.y * 0.5 + 0.5) * this.host.clientHeight;
      const crowded = this.units.size > 12 && occupied.some(point => Math.abs(point.x - x) < 92 && Math.abs(point.y - y) < 28);
      const visible = !crowded && (!this.objects.has(id) || id === this.selected) && group.visible && vector.z < 1 && vector.z > -1 && Math.abs(vector.x) < 1.2 && Math.abs(vector.y) < 1.2;
      label.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) { occupied.push({ x, y }); label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`; }
    });
    if (this.rain.visible) { const positions = this.rain.geometry.attributes.position; for (let index = 0; index < positions.count; index++) positions.setY(index, (positions.getY(index) - 8 + 1100) % 1100); positions.needsUpdate = true; }
    if (this.appearance === 'holographic' && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
