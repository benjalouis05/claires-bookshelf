import * as THREE from "three";
import type { Book } from "../catalog";
import type { AtlasRect, SpineAtlas } from "./SpineAtlas";

const pageColor = new THREE.Color("#d9ccb1");

/** Face kinds baked per vertex: 0 board, 1 spine, 2 page edges. */
function createBookGeometry() {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const normals = geometry.getAttribute("normal");
  const faces = new Float32Array(normals.count);
  for (let i = 0; i < normals.count; i += 1) {
    const nx = normals.getX(i);
    const nz = normals.getZ(i);
    faces[i] = nx < -0.5 ? 1 : Math.abs(nz) > 0.5 ? 0 : 2;
  }
  geometry.setAttribute("aFace", new THREE.BufferAttribute(faces, 1));
  return geometry;
}

function createLibraryMaterial(atlas: SpineAtlas) {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.8,
    metalness: 0,
  });
  const uniforms = {
    uFarA: { value: atlas.farTextures[0] },
    uFarB: { value: atlas.farTextures[1] },
    uNear: { value: atlas.nearTexture },
    uPaper: { value: pageColor },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aFace;
        attribute vec4 aSpine;
        attribute float aPage;
        attribute vec3 aBoard;
        attribute float aHighlight;
        varying float vFace;
        varying vec4 vSpine;
        varying float vPage;
        varying vec3 vBoard;
        varying float vHighlight;
        varying vec2 vBookUv;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vFace = aFace;
        vSpine = aSpine;
        vPage = aPage;
        vBoard = aBoard;
        vHighlight = aHighlight;
        vBookUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uFarA;
        uniform sampler2D uFarB;
        uniform sampler2D uNear;
        uniform vec3 uPaper;
        varying float vFace;
        varying vec4 vSpine;
        varying float vPage;
        varying vec3 vBoard;
        varying float vHighlight;
        varying vec2 vBookUv;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        if (vFace > 1.5) {
          diffuseColor.rgb = uPaper;
        } else if (vFace > 0.5) {
          vec2 spineUv = vec2(
            vSpine.x + vBookUv.x * vSpine.z,
            vSpine.y + (1.0 - vBookUv.y) * vSpine.w
          );
          vec4 texel = vPage > 1.5
            ? texture2D(uNear, spineUv)
            : vPage > 0.5 ? texture2D(uFarB, spineUv) : texture2D(uFarA, spineUv);
          diffuseColor.rgb = sRGBTransferEOTF(texel).rgb;
        } else {
          diffuseColor.rgb = vBoard;
        }
        diffuseColor.rgb *= 1.0 + vHighlight * 0.16;`,
      );
  };
  material.customProgramCacheKey = () => "instanced-library-v1";
  return material;
}

/**
 * All 765 books as one InstancedMesh: one draw call (plus one in the shadow
 * pass) regardless of library size. Instance `i` is catalog book `i`.
 */
export class InstancedLibrary {
  readonly mesh: THREE.InstancedMesh;
  private spine: THREE.InstancedBufferAttribute;
  private page: THREE.InstancedBufferAttribute;
  private highlight: THREE.InstancedBufferAttribute;
  private matrix = new THREE.Matrix4();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private position = new THREE.Vector3();
  private yAxis = new THREE.Vector3(0, 1, 0);
  private hidden = new Set<number>();

  constructor(
    private books: Book[],
    atlas: SpineAtlas,
  ) {
    const geometry = createBookGeometry();
    const count = books.length;
    this.spine = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.page = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.highlight = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    const board = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const color = new THREE.Color();
    books.forEach((book, index) => {
      color.set(book.cover);
      board.setXYZ(index, color.r, color.g, color.b);
    });
    geometry.setAttribute("aSpine", this.spine);
    geometry.setAttribute("aPage", this.page);
    geometry.setAttribute("aBoard", board);
    geometry.setAttribute("aHighlight", this.highlight);

    this.mesh = new THREE.InstancedMesh(geometry, createLibraryMaterial(atlas), count);
    this.mesh.name = "instancedLibrary";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  setSpine(index: number, rect: AtlasRect) {
    this.spine.setXYZW(index, rect.u, rect.v, rect.du, rect.dv);
    this.page.setX(index, rect.page);
    this.spine.needsUpdate = true;
    this.page.needsUpdate = true;
  }

  setHighlight(index: number, value: number) {
    this.highlight.setX(index, value);
    this.highlight.needsUpdate = true;
  }

  /** Books replaced by a detailed hero are collapsed to zero scale. */
  setHidden(index: number, hidden: boolean) {
    if (hidden) this.hidden.add(index);
    else this.hidden.delete(index);
  }

  isHidden(index: number) {
    return this.hidden.has(index);
  }

  /**
   * Writes one instance. `center` is the book's world-space center; `yaw`
   * turns the book's local frame (width on X, thickness on Z, spine on -X).
   */
  setPose(index: number, center: THREE.Vector3, yaw: number, scale = 1) {
    const book = this.books[index];
    const visibleScale = this.hidden.has(index) ? 0 : scale;
    this.position.copy(center);
    this.quaternion.setFromAxisAngle(this.yAxis, yaw);
    this.scale.set(
      book.width * visibleScale,
      book.height * visibleScale,
      book.thickness * visibleScale,
    );
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.mesh.setMatrixAt(index, this.matrix);
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  refreshBounds() {
    this.mesh.computeBoundingSphere();
    this.mesh.computeBoundingBox();
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
