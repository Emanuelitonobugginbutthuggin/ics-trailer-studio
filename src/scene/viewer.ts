import { SparkRenderer, SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType, type SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { gradeActive, type LookSettings } from '../look/look';
import { HEIGHT, WIDTH, type CropBox, type Fixup, type Framing } from '../project/schema';
import type { Pose } from '../shots/path';
import { framingTransform } from '../shots/videoTime';
import { fxActive, type FrameFx } from '../timeline/timeline';
import { cropBoxTransform } from './fixup';

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Draws a video frame into the 9:16 frame. Pixel values pass through
// unchanged; outside the clip is black.
const VIDEO_FRAGMENT = /* glsl */ `
  uniform sampler2D tVideo;
  uniform vec2 uScale;
  uniform vec2 uOffset;
  varying vec2 vUv;
  void main() {
    vec2 uv = (vUv - 0.5) * uScale + 0.5 + uOffset;
    vec3 c = texture2D(tVideo, uv).rgb;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    gl_FragColor = vec4(c * inside, 1.0);
  }
`;

const SRGB_GLSL = /* glsl */ `
  vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  vec3 toSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
`;

// Motion blur: adds one sub-frame to the running sum. The sum is kept in
// linear light, as a camera sensor would collect it, so bright things
// leave bright streaks instead of grey ones.
const ACCUM_FRAGMENT = /* glsl */ `
  uniform sampler2D tFrame;
  uniform float uWeight;
  varying vec2 vUv;
  ${SRGB_GLSL}
  void main() {
    gl_FragColor = vec4(toLinear(texture2D(tFrame, vUv).rgb) * uWeight, 1.0);
  }
`;

// The finishing pass on every frame, in this order: whip (sideways slide
// with a directional blur, mirrored at the edges so no black shows), colour
// grade, vignette, flash, grain.
const POST_FRAGMENT = /* glsl */ `
  uniform sampler2D tFrame;
  uniform bool uLinearInput;
  uniform float uFlash;
  uniform float uWhip;
  uniform float uExposure;
  uniform float uContrast;
  uniform float uSaturation;
  uniform float uWarmth;
  uniform float uSplit;
  uniform float uFade;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uSeed;
  uniform vec2 uResolution;
  varying vec2 vUv;
  ${SRGB_GLSL}
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  float mirror(float x) {
    return 1.0 - abs(1.0 - mod(x, 2.0));
  }
  float hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  vec3 source(vec2 uv) {
    vec3 c = texture2D(tFrame, uv).rgb;
    return uLinearInput ? toSRGB(c) : c;
  }

  void main() {
    vec3 c;
    float strength = abs(uWhip);
    if (strength > 0.001) {
      float slide = uWhip * 0.7;
      float blur = strength * 0.45;
      c = vec3(0.0);
      const int TAPS = 32;
      for (int i = 0; i < TAPS; i++) {
        float o = (float(i) / float(TAPS - 1) - 0.5) * blur;
        c += source(vec2(mirror(vUv.x + slide + o), vUv.y));
      }
      c /= float(TAPS);
    } else {
      c = source(vUv);
    }

    // grade, on display values so the sliders behave like a photo editor
    c *= exp2(uExposure);
    c *= vec3(1.0 + 0.10 * uWarmth, 1.0, 1.0 - 0.10 * uWarmth);
    c = (c - 0.45) * uContrast + 0.45;
    float l = clamp(dot(c, LUMA), 0.0, 1.0);
    c += uSplit * 0.10 * mix(vec3(-0.55, 0.05, 0.50), vec3(0.50, 0.10, -0.55), smoothstep(0.15, 0.85, l));
    c = mix(vec3(dot(c, LUMA)), c, uSaturation);
    c = clamp(c, 0.0, 1.0);
    c = c * (1.0 - uFade) + uFade;

    vec2 d = (vUv - 0.5) * 2.0;
    c *= 1.0 - uVignette * 0.8 * smoothstep(0.55, 1.45, length(d));

    c = mix(c, vec3(1.0), clamp(uFlash, 0.0, 1.0));

    // grain: the same size relative to the frame in preview and export
    // (about 2 px at 1080 x 1920, so it survives video compression)
    if (uGrain > 0.0) {
      vec2 cell = floor(gl_FragCoord.xy / max(1.0, uResolution.y / 960.0));
      float n = hash(cell + uSeed * vec2(17.13, 31.71)) + hash(cell.yx + uSeed * vec2(5.77, 91.3)) - 1.0;
      float lum = dot(c, LUMA);
      c += n * uGrain * 0.22 * (1.0 - 0.6 * abs(2.0 * lum - 1.0));
    }
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }
`;

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
  private exportResized = false;

  // full-screen passes: video frames and post effects
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private videoMaterial = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: VIDEO_FRAGMENT,
    uniforms: { tVideo: { value: null }, uScale: { value: new THREE.Vector2(1, 1) }, uOffset: { value: new THREE.Vector2() } },
    depthTest: false,
    depthWrite: false,
  });
  private postMaterial = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: POST_FRAGMENT,
    uniforms: {
      tFrame: { value: null },
      uLinearInput: { value: false },
      uFlash: { value: 0 },
      uWhip: { value: 0 },
      uExposure: { value: 0 },
      uContrast: { value: 1 },
      uSaturation: { value: 1 },
      uWarmth: { value: 0 },
      uSplit: { value: 0 },
      uFade: { value: 0 },
      uVignette: { value: 0 },
      uGrain: { value: 0 },
      uSeed: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    depthTest: false,
    depthWrite: false,
  });
  private accumMaterial = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader: ACCUM_FRAGMENT,
    uniforms: { tFrame: { value: null }, uWeight: { value: 1 } },
    depthTest: false,
    depthWrite: false,
    // sub-frames add up
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  private accumQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.accumMaterial);
  private accumTarget: THREE.WebGLRenderTarget | null = null;
  private videoQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.videoMaterial);
  private postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
  private frameCopy: THREE.FramebufferTexture | null = null;
  private exportCanvasTexture: THREE.Texture | null = null;

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
    // onFrame draws the frame: draw3D() or drawVideo(), then present()
    this.onFrame?.(dt);
  }

  /** Draws the 3D scene (live: the splats may still be re-sorting). */
  draw3D() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Draws a video frame into the 9:16 frame instead of the 3D scene. */
  drawVideo(texture: THREE.Texture, clipWidth: number, clipHeight: number, framing: Framing) {
    const { scale, offset } = framingTransform(framing, clipWidth / clipHeight, this.camera.aspect);
    const u = this.videoMaterial.uniforms;
    u.tVideo.value = texture;
    u.uScale.value.set(scale[0], scale[1]);
    u.uOffset.value.set(offset[0], offset[1]);
    this.renderer.render(this.videoQuad, this.quadCamera);
  }

  /** Export: draws an exactly decoded frame (a canvas from the decoder). */
  drawVideoCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, framing: Framing) {
    let texture = this.exportCanvasTexture;
    if (!texture || texture.image !== canvas) {
      texture?.dispose();
      texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      this.exportCanvasTexture = texture;
    }
    texture.needsUpdate = true;
    this.drawVideo(texture, canvas.width, canvas.height, framing);
  }

  /** The frame on the canvas, copied into a texture the post pass can read. */
  private copyFrame(): THREE.FramebufferTexture {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!this.frameCopy || this.frameCopy.image.width !== size.x || this.frameCopy.image.height !== size.y) {
      this.frameCopy?.dispose();
      this.frameCopy = new THREE.FramebufferTexture(size.x, size.y);
      this.frameCopy.minFilter = THREE.LinearFilter;
      this.frameCopy.magFilter = THREE.LinearFilter;
    }
    this.renderer.copyFramebufferToTexture(this.frameCopy);
    return this.frameCopy;
  }

  /** Motion blur needs a render target with more than 8 bits per channel. */
  get canAccumulate(): boolean {
    const ext = this.renderer.extensions;
    return ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
  }

  /** Motion blur: starts a new output frame with an empty sum. */
  accumBegin() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!this.accumTarget || this.accumTarget.width !== size.x || this.accumTarget.height !== size.y) {
      this.accumTarget?.dispose();
      this.accumTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }
    const r = this.renderer;
    r.setRenderTarget(this.accumTarget);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.setRenderTarget(null);
  }

  /** Motion blur: adds the sub-frame that was just drawn on the canvas, with a weight (1 / samples). */
  accumAdd(weight: number) {
    const r = this.renderer;
    this.accumMaterial.uniforms.tFrame.value = this.copyFrame();
    this.accumMaterial.uniforms.uWeight.value = weight;
    const autoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.accumTarget);
    r.render(this.accumQuad, this.quadCamera);
    r.setRenderTarget(null);
    r.autoClear = autoClear;
  }

  /**
   * Finishes the frame: transition effects and the look (grade, vignette,
   * grain). `source` is the frame just drawn on the canvas, or the motion
   * blur sum built with accumBegin / accumAdd.
   *
   * The frame is always drawn straight to the canvas first and copied from
   * there, because Spark blends splats differently (in linear light) when
   * it renders into an offscreen target, which would change how scans look.
   * With nothing to apply this does nothing, so plain frames are untouched.
   */
  present(fx: FrameFx | null, look: LookSettings | null = null, seed = 0, source: 'canvas' | 'accum' = 'canvas') {
    const graded = gradeActive(look);
    const hasFx = !!fx && fxActive(fx);
    if (!graded && !hasFx && source === 'canvas') return;
    const u = this.postMaterial.uniforms;
    u.tFrame.value = source === 'accum' ? this.accumTarget!.texture : this.copyFrame();
    u.uLinearInput.value = source === 'accum';
    u.uFlash.value = hasFx ? fx!.flash : 0;
    u.uWhip.value = hasFx ? fx!.whip : 0;
    u.uExposure.value = graded ? look!.exposure : 0;
    u.uContrast.value = graded ? look!.contrast : 1;
    u.uSaturation.value = graded ? look!.saturation : 1;
    u.uWarmth.value = graded ? look!.warmth : 0;
    u.uSplit.value = graded ? look!.splitTone : 0;
    u.uFade.value = graded ? look!.fade : 0;
    u.uVignette.value = graded ? look!.vignette : 0;
    u.uGrain.value = graded ? look!.grain : 0;
    u.uSeed.value = seed % 1024;
    this.renderer.getDrawingBufferSize(u.uResolution.value);
    this.renderer.render(this.postQuad, this.quadCamera);
  }

  setMesh(mesh: SplatMesh | null) {
    if (this.mesh === mesh) return;
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

  /**
   * Stops the live loop for exact rendering. With a size the canvas switches
   * to exactly that many pixels (export); without, it keeps its preview size.
   */
  beginExport(width?: number, height?: number) {
    this.exporting = true;
    this.renderer.getSize(this.savedSize);
    this.savedPixelRatio = this.renderer.getPixelRatio();
    this.exportResized = !!(width && height);
    if (width && height) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.helpers.visible = false;
    // from here on Spark only updates when renderExact() asks it to
    this.spark.autoUpdate = false;
  }

  endExport() {
    this.spark.autoUpdate = true;
    this.helpers.visible = true;
    this.exporting = false;
    // setting the size clears the canvas, so only do it if it was changed
    // (a test frame keeps the preview size and must stay on screen)
    if (this.exportResized) {
      this.renderer.setPixelRatio(this.savedPixelRatio);
      this.renderer.setSize(this.savedSize.x, this.savedSize.y, false);
      this.resize();
    }
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
