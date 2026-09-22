import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { drawShelfLabel } from "../cover-art";
import type { BookendKind, ShelfLayout } from "../layout-shelves";
import { createBookend, type Bookend } from "./Bookends";
import { applyWoodGrain, tagWood } from "./wood";

export const rowHeight = 2.75;
export const boardFrontZ = 0.85;

export function shelfTopY(row: number) {
  return -row * rowHeight;
}

const labelCell = { width: 1024, height: 128 };
/** Brass shelf plates: world size of one label. */
const labelHeight = 0.2;
const labelWidth = labelHeight * (labelCell.width / labelCell.height);

/** A stable pseudo-random tone per board so the wood isn't uniform. */
function toneFor(seed: number) {
  const x = Math.sin(seed * 91.17 + 3.1) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Walnut bookcase for any number of shelves. Boards, lips, sides and labels
 * are merged into four meshes so furniture costs a constant few draw calls.
 */
export class Bookcase {
  readonly group = new THREE.Group();
  /** Shelf ornaments (penguin, surfboard), created on first use. */
  readonly bookends = new Map<BookendKind, Bookend>();
  /** Merged furniture meshes, rebuilt whenever the shelf count changes. */
  private furniture = new THREE.Group();
  private labelCanvas = document.createElement("canvas");
  private labelTexture: THREE.CanvasTexture;
  private woodMaterial = new THREE.MeshStandardMaterial({
    color: "#5a4132",
    roughness: 0.62,
    metalness: 0.03,
  });
  private lipMaterial = new THREE.MeshPhysicalMaterial({
    color: "#4b3429",
    roughness: 0.46,
    clearcoat: 0.14,
    clearcoatRoughness: 0.5,
  });
  private backMaterial = new THREE.MeshStandardMaterial({
    color: "#e3d8c4",
    roughness: 0.9,
    metalness: 0,
  });
  private labelMaterial: THREE.MeshStandardMaterial;
  rows = 0;
  bottomY = 0;
  topY = 0;

  constructor(
    private shelfWidth: number,
    anisotropy: number,
  ) {
    this.group.name = "bookcase";
    this.group.add(this.furniture);
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.anisotropy = anisotropy;
    this.labelMaterial = new THREE.MeshStandardMaterial({
      map: this.labelTexture,
      roughness: 0.34,
      metalness: 0.18,
      transparent: true,
    });
    // Kept faint: a hint of grain and plank variation, not a busy pattern.
    applyWoodGrain(this.woodMaterial, "bookcase-wood-v2", 0.32);
    applyWoodGrain(this.lipMaterial, "bookcase-lip-v2", 0.28);
  }

  private clearMeshes() {
    this.furniture.children.slice().forEach((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      child.removeFromParent();
    });
  }

  build(rows: number) {
    this.clearMeshes();
    this.rows = rows;
    const width = this.shelfWidth + 0.7;
    const centerX = this.shelfWidth * 0.5;
    const depth = 2.3;
    const centerZ = boardFrontZ - depth * 0.5;
    this.topY = shelfTopY(-1) + 0.2;
    this.bottomY = shelfTopY(rows - 1) - 0.62;

    const boards: THREE.BufferGeometry[] = [];
    const lips: THREE.BufferGeometry[] = [];
    for (let row = -1; row < rows; row += 1) {
      const y = shelfTopY(row);
      const board = new RoundedBoxGeometry(width, 0.22, depth, 2, 0.04);
      board.translate(centerX, row === -1 ? y + 0.02 : y - 0.11, centerZ);
      boards.push(tagWood(board, false, toneFor(row + 2)));
      if (row >= 0) {
        const lip = new THREE.BoxGeometry(width, 0.24, 0.12).toNonIndexed();
        lip.translate(centerX, y - 0.12, boardFrontZ + 0.02);
        lips.push(tagWood(lip, false, toneFor(row + 40)));
      }
    }
    const sideHeight = this.topY - this.bottomY;
    for (const x of [-0.35 - 0.13, this.shelfWidth + 0.35 + 0.13]) {
      const side = new RoundedBoxGeometry(0.26, sideHeight, depth + 0.1, 2, 0.05);
      side.translate(x, this.bottomY + sideHeight * 0.5, centerZ + 0.05);
      boards.push(tagWood(side, true, toneFor(x)));
    }
    const plinth = new RoundedBoxGeometry(width + 0.52, 0.5, depth + 0.1, 2, 0.04);
    plinth.translate(centerX, this.bottomY + 0.25, centerZ + 0.05);
    boards.push(tagWood(plinth, false, 0.3));

    const wood = new THREE.Mesh(mergeGeometries(boards), this.woodMaterial);
    wood.name = "bookcaseWood";
    wood.castShadow = true;
    wood.receiveShadow = true;
    this.furniture.add(wood);
    boards.forEach((geometry) => geometry.dispose());

    const lip = new THREE.Mesh(mergeGeometries(lips), this.lipMaterial);
    lip.name = "bookcaseLips";
    lip.castShadow = true;
    this.furniture.add(lip);
    lips.forEach((geometry) => geometry.dispose());

    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 0.2, sideHeight),
      this.backMaterial,
    );
    back.name = "bookcaseBack";
    back.position.set(centerX, this.bottomY + sideHeight * 0.5, centerZ - depth * 0.5 - 0.01);
    back.receiveShadow = true;
    this.furniture.add(back);

    // One quad per shelf, all sampling rows of a single label atlas.
    const labelCanvasHeight = labelCell.height * Math.max(1, rows);
    if (this.labelCanvas.height !== labelCanvasHeight) {
      // WebGL2 textures are immutable in size; resize means a new texture.
      this.labelCanvas.width = labelCell.width;
      this.labelCanvas.height = labelCanvasHeight;
      const anisotropy = this.labelTexture.anisotropy;
      this.labelTexture.dispose();
      this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
      this.labelTexture.colorSpace = THREE.SRGBColorSpace;
      this.labelTexture.anisotropy = anisotropy;
      this.labelMaterial.map = this.labelTexture;
      this.labelMaterial.needsUpdate = true;
    }
    const quads: THREE.BufferGeometry[] = [];
    for (let row = 0; row < rows; row += 1) {
      const quad = new THREE.PlaneGeometry(labelWidth, labelHeight);
      const uv = quad.getAttribute("uv");
      const v0 = 1 - (row + 1) / rows;
      const v1 = 1 - row / rows;
      for (let i = 0; i < uv.count; i += 1) {
        uv.setY(i, uv.getY(i) > 0.5 ? v1 : v0);
      }
      quad.translate(this.shelfWidth * 0.5, shelfTopY(row) - 0.12, boardFrontZ + 0.081);
      quads.push(quad);
    }
    if (quads.length) {
      const labels = new THREE.Mesh(mergeGeometries(quads), this.labelMaterial);
      labels.name = "shelfLabels";
      this.furniture.add(labels);
      quads.forEach((geometry) => geometry.dispose());
    }
  }

  /** Stands each bookend in the gap the layout left for it. */
  setBookends(placed: ShelfLayout["bookends"]) {
    this.bookends.forEach((bookend) => {
      bookend.group.visible = false;
    });
    for (const { kind, shelf, x } of placed) {
      let bookend = this.bookends.get(kind);
      if (!bookend) {
        bookend = createBookend(kind);
        this.bookends.set(kind, bookend);
        this.group.add(bookend.group);
      }
      bookend.group.visible = true;
      bookend.place(x, shelfTopY(shelf));
    }
  }

  update(elapsed: number, delta: number, reducedMotion: boolean) {
    this.bookends.forEach((bookend) => {
      if (bookend.group.visible) bookend.update(elapsed, delta, reducedMotion);
    });
  }

  /** The bookend under a ray, if any. */
  pickBookend(raycaster: THREE.Raycaster) {
    for (const bookend of this.bookends.values()) {
      if (!bookend.group.visible) continue;
      if (raycaster.intersectObject(bookend.group, true).length) return bookend;
    }
    return null;
  }

  setLabels(labels: string[]) {
    const ctx = this.labelCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    labels.forEach((text, row) => {
      drawShelfLabel(
        ctx,
        0,
        row * labelCell.height,
        labelCell.width,
        labelCell.height,
        String(row + 1).padStart(2, "0"),
        text,
      );
    });
    this.labelTexture.needsUpdate = true;
  }

  dispose() {
    this.clearMeshes();
    this.bookends.forEach((bookend) => bookend.dispose());
    this.bookends.clear();
    this.woodMaterial.dispose();
    this.lipMaterial.dispose();
    this.backMaterial.dispose();
    this.labelMaterial.dispose();
    this.labelTexture.dispose();
  }
}
