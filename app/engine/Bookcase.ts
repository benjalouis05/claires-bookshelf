import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { drawShelfLabel } from "../cover-art";

export const rowHeight = 2.75;
export const boardFrontZ = 0.85;

export function shelfTopY(row: number) {
  return -row * rowHeight;
}

const labelCell = { width: 1024, height: 64 };

/**
 * Walnut bookcase for any number of shelves. Boards, lips, sides and labels
 * are merged into four meshes so furniture costs a constant few draw calls.
 */
export class Bookcase {
  readonly group = new THREE.Group();
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
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.anisotropy = anisotropy;
    this.labelMaterial = new THREE.MeshStandardMaterial({
      map: this.labelTexture,
      roughness: 0.5,
      metalness: 0.1,
      transparent: true,
    });
  }

  private clearMeshes() {
    this.group.children.slice().forEach((child) => {
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
      boards.push(board);
      if (row >= 0) {
        const lip = new THREE.BoxGeometry(width, 0.24, 0.12);
        lip.translate(centerX, y - 0.12, boardFrontZ + 0.02);
        lips.push(lip);
      }
    }
    const sideHeight = this.topY - this.bottomY;
    for (const x of [-0.35 - 0.13, this.shelfWidth + 0.35 + 0.13]) {
      const side = new RoundedBoxGeometry(0.26, sideHeight, depth + 0.1, 2, 0.05);
      side.translate(x, this.bottomY + sideHeight * 0.5, centerZ + 0.05);
      boards.push(side);
    }
    const plinth = new RoundedBoxGeometry(width + 0.52, 0.5, depth + 0.1, 2, 0.04);
    plinth.translate(centerX, this.bottomY + 0.25, centerZ + 0.05);
    boards.push(plinth);

    const wood = new THREE.Mesh(mergeGeometries(boards), this.woodMaterial);
    wood.name = "bookcaseWood";
    wood.castShadow = true;
    wood.receiveShadow = true;
    this.group.add(wood);
    boards.forEach((geometry) => geometry.dispose());

    const lip = new THREE.Mesh(mergeGeometries(lips), this.lipMaterial);
    lip.name = "bookcaseLips";
    lip.castShadow = true;
    this.group.add(lip);
    lips.forEach((geometry) => geometry.dispose());

    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 0.2, sideHeight),
      this.backMaterial,
    );
    back.name = "bookcaseBack";
    back.position.set(centerX, this.bottomY + sideHeight * 0.5, centerZ - depth * 0.5 - 0.01);
    back.receiveShadow = true;
    this.group.add(back);

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
    const labelHeight = 0.18;
    const labelWidth = labelHeight * (labelCell.width / labelCell.height);
    for (let row = 0; row < rows; row += 1) {
      const quad = new THREE.PlaneGeometry(labelWidth, labelHeight);
      const uv = quad.getAttribute("uv");
      const v0 = 1 - (row + 1) / rows;
      const v1 = 1 - row / rows;
      for (let i = 0; i < uv.count; i += 1) {
        uv.setY(i, uv.getY(i) > 0.5 ? v1 : v0);
      }
      quad.translate(0.35 + labelWidth * 0.5, shelfTopY(row) - 0.12, boardFrontZ + 0.081);
      quads.push(quad);
    }
    if (quads.length) {
      const labels = new THREE.Mesh(mergeGeometries(quads), this.labelMaterial);
      labels.name = "shelfLabels";
      this.group.add(labels);
      quads.forEach((geometry) => geometry.dispose());
    }
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
    this.woodMaterial.dispose();
    this.lipMaterial.dispose();
    this.backMaterial.dispose();
    this.labelMaterial.dispose();
    this.labelTexture.dispose();
  }
}
