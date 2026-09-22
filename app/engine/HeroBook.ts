import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Book } from "../catalog";
import type { BookPose } from "../book-motion";
import { createBackCover, createFrontCover, createSpineCover } from "../cover-art";
import type { TextureCache } from "./TextureCache";

const pageColor = new THREE.Color("#e9dfca");

function toTexture(canvas: HTMLCanvasElement, anisotropy: number) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

function createLivingMaterial(color: string) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uStrength;
      uniform vec3 uColor;

      void main() {
        float diagonal = fract(vUv.x * 0.72 + vUv.y * 0.31 + uTime * 0.045);
        float sheen = smoothstep(0.44, 0.5, diagonal) * (1.0 - smoothstep(0.5, 0.57, diagonal));
        float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        float alpha = sheen * edge * uStrength * 0.32;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
}

/**
 * A fully modelled hardcover (boards, page block, headbands, printed cover,
 * spine and back), ported from the reference shelf. Only the handful of books
 * that leave the shelf get one; everything else is an instanced box.
 */
export class HeroBook {
  readonly slot = new THREE.Group();
  readonly content = new THREE.Group();
  readonly inspectionIdle = new THREE.Group();
  readonly pickProxy: THREE.Mesh;
  readonly livingMaterial?: THREE.ShaderMaterial;
  pose: BookPose;
  hover = 0;
  targetHover = 0;
  idleAmount = 0;
  private frontMaterial: THREE.MeshPhysicalMaterial;
  private textures: THREE.Texture[] = [];
  private coverUrl: string | null = null;
  private disposed = false;

  constructor(
    readonly book: Book,
    readonly bookIndex: number,
    slotCenter: THREE.Vector3,
    pose: BookPose,
    private cache: TextureCache,
    anisotropy: number,
    useCoverImage: boolean,
  ) {
    const { width, height, thickness: depth } = book;
    this.pose = pose;
    this.slot.name = `heroSlot:${book.id}`;
    this.slot.position.copy(slotCenter);
    this.slot.add(this.content);
    this.content.add(this.inspectionIdle);
    const physical = new THREE.Group();
    this.inspectionIdle.add(physical);

    const boardMaterial = new THREE.MeshPhysicalMaterial({
      color: book.cover,
      roughness: 0.78,
      metalness: 0,
      sheen: 0.36,
      sheenColor: new THREE.Color(book.ink),
      sheenRoughness: 0.82,
      clearcoat: 0.04,
      clearcoatRoughness: 0.7,
    });
    const paperMaterial = new THREE.MeshStandardMaterial({
      color: pageColor,
      roughness: 0.88,
      metalness: 0,
    });

    const pageBlock = new THREE.Mesh(
      new RoundedBoxGeometry(
        width - 0.075,
        height - 0.105,
        Math.max(0.08, depth - 0.052),
        3,
        0.018,
      ),
      paperMaterial,
    );
    pageBlock.castShadow = true;
    pageBlock.receiveShadow = true;
    physical.add(pageBlock);

    const boardGeometry = new RoundedBoxGeometry(width, height, 0.034, 4, 0.025);
    const frontBoard = new THREE.Mesh(boardGeometry, boardMaterial);
    frontBoard.position.z = depth * 0.5;
    frontBoard.castShadow = true;
    frontBoard.receiveShadow = true;
    physical.add(frontBoard);

    const backBoard = new THREE.Mesh(boardGeometry, boardMaterial);
    backBoard.position.z = -depth * 0.5;
    backBoard.castShadow = true;
    backBoard.receiveShadow = true;
    physical.add(backBoard);

    const spine = new THREE.Mesh(
      new RoundedBoxGeometry(0.055, height - 0.01, depth + 0.012, 3, 0.018),
      boardMaterial,
    );
    spine.position.x = -width * 0.5 + 0.022;
    spine.castShadow = true;
    physical.add(spine);

    const headbandMaterial = new THREE.MeshPhysicalMaterial({
      color: book.accent,
      roughness: 0.62,
      metalness: 0.2,
    });
    const headbandGeometry = new THREE.CylinderGeometry(0.017, 0.017, width - 0.1, 10);
    headbandGeometry.rotateZ(Math.PI / 2);
    const headbandTop = new THREE.Mesh(headbandGeometry, headbandMaterial);
    headbandTop.position.set(0, height * 0.5 - 0.045, 0);
    physical.add(headbandTop);
    const headbandBottom = headbandTop.clone();
    headbandBottom.position.y = -height * 0.5 + 0.045;
    physical.add(headbandBottom);

    const spineTexture = toTexture(createSpineCover(book), Math.min(4, anisotropy));
    const backTexture = toTexture(createBackCover(book), anisotropy);
    this.textures.push(spineTexture, backTexture);

    let frontTexture: THREE.Texture | null = null;
    if (!(useCoverImage && book.coverImage)) {
      frontTexture = toTexture(createFrontCover(book), anisotropy);
      this.textures.push(frontTexture);
    }
    this.frontMaterial = new THREE.MeshPhysicalMaterial({
      map: frontTexture,
      // Until the cover image arrives, show the board color instead of white.
      color: frontTexture ? "#ffffff" : book.cover,
      roughness: 0.62,
      metalness: 0.02,
      clearcoat: 0.08,
      clearcoatRoughness: 0.48,
    });
    const frontSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(width - 0.065, height - 0.065),
      this.frontMaterial,
    );
    frontSurface.position.z = depth * 0.5 + 0.019;
    physical.add(frontSurface);

