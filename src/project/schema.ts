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

export interface SplatShot {
  id: string;
  type: 'splat';
  name: string;
  sceneId: string;
  duration: number;
  easing: Easing;
  ramp: SpeedRamp;
  dolly: DollyZoom;
  keyframes: Keyframe[];
}

// Video and photo shots join this union in later stages.
export type Shot = SplatShot;

export interface Project {
  app: 'ics-trailer-studio';
  version: 1;
  name: string;
  scenes: SceneDef[];
  shots: Shot[];
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

export function newProject(): Project {
  return { app: 'ics-trailer-studio', version: 1, name: 'ICS Milan trailer', scenes: [], shots: [] };
}

export function newSplatShot(sceneId: string, name: string): SplatShot {
  return {
    id: newId('shot'),
    type: 'splat',
    name,
    sceneId,
    duration: 1.5,
    easing: 'linear',
    ramp: { enabled: false, strength: 4, center: 0.5, width: 0.6 },
    dolly: { enabled: false, target: null },
    keyframes: [],
  };
}
