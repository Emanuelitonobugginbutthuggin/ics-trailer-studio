import * as THREE from 'three';
import type { DollyZoom, Keyframe, SplatShot } from '../project/schema';
import { ShotTiming } from './timing';

export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

export function newPose(): Pose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 60 };
}

const SAMPLES_PER_SEGMENT = 48;
export const MIN_FOV = 8;
export const MAX_FOV = 130;

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Smooth camera path through keyframes.
 * Position: centripetal Catmull-Rom spline (no loops or overshoot at
 * unevenly spaced keyframes). Rotation and field of view: Catmull-Rom on
 * the components, so angular velocity stays continuous through keyframes.
 * `evaluate(p)` is parameterised by distance travelled, so the easing and
 * speed ramp of a shot control real speed, not keyframe spacing.
 */
export class CameraPath {
  readonly count: number;
  private curve: THREE.CatmullRomCurve3 | null = null;
  private quats: THREE.Quaternion[] = [];
  private fovs: number[] = [];
  private lengths: Float64Array = new Float64Array(1);
  private total = 0;

  constructor(private keyframes: Keyframe[]) {
    this.count = keyframes.length;
    if (this.count === 0) return;

    let prev: THREE.Quaternion | null = null;
    for (const k of keyframes) {
      const q = new THREE.Quaternion(...k.quaternion).normalize();
      // keep neighbouring quaternions in the same hemisphere so component
      // interpolation takes the short way round
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      this.quats.push(q);
      this.fovs.push(k.fov);
      prev = q;
    }
    if (this.count < 2) return;

    const points = keyframes.map((k) => new THREE.Vector3(...k.position));
    this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    this.buildLengthTable(points);
  }

  private buildLengthTable(points: THREE.Vector3[]) {
    const segments = this.count - 1;
    const n = segments * SAMPLES_PER_SEGMENT;
    const pos: THREE.Vector3[] = [];
    const rot: THREE.Quaternion[] = [];
    const fov: number[] = [];
    const pose = newPose();
    for (let i = 0; i <= n; i++) {
      this.evaluateAtU((i / n) * segments, pose);
      pos.push(pose.position.clone());
      rot.push(pose.quaternion.clone());
      fov.push(pose.fov);
    }
    let travel = 0;
    for (let i = 1; i < points.length; i++) travel += points[i].distanceTo(points[i - 1]);
    // A rotation or zoom with no travel must still take time. One full turn
    // counts as much as the whole travelled distance (or 1 unit if the
    // camera never moves).
    const turnWeight = (travel > 1e-4 ? travel : 1) / (2 * Math.PI);

    this.lengths = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) {
      const d =
        pos[i].distanceTo(pos[i - 1]) +
        turnWeight * rot[i].angleTo(rot[i - 1]) +
        turnWeight * THREE.MathUtils.degToRad(Math.abs(fov[i] - fov[i - 1]));
      this.lengths[i] = this.lengths[i - 1] + d;
    }
    this.total = this.lengths[n];
  }

  /** u is in keyframe units: 0 = first keyframe, count - 1 = last. */
  private evaluateAtU(u: number, out: Pose) {
    const last = this.count - 1;
    const uc = Math.min(last, Math.max(0, u));
    this.curve!.getPoint(uc / last, out.position);

    const i = Math.min(last - 1, Math.floor(uc));
    const t = uc - i;
    const q = this.quats;
    const q1 = q[i];
    const q2 = q[i + 1];
    const q0 = q[i - 1] ?? q1;
    const q3 = q[i + 2] ?? q2;
    out.quaternion
      .set(
        catmullRom(q0.x, q1.x, q2.x, q3.x, t),
        catmullRom(q0.y, q1.y, q2.y, q3.y, t),
        catmullRom(q0.z, q1.z, q2.z, q3.z, t),
        catmullRom(q0.w, q1.w, q2.w, q3.w, t),
      )
      .normalize();

    const f = this.fovs;
    const fov = catmullRom(f[i - 1] ?? f[i], f[i], f[i + 1], f[i + 2] ?? f[i + 1], t);
    // never overshoot outside the two neighbouring keyframes
    out.fov = Math.min(Math.max(f[i], f[i + 1]), Math.max(Math.min(f[i], f[i + 1]), fov));
  }

  /** p in 0..1: fraction of the path travelled. */
  evaluate(p: number, out: Pose): Pose {
    if (this.count === 0) return out;
    if (this.count === 1 || !this.curve) {
      const k = this.keyframes[0];
      out.position.set(...k.position);
      out.quaternion.copy(this.quats[0]);
      out.fov = k.fov;
      return out;
    }
    const segments = this.count - 1;
    const n = this.lengths.length - 1;
    const pc = Math.min(1, Math.max(0, p));
    let u: number;
    if (this.total < 1e-9) {
      u = pc * segments;
    } else {
      const target = pc * this.total;
      let lo = 0;
      let hi = n;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.lengths[mid] <= target) lo = mid;
        else hi = mid;
      }
      const span = this.lengths[hi] - this.lengths[lo];
      const frac = span > 0 ? (target - this.lengths[lo]) / span : 0;
      u = ((lo + frac) / n) * segments;
    }
    this.evaluateAtU(u, out);
    return out;
  }

  /** Points along the path for drawing it in the viewport. */
  polyline(steps = 96): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    if (this.count < 2) return pts;
    const pose = newPose();
    for (let i = 0; i <= steps; i++) pts.push(this.evaluate(i / steps, pose).position.clone());
    return pts;
  }
}

const _forward = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

function depthAlongView(pose: Pose, target: THREE.Vector3): number {
  _forward.set(0, 0, -1).applyQuaternion(pose.quaternion);
  return _toTarget.copy(target).sub(pose.position).dot(_forward);
}

/** Evaluates a whole shot: path + easing + speed ramp + dolly zoom. */
export class ShotSampler {
  readonly path: CameraPath;
  private timing: ShotTiming;
  private dolly: DollyZoom;
  private dollyTarget = new THREE.Vector3();
  private dollyWidth = 0;

  constructor(shot: SplatShot) {
    this.path = new CameraPath(shot.keyframes);
    this.timing = new ShotTiming(shot.easing, shot.ramp);
    this.dolly = shot.dolly;
    if (this.dollyActive()) {
      this.dollyTarget.set(...shot.dolly.target!);
      const start = this.path.evaluate(0, newPose());
      const d0 = Math.max(0.05, depthAlongView(start, this.dollyTarget));
      this.dollyWidth = d0 * Math.tan(THREE.MathUtils.degToRad(start.fov) / 2);
    }
  }

  private dollyActive(): boolean {
    return this.dolly.enabled && !!this.dolly.target && this.path.count >= 2;
  }

  /** tau in 0..1: fraction of the shot's duration. */
  sample(tau: number, out: Pose): Pose {
    this.path.evaluate(this.timing.progress(tau), out);
    if (this.dollyActive()) {
      const d = Math.max(0.05, depthAlongView(out, this.dollyTarget));
      const fov = THREE.MathUtils.radToDeg(2 * Math.atan(this.dollyWidth / d));
      out.fov = Math.min(MAX_FOV, Math.max(MIN_FOV, fov));
    }
    return out;
  }
}
