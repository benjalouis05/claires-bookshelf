import * as THREE from "three";
import type { Book } from "../catalog";
import { drawSpine } from "../cover-art";

export type AtlasRect = {
  /** 0 and 1 are the far pages, 2 is the near (high-resolution) page. */
  page: number;
  /** Normalized, top-left origin: u, v, width, height. */
  u: number;
  v: number;
  du: number;
  dv: number;
};

const pageSize = 2048;
const farCell = { width: 32, height: 320 };
const nearCell = { width: 128, height: 1024 };
const farColumns = pageSize / farCell.width;
const farRows = Math.floor(pageSize / farCell.height);
const farPerPage = farColumns * farRows;
const nearColumns = pageSize / nearCell.width;
const nearRows = pageSize / nearCell.height;
export const nearCapacity = nearColumns * nearRows;

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function atlasTexture(canvas: HTMLCanvasElement, anisotropy: number) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/**
 * Every spine in the library lives in two 2048² "far" atlas pages (32×320
 * cells, ~45 MB with mipmaps for all 765 books). Books near the camera are
 * additionally redrawn at 128×1024 into a 32-cell "near" page, uploaded one
 * cell at a time with texSubImage2D.
 */
export class SpineAtlas {
  readonly farTextures: THREE.CanvasTexture[] = [];
  readonly nearTexture: THREE.CanvasTexture;
  private farRects: AtlasRect[] = [];
  private nearCanvas: HTMLCanvasElement;
  private scratch: HTMLCanvasElement;
  private scratchContext: CanvasRenderingContext2D | null;
  /** near cell → book index, and book index → near cell. */
  private nearOwner: Array<number | null> = new Array(nearCapacity).fill(null);
  private nearCellOf = new Map<number, number>();
  private nearUse: number[] = new Array(nearCapacity).fill(0);
  private useClock = 0;

  constructor(
    private books: Book[],
    private renderer: THREE.WebGLRenderer,
    anisotropy: number,
  ) {
    const pageCount = Math.max(1, Math.ceil(books.length / farPerPage));
    for (let page = 0; page < Math.max(2, pageCount); page += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = pageSize;
      canvas.height = pageSize;
      this.farTextures.push(atlasTexture(canvas, Math.min(4, anisotropy)));
    }
    this.nearCanvas = document.createElement("canvas");
    this.nearCanvas.width = pageSize;
    this.nearCanvas.height = pageSize;
    this.nearTexture = atlasTexture(this.nearCanvas, anisotropy);
    this.scratch = document.createElement("canvas");
    this.scratch.width = nearCell.width;
    this.scratch.height = nearCell.height;
    this.scratchContext = this.scratch.getContext("2d");
  }

  farRect(bookIndex: number) {
    return this.farRects[bookIndex];
  }

  /** Draws every far spine, yielding to the browser between chunks. */
  async build(onProgress: (fraction: number) => void, isCancelled: () => boolean) {
    const chunk = 48;
    for (let start = 0; start < this.books.length; start += chunk) {
      if (isCancelled()) return;
      for (let index = start; index < Math.min(this.books.length, start + chunk); index += 1) {
        const page = Math.floor(index / farPerPage);
        const cell = index % farPerPage;
        const x = (cell % farColumns) * farCell.width;
        const y = Math.floor(cell / farColumns) * farCell.height;
        const canvas = this.farTextures[page].image as HTMLCanvasElement;
        const ctx = canvas.getContext("2d");
        if (ctx) drawSpine(ctx, this.books[index], x, y, farCell.width, farCell.height);
        this.farRects[index] = {
          page,
          u: x / pageSize,
          v: y / pageSize,
          du: farCell.width / pageSize,
          dv: farCell.height / pageSize,
        };
      }
      onProgress(Math.min(1, (start + chunk) / this.books.length));
      await nextFrame();
    }
    this.farTextures.forEach((texture) => {
      texture.needsUpdate = true;
    });
    // Allocate GPU storage for the near page once; later cells are patched in.
    this.renderer.initTexture(this.nearTexture);
  }

  hasNear(bookIndex: number) {
    return this.nearCellOf.has(bookIndex);
  }

  nearRect(bookIndex: number): AtlasRect | null {
    const cell = this.nearCellOf.get(bookIndex);
    if (cell === undefined) return null;
    return this.rectForNearCell(cell);
  }

  private rectForNearCell(cell: number): AtlasRect {
    const x = (cell % nearColumns) * nearCell.width;
    const y = Math.floor(cell / nearColumns) * nearCell.height;
    return {
      page: 2,
      u: x / pageSize,
      v: y / pageSize,
      du: nearCell.width / pageSize,
      dv: nearCell.height / pageSize,
    };
  }

  /** Marks a book as wanted so it is not evicted this round. */
  touchNear(bookIndex: number) {
    const cell = this.nearCellOf.get(bookIndex);
    if (cell !== undefined) this.nearUse[cell] = ++this.useClock;
  }

  /**
   * Draws `bookIndex` into the least-recently-used near cell. Returns the
   * evicted book index (whose instance should fall back to its far rect).
   */
  addNear(bookIndex: number, protectedBooks: Set<number>) {
    if (this.nearCellOf.has(bookIndex) || !this.scratchContext) return undefined;
    let cell = -1;
    let oldest = Infinity;
    for (let candidate = 0; candidate < nearCapacity; candidate += 1) {
      const owner = this.nearOwner[candidate];
      if (owner !== null && protectedBooks.has(owner)) continue;
      if (this.nearUse[candidate] < oldest) {
        oldest = this.nearUse[candidate];
        cell = candidate;
      }
    }
    if (cell < 0) return undefined;
    const evicted = this.nearOwner[cell];
    if (evicted !== null) this.nearCellOf.delete(evicted);

    const ctx = this.scratchContext;
    ctx.clearRect(0, 0, nearCell.width, nearCell.height);
    drawSpine(ctx, this.books[bookIndex], 0, 0, nearCell.width, nearCell.height);
    // A fresh, never-uploaded CanvasTexture makes three copy straight from the
    // canvas with texSubImage2D, touching only this cell of the near page.
    const source = new THREE.CanvasTexture(this.scratch);
    const x = (cell % nearColumns) * nearCell.width;
    const y = Math.floor(cell / nearColumns) * nearCell.height;
    this.renderer.copyTextureToTexture(source, this.nearTexture, null, new THREE.Vector2(x, y));
    source.dispose();

    this.nearOwner[cell] = bookIndex;
    this.nearCellOf.set(bookIndex, cell);
    this.nearUse[cell] = ++this.useClock;
    return evicted ?? undefined;
  }

  dispose() {
    this.farTextures.forEach((texture) => texture.dispose());
    this.nearTexture.dispose();
  }
}
