import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { BookendKind } from "../layout-shelves";

/**
 * Low-poly shelf ornaments. Each is built from a handful of faceted
 * primitives merged into one flat-shaded, vertex-colored mesh (one draw call).
 */

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
  const shaped = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(matrix);
  geometry.dispose();
  shaped.clearGroups();
  shaped.deleteAttribute("uv");
  const tint = new THREE.Color(color);
  const colors = new Float32Array(shaped.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = tint.r;
    colors[i + 1] = tint.g;
    colors[i + 2] = tint.b;
  }
  shaped.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return shaped;
}

/** A faceted sphere: 80 triangles, the heart of the low-poly look. */
const gem = (detail = 1) => new THREE.IcosahedronGeometry(1, detail);

function buildMesh(parts: THREE.BufferGeometry[]) {
  const geometry = mergeGeometries(parts);
  parts.forEach((piece) => piece.dispose());
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.55,
      metalness: 0.02,
    }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export abstract class Bookend {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  protected body = new THREE.Group();
  protected pokeTime = -1;

  constructor(parts: THREE.BufferGeometry[], name: string) {
    this.group.name = name;
    this.mesh = buildMesh(parts);
    this.body.add(this.mesh);
    this.group.add(this.body);
  }

  /** Stand on a shelf with the front roughly flush with the book spines. */
  place(x: number, shelfTop: number) {
    this.group.position.set(x, shelfTop, -0.26);
  }

  poke() {
    if (this.pokeTime < 0) this.pokeTime = 0;
  }

  update(elapsed: number, delta: number, reducedMotion: boolean) {
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    if (reducedMotion) {
      this.pokeTime = -1;
      return;
    }
    let poke = -1;
    if (this.pokeTime >= 0) {
      this.pokeTime += delta;
      poke = this.pokeTime / 0.6;
      if (poke >= 1) {
        this.pokeTime = -1;
        poke = -1;
      }
    }
    this.animate(elapsed, poke);
  }

  /** `poke` runs 0→1 after a click, or is −1 when idle. */
  protected abstract animate(elapsed: number, poke: number): void;

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}

/** A little low-poly penguin in a red scarf. About 1.3 units tall. */
export class PenguinBookend extends Bookend {
  constructor() {
    const black = "#23262d";
    const white = "#f3efe6";
    const orange = "#f0a13a";
    const blush = "#f2a5a0";
    const scarf = "#c8423b";
    const walnut = "#4b3429";
    super(
      [
        part(new THREE.CylinderGeometry(0.34, 0.37, 0.08, 8), walnut, [0, 0.04, 0], [1, 1, 0.9]),
        part(gem(), black, [0, 0.52, 0], [0.3, 0.46, 0.26]),
        part(gem(), white, [0, 0.46, 0.12], [0.22, 0.35, 0.16]),
        part(gem(), black, [0, 1.06, 0.01], [0.22, 0.21, 0.21]),
        part(gem(), white, [0, 1.03, 0.1], [0.15, 0.13, 0.12]),
        part(gem(0), black, [-0.065, 1.08, 0.2], [0.032, 0.038, 0.024]),
        part(gem(0), black, [0.065, 1.08, 0.2], [0.032, 0.038, 0.024]),
        part(gem(0), white, [-0.057, 1.092, 0.222], [0.01, 0.01, 0.006]),
        part(gem(0), white, [0.073, 1.092, 0.222], [0.01, 0.01, 0.006]),
        part(gem(0), blush, [-0.12, 1.01, 0.175], [0.038, 0.024, 0.014], [0, -0.5, 0]),
        part(gem(0), blush, [0.12, 1.01, 0.175], [0.038, 0.024, 0.014], [0, 0.5, 0]),
        part(new THREE.ConeGeometry(0.05, 0.12, 4), orange, [0, 1.02, 0.255], [1, 1, 0.8], [Math.PI / 2, Math.PI / 4, 0]),
        part(new THREE.TorusGeometry(0.2, 0.05, 4, 10), scarf, [0, 0.9, 0.02], [1, 1, 0.95], [Math.PI / 2, 0, 0]),
        part(new THREE.BoxGeometry(0.09, 0.22, 0.045), scarf, [0.1, 0.78, 0.2], [1, 1, 1], [0.15, 0, -0.18]),
        part(gem(), black, [-0.29, 0.55, 0], [0.065, 0.25, 0.12], [0, 0, 0.32]),
        part(gem(), black, [0.29, 0.55, 0], [0.065, 0.25, 0.12], [0, 0, -0.32]),
        part(gem(0), orange, [-0.1, 0.1, 0.14], [0.09, 0.035, 0.13], [0, 0.25, 0]),
        part(gem(0), orange, [0.1, 0.1, 0.14], [0.09, 0.035, 0.13], [0, -0.25, 0]),
      ],
      "penguinBookend",
    );
  }

