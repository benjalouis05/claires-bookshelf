import * as THREE from "three";

type Entry = {
  promise: Promise<THREE.Texture | null>;
  texture: THREE.Texture | null;
  refs: number;
};

/**
 * Bounded LRU of cover textures. Heroes `acquire` the covers they show and
 * `release` them when shelved; unreferenced covers beyond `capacity` are
 * disposed, so GPU memory stays flat however many books are opened.
 */
export class TextureCache {
  private entries = new Map<string, Entry>();
  private loader = new THREE.TextureLoader();
  private disposed = false;

  constructor(
    private capacity: number,
    private anisotropy: number,
  ) {}

  get size() {
    return this.entries.size;
  }

  private touch(url: string, entry: Entry) {
    this.entries.delete(url);
    this.entries.set(url, entry);
  }

  private load(url: string): Entry {
    const existing = this.entries.get(url);
    if (existing) {
      this.touch(url, existing);
      return existing;
    }
    const entry: Entry = { promise: Promise.resolve(null), texture: null, refs: 0 };
    entry.promise = this.loader
      .loadAsync(url)
      .then((texture) => {
        if (this.disposed || !this.entries.has(url)) {
          texture.dispose();
          return null;
        }
        texture.name = `cover:${url}`;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = this.anisotropy;
        entry.texture = texture;
        return texture;
      })
      .catch(() => null);
    this.entries.set(url, entry);
    this.evict();
    return entry;
  }

  prefetch(url: string) {
    this.load(url);
  }

  acquire(url: string) {
    const entry = this.load(url);
    entry.refs += 1;
    return entry.promise;
  }

  release(url: string) {
    const entry = this.entries.get(url);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    this.evict();
  }

  private evict() {
    if (this.entries.size <= this.capacity) return;
    for (const [url, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (entry.refs > 0) continue;
      entry.texture?.dispose();
      this.entries.delete(url);
    }
  }

  dispose() {
    this.disposed = true;
    this.entries.forEach((entry) => entry.texture?.dispose());
    this.entries.clear();
  }
}
