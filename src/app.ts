import { SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { exportSplatShot, type ExportProgress, type ExportResult } from './export/exportShot';
import { autosave, clearAutosave, loadAutosave, parseProject, serializeProject } from './project/saveLoad';
import {
  defaultFixup,
  newId,
  newProject,
  newSplatShot,
  type Fixup,
  type Keyframe,
  type Project,
  type SceneDef,
  type SplatShot,
} from './project/schema';
import { fixupFromFloorPoints, fixupMatrix, robustBounds, rotateFixup, type Bounds } from './scene/fixup';
import { FlyControls } from './scene/flyControls';
import { Viewer } from './scene/viewer';
import { ShotSampler, newPose } from './shots/path';
import { buildPreset, type PresetId } from './shots/presets';
import { downloadBlob, toast } from './ui/dom';

const SPLAT_EXTENSIONS = ['spz', 'ply', 'splat', 'ksplat', 'sog'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'];
const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'webp'];
const MAX_SAMPLES = 200_000;

export type PickMode = null | 'floor3' | 'floor1' | 'dolly';

interface LoadedScene {
  mesh: SplatMesh;
  /** raw splat centres (xyz triples), subsampled; used for bounds */
  samples: Float32Array;
  numSplats: number;
}

function extension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function poseToKeyframe(pose: { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number }): Keyframe {
  const { position: p, quaternion: q } = pose;
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w], fov: Math.round(pose.fov * 10) / 10 };
}

/** Application state and every action the UI can trigger. */
export class App {
  project: Project = newProject();
  readonly viewer: Viewer;
  readonly controls: FlyControls;
  readonly loaded = new Map<string, LoadedScene>();

  activeSceneId: string | null = null;
  activeShotId: string | null = null;
  pickMode: PickMode = null;
  pickPoints: THREE.Vector3[] = [];
  /** what is being loaded right now, for the status line */
  busy: string | null = null;
  showGrid = false;
  showSafe = true;

  playing = false;
  /** playback position within the active shot, 0..1 */
  playTau = 0;

  private sampler: ShotSampler | null = null;
  private listeners = new Set<() => void>();
  private timeListeners = new Set<() => void>();
  private saveTimer = 0;
  private pose = newPose();
  private modifiers = { shift: false, alt: false };

  constructor(canvas: HTMLCanvasElement, stage: HTMLElement) {
    this.viewer = new Viewer(canvas, stage);
    this.controls = new FlyControls(this.viewer.camera, canvas);
    this.controls.onClick = (x, y) => this.handleClick(x, y);
    this.controls.onMove = () => this.notifyTime();
    this.viewer.onFrame = (dt) => this.frame(dt);

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.trackModifiers(e));