    const backSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(width - 0.065, height - 0.065),
      new THREE.MeshStandardMaterial({ map: backTexture, roughness: 0.72 }),
    );
    backSurface.position.z = -depth * 0.5 - 0.019;
    backSurface.rotation.y = Math.PI;
    physical.add(backSurface);

    const spineSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(depth - 0.02, height - 0.04),
      new THREE.MeshPhysicalMaterial({
        map: spineTexture,
        roughness: 0.68,
        metalness: 0.015,
      }),
    );
    spineSurface.rotation.y = -Math.PI / 2;
    spineSurface.position.x = -width * 0.5 - 0.019;
    physical.add(spineSurface);

    // Five-star books get the reference's "living" foil sheen.
    if (book.myRating === 5) {
      this.livingMaterial = createLivingMaterial(book.accent);
      const shimmer = new THREE.Mesh(
        new THREE.PlaneGeometry(width - 0.07, height - 0.07),
        this.livingMaterial,
      );
      shimmer.position.z = depth * 0.5 + 0.034;
      this.inspectionIdle.add(shimmer);
    }

    this.pickProxy = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth + 0.07),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.pickProxy.userData.bookIndex = bookIndex;
    this.inspectionIdle.add(this.pickProxy);

    this.applyPose(pose);

    if (useCoverImage && book.coverImage) {
      this.coverUrl = book.coverImage;
      void cache.acquire(book.coverImage).then((texture) => {
        if (this.disposed) return;
        if (texture) {
          this.frontMaterial.map = texture;
          this.frontMaterial.color.set("#ffffff");
        } else {
          const fallback = toTexture(createFrontCover(book), anisotropy);
          this.textures.push(fallback);
          this.frontMaterial.map = fallback;
          this.frontMaterial.color.set("#ffffff");
        }
        this.frontMaterial.needsUpdate = true;
      });
    }
  }

  applyPose(pose: BookPose) {
    this.pose = { ...pose };
    this.content.position.x = pose.x;
    this.content.position.z = pose.z;
    this.content.rotation.y = pose.yaw;
    this.content.scale.setScalar(pose.scale);
  }

  dispose() {
    this.disposed = true;
    this.slot.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.slot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach(
        (material) => materials.add(material),
      );
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
    if (this.coverUrl) this.cache.release(this.coverUrl);
  }
}
