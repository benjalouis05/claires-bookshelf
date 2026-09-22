import * as THREE from "three";

/**
 * Procedural wood for the merged bookcase meshes, computed in the fragment
 * shader from world position (no textures, so it never stretches):
 * long grain lines with gentle waviness, fine flecks, and planks of slightly
 * different tone separated by faint seams.
 */

/**
 * Tags a piece of furniture before merging. `vertical` pieces (the sides)
 * run their grain up and down; `tone` in [0, 1] shifts the board's shade.
 */
export function tagWood(geometry: THREE.BufferGeometry, vertical: boolean, tone: number) {
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("aGrain", new THREE.BufferAttribute(new Float32Array(count).fill(vertical ? 1 : 0), 1));
  geometry.setAttribute("aTone", new THREE.BufferAttribute(new Float32Array(count).fill(tone), 1));
  return geometry;
}

const woodFunctions = /* glsl */ `
  varying vec3 vWoodPos;
  varying float vGrain;
  varying float vTone;

  float woodHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float woodNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(woodHash(i), woodHash(i + vec2(1.0, 0.0)), u.x),
      mix(woodHash(i + vec2(0.0, 1.0)), woodHash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
`;

export function applyWoodGrain(material: THREE.Material, cacheKey: string, strength = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWoodStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aGrain;
        attribute float aTone;
        varying vec3 vWoodPos;
        varying float vGrain;
        varying float vTone;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vWoodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGrain = aGrain;
        vTone = aTone;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uWoodStrength;
        ${woodFunctions}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          // along: the length of the board; across: through its growth rings.
          float along = vGrain > 0.5 ? vWoodPos.y : vWoodPos.x;
          float across = vGrain > 0.5
            ? vWoodPos.x * 0.8 + vWoodPos.z * 0.6
            : vWoodPos.y * 0.9 + vWoodPos.z * 0.55;

          // Planks about 2.6 units long, each with its own shade and a seam.
          float plankId = floor(along / 2.6 + vTone * 7.0);
          float plankTone = woodHash(vec2(plankId, vTone * 13.0)) - 0.5;
          float seamPos = fract(along / 2.6 + vTone * 7.0);
          float seam = smoothstep(0.0, 0.006, seamPos) * smoothstep(1.0, 0.994, seamPos);

          float warp = woodNoise(vec2(along * 0.45, across * 3.0 + plankId * 5.0));
          float rings = sin(across * 78.0 + warp * 7.0 + sin(along * 0.7 + plankId) * 1.6);
          float grain = smoothstep(-0.3, 1.0, rings);
          float fine = woodNoise(vec2(along * 1.2, across * 160.0));
          float fleck = woodNoise(vec2(along * 5.0, across * 55.0));
          float knot = smoothstep(0.82, 0.97, woodNoise(vec2(along * 0.6 + 11.0, across * 2.5 + plankId)));

          float shade = 0.74 + 0.3 * grain + 0.12 * fine + 0.08 * fleck - 0.16 * knot;
          shade *= 1.0 + (vTone - 0.5) * 0.24 + plankTone * 0.2;
          shade *= mix(0.62, 1.0, seam);
          // Planks drift between redder and more golden walnut.
          vec3 hue = mix(vec3(1.08, 0.94, 0.86), vec3(0.95, 1.02, 1.06), fract(plankTone + 0.5));
          diffuseColor.rgb *= mix(vec3(1.0), shade * hue, uWoodStrength);
        }`,
      );
  };
  material.customProgramCacheKey = () => cacheKey;
}
