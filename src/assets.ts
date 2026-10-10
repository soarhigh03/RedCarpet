import * as THREE from 'three';
import { IMAGE_MAP_PATH } from './image-map';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export const MODEL_FILES = ['military-jet', 'hostile-drone', 'tree-a', 'tree-b', 'tree-a-lod', 'tree-b-lod'] as const;
type ModelName = typeof MODEL_FILES[number];
type ModelPart = { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; matrix: THREE.Matrix4 };
/** Repeatable 0–1 scatter, so a grove lays out identically on every load without a visible lattice. */
const scatter = (value: number) => { const noise = Math.sin(value * 127.1 + 311.7) * 43758.5453; return noise - Math.floor(noise); };

export class SceneAssets {
  private models = new Map<ModelName, THREE.Group>();
  private treeParts = new Map<ModelName, ModelPart[]>();
  private distantParts = new Map<string, ModelPart[]>();
  grass?: THREE.Texture;
  referenceMap?: THREE.Texture;
  async load(): Promise<string[]> {
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`).setWorkerLimit(2);
    const loader = new GLTFLoader().setDRACOLoader(draco);
    const failed: string[] = [];
    await Promise.all([
      ...MODEL_FILES.map(async name => {
        try {
          const { scene } = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
          scene.traverse(child => {
            child.userData.sharedAsset = true;
            if (child instanceof THREE.Mesh) { child.castShadow = true; child.receiveShadow = true; }
          });
          this.models.set(name, scene);
        } catch { failed.push(name); }
      }),
      new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}${IMAGE_MAP_PATH}`).then(texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        this.referenceMap = texture;
      }).catch(() => { failed.push('fictional reference image'); }),
      new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}textures/grass.png`).then(texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.MirroredRepeatWrapping;
        texture.repeat.set(6200 / 4, 6000 / (4 * 1920 / 1080));
        this.grass = texture;
      }).catch(() => { failed.push('grass'); }),
    ]);
    draco.dispose();
    return failed;
  }
  jet(): THREE.Group | undefined {
    const template = this.models.get('military-jet'); if (!template) return;
    const model = template.clone(true);
    model.rotation.y = Math.PI;
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model); const center = bounds.getCenter(new THREE.Vector3());
    const scale = 64 / bounds.getSize(new THREE.Vector3()).z;
    const mount = new THREE.Group();
    model.position.set(-center.x * scale, -bounds.min.y * scale - 3.25, -center.z * scale);
    model.scale.setScalar(scale); mount.add(model);
    return mount;
  }
  hostileDrone(): THREE.Group | undefined {
    const template = this.models.get('hostile-drone'); if (!template) return;
    const model = template.clone(true);
    // The supplied mesh faces -X; vehicle motion uses local -Z as forward.
    model.rotation.y = -Math.PI / 2;
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model); const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3()); const scale = 58 / Math.max(size.x, size.z);
    const mount = new THREE.Group();
    model.position.copy(center).multiplyScalar(-scale);
    model.scale.setScalar(scale); mount.add(model);
    return mount;
  }
  private parts(name: ModelName): ModelPart[] {
    const cached = this.treeParts.get(name); if (cached) return cached;
    const template = this.models.get(name); if (!template) return [];
    template.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(template); const center = bounds.getCenter(new THREE.Vector3());
    const scale = 1 / bounds.getSize(new THREE.Vector3()).y;
    const normalize = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));
    const parts: ModelPart[] = [];
    template.traverse(child => { if (child instanceof THREE.Mesh) parts.push({ geometry: child.geometry, material: child.material, matrix: normalize.clone().multiply(child.matrixWorld) }); });
    this.treeParts.set(name, parts); return parts;
  }
  /**
   * Far stand-in for a supplied tree: a few dozen triangles in the same normalized space the GLB
   * parts use, so one instance matrix drives every level. Woodland is mostly seen from kilometres
   * away, where the detailed meshes cost thousands of triangles each and read as the same green mass.
   */
  private distant(variant: 'a' | 'b'): ModelPart[] {
    const cached = this.distantParts.get(variant); if (cached) return cached;
    const narrow = variant === 'a';
    // One canopy, no trunk: a trunk is below a pixel at this range and would double the draw calls.
    const canopy = new THREE.ConeGeometry(narrow ? 0.33 : 0.42, 0.94, 6);
    const parts: ModelPart[] = [{
      geometry: canopy,
      material: new THREE.MeshStandardMaterial({ color: narrow ? 0x5e7d64 : 0x74906f, roughness: 1, metalness: 0 }),
      matrix: new THREE.Matrix4().makeTranslation(0, 0.53, 0),
    }];
    this.distantParts.set(variant, parts); return parts;
  }
  /** Tree count follows the footprint, so a large woodland fills out instead of scattering a dozen trees. */
  private static density(width: number, depth: number) { return Math.max(12, Math.min(60, Math.round(width * depth / 8000))); }
  grove(width: number, height: number, depth: number): THREE.LOD | undefined {
    if (!this.models.has('tree-a') || !this.models.has('tree-b')) return;
    const lod = new THREE.LOD();
    const count = SceneAssets.density(width, depth);
    // Every level stands the same trees in the same places, so the placement is solved once.
    const placement = { a: [] as THREE.Matrix4[], b: [] as THREE.Matrix4[] };
    for (const variant of ['a', 'b'] as const) for (let index = 0; index < count; index++) {
      const tree = index * 2 + (variant === 'a' ? 0 : 1);
      const treeHeight = height * (0.65 + scatter(tree + 7) * 0.5);
      const position = new THREE.Vector3((scatter(tree) - 0.5) * width * 0.92, 0, (scatter(tree + 53) - 0.5) * depth * 0.92);
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), scatter(tree + 211) * Math.PI * 2);
      placement[variant].push(new THREE.Matrix4().compose(position, rotation, new THREE.Vector3().setScalar(treeHeight)));
    }
    const transform = new THREE.Matrix4();
    for (const [level, distance] of [0, 340, 1100].entries()) {
      const group = new THREE.Group();
      for (const variant of ['a', 'b'] as const) {
        const name: ModelName = `tree-${variant}${level === 1 && this.models.has(`tree-${variant}-lod`) ? '-lod' : ''}`;
        for (const part of level === 2 ? this.distant(variant) : this.parts(name)) {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, count);
          mesh.userData.sharedAsset = true; mesh.castShadow = true; mesh.receiveShadow = true;
          for (let index = 0; index < count; index++) mesh.setMatrixAt(index, transform.multiplyMatrices(placement[variant][index], part.matrix));
          mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); group.add(mesh);
        }
      }
      lod.addLevel(group, distance, 0.15);
    }
    return lod;
  }
}
