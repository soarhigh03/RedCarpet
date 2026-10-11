import * as THREE from 'three';
import type { Vec3 } from './types';

const DEBRIS = 26;
const LIFE = 1.15;      // seconds from flash to gone
const SHARDS = 0.42;    // how long the debris outruns the fireball

type Burst = {
  group: THREE.Group;
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  wave: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  shards: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  spread: Float32Array;
  born: number;
};

const ease = (value: number) => 1 - (1 - value) ** 3;

/**
 * Takedown flashes, pooled.
 *
 * One burst is a white core that swells and cools to orange, a shockwave ring thrown out flat, and
 * a scatter of debris that outruns both. Everything is additive and depth-write off, so it reads on
 * the pale realistic sky and the dark holographic ground without being restyled by either.
 */
export class Blasts {
  readonly group = new THREE.Group();
  private pool: Burst[] = [];
  private live: Burst[] = [];
  private sphere = new THREE.SphereGeometry(1, 14, 10);
  private ring = new THREE.RingGeometry(0.72, 1, 36);

  constructor(private size = 10) { this.group.name = 'Takedown effects'; }

  private make(): Burst {
    const group = new THREE.Group();
    const core = new THREE.Mesh(this.sphere, new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    const wave = new THREE.Mesh(this.ring, new THREE.MeshBasicMaterial({ color: 0xffb259, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
    wave.rotation.x = -Math.PI / 2;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DEBRIS * 3), 3));
    const shards = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xffd9a0, size: 2.6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    shards.frustumCulled = false;
    group.add(core, wave, shards); group.visible = false;
    this.group.add(group);
    return { group, core, wave, shards, spread: new Float32Array(DEBRIS * 3), born: 0 };
  }

  /** Light one off. Oldest in flight is recycled once the pool is full, so this never allocates mid-run. */
  spawn(at: Vec3, now: number) {
    const burst = this.pool.pop() ?? (this.group.children.length < this.size ? this.make() : this.live.shift()!);
    burst.group.position.set(at.x, at.y, at.z);
    burst.group.visible = true;
    burst.born = now;
    for (let index = 0; index < DEBRIS; index++) {
      // Even-ish directions from a golden-angle spiral, then biased outward and a little upward.
      const climb = 1 - 2 * (index + 0.5) / DEBRIS;
      const radius = Math.sqrt(Math.max(0, 1 - climb * climb));
      const turn = index * 2.399963;
      const speed = 26 + (index % 5) * 7;
      burst.spread[index * 3] = Math.cos(turn) * radius * speed;
      burst.spread[index * 3 + 1] = (climb * 0.7 + 0.35) * speed;
      burst.spread[index * 3 + 2] = Math.sin(turn) * radius * speed;
    }
    this.live.push(burst);
  }

  /** Advance every burst. Returns nothing; the group is already in the scene. */
  update(now: number) {
    for (let index = this.live.length - 1; index >= 0; index--) {
      const burst = this.live[index];
      const age = (now - burst.born) / LIFE;
      if (age >= 1) {
        burst.group.visible = false;
        this.live.splice(index, 1); this.pool.push(burst);
        continue;
      }
      const grown = ease(age);
      // Core: a hard flash that swells fast, then cools from white through amber as it fades.
      const flash = Math.min(1, age / 0.09);
      burst.core.scale.setScalar(4 + grown * 26);
      burst.core.material.opacity = (1 - age) ** 2 * (0.35 + 0.65 * (1 - flash * 0.4));
      burst.core.material.color.setRGB(1, 0.95 - grown * 0.55, 0.82 - grown * 0.72);
      // Shockwave: thrown out flat and thinning.
      burst.wave.scale.setScalar(8 + grown * 62);
      burst.wave.material.opacity = Math.max(0, 0.55 - age * 0.7);
      // Debris outruns the fireball, then drops away.
      const position = burst.shards.geometry.getAttribute('position') as THREE.BufferAttribute;
      const travel = Math.min(age, SHARDS) * LIFE;
      for (let shard = 0; shard < DEBRIS; shard++) {
        position.setXYZ(shard,
          burst.spread[shard * 3] * travel,
          burst.spread[shard * 3 + 1] * travel - 9.8 * travel * travel * 0.5,
          burst.spread[shard * 3 + 2] * travel);
      }
      position.needsUpdate = true;
      burst.shards.material.opacity = Math.max(0, 1 - age / SHARDS * 0.9);
    }
  }

  dispose() {
    this.sphere.dispose(); this.ring.dispose();
    for (const burst of [...this.pool, ...this.live]) {
      burst.core.material.dispose(); burst.wave.material.dispose();
      burst.shards.material.dispose(); burst.shards.geometry.dispose();
    }
    this.pool = []; this.live = [];
  }
}
