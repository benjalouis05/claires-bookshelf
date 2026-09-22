import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Book } from "../catalog";
import {
  bookFootprintsOverlap,
  browseMotionPose,
  browsePhaseDuration,
  createMotionLayout,
  focusedBookPose,
  layoutForBook,
  presentedBookPose,
  shelvedBookPose,
  type BookFootprint,
  type BookPose,
  type BrowseMotionPhase,
  type MotionLayout,
} from "../book-motion";
import {
  defaultShelfOptions,
  layoutShelves,
  nearestOnRow,
  type ShelfLayout,
} from "../layout-shelves";
import { siteConfig } from "../site-config";
import { Bookcase, boardFrontZ, rowHeight, shelfTopY } from "./Bookcase";
import { HeroBook } from "./HeroBook";
import { InstancedLibrary } from "./InstancedLibrary";
import { SpineAtlas, nearCapacity } from "./SpineAtlas";
import { TextureCache } from "./TextureCache";

export type ShelfMode = "bookcase" | "browse" | "focusing" | "inspect" | "returning";

export type ShelfCallbacks = {
  /** Display position of the book presented on the shelf (browse view). */
  onActiveIndex: (position: number) => void;
  /** Shelf centered in the bookcase view. */
  onShelf: (shelf: number) => void;
  onMode: (mode: ShelfMode, selectedPosition: number | null) => void;
  onStatus: (message: string) => void;
  onProgress: (fraction: number) => void;
  onReady: () => void;
  onContextLost: () => void;
};

const shelfWidth = defaultShelfOptions.shelfWidth;
const slotZ = 0.04;
const browseCameraOffset = new THREE.Vector3(0, 1.14, 7.1);
const browseTargetOffset = new THREE.Vector3(0, 1.0, 0.15);
const mobileBrowseCameraOffset = new THREE.Vector3(0, 1.16, 8.3);
const clamp = THREE.MathUtils.clamp;
const focusInDuration = 0.46;
const focusOutDuration = 0.34;
const desktopDetailWidthRatio = 0.41;
const compactDetailWidthRatio = 0.48;
const desktopDetailMaxWidth = 620;
const compactDetailMaxWidth = 570;
const desktopFocusX = -0.58;
const desktopFocusZ = 1.66;
const desktopFocusScale = 1.08;
const mobileFocusZ = 1.4;
const mobileFocusScale = 0.92;
const inspectionIdleLift = 0.014;
const inspectionIdlePitch = THREE.MathUtils.degToRad(0.28);
const inspectionIdleYaw = THREE.MathUtils.degToRad(0.48);
const inspectionIdleRoll = THREE.MathUtils.degToRad(0.22);
/** Books within this many positions of the active one get hi-res spines. */
const nearRadius = Math.floor((nearCapacity - 3) / 2);
const coverPrefetchRadius = 3;
const sortDuration = 0.95;
const sortStagger = 0.4;
const sortFlightZ = 1.95;

function damp(current: number, target: number, lambda: number, delta: number) {
  return THREE.MathUtils.damp(current, target, lambda, delta);
}

function easeOutCubic(value: number) {
  const t = 1 - clamp(value, 0, 1);
  return 1 - t * t * t;
}

