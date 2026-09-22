import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const black = "#23262d";
const white = "#f3efe6";
const orange = "#f0a13a";
const blush = "#f2a5a0";
const scarf = "#c8423b";
const walnut = "#4b3429";

function part(
  geometry: THREE.BufferGeometry,
  color: string,
  position: [number, number, number],
  scale: [number, number, number] = [1, 1, 1],
  rotation: [number, number, number] = [0, 0, 0],
) {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  );
  const shaped = geometry.toNonIndexed().applyMatrix4(matrix);
  geometry.dispose();
  const tint = new THREE.Color(color);
  const colors = new Float32Array(shaped.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = tint.r;
    colors[i + 1] = tint.g;
    colors[i + 2] = tint.b;
  }
  shaped.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  shaped.deleteAttribute("uv");
  return shaped;
}

const sphere = () => new THREE.SphereGeometry(1, 32, 20);

/**
 * A little penguin bookend (about 1.3 units tall, facing +Z, origin at the
 * base). All parts share one vertex-colored mesh, so it is a single draw call.
 */
export class Penguin {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private body = new THREE.Group();
  private hopTime = -1;

  constructor() {
    this.group.name = "penguinBookend";
    const parts = [
      // Walnut plinth the penguin stands on.
      part(new THREE.CylinderGeometry(0.34, 0.36, 0.07, 40), walnut, [0, 0.035, 0], [1, 1, 0.9]),
      // Body, belly and head.
      part(sphere(), black, [0, 0.52, 0], [0.3, 0.46, 0.26]),
      part(sphere(), white, [0, 0.46, 0.13], [0.22, 0.35, 0.15]),
      part(sphere(), black, [0, 1.06, 0.01], [0.22, 0.21, 0.21]),
      part(sphere(), white, [0, 1.03, 0.1], [0.15, 0.13, 0.12]),
      // Eyes, cheeks and beak.
      part(sphere(), black, [-0.065, 1.08, 0.205], [0.028, 0.034, 0.02]),
      part(sphere(), black, [0.065, 1.08, 0.205], [0.028, 0.034, 0.02]),
      part(sphere(), white, [-0.058, 1.09, 0.222], [0.008, 0.008, 0.006]),
      part(sphere(), white, [0.072, 1.09, 0.222], [0.008, 0.008, 0.006]),
      part(sphere(), blush, [-0.12, 1.01, 0.18], [0.035, 0.022, 0.012], [0, -0.5, 0]),
      part(sphere(), blush, [0.12, 1.01, 0.18], [0.035, 0.022, 0.012], [0, 0.5, 0]),
      part(new THREE.ConeGeometry(0.045, 0.11, 20), orange, [0, 1.02, 0.255], [1, 1, 0.8], [Math.PI / 2, 0, 0]),
      // Scarf around the neck, with a tail hanging down the front.
      part(new THREE.TorusGeometry(0.2, 0.045, 14, 40), scarf, [0, 0.9, 0.02], [1, 1, 0.95], [Math.PI / 2, 0, 0]),
      part(new THREE.BoxGeometry(0.09, 0.22, 0.04), scarf, [0.1, 0.78, 0.2], [1, 1, 1], [0.15, 0, -0.18]),
      // Flippers and feet.
      part(sphere(), black, [-0.29, 0.55, 0], [0.06, 0.25, 0.12], [0, 0, 0.32]),
      part(sphere(), black, [0.29, 0.55, 0], [0.06, 0.25, 0.12], [0, 0, -0.32]),
      part(sphere(), orange, [-0.1, 0.09, 0.14], [0.085, 0.03, 0.12], [0, 0.25, 0]),
      part(sphere(), orange, [0.1, 0.09, 0.14], [0.085, 0.03, 0.12], [0, -0.25, 0]),
    ];
    const geometry = mergeGeometries(parts);
    parts.forEach((geometry) => geometry.dispose());
    geometry.computeBoundingSphere();

    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.02 }),
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.body.add(this.mesh);
    this.group.add(this.body);
  }

  /** Stand the penguin on a shelf, its front flush with the book spines. */
  place(x: number, shelfTop: number) {
    this.group.position.set(x, shelfTop, -0.26);
  }

  hop() {
    if (this.hopTime < 0) this.hopTime = 0;
  }

  update(elapsed: number, delta: number, reducedMotion: boolean) {
    if (reducedMotion) {
      this.body.rotation.set(0, 0, 0);
      this.body.position.y = 0;
      this.hopTime = -1;
      return;
    }
    // A gentle waddle-in-place, pivoting on the plinth.
    this.body.rotation.z = Math.sin(elapsed * 1.4) * 0.035;
    this.body.rotation.y = Math.sin(elapsed * 0.7) * 0.08;
    if (this.hopTime >= 0) {
      this.hopTime += delta;
      const t = this.hopTime / 0.55;
      this.body.position.y = t < 1 ? Math.sin(t * Math.PI) * 0.22 : 0;
      this.body.rotation.y += t < 1 ? Math.sin(t * Math.PI * 2) * 0.3 : 0;
      if (t >= 1) this.hopTime = -1;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}
