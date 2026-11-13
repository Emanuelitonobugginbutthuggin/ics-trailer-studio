import { SparkRenderer, SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType, type SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { HEIGHT, WIDTH, type CropBox, type Fixup } from '../project/schema';
import type { Pose } from '../shots/path';
import { cropBoxTransform } from './fixup';

const ASPECT = WIDTH / HEIGHT;
const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Owns the WebGL canvas, the three.js scene and the Spark splat renderer.
 * The canvas always has the 9:16 shape of the final video, so what you
 * frame in the viewport is what gets exported.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, ASPECT, 0.02, 1000);
  readonly spark: SparkRenderer;
  /** carries the fix-up transform of the active scan */
  readonly fixGroup = new THREE.Group();
  /** grid, crop box outline, path line: never exported */
  readonly helpers = new THREE.Group();
  readonly grid: THREE.GridHelper;
  readonly cropOutline: THREE.LineSegments;
  readonly pathLine: THREE.Line;
  readonly keyMarkers: THREE.Points;
  readonly pickMarkers: THREE.Points;

  /** called every preview frame with the time step in seconds */
  onFrame: ((dt: number) => void) | null = null;
  exporting = false;

  private mesh: SplatMesh | null = null;
  private cropEdit: SplatEdit;
  private cropSdf: SplatEditSdf;
  private raycaster = new THREE.Raycaster();
  private lastTime = 0;
  private savedSize = new THREE.Vector2();
  private savedPixelRatio = 1;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private stage: HTMLElement,
  ) {
    // antialias off: MSAA does not help splats and costs a lot (Spark docs)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    this.scene.add(this.fixGroup);
    this.scene.add(this.helpers);
    this.scene.add(this.camera);

    // Opaque on purpose: opaque objects draw before the splats, so the scan
    // covers the grid where it is in front of it.
    this.grid = new THREE.GridHelper(40, 40, 0x2f7f99, 0x2a303b);
    this.grid.visible = false;
    this.helpers.add(this.grid);

    const box = new THREE.BoxGeometry(2, 2, 2);
    this.cropOutline = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xffb703 }));
    this.cropOutline.visible = false;
    this.helpers.add(this.cropOutline);
    box.dispose();

    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff4d6d }));
    this.pathLine.frustumCulled = false;
    this.helpers.add(this.pathLine);
    this.keyMarkers = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false }),
    );
    this.keyMarkers.frustumCulled = false;
    this.helpers.add(this.keyMarkers);
    this.pickMarkers = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0x4cc9f0, size: 12, sizeAttenuation: false, depthTest: false }),
    );
    this.pickMarkers.frustumCulled = false;
    this.helpers.add(this.pickMarkers);

    // Crop: everything outside the box gets opacity 0.
    this.cropEdit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, invert: true });
    this.cropSdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0 });
    this.cropEdit.add(this.cropSdf);

    this.camera.position.set(0, 1.5, 3);
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
    this.renderer.setAnimationLoop((time) => this.frame(time));
  }

  /** Fits the 9:16 canvas into the stage. */
  resize() {
    if (this.exporting) return;
    const pad = 16;
    const availW = Math.max(90, this.stage.clientWidth - pad * 2);
    const availH = Math.max(160, this.stage.clientHeight - pad * 2);
    const h = Math.floor(Math.min(availH, availW / ASPECT));
    const w = Math.floor(h * ASPECT);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    // never preview at more pixels than the export has
    const ratio = Math.min(window.devicePixelRatio || 1, 2, HEIGHT / h);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = ASPECT;
    this.camera.updateProjectionMatrix();
  }

  private frame(time: number) {
    if (this.exporting) return;
    const dt = Math.min(0.1, (time - this.lastTime) / 1000);
    this.lastTime = time;
    this.onFrame?.(dt);
    this.renderer.render(this.scene, this.camera);
  }

  setMesh(mesh: SplatMesh | null) {
    if (this.mesh) this.fixGroup.remove(this.mesh);
    this.mesh = mesh;
    if (mesh) this.fixGroup.add(mesh);
  }

  applyFixup(fixup: Fixup) {
    this.fixGroup.quaternion.set(...fixup.rotation);
    this.fixGroup.position.set(0, -fixup.floorY, 0);
    this.fixGroup.updateMatrixWorld(true);
    this.applyCrop(fixup.crop);
  }

  applyCrop(crop: CropBox) {
    const { center, half, rot } = cropBoxTransform(crop);
    this.cropSdf.position.copy(center);
    this.cropSdf.quaternion.copy(rot);
    this.cropSdf.scale.copy(half); // Spark reads the box half-size from scale
    this.cropOutline.position.copy(center);
    this.cropOutline.quaternion.copy(rot);
    this.cropOutline.scale.copy(half);
    if (crop.enabled && !this.cropEdit.parent) this.scene.add(this.cropEdit);
    if (!crop.enabled && this.cropEdit.parent) this.scene.remove(this.cropEdit);
  }

  setPose(pose: Pose) {
    this.camera.position.copy(pose.position);
    this.camera.quaternion.copy(pose.quaternion);
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  getPose(out: Pose): Pose {
    out.position.copy(this.camera.position);
    out.quaternion.copy(this.camera.quaternion);
    out.fov = this.camera.fov;
    return out;
  }

  /** First splat hit under a point of the canvas (client coordinates), in world space. */
  raycastClient(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.canvas.getBoundingClientRect();
    return this.raycastNdc(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
  }

  raycastNdc(x: number, y: number): THREE.Vector3 | null {
    if (!this.mesh) return null;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    return hits.length ? hits[0].point.clone() : null;
  }

  setPath(points: THREE.Vector3[], keys: THREE.Vector3[]) {
    this.pathLine.geometry.dispose();
    this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.keyMarkers.geometry.dispose();
    this.keyMarkers.geometry = new THREE.BufferGeometry().setFromPoints(keys);
  }

  setPickMarkers(points: THREE.Vector3[]) {
    this.pickMarkers.geometry.dispose();
    this.pickMarkers.geometry = new THREE.BufferGeometry().setFromPoints(points);
  }

  // ---- offline rendering -------------------------------------------------

  /** Switches the canvas to the exact export size and stops the live loop. */
  beginExport(width: number, height: number) {
    this.exporting = true;
    this.renderer.getSize(this.savedSize);
    this.savedPixelRatio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.helpers.visible = false;
    // from here on Spark only updates when renderExact() asks it to
    this.spark.autoUpdate = false;
  }

  endExport() {
    this.spark.autoUpdate = true;
    this.helpers.visible = true;
    this.renderer.setPixelRatio(this.savedPixelRatio);
    this.renderer.setSize(this.savedSize.x, this.savedSize.y, false);
    this.exporting = false;
    this.resize();
  }

  /**
   * Renders one frame with the splats fully sorted for the current camera.
   * Same idea as SuperSplat's video export (sort, wait, then render):
   * Spark's update() resolves once the sort it started has finished, but it
   * returns early if an older sort is still running, so wait for that first.
   */
  async renderExact() {
    const spark = this.spark;
    this.camera.updateMatrixWorld(true);
    const start = performance.now();
    for (;;) {
      await this.waitWhileSorting(start);
      await spark.update({ scene: this.scene, camera: this.camera });
      await this.waitWhileSorting(start);
      // sortDirty still set means Spark skipped the sort (for example the
      // splat set changed mid-update); ask again
      if (!spark.sortDirty) break;
      await tick(1);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private async waitWhileSorting(start: number) {
    while (this.spark.sorting) {
      if (performance.now() - start > 60_000) throw new Error('Splat sorting did not finish within 60 s');
      await tick(1);
    }
  }
}
