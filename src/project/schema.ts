import { defaultLook, type LookSettings } from '../look/look';

// Project file format. Everything here is plain JSON: media (scans, clips,
// photos) is never embedded, only remembered by file name.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

/** Crop box in levelled world space. The box spans min..max in a frame
 *  rotated by `yaw` degrees around the vertical axis. */
export interface CropBox {
  enabled: boolean;
  min: Vec3;
  max: Vec3;
  yaw: number;
}

/** Fix-up applied to a raw scan: world = translate(0, -floorY, 0) * rotation * raw. */
export interface Fixup {
  rotation: Quat;
  floorY: number;
  crop: CropBox;
}

export interface SceneDef {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  fixup: Fixup;
}

export interface Keyframe {
  position: Vec3;
  quaternion: Quat;
  /** Vertical field of view of the 9:16 frame, in degrees. */
  fov: number;
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

/** Slow > fast > slow speed ramp. `strength` is the peak speed relative to
 *  the slow parts; `center` and `width` are fractions of the shot. */
export interface SpeedRamp {
  enabled: boolean;
  strength: number;
  center: number;
  width: number;
}

/** Dolly zoom: the field of view follows the camera distance to `target`
 *  so the subject keeps its size while the background stretches. */
export interface DollyZoom {
  enabled: boolean;
  target: Vec3 | null;
}

export type Transition = 'cut' | 'flash' | 'whipLeft' | 'whipRight';

/** Fields every kind of shot has. */
interface ShotBase {
  id: string;
  name: string;
  /** length of the shot in the trailer, seconds */
  duration: number;
  easing: Easing;
  ramp: SpeedRamp;
  /** part of the trailer (shots are played in list order) */
  inTrailer: boolean;
  /** how the trailer cuts INTO this shot */
  transition: Transition;
}

export interface SplatShot extends ShotBase {
  type: 'splat';
  sceneId: string;
  dolly: DollyZoom;
  keyframes: Keyframe[];
}

/** How a clip is placed in the 9:16 frame. */
export interface Framing {
  /** cover: fill the frame, cropping the clip. contain: show the whole clip. */
  fit: 'cover' | 'contain';
  zoom: number;
  /** -1..1: which part of the cropped-away area is shown */
  panX: number;
  panY: number;
}

export interface VideoShot extends ShotBase {
  type: 'video';
  videoId: string;
  /** trimmed part of the clip, in clip seconds; played over `duration` with easing and ramp */
  trimIn: number;
  trimOut: number;
  framing: Framing;
}

export type Shot = SplatShot | VideoShot;

/** A video file on the user's disk, remembered by name. */
export interface VideoDef {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  duration: number;
  width: number;
  height: number;
}

export interface TimelineSettings {
  bpm: number;
  /** trailer time of one beat, seconds */
  beatOffset: number;
  /** cuts snap to every `division` beats (0.5 = half beats) */
  division: number;
  snap: boolean;
  /** music used to find the beat; never exported */
  audio: { fileName: string; /** song time at trailer start, seconds */ start: number; /** song time of its first beat */ firstBeat: number } | null;
}

export interface Project {
  app: 'ics-trailer-studio';
  version: 1;
  name: string;
  scenes: SceneDef[];
  videos: VideoDef[];
  shots: Shot[];
  timeline: TimelineSettings;
  look: LookSettings;
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function defaultFixup(): Fixup {
  return {
    rotation: [0, 0, 0, 1],
    floorY: 0,
    crop: { enabled: false, min: [-5, -1, -5], max: [5, 4, 5], yaw: 0 },
  };
}

export function defaultTimeline(): TimelineSettings {
  return { bpm: 120, beatOffset: 0, division: 1, snap: true, audio: null };
}

export function newProject(): Project {
  return { app: 'ics-trailer-studio', version: 1, name: 'ICS Milan trailer', scenes: [], videos: [], shots: [], timeline: defaultTimeline(), look: defaultLook() };
}

const defaultRamp = (): SpeedRamp => ({ enabled: false, strength: 4, center: 0.5, width: 0.6 });

export function newSplatShot(sceneId: string, name: string): SplatShot {
  return {
    id: newId('shot'),
    type: 'splat',
    name,
    sceneId,
    duration: 1.5,
    easing: 'linear',
    ramp: defaultRamp(),
    inTrailer: true,
    transition: 'cut',
    dolly: { enabled: false, target: null },
    keyframes: [],
  };
}

export function newVideoShot(video: VideoDef, name: string): VideoShot {
  const length = Math.min(2, video.duration);
  return {
    id: newId('shot'),
    type: 'video',
    name,
    videoId: video.id,
    duration: Math.max(0.2, Math.round(length * 10) / 10),
    easing: 'linear',
    ramp: defaultRamp(),
    inTrailer: true,
    transition: 'cut',
    trimIn: 0,
    trimOut: length,
    framing: { fit: 'cover', zoom: 1, panX: 0, panY: 0 },
  };
}
