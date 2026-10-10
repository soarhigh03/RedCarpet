import * as THREE from 'three';

/** Display-only surface; local height preserves the gradient as vehicles move. */
export function createHolographicSurface(side: THREE.Side, minY: number, height: number, flat: boolean, mask?: THREE.Texture) {
  return new THREE.ShaderMaterial({
    name: 'Translucent cyan hologram',
    uniforms: {
      ...THREE.UniformsLib.fog,
      baseColor: { value: new THREE.Color(flat ? 0x063442 : 0x002936) },
      topColor: { value: new THREE.Color(flat ? 0x128798 : 0x00aace) },
      heightRange: { value: new THREE.Vector2(minY, Math.max(height, 0.001)) },
      surfaceOpacity: { value: flat ? 0.27 : 0.57 },
      glyphMask: { value: mask ?? null },
    },
    defines: mask ? { HOLOGRAM_GLYPH: 1 } : {},
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vHoloNormal;
      varying vec3 vHoloView;
      varying float vHeight;
      varying vec2 vGlyphUv;
      uniform vec2 heightRange;
      void main() {
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <project_vertex>
        #include <fog_vertex>
        vHoloNormal = normalize(transformedNormal);
        vHoloView = -mvPosition.xyz;
        vHeight = clamp((position.y - heightRange.x) / heightRange.y, 0.0, 1.0);
        vGlyphUv = uv;
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 baseColor;
      uniform vec3 topColor;
      uniform float surfaceOpacity;
      uniform sampler2D glyphMask;
      varying vec3 vHoloNormal;
      varying vec3 vHoloView;
      varying float vHeight;
      varying vec2 vGlyphUv;
      void main() {
        vec3 normal = normalize(vHoloNormal);
        float rim = pow(1.0 - abs(dot(normal, normalize(vHoloView))), 2.2);
        float facing = 0.76 + 0.24 * abs(dot(normal, normalize(vec3(-0.4, 0.8, 0.6))));
        vec3 color = mix(baseColor, topColor, 0.15 + 0.85 * smoothstep(0.0, 1.0, vHeight)) * facing;
        color += vec3(0.0, 0.20, 0.30) * rim;
        float alpha = surfaceOpacity + 0.17 * rim;
        #ifdef HOLOGRAM_GLYPH
          alpha = texture2D(glyphMask, vGlyphUv).a * 0.85;
          if (alpha < 0.03) discard;
          color = vec3(0.22, 0.9, 0.94);
        #endif
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true, depthWrite: false, side, fog: true,
    toneMapped: false, forceSinglePass: true,
  });
}
