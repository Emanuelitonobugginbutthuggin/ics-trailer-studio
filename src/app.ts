import { SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { exportTimeline, renderEntryFrames, singleShotTimeline, type ExportMedia, type ExportProgress, type ExportResult } from './export/exportSequence';
import { LOOK_PRESETS, type LookSettings } from './look/look';
import { Music } from './media/music';
import { VideoClip, clipWarnings } from './media/videoClip';
import { FPS } from './project/schema';
import { autosave, clearAutosave, loadAutosave, parseProject, serializeProject } from './project/saveLoad';
import {
  defaultFixup,
  newId,
  newProject,
  newSplatShot,
  newVideoShot,
  type Fixup,
  type Keyframe,
  type Project,
  type SceneDef,
  type Shot,
  type SplatShot,
  type VideoShot,
} from './project/schema';
import { fixupFromFloorPoints, fixupMatrix, robustBounds, rotateFixup, type Bounds } from './scene/fixup';
import { FlyControls } from './scene/flyControls';
import { Viewer } from './scene/viewer';
import { ShotSampler, newPose } from './shots/path';
import { buildPreset, type PresetId } from './shots/presets';
import { VideoShotSampler } from './shots/videoTime';
import {
  MIN_SHOT_SECONDS,
  beatOffsetFromAudio,
  buildTimeline,
  entryIndexAtFrame,
  frameFx,
  gridStep,
  snapDurations,
  snapTime,
  type Timeline,
} from './timeline/timeline';
import { downloadBlob, toast } from './ui/dom';

const SPLAT_EXTENSIONS = ['spz', 'ply', 'splat', 'ksplat', 'sog'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'];
const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'webp'];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'];
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
  /** loaded scans, by scene id */
  readonly loaded = new Map<string, LoadedScene>();
  /** loaded clips, by video id */
  readonly clips = new Map<string, VideoClip>();
  music: Music | null = null;

  activeSceneId: string | null = null;
  activeShotId: string | null = null;
  pickMode: PickMode = null;
  pickPoints: THREE.Vector3[] = [];
  /** what is being loaded right now, for the status line */
  busy: string | null = null;
  showGrid = false;
  showSafe = true;

  /** shot: edit and preview one shot. trailer: preview the whole cut with music. */
  mode: 'shot' | 'trailer' = 'shot';
  playing = false;
  /** playback position within the active shot, 0..1 */
  playTau = 0;
  /** playback position in the trailer, seconds */
  trailerTime = 0;

  private splatSamplers = new Map<string, ShotSampler>();
  private videoSamplers = new Map<string, VideoShotSampler>();
  private timelineCache: Timeline | null = null;
  private shownSceneId: string | null | undefined = undefined;
  private liveClip: VideoClip | null = null;
  private taps: number[] = [];
  /** which tab the right panel shows */
  rightTab: 'shots' | 'look' = 'shots';
  /** a test frame at export quality is on screen; the live loop leaves it alone */
  still = false;
  /** true while a test frame is being rendered */
  rendering = false;
  /** performance.now() at which trailer time 0 would have played, while playing */
  private trailerClockStart = 0;
  private listeners = new Set<() => void>();
  private timeListeners = new Set<() => void>();
  private saveTimer = 0;
  private pose = newPose();
  private modifiers = { shift: false, alt: false };

  constructor(canvas: HTMLCanvasElement, stage: HTMLElement) {
    this.viewer = new Viewer(canvas, stage);
    this.controls = new FlyControls(this.viewer.camera, canvas);
    this.controls.onClick = (x, y) => this.handleClick(x, y);
    this.controls.onMove = () => {
      this.still = false;
      this.notifyTime();
    };
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
    this.still = false;
    this.timelineCache = null;
    this.splatSamplers.clear();
    this.videoSamplers.clear();
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
  get activeShot(): Shot | null {
    return this.project.shots.find((s) => s.id === this.activeShotId) ?? null;
  }
  /** the active shot if it is a camera move through a scan */
  get activeSplatShot(): SplatShot | null {
    const shot = this.activeShot;
    return shot?.type === 'splat' ? shot : null;
  }
  isLoaded(sceneId: string): boolean {
    return this.loaded.has(sceneId);
  }
  get missingScenes(): SceneDef[] {
    return this.project.scenes.filter((s) => !this.loaded.has(s.id));
  }
  /** file names the project refers to that have not been dropped in yet */
  get missingFiles(): string[] {
    const audio = this.project.timeline.audio;
    return [
      ...this.missingScenes.map((s) => s.fileName),
      ...this.project.videos.filter((v) => !this.clips.has(v.id)).map((v) => v.fileName),
      ...(audio && !this.music ? [audio.fileName] : []),
    ];
  }
  /** true when the media a shot needs is loaded */
  shotReady(shot: Shot): boolean {
    return shot.type === 'splat' ? this.loaded.has(shot.sceneId) : this.clips.has(shot.videoId);
  }
  get timeline(): Timeline {
    this.timelineCache ??= buildTimeline(this.project);
    return this.timelineCache;
  }
  get trailerSeconds(): number {
    return this.timeline.totalFrames / FPS;
  }

  // ---- files -------------------------------------------------------------

  async addFiles(files: File[]) {
    for (const file of files) {
      const ext = extension(file.name);
      try {
        if (ext === 'json') await this.openProjectFile(file);
        else if (SPLAT_EXTENSIONS.includes(ext)) await this.addSplatFile(file);
        else if (VIDEO_EXTENSIONS.includes(ext)) await this.addVideoFile(file);
        else if (AUDIO_EXTENSIONS.includes(ext)) await this.loadMusic(file);
        else if (PHOTO_EXTENSIONS.includes(ext)) toast(`${file.name}: photo shots arrive in stage 4.`);
        else toast(`${file.name}: not a file type this tool uses (scans: .spz .ply .splat, clips: .mp4 .mov, music: .mp3 .m4a .wav, or a project .json).`, 'error');
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

  // ---- video clips and music ----------------------------------------------

  private async addVideoFile(file: File) {
    const sameName = this.project.videos.find((v) => v.fileName.toLowerCase() === file.name.toLowerCase());
    if (sameName && this.clips.has(sameName.id)) {
      toast(`${file.name} is already loaded.`);
      return;
    }
    this.busy = `Reading ${file.name}…`;
    this.changed();
    const clip = await VideoClip.open(file);
    const { info } = clip;

    let video = sameName;
    if (!video) {
      video = {
        id: newId('video'),
        name: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        fileSize: file.size,
        duration: info.duration,
        width: info.width,
        height: info.height,
      };
      this.project.videos.push(video);
    }
    this.clips.set(video.id, clip);
    const warnings = clipWarnings(info, clip.previewOk);
    if (!sameName) this.addVideoShot(video.id);
    else this.changed();
    if (warnings.length) toast(`${file.name}: ${warnings.join(' ')}`, !info.canDecode || info.hdr ? 'error' : 'info');
    else toast(sameName ? `Relinked ${file.name}.` : `Loaded ${file.name}: ${info.width} × ${info.height}, ${info.duration.toFixed(1)} s.`);
  }

  clipProblems(videoId: string): string[] {
    const clip = this.clips.get(videoId);
    return clip ? clipWarnings(clip.info, clip.previewOk) : [];
  }

  removeVideo(id: string) {
    const video = this.project.videos.find((v) => v.id === id);
    if (!video) return;
    const shots = this.project.shots.filter((s) => s.type === 'video' && s.videoId === id).length;
    const warn = shots ? ` and its ${shots} shot${shots > 1 ? 's' : ''}` : '';
    if (!confirm(`Remove "${video.name}"${warn} from the project? The file on your disk is not touched.`)) return;
    this.stop();
    if (this.liveClip === this.clips.get(id)) this.liveClip = null;
    this.clips.get(id)?.dispose();
    this.clips.delete(id);
    this.project.videos = this.project.videos.filter((v) => v.id !== id);
    this.project.shots = this.project.shots.filter((s) => !(s.type === 'video' && s.videoId === id));
    if (!this.activeShot) this.activeShotId = null;
    this.changed();
  }

  addVideoShot(videoId: string): VideoShot | null {
    const video = this.project.videos.find((v) => v.id === videoId);
    if (!video) return null;
    const count = this.project.shots.filter((s) => s.type === 'video' && s.videoId === videoId).length + 1;
    const shot = newVideoShot(video, `${video.name} ${count}`);
    this.project.shots.push(shot);
    this.selectShot(shot.id);
    return shot;
  }

  private async loadMusic(file: File) {
    this.busy = `Reading ${file.name}…`;
    this.changed();
    const music = await Music.load(file);
    this.stop();
    this.music?.stop();
    this.music = music;
    const t = this.project.timeline;
    if (t.audio && t.audio.fileName.toLowerCase() === file.name.toLowerCase()) {
      toast(`Relinked ${file.name}.`);
      return;
    }
    t.audio = { fileName: file.name, start: 0, firstBeat: 0 };
    await this.detectBeat();
  }

  /** Finds tempo and first beat of the loaded song; the trailer then starts on that beat. */
  async detectBeat() {
    const t = this.project.timeline;
    if (!this.music || !t.audio) return;
    try {
      this.busy = 'Finding the beat…';
      this.changed();
      const { bpm, firstBeat } = await this.music.detectBeat();
      t.bpm = bpm;
      t.audio.firstBeat = firstBeat;
      // start the trailer on the first beat (rounded down so the beat is never just before 0)
      t.audio.start = Math.floor(firstBeat * 1000) / 1000;
      this.updateBeatOffset();
      toast(`${t.audio.fileName}: ${bpm} BPM. Check it against the song; you can type the BPM or tap it.`);
    } catch (error) {
      console.error(error);
      toast('Could not find a clear beat in this song. Type the BPM or tap it instead.', 'error');
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  removeMusic() {
    this.stop();
    this.music?.stop();
    this.music = null;
    this.project.timeline.audio = null;
    this.project.timeline.beatOffset = 0;
    this.changed();
  }

  /** Call after BPM or song start changed. */
  updateBeatOffset() {
    const t = this.project.timeline;
    t.beatOffset = t.audio ? beatOffsetFromAudio(t.bpm, t.audio.firstBeat, t.audio.start) : 0;
  }

  /** Tap along with the music: the BPM is the average of the last taps. */
  tapTempo() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length >= 3) {
      const span = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      this.project.timeline.bpm = Math.round((60_000 / span) * 10) / 10;
      this.updateBeatOffset();
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
    this.shownSceneId = undefined;
    this.showScene(id);
    const shot = this.activeShot;
    if (shot && (shot.type !== 'splat' || shot.sceneId !== id)) this.activeShotId = null;
    this.refreshPath();
    if (scene && loaded && frame) this.frameScene();
    this.syncHelpers();
    this.changed();
  }

  removeScene(id: string) {
    const scene = this.project.scenes.find((s) => s.id === id);
    if (!scene) return;
    const ofScene = (s: Shot) => s.type === 'splat' && s.sceneId === id;
    const shots = this.project.shots.filter(ofScene).length;
    const warn = shots ? ` and its ${shots} shot${shots > 1 ? 's' : ''}` : '';
    if (!confirm(`Remove "${scene.name}"${warn} from the project? The file on your disk is not touched.`)) return;
    this.stop();
    this.shownSceneId = undefined;
    this.viewer.setMesh(null);
    this.loaded.get(id)?.mesh.dispose();
    this.loaded.delete(id);
    this.project.scenes = this.project.scenes.filter((s) => s.id !== id);
    this.project.shots = this.project.shots.filter((s) => !ofScene(s));
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
      if (shot.type !== 'splat' || shot.sceneId !== scene.id) continue;
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
    this.refreshPath();
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
    // helper lines are for editing a camera move only
    this.viewer.helpers.visible = this.mode === 'shot' && !this.playing && this.activeShot?.type !== 'video';
    this.controls.enabled = this.viewer.helpers.visible;
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
      const shot = this.activeSplatShot;
      this.setPickMode(null);
      if (shot) {
        shot.dolly.target = [point.x, point.y, point.z];
        shot.dolly.enabled = true;
        this.refreshPath();
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
    const count = this.project.shots.filter((s) => s.type === 'splat' && s.sceneId === scene.id).length + 1;
    const shot = newSplatShot(scene.id, `${scene.name} ${count}`);
    this.project.shots.push(shot);
    this.selectShot(shot.id);
    return shot;
  }

  selectShot(id: string | null) {
    this.stop();
    this.setPickMode(null);
    this.activeShotId = id;
    const shot = this.activeShot;
    if (shot?.type === 'splat' && shot.sceneId !== this.activeSceneId) {
      this.selectScene(shot.sceneId);
      this.activeShotId = id;
    }
    this.playTau = 0;
    // in trailer view, selecting a shot jumps to where it starts
    const entry = this.timeline.entries.find((e) => e.shot.id === id);
    if (this.mode === 'trailer' && entry) this.trailerTime = entry.startFrame / FPS;
    this.refreshPath();
    this.syncHelpers();
    this.changed();
  }

  deleteShot(id: string) {
    const shot = this.project.shots.find((s) => s.id === id);
    if (!shot || !confirm(`Delete shot "${shot.name}"?`)) return;
    this.stop();
    this.project.shots = this.project.shots.filter((s) => s.id !== id);
    if (this.activeShotId === id) this.activeShotId = null;
    this.refreshPath();
    this.syncHelpers();
    this.changed();
  }

  duplicateShot(id: string) {
    const shot = this.project.shots.find((s) => s.id === id);
    if (!shot) return;
    const copy: Shot = JSON.parse(JSON.stringify(shot));
    copy.id = newId('shot');
    copy.name = `${shot.name} copy`;
    this.project.shots.splice(this.project.shots.indexOf(shot) + 1, 0, copy);
    this.selectShot(copy.id);
  }

  /** Moves a shot earlier (-1) or later (+1) in the trailer order. */
  moveShot(id: string, by: number) {
    const shots = this.project.shots;
    const from = shots.findIndex((s) => s.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= shots.length) return;
    const [shot] = shots.splice(from, 1);
    shots.splice(to, 0, shot);
    this.changed();
  }

  addKeyframe() {
    if (this.mode !== 'shot' || this.activeShot?.type === 'video') return;
    let shot = this.activeSplatShot;
    if (!shot) shot = this.addShot();
    if (!shot) {
      toast('Load a scan first, then add keyframes.', 'error');
      return;
    }
    this.stop();
    shot.keyframes.push(poseToKeyframe(this.viewer.getPose(this.pose)));
    this.refreshPath();
    this.changed();
  }

  updateKeyframe(index: number) {
    const shot = this.activeSplatShot;
    if (!shot?.keyframes[index]) return;
    this.stop();
    shot.keyframes[index] = poseToKeyframe(this.viewer.getPose(this.pose));
    this.refreshPath();
    this.changed();
  }

  deleteKeyframe(index: number) {
    const shot = this.activeSplatShot;
    if (!shot) return;
    shot.keyframes.splice(index, 1);
    this.refreshPath();
    this.changed();
  }

  moveKeyframe(index: number, by: number) {
    const shot = this.activeSplatShot;
    const to = index + by;
    if (!shot || to < 0 || to >= shot.keyframes.length) return;
    const [k] = shot.keyframes.splice(index, 1);
    shot.keyframes.splice(to, 0, k);
    this.refreshPath();
    this.changed();
  }

  gotoKeyframe(index: number) {
    const k = this.activeSplatShot?.keyframes[index];
    if (!k) return;
    this.setMode('shot');
    this.stop();
    this.pose.position.set(...k.position);
    this.pose.quaternion.set(...k.quaternion);
    this.pose.fov = k.fov;
    this.viewer.setPose(this.pose);
    this.notifyTime();
  }

  applyPreset(id: PresetId) {
    let shot = this.activeSplatShot;
    if (shot && shot.keyframes.length && !confirm('Replace the keyframes of this shot with the preset move?')) return;
    if (!shot) shot = this.addShot();
    if (!shot) {
      toast('Load a scan first.', 'error');
      return;
    }
    this.setMode('shot');
    this.stop();
    const pose = this.viewer.getPose(newPose());
    // aim the move at what is in the middle of the view
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    const pivot = this.viewer.raycastNdc(0, 0) ?? pose.position.clone().addScaledVector(forward, 3);
    const result = buildPreset(id, pose, pivot);
    shot.keyframes = result.keyframes;
    shot.easing = result.easing;
    shot.ramp = result.ramp;
    this.setShotDuration(shot, result.duration);
    this.refreshPath();
    this.changed();
    this.play();
  }

  private splatSampler(shot: SplatShot): ShotSampler | null {
    if (!shot.keyframes.length) return null;
    let sampler = this.splatSamplers.get(shot.id);
    if (!sampler) this.splatSamplers.set(shot.id, (sampler = new ShotSampler(shot)));
    return sampler;
  }

  private videoSampler(shot: VideoShot, clip: VideoClip): VideoShotSampler {
    let sampler = this.videoSamplers.get(shot.id);
    if (!sampler) this.videoSamplers.set(shot.id, (sampler = new VideoShotSampler(shot, clip.info.duration)));
    return sampler;
  }

  /** Redraws the path line of the active shot. Call after its keyframes or timing change. */
  refreshPath() {
    this.splatSamplers.clear();
    this.videoSamplers.clear();
    const shot = this.activeSplatShot;
    const sampler = shot ? this.splatSampler(shot) : null;
    const keys = shot ? shot.keyframes.map((k) => new THREE.Vector3(...k.position)) : [];
    this.viewer.setPath(sampler ? sampler.path.polyline() : [], keys);
  }

  /** Shot settings changed through a slider or field: no panel rebuild. */
  shotEdited() {
    this.touch();
    this.refreshPath();
    if (!this.playing && this.mode === 'shot') this.scrub(this.playTau);
  }

  /** Average playback speed of a video shot relative to real time. */
  videoShotRate(shot: VideoShot): number {
    return (shot.trimOut - shot.trimIn) / shot.duration;
  }

  // ---- trailer timeline ------------------------------------------------------

  /** Trailer time at which a shot starts, or null if it is not in the trailer. */
  private shotStart(shot: Shot): number | null {
    let time = 0;
    for (const s of this.project.shots) {
      if (s === shot) return s.inTrailer ? time : null;
      if (s.inTrailer) time += s.duration;
    }
    return null;
  }

  /**
   * Sets a shot's length. With snapping on, the shot's end lands on the
   * nearest beat line (at least one grid step after its start).
   */
  setShotDuration(shot: Shot, seconds: number) {
    const t = this.project.timeline;
    let duration = Math.max(MIN_SHOT_SECONDS, seconds);
    const start = this.shotStart(shot);
    if (t.snap && start !== null) {
      const step = gridStep(t);
      let end = snapTime(t, start + duration);
      while (end - start < Math.max(MIN_SHOT_SECONDS, step * 0.5)) end += step;
      duration = end - start;
    }
    shot.duration = Math.round(duration * 1e4) / 1e4;
    this.touch();
  }

  /** Moves every cut of the trailer onto the beat grid. */
  snapAllCuts() {
    const shots = this.project.shots.filter((s) => s.inTrailer);
    const snapped = snapDurations(shots.map((s) => s.duration), this.project.timeline);
    shots.forEach((s, i) => (s.duration = snapped[i]));
    this.changed();
    toast(`${shots.length} cuts moved onto the beat.`);
  }

  setMode(mode: 'shot' | 'trailer') {
    if (this.mode === mode) return;
    this.stop();
    this.setPickMode(null);
    this.mode = mode;
    if (mode === 'trailer') {
      const entry = this.timeline.entries.find((e) => e.shot.id === this.activeShotId);
      if (entry) this.trailerTime = entry.startFrame / FPS;
    } else {
      this.liveClip?.pause();
      this.showScene(this.activeSceneId);
    }
    this.syncHelpers();
    this.changed();
  }

  scrubTrailer(seconds: number) {
    this.stop();
    this.still = false;
    this.trailerTime = Math.min(Math.max(0, seconds), Math.max(0, this.trailerSeconds - 1 / FPS));
    this.notifyTime();
  }

  // ---- preview playback ----------------------------------------------------

  play() {
    if (this.playing) return;
    this.still = false;
    if (this.mode === 'trailer') {
      if (!this.timeline.entries.length) return;
      if (this.trailerTime >= this.trailerSeconds - 2 / FPS) this.trailerTime = 0;
      const audio = this.project.timeline.audio;
      if (this.music && audio) this.music.play(audio.start + this.trailerTime);
      this.trailerClockStart = performance.now() - this.trailerTime * 1000;
    } else {
      const shot = this.activeShot;
      if (!shot || (shot.type === 'splat' && !shot.keyframes.length)) return;
      if (this.playTau >= 1) this.playTau = 0;
    }
    this.playing = true;
    this.syncHelpers();
    this.changed();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.music?.stop();
    this.liveClip?.pause();
    this.syncHelpers();
    this.changed();
  }

  togglePlay() {
    if (this.playing) this.stop();
    else this.play();
  }

  /** Moves to a position within the active shot (0..1). */
  scrub(tau: number) {
    this.still = false;
    this.playTau = Math.min(1, Math.max(0, tau));
    const shot = this.activeSplatShot;
    const sampler = shot ? this.splatSampler(shot) : null;
    if (sampler && this.mode === 'shot') this.viewer.setPose(sampler.sample(this.playTau, this.pose));
    this.notifyTime();
  }

  /** Shows a scan in the viewport without changing what is selected. */
  private showScene(id: string | null) {
    if (this.shownSceneId === id) return;
    this.shownSceneId = id;
    const scene = this.project.scenes.find((s) => s.id === id);
    this.viewer.setMesh((id && this.loaded.get(id)?.mesh) || null);
    if (scene) this.viewer.applyFixup(scene.fixup);
  }

  /** Draws one live frame of a shot at tau (0..1). */
  private drawShot(shot: Shot, tau: number, playing: boolean) {
    const viewer = this.viewer;
    if (shot.type === 'video') {
      const clip = this.clips.get(shot.videoId);
      if (this.liveClip && this.liveClip !== clip) this.liveClip.pause();
      this.liveClip = clip ?? null;
      if (!clip) {
        viewer.renderer.clear();
        return;
      }
      const sampler = this.videoSampler(shot, clip);
      clip.sync(sampler.timeAt(tau), playing, sampler.rateAt(tau));
      viewer.drawVideo(clip.texture, clip.info.width, clip.info.height, shot.framing);
      return;
    }
    if (this.liveClip) {
      this.liveClip.pause();
      this.liveClip = null;
    }
    this.showScene(shot.sceneId);
    const sampler = this.splatSampler(shot);
    if (sampler) viewer.setPose(sampler.sample(tau, this.pose));
    viewer.draw3D();
  }

  /** The look as the live preview shows it (grade, vignette, grain; motion blur is export-only). */
  private get liveLook(): LookSettings | null {
    return this.project.look.enabled ? this.project.look : null;
  }

  private frame(dt: number) {
    const viewer = this.viewer;
    if (this.still) return;
    const seed = Math.floor(performance.now() / (1000 / FPS));

    if (this.mode === 'trailer') {
      const timeline = this.timeline;
      if (!timeline.entries.length) {
        viewer.renderer.clear();
        return;
      }
      if (this.playing) {
        // follow the real clock, not the frame count, so the picture stays in
        // step with the music even when the preview drops frames
        this.trailerTime = (performance.now() - this.trailerClockStart) / 1000;
        if (this.trailerTime >= this.trailerSeconds) {
          this.trailerTime = Math.max(0, this.trailerSeconds - 1 / FPS);
          this.stop();
        }
      }
      const framePos = Math.min(this.trailerTime * FPS, timeline.totalFrames - 0.001);
      const frame = Math.floor(framePos);
      const index = entryIndexAtFrame(timeline, frame);
      const entry = timeline.entries[index];
      const tau = (framePos - entry.startFrame) / (entry.endFrame - entry.startFrame);
      this.drawShot(entry.shot, Math.min(1, Math.max(0, tau)), this.playing);
      viewer.present(frameFx(timeline, index, frame), this.liveLook, seed);
      // have the next clip waiting on its first frame, so the cut is instant
      const next = timeline.entries[index + 1]?.shot;
      if (this.playing && next?.type === 'video') {
        const clip = this.clips.get(next.videoId);
        if (clip && clip !== this.liveClip) clip.sync(this.videoSampler(next, clip).timeAt(0), false, 1);
      }
      if (this.playing) this.notifyTime();
      return;
    }

    const shot = this.activeShot;
    if (this.playing && shot) {
      this.playTau += dt / shot.duration;
      if (this.playTau >= 1) this.playTau %= 1; // loop
      this.notifyTime();
    }
    if (shot?.type === 'video') {
      this.drawShot(shot, this.playTau, this.playing);
      viewer.present(null, this.liveLook, seed);
      return;
    }
    this.showScene(this.activeSceneId);
    if (this.liveClip) {
      this.liveClip.pause();
      this.liveClip = null;
    }
    if (this.playing && shot) {
      const sampler = this.splatSampler(shot);
      if (sampler) viewer.setPose(sampler.sample(this.playTau, this.pose));
    } else {
      this.controls.update(dt, this.modifiers.shift, this.modifiers.alt);
    }
    viewer.draw3D();
    viewer.present(null, this.liveLook, seed);
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
    } else if (e.code === 'KeyT') {
      this.setMode(this.mode === 'shot' ? 'trailer' : 'shot');
    } else if (e.code === 'Escape') {
      if (this.pickMode) {
        this.setPickMode(null);
        this.changed();
      } else this.stop();
    }
  }

  // ---- export --------------------------------------------------------------

  /** Why a shot cannot be exported right now, or null if it can. */
  shotProblem(shot: Shot): string | null {
    if (shot.type === 'splat') {
      const scene = this.project.scenes.find((s) => s.id === shot.sceneId);
      if (!this.loaded.has(shot.sceneId)) return `"${shot.name}": drop in ${scene?.fileName ?? 'its scan'} first.`;
      if (!shot.keyframes.length) return `"${shot.name}" has no keyframes yet.`;
      return null;
    }
    const video = this.project.videos.find((v) => v.id === shot.videoId);
    const clip = this.clips.get(shot.videoId);
    if (!clip) return `"${shot.name}": drop in ${video?.fileName ?? 'its clip'} first.`;
    if (!clip.info.canDecode) return `"${shot.name}": this browser cannot decode ${video?.fileName}. ${clipWarnings(clip.info, clip.previewOk)[0]}`;
    return null;
  }

  private exportMedia(): ExportMedia {
    return {
      scene: (shot) => {
        const scene = this.project.scenes.find((s) => s.id === shot.sceneId);
        const loaded = this.loaded.get(shot.sceneId);
        return scene && loaded ? { mesh: loaded.mesh, fixup: scene.fixup } : null;
      },
      clip: (shot) => this.clips.get(shot.videoId) ?? null,
    };
  }

  private async runExport(timeline: Timeline, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
    this.stop();
    this.setPickMode(null);
    this.liveClip?.pause();
    this.controls.enabled = false;
    const camera = this.viewer.getPose(newPose());
    try {
      return await exportTimeline(this.viewer, this.exportMedia(), timeline, { onProgress, signal, look: this.project.look });
    } finally {
      // put the viewport back the way it was
      this.shownSceneId = undefined;
      this.showScene(this.activeSceneId);
      this.viewer.setPose(camera);
      this.syncHelpers();
    }
  }

  // ---- look ----------------------------------------------------------------

  applyLookPreset(id: string) {
    const preset = LOOK_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    Object.assign(this.project.look, preset.grade, { enabled: true });
    this.changed();
  }

  /**
   * Renders the frame under the playhead exactly as the export would,
   * including motion blur, and leaves it on screen until the next action.
   * Preview size, not 1080 x 1920, so it is quick.
   */
  async renderTestFrame() {
    if (this.rendering || this.viewer.exporting) return;
    let timeline: Timeline;
    let index: number;
    let frame: number;
    if (this.mode === 'trailer') {
      timeline = this.timeline;
      if (!timeline.entries.length) return;
      const at = Math.min(Math.floor(this.trailerTime * FPS), timeline.totalFrames - 1);
      index = entryIndexAtFrame(timeline, at);
      frame = at - timeline.entries[index].startFrame;
    } else {
      const shot = this.activeShot;
      if (!shot) {
        toast('Select a shot first: the test frame is rendered from its camera move.', 'error');
        return;
      }
      timeline = singleShotTimeline(shot);
      index = 0;
      frame = Math.min(Math.floor(this.playTau * timeline.totalFrames), timeline.totalFrames - 1);
    }
    const problem = this.shotProblem(timeline.entries[index].shot);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    this.stop();
    this.setPickMode(null);
    this.rendering = true;
    this.changed();
    const camera = this.viewer.getPose(newPose());
    this.viewer.beginExport();
    try {
      await renderEntryFrames(this.viewer, this.exportMedia(), timeline, index, [frame], this.project.look, () => {});
      this.still = true;
    } catch (error) {
      console.error(error);
      toast(`Could not render the test frame: ${(error as Error).message}`, 'error');
    } finally {
      this.viewer.endExport();
      this.shownSceneId = undefined;
      this.showScene(this.activeSceneId);
      this.viewer.setPose(camera);
      this.rendering = false;
      const keep = this.still;
      this.changed(); // rebuilds the panels (and clears `still` through touch)
      this.still = keep;
      this.syncHelpers();
      this.notifyTime(); // the viewport label now says it is a test frame
    }
  }

  async exportActiveShot(onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
    const shot = this.activeShot;
    if (!shot) throw new Error('Select a shot first.');
    const problem = this.shotProblem(shot);
    if (problem) throw new Error(problem);
    return this.runExport(singleShotTimeline(shot), onProgress, signal);
  }

  async exportTrailer(onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<ExportResult> {
    const timeline = buildTimeline(this.project);
    if (!timeline.entries.length) throw new Error('The trailer has no shots yet.');
    const problems = timeline.entries.map((e) => this.shotProblem(e.shot)).filter((p): p is string => !!p);
    if (problems.length) throw new Error(problems.slice(0, 3).join(' '));
    return this.runExport(timeline, onProgress, signal);
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
    const missing = this.missingFiles;
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
    this.shownSceneId = undefined;
    this.viewer.setMesh(null);
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

    // the same for clips and music
    const keepClips = new Map<string, VideoClip>();
    for (const video of project.videos) {
      const old = this.project.videos.find((v) => v.fileName.toLowerCase() === video.fileName.toLowerCase());
      const clip = old ? this.clips.get(old.id) : undefined;
      if (old && clip) {
        keepClips.set(video.id, clip);
        this.clips.delete(old.id);
      }
    }
    for (const unused of this.clips.values()) unused.dispose();
    this.clips.clear();
    for (const [id, clip] of keepClips) this.clips.set(id, clip);
    this.liveClip = null;
    if (this.music && project.timeline.audio?.fileName.toLowerCase() !== this.music.fileName.toLowerCase()) {
      this.music.stop();
      this.music = null;
    }

    this.project = project;
    this.mode = 'shot';
    this.trailerTime = 0;
    this.activeShotId = null;
    this.selectScene(project.scenes[0]?.id ?? null, true);
  }
}
