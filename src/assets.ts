import * as THREE from 'three';
import { IMAGE_MAP_PATH } from './image-map';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export const MODEL_FILES = ['military-jet', 'hostile-drone', 'tree-a', 'tree-b', 'tree-a-lod', 'tree-b-lod'] as const;
type ModelName = typeof MODEL_FILES[number];
type ModelPart = { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; matrix: THREE.Matrix4 };

export class SceneAssets {
  private models = new Map<ModelName, THREE.Group>();
  private treeParts = new Map<ModelName, ModelPart[]>();
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
  grove(width: number, height: number, depth: number): THREE.LOD | undefined {
    if (!this.models.has('tree-a') || !this.models.has('tree-b')) return;
    const lod = new THREE.LOD();
    for (const distant of [false, true]) {
      const level = new THREE.Group();
      for (const variant of ['a', 'b'] as const) {
        const name: ModelName = `tree-${variant}${distant && this.models.has(`tree-${variant}-lod`) ? '-lod' : ''}`;
        for (const part of this.parts(name)) {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, 12);
          mesh.userData.sharedAsset = true; mesh.castShadow = true; mesh.receiveShadow = true;
          for (let index = 0; index < 12; index++) {
            const tree = index * 2 + (variant === 'a' ? 0 : 1);
            const treeHeight = height * (0.65 + (Math.sin(tree * 10) + 1) * 0.25);
            const position = new THREE.Vector3(Math.sin(tree * 27.1) * width * 0.42, 0, Math.cos(tree * 19.7) * depth * 0.42);
            const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree * 2.4);
            const transform = new THREE.Matrix4().compose(position, rotation, new THREE.Vector3().setScalar(treeHeight));
            mesh.setMatrixAt(index, transform.multiply(part.matrix));
          }
          mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); level.add(mesh);
        }
      }
      lod.addLevel(level, distant ? 850 : 0, 0.15);
    }
    return lod;
  }
}