  protected animate(elapsed: number, poke: number) {
    // A gentle waddle in place; a click makes it hop and spin.
    this.body.rotation.z = Math.sin(elapsed * 1.4) * 0.035;
    this.body.rotation.y = Math.sin(elapsed * 0.7) * 0.08;
    if (poke >= 0) {
      this.body.position.y = Math.sin(poke * Math.PI) * 0.22;
      this.body.rotation.y += Math.sin(poke * Math.PI * 2) * 0.35;
    }
  }
}

/** Half-width of the board outline at t (0 = tail, 1 = nose). */
function boardHalfWidth(t: number) {
  return 0.27 * Math.pow(Math.sin(Math.PI * (0.08 + 0.92 * t)), 0.6) * (1 - 0.12 * t);
}

/** Outline polygon between t0 and t1 (a band across the board). */
function boardBand(t0: number, t1: number, length: number, inset = 0, steps = 6) {
  const shape = new THREE.Shape();
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + ((t1 - t0) * i) / steps;
    points.push([Math.max(0, boardHalfWidth(t) - inset), t * length]);
  }
  shape.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach(([x, y]) => shape.lineTo(x, y));
  [...points].reverse().forEach(([x, y]) => shape.lineTo(-x, y));
  shape.closePath();
  return shape;
}

/** A low-poly surfboard standing on its tail in a little wooden stand. */
export class SurfboardBookend extends Bookend {
  constructor() {
    const length = 2.05;
    const deck = "#f4ead5";
    const coral = "#e8735a";
    const teal = "#3fa7a3";
    const sand = "#d9b98a";
    const walnut = "#4b3429";
    const board = new THREE.ExtrudeGeometry(boardBand(0, 1, length, 0, 11), {
      depth: 0.05,
      bevelEnabled: true,
      bevelThickness: 0.018,
      bevelSize: 0.018,
      bevelSegments: 1,
      curveSegments: 2,
    });
    const front = 0.05 + 0.018 + 0.003;
    const flat = (shape: THREE.Shape) => new THREE.ShapeGeometry(shape, 1);
    const lift = 0.1;
    super(
      [
        // Stand: a chunky block with a slot the board sits in.
        part(new THREE.BoxGeometry(0.62, 0.12, 0.36), walnut, [0, 0.06, 0]),
        part(new THREE.BoxGeometry(0.5, 0.05, 0.3), sand, [0, 0.145, 0]),
        part(board, deck, [0, lift, -0.025]),
        // Coral stringer stripe, a teal nose band and a coral tail band.
        part(flat(boardBand(0.12, 0.8, length, 0.2, 5)), coral, [0, lift, front - 0.025]),
        part(flat(boardBand(0.74, 0.82, length, 0.01, 2)), teal, [0, lift, front - 0.024]),
        part(flat(boardBand(0.86, 0.9, length, 0.01, 2)), teal, [0, lift, front - 0.024]),
        part(flat(boardBand(0.06, 0.1, length, 0.01, 2)), coral, [0, lift, front - 0.024]),
        // Fin on the back.
        part(new THREE.ConeGeometry(0.1, 0.22, 3), teal, [0, lift + 0.32, -0.12], [0.3, 1, 1.2], [-Math.PI / 2, 0, 0]),
      ],
      "surfboardBookend",
    );
  }

  protected animate(elapsed: number, poke: number) {
    // Leans a touch, like it's propped against the books; a click wobbles it.
    this.body.rotation.z = -0.045 + Math.sin(elapsed * 0.9) * 0.008;
    if (poke >= 0) {
      this.body.rotation.z += Math.sin(poke * Math.PI * 3) * (1 - poke) * 0.09;
    }
  }
}

export function createBookend(kind: BookendKind): Bookend {
  return kind === "penguin" ? new PenguinBookend() : new SurfboardBookend();
}
