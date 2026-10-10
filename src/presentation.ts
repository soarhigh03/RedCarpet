import * as THREE from 'three';
import { createHolographicSurface } from './holographic-surface';

export type SceneAppearance = 'realistic' | 'holographic';
export const appearanceFromStorage = (value: string | null): SceneAppearance => value === 'realistic' ? 'realistic' : 'holographic';

/** Owns only display materials. Geometry, asset textures and simulation state stay untouched. */
export class HolographicMaterials {
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private surfaces = new Map<string, THREE.ShaderMaterial>();
  private edgeCache = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  private outlines: { parent: THREE.Mesh; line: THREE.LineSegments; instanced: boolean }[] = [];
  private edgeMaterial = new THREE.LineBasicMaterial({ color: 0x55d7ec, transparent: true, opacity: 0.65, depthWrite: false, toneMapped: false });
  private detailedEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x249bb8, transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false });
  private instancedEdgeMaterial = this.detailedEdgeMaterial.clone();

  constructor() {
    this.instancedEdgeMaterial.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute mat4 wireInstanceMatrix;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = (wireInstanceMatrix * vec4(transformed, 1.0)).xyz;');
    };
    this.instancedEdgeMaterial.customProgramCacheKey = () => 'airfield-instanced-edges-v1';
  }

  private outline(mesh: THREE.Mesh, detailed: boolean) {
    let edges = this.edgeCache.get(mesh.geometry);
    if (!edges) { edges = new THREE.EdgesGeometry(mesh.geometry, 24); this.edgeCache.set(mesh.geometry, edges); }
    let geometry: THREE.BufferGeometry = edges;
    const instanced = mesh instanceof THREE.InstancedMesh;
    if (instanced) {
      const copies = new THREE.InstancedBufferGeometry();
      copies.setAttribute('position', edges.getAttribute('position'));
      copies.setAttribute('wireInstanceMatrix', new THREE.InstancedBufferAttribute(mesh.instanceMatrix.array.slice(), 16));
      copies.instanceCount = mesh.count;
      geometry = copies;
    }
    const line = new THREE.LineSegments(geometry, instanced ? this.instancedEdgeMaterial : detailed ? this.detailedEdgeMaterial : this.edgeMaterial);
    line.name = 'Holographic contours'; line.raycast = () => {}; line.renderOrder = 1;
    // Instance bounds are already managed by the parent tree LOD groups.
    line.frustumCulled = !instanced;
    mesh.add(line); this.outlines.push({ parent: mesh, line, instanced });
  }

  apply(...roots: THREE.Object3D[]) {
    for (const root of roots) root.traverse(object => {
      if (!(object instanceof THREE.Mesh) || this.originals.has(object)) return;
      this.originals.set(object, object.material);
      const detailed = Boolean(object.userData.sharedAsset);
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox!;
      const size = bounds.getSize(new THREE.Vector3());
      const flat = !detailed && Math.min(size.x, size.y, size.z) <= 2;
      let glyph = false;
      const replace = (original: THREE.Material) => {
        // Preserve alpha-only painted runway text, without restoring photographic colors.
        const map = (original as THREE.MeshBasicMaterial).map;
        const mask = !detailed && map instanceof THREE.CanvasTexture ? map : undefined;
        glyph ||= Boolean(mask);
        const key = `${original.side}:${bounds.min.y}:${size.y}:${flat}:${mask?.uuid ?? ''}`;
        let material = this.surfaces.get(key);
        if (!material) {
          material = createHolographicSurface(original.side, bounds.min.y, size.y, flat, mask);
          this.surfaces.set(key, material);
        }
        return material;
      };
      object.material = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
      if (!glyph) this.outline(object, detailed);
    });
  }

  restore() {
    for (const { parent, line, instanced } of this.outlines) { parent.remove(line); if (instanced) line.geometry.dispose(); }
    this.outlines = [];
    for (const [mesh, original] of this.originals) mesh.material = original;
    this.originals.clear();
  }

  dispose() { this.restore(); this.surfaces.forEach(material => material.dispose()); this.surfaces.clear(); this.edgeCache.forEach(geometry => geometry.dispose()); this.edgeCache.clear(); this.edgeMaterial.dispose(); this.detailedEdgeMaterial.dispose(); this.instancedEdgeMaterial.dispose(); }
}

export function createHolographicGround() {
  const material = new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vGround;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vGround = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `varying vec2 vGround;
      float grid(vec2 coordinates, float scale) {
        vec2 cell = coordinates / scale;
        vec2 width = max(fwidth(cell), vec2(0.0001));
        vec2 lines = abs(fract(cell - 0.5) - 0.5) / width;
        return 1.0 - min(min(lines.x, lines.y), 1.0);
      }
      void main() {
        float fade = 1.0 - smoothstep(1800.0, 4100.0, length(vGround));
        float minor = grid(vGround, 100.0) * 0.07;
        float major = grid(vGround, 500.0) * 0.18;
        vec3 base = vec3(0.000607, 0.002732, 0.006049);
        vec3 lines = vec3(0.025, 0.36, 0.40) * (minor + major) * fade;
        gl_FragColor = vec4(base + lines, 1.0);
      }`,
    toneMapped: false,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(10000, 10000), material);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.2;
  ground.name = 'Holographic coordinate grid'; ground.visible = false;
  return ground;
}