function smooth(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export class ShelfEngine {
  private canvas: HTMLCanvasElement;
  private books: Book[];
  private callbacks: ShelfCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private keyLight: THREE.DirectionalLight;
  private shadowSpan = 0;
  private anisotropy: number;
  private atlas: SpineAtlas;
  private library: InstancedLibrary;
  private bookcase: Bookcase;
  private textureCache: TextureCache;
  private heroes = new Map<number, HeroBook>();
  private motionLayouts: MotionLayout[];

  private order: number[];
  private positionOf: Int32Array;
  private layout: ShelfLayout;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(10, 10);
  private pointerDirty = false;
  private hoverInstance: number | null = null;
  private hoverAmounts = new Map<number, number>();
  private animationFrame = 0;
  private resizeObserver: ResizeObserver;
  private mode: ShelfMode = "bookcase";
  private selectedIndex: number | null = null;
  private activeIndex = 0;
  private presentedIndex: number | null = null;
  private pendingFocusIndex: number | null = null;
  private browseMotionPhase: BrowseMotionPhase | "idle" = "idle";
  private browseMotionProgress = 0;
  private motionBookIndex: number | null = null;
  private collisionRejects = 0;
  private lastCollisionPair: [string, string] | null = null;
  private scrollIndex = 0;
  private targetScrollIndex = 0;
  /** Bookcase view: camera center, in shelf rows (free scrolling, no snap). */
  private viewCenter = 0;
  private targetViewCenter = 0;
  /** Shelf picked with arrows/rail when every shelf already fits on screen. */
  private pickedShelf = 0;
  private reportedShelf = -1;
  private wall!: THREE.Mesh;
  private ground!: THREE.Mesh;
  private focusProgress = 0;
  private lastInputTime = 0;
  private pointerDown = false;
  private pointerId: number | null = null;
  private pointerStartX = 0;
  private pointerStartY = 0;
  private pointerLastX = 0;
  private pointerLastY = 0;
  private pointerTravel = 0;
  private reducedMotion = false;
  private viewTransition = 0;
  private cameraTarget = new THREE.Vector3();
  private desiredPosition = new THREE.Vector3();
  private desiredTarget = new THREE.Vector3();
  private focusCameraPosition = new THREE.Vector3();
  private focusCameraTarget = new THREE.Vector3();
  private bookcaseDistance = 20;
  private browseOffset = browseCameraOffset.clone();
  private sortAnimation: {
    elapsed: number;
    from: Float32Array;
    to: Float32Array;
    delay: Float32Array;
    fromScale: Float32Array;
    toScale: Float32Array;
  } | null = null;
  private instancesDirty = true;
  private ready = false;
  private lastTimestamp = 0;
  private lastDiagnosticsAt = 0;
  private fps = 60;
  private lastDevicePixelRatio = 0;
  private clockOffset = 0;
  /** ms after navigation start when the bookcase became interactive. */
  private readyAt = 0;
  private isDisposed = false;
  private scratch = new THREE.Vector3();
  private scratchB = new THREE.Vector3();

  constructor(
    canvas: HTMLCanvasElement,
    books: Book[],
    order: number[],
    labels: string[],
    callbacks: ShelfCallbacks,
  ) {
    this.canvas = canvas;
    this.books = books;
    this.callbacks = callbacks;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.03;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.camera = new THREE.PerspectiveCamera(27, 1, 0.08, 140);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.enableZoom = true;
    this.controls.minDistance = 2.7;
    this.controls.maxDistance = 7.2;
    this.controls.minPolarAngle = Math.PI * 0.22;
    this.controls.maxPolarAngle = Math.PI * 0.78;

    this.keyLight = new THREE.DirectionalLight("#fff6e7", 4.6);
    this.textureCache = new TextureCache(40, this.anisotropy);
    this.atlas = new SpineAtlas(books, this.renderer, this.anisotropy);
    this.library = new InstancedLibrary(books, this.atlas);
    this.bookcase = new Bookcase(shelfWidth, this.anisotropy);

    const base = createMotionLayout(
      books.map((book) => ({ width: book.width, thickness: book.thickness })),
    );
    // Every book keeps its spine flush with the shelf front, so its shelved
    // depth depends on its own cover width.
    this.motionLayouts = books.map((book) => layoutForBook(base, book.width));

    this.order = order;
    this.positionOf = new Int32Array(books.length).fill(-1);
    order.forEach((catalogIndex, position) => {
      this.positionOf[catalogIndex] = position;
    });
    this.layout = layoutShelves(order.map((index) => books[index].thickness));
    this.bookcase.build(this.layout.rows.length);
    this.bookcase.setLabels(labels);
    this.bookcase.setBookends(this.layout.bookends);

    this.setupScene();
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.bindEvents();
    this.resizeObserver.observe(canvas);
    this.handleResize();
    this.viewCenter = this.targetViewCenter = this.viewBounds().min;
    this.snapCamera();
    this.animate();
    void this.start();

    (window as unknown as { __BOOKSHELF__?: unknown }).__BOOKSHELF__ = {
      diagnostics: () => this.getDiagnostics(),
      focus: (position: number) => this.focusBook(position),
      browse: (position: number) => this.goToBook(position),
      shelf: (shelf: number) => this.shelfTo(shelf),
      bookcase: () => this.exitToBookcase(),
      returnToShelf: () => this.returnToShelf(),
      tick: (frames: number) => this.tick(frames),
    };
  }

  // ---------------------------------------------------------------- setup

  private async start() {
    this.callbacks.onStatus("Printing spines");
    await this.atlas.build(this.callbacks.onProgress, () => this.isDisposed);
    if (this.isDisposed) return;
    this.books.forEach((_, index) => {
      this.library.setSpine(index, this.atlas.farRect(index));
    });
    this.writeAllInstances();
    this.library.refreshBounds();
    this.scene.add(this.library.mesh);
    this.ready = true;
    this.readyAt = Math.round(performance.now());
    this.callbacks.onReady();
    this.callbacks.onStatus(`${this.order.length} volumes ready`);
    this.callbacks.onShelf(0);
  }

  private setupScene() {
    this.scene.background = new THREE.Color("#eee8db");

    const hemisphere = new THREE.HemisphereLight("#fff8ea", "#6e5848", 2.4);
    this.scene.add(hemisphere);

    this.keyLight.castShadow = true;
    const mapSize = window.innerWidth < 700 ? 1024 : 2048;
    this.keyLight.shadow.mapSize.set(mapSize, mapSize);
    this.keyLight.shadow.camera.near = 0.5;
    this.keyLight.shadow.camera.far = 30;
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    const rim = new THREE.DirectionalLight("#c8d5e5", 2.1);
    rim.position.set(5, 3, -4);
    this.scene.add(rim);

    const wall = (this.wall = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshStandardMaterial({ color: "#eee8db", roughness: 1, metalness: 0 }),
    ));
    wall.position.set(shelfWidth * 0.5, 0, -1.9);
    wall.receiveShadow = true;
    this.scene.add(wall);

    const ground = (this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 60),
      new THREE.MeshStandardMaterial({ color: "#e7dfd0", roughness: 0.94, metalness: 0 }),
    ));
    ground.name = "ground";
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(shelfWidth * 0.5, 0, 20);
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.scene.add(this.bookcase.group);
    this.placeRoom();
  }

  /** Keeps the floor under the bookcase when a sort changes its height. */
  private placeRoom() {
    this.wall.position.y = this.bookcase.bottomY + 100;
    this.ground.position.y = this.bookcase.bottomY;
  }

  // ------------------------------------------------------------ geometry

  private bookAt(position: number) {
    return this.books[this.order[position]];
  }

  private rowOf(position: number) {
    return this.layout.slots[position]?.shelf ?? 0;
  }

  private slotCenter(position: number, out: THREE.Vector3) {
    const book = this.bookAt(position);
    const slot = this.layout.slots[position];
    return out.set(slot.x, shelfTopY(slot.shelf) + book.height * 0.5, slotZ);
  }

  private layoutFor(position: number) {
    return this.motionLayouts[this.order[position]];
  }

  private xAtIndex(index: number) {
    const lower = clamp(Math.floor(index), 0, this.order.length - 1);
    const upper = clamp(Math.ceil(index), 0, this.order.length - 1);
    return THREE.MathUtils.lerp(
      this.layout.slots[lower].x,
      this.layout.slots[upper].x,
      index - Math.floor(index),
    );
  }

  private shelfTopAtIndex(index: number) {
    const lower = clamp(Math.floor(index), 0, this.order.length - 1);
    const upper = clamp(Math.ceil(index), 0, this.order.length - 1);
    return THREE.MathUtils.lerp(
      shelfTopY(this.rowOf(lower)),
      shelfTopY(this.rowOf(upper)),
      index - Math.floor(index),
    );
  }

  private shelvedCenter(position: number, out: THREE.Vector3) {
    this.slotCenter(position, out);
    out.z += this.layoutFor(position).shelvedZ;
    return out;
  }

  private writeInstance(catalogIndex: number) {
    const position = this.positionOf[catalogIndex];
    if (position < 0) {
      // Not on the shelves under the current sort (e.g. unrated books).
      this.library.setPose(catalogIndex, this.scratch.set(0, 0, -4), Math.PI / 2, 0);
      return;
    }
    this.shelvedCenter(position, this.scratch);
    const hover = this.hoverAmounts.get(catalogIndex) ?? 0;
    this.scratch.z += hover * 0.14;
    this.library.setPose(catalogIndex, this.scratch, Math.PI / 2);
  }

  private writeAllInstances() {
    for (let index = 0; index < this.books.length; index += 1) {
      this.writeInstance(index);
    }
    this.library.commit();
    this.instancesDirty = false;
  }

  // ---------------------------------------------------------------- heroes

  private ensureHero(position: number, pose: BookPose) {
    const existing = this.heroes.get(position);
    if (existing) return existing;
    const catalogIndex = this.order[position];
    const hero = new HeroBook(
      this.books[catalogIndex],
      catalogIndex,
      this.slotCenter(position, new THREE.Vector3()),
      pose,
      this.textureCache,
      this.anisotropy,
      siteConfig.useCoverImages,
    );
    hero.pickProxy.userData.position = position;
    this.heroes.set(position, hero);
    this.scene.add(hero.slot);
    this.library.setHidden(catalogIndex, true);
    this.writeInstance(catalogIndex);
    this.library.commit();
    return hero;
  }

  private releaseHero(position: number) {
    const hero = this.heroes.get(position);
    if (!hero) return;
    hero.dispose();
    this.heroes.delete(position);
    this.library.setHidden(hero.bookIndex, false);
    this.writeInstance(hero.bookIndex);
    this.library.commit();
  }

  private releaseAllHeroes() {
    Array.from(this.heroes.keys()).forEach((position) => this.releaseHero(position));
  }

  private footprintFor(position: number, pose?: BookPose): BookFootprint {
    const book = this.bookAt(position);
    const slot = this.layout.slots[position];
    const effective =
      pose ?? this.heroes.get(position)?.pose ?? shelvedBookPose(this.layoutFor(position));
    return {
      id: book.id,
      x: slot.x + effective.x,
      z: slotZ + effective.z,
      yaw: effective.yaw,
      scale: effective.scale,
      width: book.width,
      thickness: book.thickness,
    };
  }

  /** Same-shelf neighbours are the only books a moving volume can touch. */
  private collisionFor(position: number, pose: BookPose) {
    const proposed = this.footprintFor(position, pose);
    const row = this.layout.rows[this.rowOf(position)];
    const margin = this.layoutFor(position).collisionMargin;
    for (
      let other = Math.max(row.start, position - 8);
      other < Math.min(row.end, position + 9);
      other += 1
    ) {
      if (other === position) continue;
      if (bookFootprintsOverlap(proposed, this.footprintFor(other), margin)) {
        return other;
      }
    }
    return null;
  }

  private commitBookPose(position: number, pose: BookPose, guardCollision = true) {
    const hero = this.heroes.get(position);
    if (!hero) return false;
    if (guardCollision) {
      const collidedWith = this.collisionFor(position, pose);
      if (collidedWith !== null) {
        this.collisionRejects += 1;
        this.lastCollisionPair = [this.bookAt(position).id, this.bookAt(collidedWith).id];
        return false;
      }
    }
    hero.applyPose(pose);
    return true;
  }

  // ---------------------------------------------------------------- input

  private bindEvents() {
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("blur", this.handleWindowBlur);
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    this.callbacks.onContextLost();
  };

  private handleWheel = (event: WheelEvent) => {
    if (!this.ready || this.sortAnimation) return;
    if (this.mode === "bookcase") {
      event.preventDefault();
      this.scrollViewBy(event.deltaY * 0.0045);
      this.lastInputTime = this.now();
      return;
    }
    if (this.mode !== "browse") return;
    event.preventDefault();
    this.pendingFocusIndex = null;
    const dominant =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    this.targetScrollIndex = clamp(
      this.targetScrollIndex + dominant * 0.0024,
      0,
      this.order.length - 1,
    );
    this.lastInputTime = this.now();
  };

  private handlePointerDown = (event: PointerEvent) => {
    if (this.mode !== "browse" && this.mode !== "bookcase") return;
    this.pointerDown = true;
    this.pointerId = event.pointerId;
    this.pointerStartX = event.clientX;
    this.pointerStartY = event.clientY;
    this.pointerLastX = event.clientX;
    this.pointerLastY = event.clientY;
    this.pointerTravel = 0;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent) => {
    this.updatePointer(event);
    if (this.pointerDown && event.pointerId === this.pointerId && !this.sortAnimation) {
      const dx = event.clientX - this.pointerLastX;
      const dy = event.clientY - this.pointerLastY;
      this.pointerLastX = event.clientX;
      this.pointerLastY = event.clientY;
      this.pointerTravel += Math.hypot(dx, dy);
      if (this.pointerTravel < 4) return;
      if (this.mode === "bookcase") {
        const shelvesPerPixel =
          this.visibleShelfSpan() / Math.max(1, this.canvas.clientHeight);
        this.scrollViewBy(-dy * shelvesPerPixel);
      } else if (this.mode === "browse") {
        this.pendingFocusIndex = null;
        this.targetScrollIndex = clamp(
          this.targetScrollIndex - dx / Math.max(105, this.canvas.clientWidth * 0.11),
          0,
          this.order.length - 1,
        );
      }
      this.lastInputTime = this.now();
      this.canvas.classList.add("is-dragging");
      return;
    }
    this.pointerDirty = true;
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    const wasClick =
      this.pointerTravel < 7 &&
      Math.hypot(event.clientX - this.pointerStartX, event.clientY - this.pointerStartY) < 7;
    this.pointerDown = false;
    this.pointerId = null;
    this.canvas.classList.remove("is-dragging");
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (!wasClick || !this.ready || this.sortAnimation) return;
    this.updatePointer(event);
    const bookend = this.pickBookend();
    if (bookend) {
      bookend.poke();
      return;
    }
    const hit = this.raycastBook();
    if (this.mode === "bookcase") {
      this.enterShelf(hit ?? this.positionUnderPointer());
    } else if (this.mode === "browse" && hit !== null) {
      this.focusBook(hit);
    }
  };

  private handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerDown = false;
    this.pointerId = null;
    this.canvas.classList.remove("is-dragging");
  };

  private handlePointerLeave = () => {
    if (!this.pointerDown) {
      this.pointer.set(10, 10);
      this.setHover(null);
      this.canvas.style.cursor = "grab";
    }
  };

  private handleWindowBlur = () => {
    this.pointerDown = false;
    this.pointerId = null;
    this.canvas.classList.remove("is-dragging");
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      target !== this.canvas &&
      target !== document.body &&
      target.closest("input, select, textarea, button, a, [role='listbox']")
    ) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      if (this.mode === "browse" && this.pendingFocusIndex === null) {
        this.exitToBookcase();
      } else {
        this.returnToShelf();
      }
      return;
    }
    if ((event.key === "r" || event.key === "R") && this.mode === "inspect") {
      this.resetFocusView();
      return;
    }
    if (!this.ready) return;

    const handled = (action: () => void) => {
      event.preventDefault();
      action();
    };
    if (this.mode === "bookcase") {
      if (event.key === "ArrowDown") handled(() => this.shelfBy(1));
      else if (event.key === "ArrowUp") handled(() => this.shelfBy(-1));
      else if (event.key === "PageDown") handled(() => this.shelfBy(3));
      else if (event.key === "PageUp") handled(() => this.shelfBy(-3));
      else if (event.key === "Home") handled(() => this.shelfTo(0));
      else if (event.key === "End") handled(() => this.shelfTo(this.layout.rows.length - 1));
      else if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
        handled(() => this.enterShelf());
      }
    } else if (this.mode === "browse") {
      if (event.key === "ArrowRight") handled(() => this.browseBy(1));
      else if (event.key === "ArrowLeft") handled(() => this.browseBy(-1));
      else if (event.key === "ArrowDown") handled(() => this.jumpShelf(1));
      else if (event.key === "ArrowUp") handled(() => this.jumpShelf(-1));
      else if (event.key === "Home") {
        handled(() => this.browseTo(this.layout.rows[this.rowOf(this.activeIndex)].start));
      } else if (event.key === "End") {
        handled(() => this.browseTo(this.layout.rows[this.rowOf(this.activeIndex)].end - 1));
      } else if (event.key === "Enter" || event.key === " ") {
        handled(() => this.focusBook(this.activeIndex));
      }
    }
  };

  private updatePointer(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Returns the display position under the pointer, or null. */
  private raycastBook() {
    if (!this.ready) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const proxies = Array.from(this.heroes.values(), (hero) => hero.pickProxy);
    const heroHit = this.raycaster.intersectObjects(proxies, false)[0];
    const libraryHit = this.library.mesh.visible
      ? this.raycaster.intersectObject(this.library.mesh, false)[0]
      : undefined;
    if (heroHit && (!libraryHit || heroHit.distance <= libraryHit.distance)) {
      return heroHit.object.userData.position as number;
    }
    if (libraryHit?.instanceId !== undefined && this.positionOf[libraryHit.instanceId] >= 0) {
      return this.positionOf[libraryHit.instanceId];
    }
    return null;
  }

  private pickBookend() {
    if (!this.bookcase.group.visible) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.bookcase.pickBookend(this.raycaster);
  }

  /** Nearest book to the pointer on the shelf it is pointing at. */
  private positionUnderPointer() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -boardFrontZ);
    const point = this.raycaster.ray.intersectPlane(plane, this.scratchB);
    if (!point) return this.middleOfShelf(this.currentShelf());
    const row = clamp(Math.ceil(-point.y / rowHeight), 0, this.layout.rows.length - 1);
    return nearestOnRow(this.layout, row, point.x);
  }

  private middleOfShelf(row: number) {
    return nearestOnRow(this.layout, row, shelfWidth * 0.5);
  }

  private setHover(catalogIndex: number | null) {
    if (this.hoverInstance === catalogIndex) return;
    if (this.hoverInstance !== null) this.library.setHighlight(this.hoverInstance, 0);
    this.hoverInstance = catalogIndex;
    if (catalogIndex !== null) {
      this.library.setHighlight(catalogIndex, 1);
      if (!this.hoverAmounts.has(catalogIndex)) this.hoverAmounts.set(catalogIndex, 0);
    }
  }

  private updateHover() {
    if (!this.pointerDirty || this.pointerDown) return;
    this.pointerDirty = false;
    if (this.mode !== "browse" && this.mode !== "bookcase") {
      this.setHover(null);
      return;
    }
    if (this.pickBookend()) {
      this.setHover(null);
      this.canvas.style.cursor = "pointer";
      return;
    }
    const hit = this.raycastBook();
    const catalogIndex = hit === null ? null : this.order[hit];
    this.setHover(
      catalogIndex !== null && !this.library.isHidden(catalogIndex) ? catalogIndex : null,
    );
    this.heroes.forEach((hero, position) => {
      hero.targetHover = position === hit ? 1 : 0;
    });
    this.canvas.style.cursor =
      hit === null && this.mode === "browse" ? "grab" : "pointer";
  }

  // ---------------------------------------------------------------- motion

  private beginFocus(position: number) {
    if (
      this.mode !== "browse" ||
      this.browseMotionPhase !== "idle" ||
      this.presentedIndex !== position
    ) {
      return;
    }
    this.pendingFocusIndex = null;
    this.selectedIndex = position;
    this.focusProgress = 0;
    this.mode = "focusing";
    this.setHover(null);
    this.callbacks.onMode(this.mode, position);
    this.callbacks.onStatus(`Opening ${this.bookAt(position).shortTitle}`);
  }

  private desiredPresented() {
    return this.mode === "browse" ? this.activeIndex : null;
  }

  private updateBrowseMotion(delta: number) {
    if (this.browseMotionPhase === "idle") {
      const desired = this.desiredPresented();
      if (this.presentedIndex === desired) {
        if (desired !== null && this.pendingFocusIndex === desired) {
          this.beginFocus(desired);
        }
        return;
      }
      if (this.presentedIndex !== null) {
        this.motionBookIndex = this.presentedIndex;
        this.browseMotionPhase = "retreat-current";
      } else if (desired !== null) {
        this.motionBookIndex = desired;
        this.browseMotionPhase = "extract-next";
        this.ensureHero(desired, shelvedBookPose(this.layoutFor(desired)));
      }
      this.browseMotionProgress = 0;
    }

    const phase = this.browseMotionPhase;
    const motionIndex = this.motionBookIndex;
    if (phase === "idle" || motionIndex === null) return;
    const duration = this.reducedMotion
      ? Math.max(0.055, browsePhaseDuration[phase] * 0.45)
      : browsePhaseDuration[phase];
    const nextProgress = clamp(this.browseMotionProgress + delta / duration, 0, 1);
    const proposedPose = browseMotionPose(phase, nextProgress, this.layoutFor(motionIndex));
    if (!this.commitBookPose(motionIndex, proposedPose)) return;

    this.browseMotionProgress = nextProgress;
    if (nextProgress < 1) return;

    this.browseMotionProgress = 0;
    switch (phase) {
      case "retreat-current":
        this.browseMotionPhase = "turn-current";
        break;
      case "turn-current":
        this.browseMotionPhase = "shelve-current";
        break;
      case "shelve-current": {
        this.presentedIndex = null;
        this.releaseHero(motionIndex);
        const desired = this.desiredPresented();
        if (desired === null) {
          this.motionBookIndex = null;
          this.browseMotionPhase = "idle";
        } else {
          this.motionBookIndex = desired;
          this.browseMotionPhase = "extract-next";
          this.ensureHero(desired, shelvedBookPose(this.layoutFor(desired)));
        }
        break;
      }
      case "extract-next":
        this.browseMotionPhase = "turn-next";
        break;
      case "turn-next":
        this.browseMotionPhase = "settle-next";
        break;
      case "settle-next":
        this.presentedIndex = motionIndex;
        this.motionBookIndex = null;
        this.browseMotionPhase = "idle";
        if (this.pendingFocusIndex === this.presentedIndex) {
          this.beginFocus(this.presentedIndex);
        }
        break;
    }
  }

  private updateSortAnimation(delta: number) {
    const animation = this.sortAnimation;
    if (!animation) return;
    animation.elapsed += delta;
    const { from, to, delay } = animation;
    let finished = true;
    for (let index = 0; index < this.books.length; index += 1) {
      const t = clamp((animation.elapsed - delay[index]) / sortDuration, 0, 1);
      if (t < 1) finished = false;
      const o = index * 3;
      const fromScale = animation.fromScale[index];
      const toScale = animation.toScale[index];
      // Slide out of the old slot, fly in front of the case, slide home.
      const out = smooth(t / 0.28);
      const travel = smooth((t - 0.22) / 0.56);
      const home = smooth((t - 0.72) / 0.28);
      let scale = 1;
      if (fromScale && toScale) {
        const x = THREE.MathUtils.lerp(from[o], to[o], travel);
        const y = THREE.MathUtils.lerp(from[o + 1], to[o + 1], travel);
        const fromZ = THREE.MathUtils.lerp(from[o + 2], sortFlightZ, out);
        this.scratch.set(x, y, THREE.MathUtils.lerp(fromZ, to[o + 2], home));
      } else if (fromScale) {
        // Leaving the shelves: slide out and shrink away.
        this.scratch.set(from[o], from[o + 1], THREE.MathUtils.lerp(from[o + 2], sortFlightZ, out));
        scale = 1 - smooth((t - 0.2) / 0.45);
      } else if (toScale) {
        // Joining the shelves: grow in front of its slot, then slide home.
        this.scratch.set(to[o], to[o + 1], THREE.MathUtils.lerp(sortFlightZ, to[o + 2], home));
        scale = smooth((t - 0.3) / 0.4);
      } else {
        this.scratch.set(0, 0, -4);
        scale = 0;
      }
      this.library.setPose(index, this.scratch, Math.PI / 2, scale);
    }
    this.library.commit();
    if (finished) {
      this.sortAnimation = null;
      this.writeAllInstances();
      this.library.refreshBounds();
      this.callbacks.onStatus(`${this.order.length} volumes re-shelved`);
    }
  }

  private updateHoverAmounts(delta: number) {
    if (!this.hoverAmounts.size || this.sortAnimation) return;
    this.hoverAmounts.forEach((amount, catalogIndex) => {
      const target = catalogIndex === this.hoverInstance ? 1 : 0;
      const next = damp(amount, target, 12, delta);
      if (Math.abs(next - target) < 0.002 && target === 0) {
        this.hoverAmounts.delete(catalogIndex);
      } else {
        this.hoverAmounts.set(catalogIndex, next);
      }
      this.writeInstance(catalogIndex);
    });
    this.library.commit();
  }

  /** Streams hi-res spines for books around the active one. */
  private updateNearSpines() {
    if (!this.ready || this.mode === "bookcase" || this.sortAnimation) return;
    const start = Math.max(0, this.activeIndex - nearRadius);
    const end = Math.min(this.order.length - 1, this.activeIndex + nearRadius);
    const wanted = new Set<number>();
    for (let position = start; position <= end; position += 1) {
      wanted.add(this.order[position]);
    }
    wanted.forEach((catalogIndex) => this.atlas.touchNear(catalogIndex));
    let budget = 3;
    // Closest books first.
    for (let offset = 0; offset <= nearRadius && budget > 0; offset += 1) {
      for (const position of [this.activeIndex + offset, this.activeIndex - offset]) {
        if (budget <= 0 || position < start || position > end) continue;
        const catalogIndex = this.order[position];
        if (this.atlas.hasNear(catalogIndex)) continue;
        const evicted = this.atlas.addNear(catalogIndex, wanted);
        if (evicted !== undefined) {
          this.library.setSpine(evicted, this.atlas.farRect(evicted));
        }
        const rect = this.atlas.nearRect(catalogIndex);
        if (rect) this.library.setSpine(catalogIndex, rect);
        budget -= 1;
        if (offset === 0) break;
      }
    }
  }

  private prefetchCovers() {
    if (!siteConfig.useCoverImages) return;
    for (let offset = -coverPrefetchRadius; offset <= coverPrefetchRadius; offset += 1) {
      const position = this.activeIndex + offset;
      if (position < 0 || position >= this.order.length) continue;
      const url = this.bookAt(position).coverImage;
      if (url) this.textureCache.prefetch(url);
    }
  }

  /** Engine clock; `tick()` advances it past real time for scripted tests. */
  private now() {
    return performance.now() + this.clockOffset;
  }

  private animate = () => {
    if (this.isDisposed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    this.frame(this.now());
  };

  /** Advances the simulation by whole 60 Hz frames, independent of rAF. */
  tick(frames = 1) {
    for (let index = 0; index < frames && !this.isDisposed; index += 1) {
      this.clockOffset += 1000 / 60;
      this.frame(this.now());
    }
  }

  private frame(timestamp: number) {
    const elapsed = timestamp / 1000;
    const rawDelta = (timestamp - this.lastTimestamp) / 1000 || 1 / 60;
    const delta = clamp(rawDelta, 0, 0.05);
    this.lastTimestamp = timestamp;
    // Moving between displays (or zooming) changes DPR without a resize.
    if (window.devicePixelRatio !== this.lastDevicePixelRatio) this.handleResize();
    this.fps = damp(this.fps, 1 / Math.max(rawDelta, 0.001), 3, delta);

    this.updateState(delta, timestamp);
    this.updateCamera(delta);
    this.updateBooks(delta, elapsed);
    this.updateSortAnimation(delta);
    this.bookcase.update(elapsed, delta, this.reducedMotion);
    this.updateHover();
    this.updateHoverAmounts(delta);
    this.updateNearSpines();
    if (this.instancesDirty && this.ready) this.writeAllInstances();

    if (this.controls.enabled) this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (timestamp - this.lastDiagnosticsAt > 500) {
      const info = this.renderer.info;
      this.canvas.dataset.drawCalls = String(info.render.calls);
      this.canvas.dataset.textures = String(info.memory.textures);
      this.canvas.dataset.mode = this.mode;
      this.canvas.dataset.fps = String(Math.round(this.fps));
      this.lastDiagnosticsAt = timestamp;
    }
  }

  private updateState(delta: number, timestamp: number) {
    this.viewTransition = Math.max(0, this.viewTransition - delta);
    if (this.mode === "bookcase") {
      // Free scrolling: the view glides to wherever the wheel or drag left
      // it, without snapping to shelf heights.
      const bounds = this.viewBounds();
      this.targetViewCenter = clamp(this.targetViewCenter, bounds.min, bounds.max);
      this.viewCenter = damp(
        this.viewCenter,
        this.targetViewCenter,
        this.reducedMotion ? 20 : 9,
        delta,
      );
      const shelf = this.currentShelf();
      if (shelf !== this.reportedShelf) {
        this.reportedShelf = shelf;
        this.callbacks.onShelf(shelf);
      }
    } else if (this.mode === "browse") {
      if (!this.pointerDown && timestamp - this.lastInputTime > 150) {
        this.targetScrollIndex = damp(
          this.targetScrollIndex,
          Math.round(this.targetScrollIndex),
          this.reducedMotion ? 18 : 8.5,
          delta,
        );
      }
      this.scrollIndex = damp(
        this.scrollIndex,
        this.targetScrollIndex,
        this.reducedMotion ? 20 : 10,
        delta,
      );
      this.focusProgress = damp(this.focusProgress, 0, 10, delta);
    } else if (this.mode === "focusing") {
      this.focusProgress = clamp(
        this.focusProgress + delta / (this.reducedMotion ? 0.08 : focusInDuration),
        0,
        1,
      );
      if (this.focusProgress >= 1) {
        this.mode = "inspect";
        this.controls.enabled = true;
        this.controls.target.copy(this.focusCameraTarget);
        this.callbacks.onMode(this.mode, this.selectedIndex);
        if (this.selectedIndex !== null) {
          this.callbacks.onStatus(`Inspecting ${this.bookAt(this.selectedIndex).shortTitle}`);
        }
      }
    } else if (this.mode === "returning") {
      this.controls.enabled = false;
      this.focusProgress = clamp(
        this.focusProgress - delta / (this.reducedMotion ? 0.08 : focusOutDuration),
        0,
        1,
      );
      if (this.focusProgress <= 0) {
        if (this.selectedIndex !== null) {
          this.commitBookPose(this.selectedIndex, presentedBookPose(this.layoutFor(this.selectedIndex)));
          this.presentedIndex = this.selectedIndex;
        }
        this.selectedIndex = null;
        this.mode = "browse";
        this.camera.clearViewOffset();
        this.callbacks.onMode(this.mode, null);
        this.callbacks.onStatus(`${this.order.length} volumes ready`);
      }
    }

    if (this.mode === "browse" || this.mode === "bookcase") {
      const nextActive = clamp(Math.round(this.scrollIndex), 0, this.order.length - 1);
      if (nextActive !== this.activeIndex) {
        this.activeIndex = nextActive;
        this.callbacks.onActiveIndex(this.activeIndex);
        this.prefetchCovers();
      }
      this.updateBrowseMotion(delta);
    }
  }

  // ---------------------------------------------------------------- camera

  private visibleShelfSpan() {
    const halfHeight =
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * this.bookcaseDistance;
    return (halfHeight * 2) / rowHeight;
  }

  /**
   * Scroll range of the bookcase camera (in shelf rows). The top leaves room
   * above the case for the page title.
   */
  private viewBounds() {
    const rows = this.layout.rows.length;
    const span = this.visibleShelfSpan();
    const titleRoom = 0.6;
    let min = (span - 1) / 2 - 0.35 - titleRoom;
    let max = rows - 1 - (span - 1) / 2 + 0.35;
    if (min >= max) min = max = (rows - 1) / 2 - titleRoom / 2;
    return { min, max };
  }

  /** Shelf the bookcase view is "on": top shelf at the top, last at the end. */
  private currentShelf() {
    const rows = this.layout.rows.length;
    const { min, max } = this.viewBounds();
    if (max - min < 1e-3) return clamp(this.pickedShelf, 0, rows - 1);
    return clamp(Math.round(((this.viewCenter - min) / (max - min)) * (rows - 1)), 0, rows - 1);
  }

  private viewCenterForShelf(shelf: number) {
    const rows = this.layout.rows.length;
    const { min, max } = this.viewBounds();
    return rows <= 1 ? min : min + (shelf / (rows - 1)) * (max - min);
  }

  private scrollViewBy(rowsDelta: number) {
    const { min, max } = this.viewBounds();
    this.targetViewCenter = clamp(this.targetViewCenter + rowsDelta, min, max);
  }

  private computeDesiredView() {
    if (this.mode === "bookcase") {
      const center = this.viewCenter;
      const y = shelfTopY(center) + rowHeight * 0.42;
      this.desiredTarget.set(shelfWidth * 0.5, y, 0);
      this.desiredPosition.set(shelfWidth * 0.5, y + 0.35, this.bookcaseDistance);
      return;
    }
    const x = this.xAtIndex(this.scrollIndex);
    const top = this.shelfTopAtIndex(this.scrollIndex);
    this.desiredPosition.set(x, top, 0).add(this.browseOffset);
    this.desiredTarget.set(x, top, 0).add(browseTargetOffset);
  }

  private snapCamera() {
    this.computeDesiredView();
    this.camera.position.copy(this.desiredPosition);
    this.cameraTarget.copy(this.desiredTarget);
    this.camera.lookAt(this.cameraTarget);
  }

  private updateCamera(delta: number) {
    this.computeDesiredView();
    const lambda = this.reducedMotion ? 24 : this.viewTransition > 0 ? 4.2 : 12;
    const amount = 1 - Math.exp(-lambda * delta);
    if (this.mode === "browse" || this.mode === "bookcase") {
      this.camera.position.lerp(this.desiredPosition, amount);
      this.cameraTarget.lerp(this.desiredTarget, amount);
      this.camera.lookAt(this.cameraTarget);
    } else if (this.mode === "focusing") {
      this.updateFocusCamera(delta);
    } else if (this.mode === "returning") {
      this.applyFocusViewOffset(easeOutCubic(this.focusProgress));
      const returnAmount = 1 - Math.exp(-(this.reducedMotion ? 24 : 14) * delta);
      this.camera.position.lerp(this.desiredPosition, returnAmount);
      this.cameraTarget.lerp(this.desiredTarget, returnAmount);
      this.camera.lookAt(this.cameraTarget);
    }
    this.updateShadowFrame();
  }

  private updateShadowFrame() {
    const span = this.mode === "bookcase" ? 13 : 6.5;
    const target = this.mode === "inspect" ? this.controls.target : this.cameraTarget;
    this.keyLight.target.position.copy(target);
    this.keyLight.position.set(target.x - 4.2, target.y + 7.4, target.z + 5.5);
    if (span !== this.shadowSpan) {
      this.shadowSpan = span;
      const shadowCamera = this.keyLight.shadow.camera;
      shadowCamera.left = -span;
      shadowCamera.right = span;
      shadowCamera.top = span;
      shadowCamera.bottom = -span;
      shadowCamera.updateProjectionMatrix();
    }
  }

  private updateFocusCamera(delta: number) {
    if (this.selectedIndex === null) return;
    const hero = this.heroes.get(this.selectedIndex);
    if (!hero) return;
    hero.content.getWorldPosition(this.scratchB);
    this.frameFocusedBook(this.scratchB, easeOutCubic(this.focusProgress));
    this.camera.position.lerp(
      this.focusCameraPosition,
      1 - Math.exp(-(this.reducedMotion ? 28 : 13) * delta),
    );
    this.cameraTarget.copy(this.focusCameraTarget);
    this.camera.lookAt(this.focusCameraTarget);
  }

  private applyFocusViewOffset(progress: number) {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const isMobile = width < 760;
    const detailWidth =
      width <= 1020
        ? Math.min(compactDetailMaxWidth, width * compactDetailWidthRatio)
        : Math.min(desktopDetailMaxWidth, width * desktopDetailWidthRatio);
    const focusDistance = isMobile ? 5.8 : 5.4;
    const verticalHalfSpan =
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * focusDistance;
    const clampedProgress = clamp(progress, 0, 1);
    const horizontalOffset = isMobile ? 0 : detailWidth * 0.5 * clampedProgress;
    const verticalOffset = isMobile
      ? (0.28 / verticalHalfSpan) * height * 0.5 * clampedProgress
      : 0;

    if (clampedProgress <= 0.001) {
      this.camera.clearViewOffset();
      return;
    }
    // Shift the composition through an asymmetric frustum so the camera and
    // OrbitControls can keep the exact center of the book as their target.
    this.camera.setViewOffset(width, height, horizontalOffset, verticalOffset, width, height);
  }

  private frameFocusedBook(worldPosition: THREE.Vector3, compositionProgress = 1) {
    const isMobile = this.canvas.clientWidth < 760;
    const focusDistance = isMobile ? 5.8 : 5.4;
    this.applyFocusViewOffset(compositionProgress);
    this.focusCameraTarget.copy(worldPosition);
    this.focusCameraPosition.set(
      worldPosition.x + (isMobile ? 0 : 0.58),
      worldPosition.y + 0.12,
      worldPosition.z + focusDistance,
    );
  }

  private updateBooks(delta: number, elapsed: number) {
    const motionFocus =
      this.mode === "returning" ? this.focusProgress : easeOutCubic(this.focusProgress);
    const isolated = this.selectedIndex !== null && motionFocus > 0.72;
    this.bookcase.group.visible = !isolated;
    this.library.mesh.visible = !isolated;
    const narrow = window.innerWidth < 760;

    if (this.selectedIndex !== null) {
      this.commitBookPose(
        this.selectedIndex,
        focusedBookPose(
          motionFocus,
          this.layoutFor(this.selectedIndex),
          narrow ? 0 : desktopFocusX,
          narrow ? mobileFocusZ : desktopFocusZ,
          narrow ? mobileFocusScale : desktopFocusScale,
        ),
      );
    }

    this.heroes.forEach((hero, position) => {
      hero.hover = damp(hero.hover, hero.targetHover, 12, delta);
      const isSelected = position === this.selectedIndex;
      hero.content.visible = !isolated || isSelected;
      hero.content.position.y = isSelected ? motionFocus * 0.04 : 0;

      const idleTarget = isSelected && this.mode === "inspect" && !this.reducedMotion ? 1 : 0;
      hero.idleAmount = damp(hero.idleAmount, idleTarget, 5, delta);
      const idleStrength = isSelected ? hero.idleAmount : 0;
      const idlePhase = elapsed * 0.78 + position * 0.37;
      hero.inspectionIdle.position.y = Math.sin(idlePhase) * inspectionIdleLift * idleStrength;
      hero.inspectionIdle.rotation.set(
        Math.sin(idlePhase * 0.73 + 0.8) * inspectionIdlePitch * idleStrength,
        Math.sin(idlePhase * 0.61) * inspectionIdleYaw * idleStrength,
        Math.sin(idlePhase * 0.89 + 1.7) * inspectionIdleRoll * idleStrength,
      );

      if (hero.livingMaterial) {
        hero.livingMaterial.uniforms.uTime.value = elapsed;
        const livingStrength = this.reducedMotion
          ? 0
          : isSelected
            ? 0.24 + motionFocus * 0.55
            : position === this.presentedIndex
              ? 0.24 + hero.hover * 0.08
              : hero.hover * 0.04;
        hero.livingMaterial.uniforms.uStrength.value = damp(
          hero.livingMaterial.uniforms.uStrength.value,
          livingStrength,
          5,
          delta,
        );
      }
    });
  }

  private handleResize = () => {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const dprCap = width < 760 ? 1.5 : 1.75;
    this.lastDevicePixelRatio = window.devicePixelRatio;
    this.browseOffset.copy(width < 760 ? mobileBrowseCameraOffset : browseCameraOffset);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = width < 600 ? 33 : width < 920 ? 30 : 27;
    this.camera.updateProjectionMatrix();

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const verticalFit = (rowHeight * (width < 760 ? 2.4 : 3.3)) / 2 / tanHalf;
    const horizontalFit = (shelfWidth * 0.5 + 1.1) / (tanHalf * this.camera.aspect);
    this.bookcaseDistance = Math.max(verticalFit, horizontalFit);

    if (this.mode === "inspect" && this.selectedIndex !== null) {
      const hero = this.heroes.get(this.selectedIndex);
      if (hero) {
        hero.content.getWorldPosition(this.scratchB);
        this.frameFocusedBook(this.scratchB);
      }
    } else if (this.mode === "browse" || this.mode === "bookcase") {
      this.camera.clearViewOffset();
    }
  };

  // ------------------------------------------------------------ public API

  getShelfCount() {
    return this.layout.rows.length;
  }

  getLayout() {
    return this.layout;
  }

  /**
   * Re-shelves the library in a new display order. `order` may hold only
   * some books (a filtered sort); the rest leave the shelves.
   */
  setOrder(order: number[], labels: string[], animate = true) {
    if (this.mode !== "browse" && this.mode !== "bookcase") return;
    const canAnimate = animate && this.ready && !this.reducedMotion;
    const count = this.books.length;
    const from = new Float32Array(count * 3);
    const fromScale = new Float32Array(count);
    const delay = new Float32Array(count);
    if (canAnimate) {
      for (let index = 0; index < count; index += 1) {
        const position = this.positionOf[index];
        if (position < 0) continue;
        this.shelvedCenter(position, this.scratch);
        from.set([this.scratch.x, this.scratch.y, this.scratch.z], index * 3);
        fromScale[index] = 1;
        delay[index] = (position / this.order.length) * sortStagger;
      }
    }

    this.releaseAllHeroes();
    this.presentedIndex = null;
    this.motionBookIndex = null;
    this.browseMotionPhase = "idle";
    this.pendingFocusIndex = null;
    this.setHover(null);
    this.hoverAmounts.clear();

    this.order = order;
    this.positionOf.fill(-1);
    order.forEach((catalogIndex, position) => {
      this.positionOf[catalogIndex] = position;
    });
    const rowsBefore = this.layout.rows.length;
    this.layout = layoutShelves(order.map((index) => this.books[index].thickness));
    if (this.layout.rows.length !== rowsBefore) {
      this.bookcase.build(this.layout.rows.length);
      this.placeRoom();
    }
    this.bookcase.setLabels(labels);
    this.bookcase.setBookends(this.layout.bookends);

    const wasBrowsing = this.mode === "browse";
    this.mode = "bookcase";
    this.activeIndex = 0;
    this.scrollIndex = 0;
    this.targetScrollIndex = 0;
    this.pickedShelf = 0;
    this.targetViewCenter = this.viewBounds().min;
    if (!canAnimate) this.viewCenter = this.targetViewCenter;
    this.reportedShelf = -1;
    this.viewTransition = 0.9;
    if (wasBrowsing) this.callbacks.onMode("bookcase", null);
    this.callbacks.onActiveIndex(0);

    if (canAnimate) {
      const to = new Float32Array(count * 3);
      const toScale = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        const position = this.positionOf[index];
        if (position < 0) continue;
        this.shelvedCenter(position, this.scratch);
        to.set([this.scratch.x, this.scratch.y, this.scratch.z], index * 3);
        toScale[index] = 1;
        const arrival = (position / order.length) * sortStagger;
        delay[index] = fromScale[index] ? Math.max(delay[index], arrival) * 0.5 + arrival * 0.5 : arrival;
      }
      this.sortAnimation = { elapsed: 0, from, to, delay, fromScale, toScale };
      this.callbacks.onStatus("Re-shelving");
    } else {
      this.instancesDirty = true;
      this.library.refreshBounds();
    }
  }

  shelfBy(direction: number) {
    if (this.mode !== "bookcase") return;
    this.shelfTo(this.currentShelf() + direction);
  }

  shelfTo(shelf: number) {
    if (this.mode === "browse") {
      this.jumpShelf(shelf - this.rowOf(this.activeIndex));
      return;
    }
    if (this.mode !== "bookcase") return;
    this.pickedShelf = clamp(Math.round(shelf), 0, this.layout.rows.length - 1);
    this.targetViewCenter = this.viewCenterForShelf(this.pickedShelf);
  }

  /** Zoom from the bookcase into one shelf, presenting `position`. */
  enterShelf(position = this.middleOfShelf(this.currentShelf())) {
    if (this.mode !== "bookcase" || !this.ready || this.sortAnimation) return;
    const next = clamp(Math.round(position), 0, this.order.length - 1);
    this.mode = "browse";
    this.scrollIndex = next;
    this.targetScrollIndex = next;
    this.activeIndex = next;
    this.viewTransition = 0.9;
    this.setHover(null);
    this.callbacks.onActiveIndex(next);
    this.callbacks.onMode("browse", null);
    this.callbacks.onStatus(`Shelf ${this.rowOf(next) + 1}`);
    this.prefetchCovers();
  }

  exitToBookcase() {
    if (this.mode !== "browse") return;
    this.pendingFocusIndex = null;
    this.mode = "bookcase";
    const row = this.rowOf(this.activeIndex);
    this.pickedShelf = row;
    this.viewCenter = this.targetViewCenter = this.viewCenterForShelf(row);
    this.reportedShelf = -1;
    this.viewTransition = 0.9;
    this.callbacks.onMode("bookcase", null);
    this.callbacks.onStatus(`${this.order.length} volumes`);
  }

  browseBy(direction: number) {
    if (this.mode !== "browse") return;
    this.browseTo(Math.round(this.targetScrollIndex) + direction);
  }

  browseTo(position: number) {
    if (this.mode !== "browse") return;
    const next = clamp(Math.round(position), 0, this.order.length - 1);
    this.pendingFocusIndex = null;
    if (this.rowOf(next) !== this.rowOf(Math.round(this.scrollIndex))) {
      // Different shelf: jump there and let the camera glide rather than
      // sweeping along every book in between.
      this.scrollIndex = next;
      this.viewTransition = 0.7;
    }
    this.targetScrollIndex = next;
    this.lastInputTime = this.now() - 1000;
  }

  jumpShelf(direction: number) {
    if (this.mode !== "browse") return;
    const row = clamp(this.rowOf(this.activeIndex) + direction, 0, this.layout.rows.length - 1);
    if (row === this.rowOf(this.activeIndex)) return;
    this.browseTo(nearestOnRow(this.layout, row, this.layout.slots[this.activeIndex].x));
  }

  /** Search result: fly to a book and pull it from the shelf. */
  goToBook(position: number) {
    if (this.mode === "bookcase") this.enterShelf(position);
    else if (this.mode === "browse") this.browseTo(position);
  }

  focusBook(position = this.activeIndex) {
    if (this.mode === "bookcase") this.enterShelf(position);
    if (this.mode !== "browse") return;
    const next = clamp(Math.round(position), 0, this.order.length - 1);
    if (this.rowOf(next) !== this.rowOf(this.activeIndex)) this.viewTransition = 0.7;
    this.targetScrollIndex = next;
    this.scrollIndex = next;
    this.activeIndex = next;
    this.pendingFocusIndex = next;
    this.callbacks.onActiveIndex(next);
    this.callbacks.onStatus(`Preparing ${this.bookAt(next).shortTitle}`);
    this.prefetchCovers();
    if (this.browseMotionPhase === "idle" && this.presentedIndex === next) {
      this.beginFocus(next);
    }
  }

  returnToShelf() {
    if (this.mode === "browse" && this.pendingFocusIndex !== null) {
      this.pendingFocusIndex = null;
      this.callbacks.onStatus("Opening cancelled");
      return;
    }
    if (this.mode === "browse" || this.mode === "bookcase" || this.mode === "returning") return;
    this.controls.enabled = false;
    this.mode = "returning";
    this.callbacks.onMode(this.mode, this.selectedIndex);
    this.callbacks.onStatus("Returning to the shelf");
  }

  resetFocusView() {
    if (this.mode !== "inspect" || this.selectedIndex === null) return;
    const hero = this.heroes.get(this.selectedIndex);
    if (!hero) return;
    hero.content.getWorldPosition(this.scratchB);
    this.frameFocusedBook(this.scratchB);
    this.controls.target.copy(this.focusCameraTarget);
    this.camera.position.copy(this.focusCameraPosition);
    this.controls.update();
  }

  focusCanvas() {
    this.canvas.focus({ preventScroll: true });
  }

  private findAnyCollision(): [string, string] | null {
    for (const position of this.heroes.keys()) {
      const other = this.collisionFor(position, this.footprintPose(position));
      if (other !== null) return [this.bookAt(position).id, this.bookAt(other).id];
    }
    return null;
  }

  private footprintPose(position: number) {
    return this.heroes.get(position)?.pose ?? shelvedBookPose(this.layoutFor(position));
  }

  getDiagnostics() {
    const info = this.renderer.info;
    return {
      mode: this.mode,
      readyAtMs: this.readyAt,
      activeIndex: this.activeIndex,
      selectedIndex: this.selectedIndex,
      shelf: this.mode === "bookcase" ? this.currentShelf() : this.rowOf(this.activeIndex),
      shelves: this.layout.rows.length,
      viewCenter: Number(this.viewCenter.toFixed(3)),
      books: this.order.length,
      heroes: this.heroes.size,
      coverCache: this.textureCache.size,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      pixelRatio: this.renderer.getPixelRatio(),
      fps: Math.round(this.fps),
      motionPhase: this.browseMotionPhase,
      sorting: this.sortAnimation !== null,
      collisionRejects: this.collisionRejects,
      lastCollisionPair: this.lastCollisionPair,
      currentCollision: this.findAnyCollision(),
    };
  }

  dispose() {
    this.isDisposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("blur", this.handleWindowBlur);

    this.releaseAllHeroes();
    this.library.dispose();
    this.bookcase.dispose();
    this.atlas.dispose();
    this.textureCache.dispose();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material?.dispose());
    });
    this.renderer.dispose();
    delete (window as unknown as { __BOOKSHELF__?: unknown }).__BOOKSHELF__;
  }
}