    const saved = loadAutosave();
    if (saved && (saved.scenes.length || saved.shots.length)) {
      this.project = saved;
      this.activeSceneId = saved.scenes[0]?.id ?? null;
    }
  }

  // ---- events ------------------------------------------------------------

  /** Structural change: panels rebuild. */
  onChange(fn: () => void) {
    this.listeners.add(fn);
  }
  /** Camera or playback time changed: readouts update. */
  onTime(fn: () => void) {
    this.timeListeners.add(fn);
  }
  changed() {
    this.touch();
    for (const fn of this.listeners) fn();
  }
  /** A value changed but the panels do not need rebuilding. */
  touch() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => autosave(this.project), 400);
  }
  /** Writes the browser autosave immediately. */
  saveNow() {
    clearTimeout(this.saveTimer);
    autosave(this.project);
  }
  private notifyTime() {
    for (const fn of this.timeListeners) fn();
  }

  // ---- lookups -----------------------------------------------------------

  get activeScene(): SceneDef | null {
    return this.project.scenes.find((s) => s.id === this.activeSceneId) ?? null;
  }
  get activeShot(): SplatShot | null {
    return this.project.shots.find((s) => s.id === this.activeShotId) ?? null;
  }
  isLoaded(sceneId: string): boolean {
    return this.loaded.has(sceneId);
  }
  get missingScenes(): SceneDef[] {
    return this.project.scenes.filter((s) => !this.loaded.has(s.id));
  }

  // ---- files -------------------------------------------------------------

  async addFiles(files: File[]) {
    for (const file of files) {
      const ext = extension(file.name);
      try {
        if (ext === 'json') await this.openProjectFile(file);
        else if (SPLAT_EXTENSIONS.includes(ext)) await this.addSplatFile(file);
        else if (VIDEO_EXTENSIONS.includes(ext)) toast(`${file.name}: video shots arrive in stage 2. Splat scans work now.`);
        else if (PHOTO_EXTENSIONS.includes(ext)) toast(`${file.name}: photo shots arrive in stage 4. Splat scans work now.`);
        else toast(`${file.name}: not a file type this tool uses (.spz, .ply, .splat or a project .json).`, 'error');
      } catch (error) {
        console.error(error);
        toast(`Could not load ${file.name}: ${(error as Error).message}`, 'error');
      } finally {
        this.busy = null;
        this.changed();
      }
    }
  }

  private async addSplatFile(file: File) {
    const sameName = this.project.scenes.find((s) => s.fileName.toLowerCase() === file.name.toLowerCase());
    if (sameName && this.loaded.has(sameName.id)) {
      toast(`${file.name} is already loaded.`);
      this.selectScene(sameName.id);
      return;
    }
    this.busy = `Loading ${file.name}…`;
    this.changed();

    const bytes = new Uint8Array(await file.arrayBuffer());
    const mesh = new SplatMesh({ fileBytes: bytes, fileName: file.name });
    await mesh.initialized;

    // subsample splat centres for bounds, floor detection and crop fitting
    let total = 0;
    mesh.forEachSplat(() => total++);
    if (total === 0) throw new Error('the file contains no splats');
    const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
    const samples = new Float32Array(Math.ceil(total / stride) * 3);
    let n = 0;
    mesh.forEachSplat((index, center) => {
      if (index % stride !== 0 || n * 3 + 2 >= samples.length) return;
      samples[n * 3] = center.x;
      samples[n * 3 + 1] = center.y;
      samples[n * 3 + 2] = center.z;
      n++;
    });

    let scene = sameName;
    const isNew = !scene;
    if (!scene) {
      scene = {
        id: newId('scene'),
        name: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        fileSize: file.size,
        fixup: defaultFixup(),
      };
      this.project.scenes.push(scene);
    }
    this.loaded.set(scene.id, { mesh, samples: samples.subarray(0, n * 3), numSplats: total });
    if (isNew) {
      const b = this.sceneBounds(scene.id, 0.01)!;
      scene.fixup.crop = { enabled: false, min: b.min, max: b.max, yaw: 0 };
    }
    this.selectScene(scene.id, isNew);
    toast(isNew ? `Loaded ${file.name}: ${total.toLocaleString()} splats.` : `Relinked ${file.name}.`);
  }

  /** Loads a splat from a URL (the bundled demo room or a public sample). */
  async addSplatFromUrl(url: string, fileName: string) {
    try {
      this.busy = `Downloading ${fileName}…`;
      this.changed();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const blob = await response.blob();
      await this.addSplatFile(new File([blob], fileName));
    } catch (error) {
      console.error(error);
      toast(`Could not load ${fileName}: ${(error as Error).message}`, 'error');
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  // ---- scenes and fix-up --------------------------------------------------

  selectScene(id: string | null, frame = false) {
    this.stop();
    this.setPickMode(null);
    this.activeSceneId = id;
    const scene = this.activeScene;
    const loaded = id ? this.loaded.get(id) : undefined;
    this.viewer.setMesh(loaded?.mesh ?? null);
    if (scene) this.viewer.applyFixup(scene.fixup);
    if (this.activeShot && this.activeShot.sceneId !== id) this.activeShotId = null;
    if (scene && loaded && frame) this.frameScene();
    this.syncHelpers();
    this.changed();
  }

  removeScene(id: string) {
    const scene = this.project.scenes.find((s) => s.id === id);
    if (!scene) return;
    const shots = this.project.shots.filter((s) => s.sceneId === id).length;
    const warn = shots ? ` and its ${shots} shot${shots > 1 ? 's' : ''}` : '';
    if (!confirm(`Remove "${scene.name}"${warn} from the project? The file on your disk is not touched.`)) return;
    this.loaded.get(id)?.mesh.dispose();
    this.loaded.delete(id);
    this.project.scenes = this.project.scenes.filter((s) => s.id !== id);
    this.project.shots = this.project.shots.filter((s) => s.sceneId !== id);
    if (this.activeSceneId === id) this.selectScene(this.project.scenes[0]?.id ?? null);
    else this.changed();
  }

  /** Bounds of a loaded scan in its levelled space. */
  sceneBounds(sceneId: string, trim: number, yaw = 0): Bounds | null {
    const scene = this.project.scenes.find((s) => s.id === sceneId);
    const loaded = this.loaded.get(sceneId);
    if (!scene || !loaded) return null;
    return robustBounds(loaded.samples, scene.fixup, yaw, trim);
  }

  /** Average position of the scan's splats in world space. */
  private sceneCentroid(sceneId: string): THREE.Vector3 {
    const scene = this.project.scenes.find((s) => s.id === sceneId)!;
    const { samples } = this.loaded.get(sceneId)!;
    const sum = new THREE.Vector3();
    const n = samples.length / 3;
    for (let i = 0; i < n; i++) sum.x += samples[i * 3], (sum.y += samples[i * 3 + 1]), (sum.z += samples[i * 3 + 2]);
    return sum.divideScalar(Math.max(1, n)).applyMatrix4(fixupMatrix(scene.fixup));
  }

  /** Puts the camera where the whole scan is in view and sets a sensible fly speed. */
  frameScene() {
    const id = this.activeSceneId;
    // Frame the dense middle of the scan: the outer 15% on each side is often
    // sky, far background or floaters, which would push the camera far away.
    const b = id ? this.sceneBounds(id, 0.15) : null;
    if (!b) return;
    const min = new THREE.Vector3(...b.min);
    const max = new THREE.Vector3(...b.max);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const radius = Math.max(0.2, min.distanceTo(max) / 2);
    const cam = this.viewer.camera;
    cam.position.set(center.x, center.y + radius * 0.25, center.z + radius * 1.6);
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    cam.fov = 60;
    cam.updateProjectionMatrix();
    this.controls.speed = THREE.MathUtils.clamp(radius * 0.5, 0.2, 6);
    this.notifyTime();
  }

  /**
   * Replaces the fix-up of the active scene. Keyframes already placed in that
   * scene are moved along with the scan, so every shot keeps its framing.
   */
  setFixup(next: Fixup) {
    const scene = this.activeScene;
    if (!scene) return;
    const delta = fixupMatrix(next).multiply(fixupMatrix(scene.fixup).invert());
    const deltaRot = new THREE.Quaternion().setFromRotationMatrix(delta);
    const v = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const shot of this.project.shots) {
      if (shot.sceneId !== scene.id) continue;
      for (const k of shot.keyframes) {
        v.set(...k.position).applyMatrix4(delta);
        k.position = [v.x, v.y, v.z];
        q.set(...k.quaternion).premultiply(deltaRot).normalize();
        k.quaternion = [q.x, q.y, q.z, q.w];
      }
      if (shot.dolly.target) {
        v.set(...shot.dolly.target).applyMatrix4(delta);
        shot.dolly.target = [v.x, v.y, v.z];
      }
    }
    // The view follows the scan (same spot, same direction), but the camera
    // is set upright again, so levelling a scan visibly levels the picture.
    const cam = this.viewer.camera;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).applyQuaternion(deltaRot);
    cam.position.applyMatrix4(delta);
    cam.up.set(0, 1, 0);
    cam.lookAt(v.copy(cam.position).add(forward));

    scene.fixup = next;
    this.viewer.applyFixup(next);
    this.rebuildSampler();
    this.changed();
  }

  rotateScene(axis: 'x' | 'y' | 'z', degrees: number) {
    const scene = this.activeScene;
    if (scene) this.setFixup(rotateFixup(scene.fixup, axis, degrees));
  }

  setFloor(floorY: number) {
    const scene = this.activeScene;
    if (scene) this.setFixup({ ...scene.fixup, floorY });
  }

  /** Guesses the floor as the height below which 2% of the splats lie. */
  autoFloor() {
    const scene = this.activeScene;
    const loaded = scene ? this.loaded.get(scene.id) : null;
    if (!scene || !loaded) return;
    const unshifted = robustBounds(loaded.samples, { ...scene.fixup, floorY: 0 }, 0, 0.02);
    this.setFloor(Math.round(unshifted.min[1] * 1000) / 1000);
    toast('Floor set to the lowest dense layer of the scan. Check it against the grid.');
  }

  resetFixup() {
    const scene = this.activeScene;
    if (!scene) return;
    this.setFixup({ ...defaultFixup(), crop: scene.fixup.crop });
  }

  /** Crop edits are frequent (slider drags), so they skip the panel rebuild. */
  updateCrop() {
    const scene = this.activeScene;
    if (!scene) return;
    this.viewer.applyCrop(scene.fixup.crop);
    this.syncHelpers();
    this.touch();
  }

  fitCrop() {
    const scene = this.activeScene;
    if (!scene) return;
    const b = this.sceneBounds(scene.id, 0.01, scene.fixup.crop.yaw);
    if (!b) return;
    scene.fixup.crop = { ...scene.fixup.crop, enabled: true, min: b.min, max: b.max };
    this.viewer.applyCrop(scene.fixup.crop);
    this.syncHelpers();
    this.changed();
  }

  syncHelpers() {
    const scene = this.activeScene;
    const loaded = !!scene && this.loaded.has(scene.id);
    this.viewer.grid.visible = this.showGrid && loaded;
    this.viewer.cropOutline.visible = loaded && !!scene?.fixup.crop.enabled && this.showGrid;
  }

  // ---- picking points in the scene ----------------------------------------

  setPickMode(mode: PickMode) {
    this.pickMode = mode;
    this.pickPoints = [];
    this.viewer.setPickMarkers([]);
    this.viewer.canvas.classList.toggle('picking', mode !== null);
  }

  private handleClick(clientX: number, clientY: number) {
    if (!this.pickMode) return;
    const scene = this.activeScene;
    const point = this.viewer.raycastClient(clientX, clientY);
    if (!scene || !point) {
      toast('Nothing was hit there. Click directly on the scan.', 'error');
      return;
    }
    if (this.pickMode === 'floor1') {
      this.setPickMode(null);
      this.setFloor(scene.fixup.floorY + point.y);
      toast('Floor level set.');
    } else if (this.pickMode === 'dolly') {
      const shot = this.activeShot;
      this.setPickMode(null);
      if (shot) {
        shot.dolly.target = [point.x, point.y, point.z];
        shot.dolly.enabled = true;
        this.rebuildSampler();
        toast('Dolly zoom subject set.');
      }
      this.changed();
    } else if (this.pickMode === 'floor3') {
      this.pickPoints.push(point);
      this.viewer.setPickMarkers(this.pickPoints);
      if (this.pickPoints.length < 3) {
        this.changed();
        return;
      }
      const [a, b, c] = this.pickPoints;
      // "up" is the side of the floor where most of the scan is
      const next = fixupFromFloorPoints(scene.fixup, a, b, c, this.sceneCentroid(scene.id));
      this.setPickMode(null);
      if (!next) {
        toast('Those three points are in a line. Pick three points spread out on the floor.', 'error');
        this.changed();
        return;
      }
      this.showGrid = true;
      this.setFixup(next);
      this.syncHelpers();
      toast('Scan levelled: the floor you clicked is now flat at height 0.');
    }
  }

  // ---- shots and keyframes -------------------------------------------------

  addShot(): SplatShot | null {
    const scene = this.activeScene;
    if (!scene) return null;
    const count = this.project.shots.filter((s) => s.sceneId === scene.id).length + 1;
    const shot = newSplatShot(scene.id, `${scene.name} ${count}`);
    this.project.shots.push(shot);
    this.selectShot(shot.id);
    return shot;
  }

  selectShot(id: string | null) {
    this.stop();
    this.activeShotId = id;
    const shot = this.activeShot;
    if (shot && shot.sceneId !== this.activeSceneId) {
      this.selectScene(shot.sceneId);
      this.activeShotId = id;
    }
    this.playTau = 0;
    this.rebuildSampler();
    this.changed();
  }

  deleteShot(id: string) {
    const shot = this.project.shots.find((s) => s.id === id);
    if (!shot || !confirm(`Delete shot "${shot.name}"?`)) return;
    this.project.shots = this.project.shots.filter((s) => s.id !== id);
    if (this.activeShotId === id) this.activeShotId = null;
    this.rebuildSampler();
    this.changed();
  }

  duplicateShot(id: string) {
    const shot = this.project.shots.find((s) => s.id === id);
    if (!shot) return;
    const copy: SplatShot = JSON.parse(JSON.stringify(shot));
    copy.id = newId('shot');
    copy.name = `${shot.name} copy`;
    this.project.shots.splice(this.project.shots.indexOf(shot) + 1, 0, copy);
    this.selectShot(copy.id);
  }

  addKeyframe() {
    let shot = this.activeShot;
    if (!shot) shot = this.addShot();
    if (!shot) {
      toast('Load a scan first, then add keyframes.', 'error');
      return;
    }
    this.stop();
    shot.keyframes.push(poseToKeyframe(this.viewer.getPose(this.pose)));
    this.rebuildSampler();
    this.changed();
  }

  updateKeyframe(index: number) {
    const shot = this.activeShot;
    if (!shot?.keyframes[index]) return;
    this.stop();
    shot.keyframes[index] = poseToKeyframe(this.viewer.getPose(this.pose));
    this.rebuildSampler();
    this.changed();
  }

  deleteKeyframe(index: number) {
    const shot = this.activeShot;
    if (!shot) return;
    shot.keyframes.splice(index, 1);
    this.rebuildSampler();
    this.changed();
  }

  moveKeyframe(index: number, by: number) {
    const shot = this.activeShot;
    const to = index + by;
    if (!shot || to < 0 || to >= shot.keyframes.length) return;
    const [k] = shot.keyframes.splice(index, 1);
    shot.keyframes.splice(to, 0, k);
    this.rebuildSampler();
    this.changed();
  }

  gotoKeyframe(index: number) {
    const k = this.activeShot?.keyframes[index];
    if (!k) return;
    this.stop();
    this.pose.position.set(...k.position);
    this.pose.quaternion.set(...k.quaternion);
    this.pose.fov = k.fov;
    this.viewer.setPose(this.pose);
    this.notifyTime();
  }

  applyPreset(id: PresetId) {
    let shot = this.activeShot;
    if (shot && shot.keyframes.length && !confirm('Replace the keyframes of this shot with the preset move?')) return;
    if (!shot) shot = this.addShot();
    if (!shot) {
      toast('Load a scan first.', 'error');
      return;
    }
    this.stop();
    const pose = this.viewer.getPose(newPose());
    // aim the move at what is in the middle of the view
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    const pivot = this.viewer.raycastNdc(0, 0) ?? pose.position.clone().addScaledVector(forward, 3);
    const result = buildPreset(id, pose, pivot);
    shot.keyframes = result.keyframes;
    shot.duration = result.duration;
    shot.easing = result.easing;
    shot.ramp = result.ramp;
    this.rebuildSampler();
    this.changed();
    this.play();
  }

  /** Call after any change to the active shot's keyframes or timing. */
  rebuildSampler() {
    const shot = this.activeShot;
    this.sampler = shot && shot.keyframes.length ? new ShotSampler(shot) : null;
    const keys = shot ? shot.keyframes.map((k) => new THREE.Vector3(...k.position)) : [];
    this.viewer.setPath(this.sampler ? this.sampler.path.polyline() : [], keys);
  }

  /** Shot settings changed through a slider or field: no panel rebuild. */
  shotEdited() {
    this.rebuildSampler();
    this.touch();
    if (!this.playing && this.sampler) this.scrub(this.playTau);
  }

  // ---- preview playback ----------------------------------------------------

  play() {
    if (!this.sampler || !this.activeShot) return;
    if (this.playTau >= 1) this.playTau = 0;
    this.playing = true;
    this.controls.enabled = false;
    this.viewer.helpers.visible = false;
    this.changed();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.controls.enabled = true;
    this.viewer.helpers.visible = true;
    this.changed();
  }

  togglePlay() {
    if (this.playing) this.stop();
    else this.play();
  }

  scrub(tau: number) {
    if (!this.sampler) return;
    this.playTau = Math.min(1, Math.max(0, tau));
    this.viewer.setPose(this.sampler.sample(this.playTau, this.pose));
    this.notifyTime();
  }

  private frame(dt: number) {
    if (this.playing && this.sampler && this.activeShot) {
      this.playTau += dt / this.activeShot.duration;
      if (this.playTau >= 1) this.playTau %= 1; // loop
      this.viewer.setPose(this.sampler.sample(this.playTau, this.pose));
      this.notifyTime();
    } else {
      this.controls.update(dt, this.modifiers.shift, this.modifiers.alt);
    }
  }

  private trackModifiers(e: KeyboardEvent) {
    this.modifiers.shift = e.shiftKey;
    this.modifiers.alt = e.altKey;
  }

  private onKey(e: KeyboardEvent) {
    this.trackModifiers(e);
    const el = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) && (el as HTMLInputElement).type !== 'range') return;
    if (e.metaKey || e.ctrlKey || this.viewer.exporting) return;
    // Space on a focused button presses that button, as usual
    if (e.code === 'Space' && el?.tagName === 'BUTTON') return;
    if (e.code === 'KeyK') {
      this.addKeyframe();
      e.preventDefault();
    } else if (e.code === 'Space') {
      this.togglePlay();
      e.preventDefault();
    } else if (e.code === 'Escape') {
      if (this.pickMode) {
        this.setPickMode(null);
        this.changed();
      } else this.stop();
    }
  }

  // ---- export --------------------------------------------------------------

  async exportActiveShot(onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
    const shot = this.activeShot;
    if (!shot) throw new Error('Select a shot first.');
    if (!this.loaded.has(shot.sceneId)) throw new Error('The scan for this shot is not loaded. Drop its file in first.');
    if (shot.keyframes.length === 0) throw new Error('This shot has no keyframes yet.');
    this.stop();
    this.setPickMode(null);
    if (this.activeSceneId !== shot.sceneId) this.selectScene(shot.sceneId);
    this.controls.enabled = false;
    try {
      return await exportSplatShot(this.viewer, shot, { onProgress, signal });
    } finally {
      this.controls.enabled = true;
    }
  }

  // ---- project files ---------------------------------------------------------

  saveProjectFile() {
    const name = this.project.name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || 'trailer';
    downloadBlob(new Blob([serializeProject(this.project)], { type: 'application/json' }), `${name}.json`);
    toast('Project saved. Keep it in the same folder as your scans and clips.');
  }

  private async openProjectFile(file: File) {
    const project = parseProject(await file.text());
    const hasWork = this.project.scenes.length || this.project.shots.length;
    if (hasWork && !confirm('Open this project and replace the one on screen?')) return;
    this.replaceProject(project);
    const missing = this.missingScenes.map((s) => s.fileName);
    toast(missing.length ? `Project opened. Now drop in: ${missing.join(', ')}` : 'Project opened.');
  }

  newProject() {
    const hasWork = this.project.scenes.length || this.project.shots.length;
    if (hasWork && !confirm('Start a new, empty project? Save the current one first if you need it.')) return;
    clearAutosave();
    this.replaceProject(newProject());
  }

  private replaceProject(project: Project) {
    this.stop();
    // keep scans that are already in memory when the new project uses the same files
    const keep = new Map<string, LoadedScene>();
    for (const scene of project.scenes) {
      const old = this.project.scenes.find((s) => s.fileName.toLowerCase() === scene.fileName.toLowerCase());
      const loaded = old ? this.loaded.get(old.id) : undefined;
      if (old && loaded) {
        keep.set(scene.id, loaded);
        this.loaded.delete(old.id);
      }
    }
    for (const unused of this.loaded.values()) unused.mesh.dispose();
    this.loaded.clear();
    for (const [id, loaded] of keep) this.loaded.set(id, loaded);

    this.project = project;
    this.activeShotId = null;
    this.selectScene(project.scenes[0]?.id ?? null, true);
  }
}
