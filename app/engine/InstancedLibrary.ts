import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Book } from "../catalog";
import type { AtlasRect, SpineAtlas } from "./SpineAtlas";

const pageColor = new THREE.Color("#d9ccb1");

/**
 * A unit rounded box. Every vertex is an inner corner (`aCorner`, ±0.5 per
 * axis) pushed out along its normal, so the vertex shader can rebuild the
 * rounding at each instance's real size instead of stretching it.
 * Face kinds per vertex: 0 board, 1 spine, 2 page edges.
 */
function createBookGeometry() {
  const geometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.06);
  const positions = geometry.getAttribute("position");
  const count = positions.count;
  const corners = new Float32Array(count * 3);
  const faces = new Float32Array(count);
  const verticesPerSide = count / 6;
  // BoxGeometry side order: +x (fore-edge), -x (spine), ±y (page edges), ±z (boards).
  const faceKind = [2, 1, 2, 2, 0, 0];
  for (let i = 0; i < count; i += 1) {
    corners[i * 3] = Math.sign(positions.getX(i)) * 0.5;
    corners[i * 3 + 1] = Math.sign(positions.getY(i)) * 0.5;
    corners[i * 3 + 2] = Math.sign(positions.getZ(i)) * 0.5;
    faces[i] = faceKind[Math.floor(i / verticesPerSide)];
  }
  geometry.setAttribute("aCorner", new THREE.BufferAttribute(corners, 3));
  geometry.setAttribute("aFace", new THREE.BufferAttribute(faces, 1));
  return geometry;
}

/**
 * GLSL that rounds a unit box scaled by instanceMatrix with a per-book radius
 * (in scene units, so it looks the same on thin and thick books):
 * the inner corner sits at (size/2 − r) and the surface lies r along the
 * normal, expressed in pre-scale units.
 */
const roundedVertex = `
  vec3 roundScale = max(vec3(
    length(instanceMatrix[0].xyz),
    length(instanceMatrix[1].xyz),
    length(instanceMatrix[2].xyz)
  ), vec3(1e-4));
  vec3 roundRadius = min(vec3(aRadius), 0.45 * roundScale) / roundScale;
  vec3 transformed = aCorner + (normal - sign(aCorner)) * roundRadius;`;

function injectRounding(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
      attribute vec3 aCorner;
      attribute float aRadius;`,
    )
    .replace("#include <begin_vertex>", roundedVertex);
}

/** Shadow-pass material that applies the same rounding. */
function createDepthMaterial() {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.onBeforeCompile = injectRounding;
  material.customProgramCacheKey = () => "instanced-library-depth-v2";
  return material;
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
    injectRounding(shader);
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
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
        // Pre-multiply by the instance scale so three's inverse-transpose
        // normal transform leaves the rounded normals undistorted.
        objectNormal *= vec3(
          length(instanceMatrix[0].xyz),
          length(instanceMatrix[1].xyz),
          length(instanceMatrix[2].xyz)
        );`,
      )
      .replace(
        "vec3 roundScale",
        `vFace = aFace;
        vSpine = aSpine;
        vPage = aPage;
        vBoard = aBoard;
        vHighlight = aHighlight;
        vBookUv = uv;
        vec3 roundScale`,
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
  material.customProgramCacheKey = () => "instanced-library-v3";
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
    const radius = new THREE.InstancedBufferAttribute(
      Float32Array.from(books, (book) => book.cornerRadius),
      1,
    );
    const color = new THREE.Color();
    books.forEach((book, index) => {
      color.set(book.cover);
      board.setXYZ(index, color.r, color.g, color.b);
    });
    geometry.setAttribute("aSpine", this.spine);
    geometry.setAttribute("aPage", this.page);
    geometry.setAttribute("aBoard", board);
    geometry.setAttribute("aHighlight", this.highlight);
    geometry.setAttribute("aRadius", radius);

    this.mesh = new THREE.InstancedMesh(geometry, createLibraryMaterial(atlas), count);
    this.mesh.name = "instancedLibrary";
    this.mesh.customDepthMaterial = createDepthMaterial();
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
    this.mesh.customDepthMaterial?.dispose();
    this.mesh.dispose();
  }
}
