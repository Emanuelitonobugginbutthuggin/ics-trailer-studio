import * as THREE from 'three';
import type { CropBox, Fixup, Vec3 } from '../project/schema';

const UP = new THREE.Vector3(0, 1, 0);

/** world = translate(0, -floorY, 0) * rotation * raw */
export function fixupMatrix(fixup: Fixup, out = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion(...fixup.rotation);
  return out.compose(new THREE.Vector3(0, -fixup.floorY, 0), q, new THREE.Vector3(1, 1, 1));
}

/**
 * Three points clicked on the floor (in current world space) define the
 * floor plane. Returns the fix-up that makes that plane y = 0 with +Y up.
 * `above` is any point known to be above the floor (the camera).
 */
export function fixupFromFloorPoints(
  current: Fixup,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  above: THREE.Vector3,
): Fixup | null {
  const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
  if (normal.length() < 1e-8) return null; // points are on one line
  normal.normalize();
  if (normal.dot(new THREE.Vector3().subVectors(above, a)) < 0) normal.negate();

  const delta = new THREE.Quaternion().setFromUnitVectors(normal, UP);
  const oldRot = new THREE.Quaternion(...current.rotation);
  const newRot = delta.clone().multiply(oldRot).normalize();

  // height of the clicked points in the new rotated (not yet shifted) frame
  const toRaw = fixupMatrix(current).invert();
  let y = 0;
  for (const p of [a, b, c]) y += p.clone().applyMatrix4(toRaw).applyQuaternion(newRot).y;

  return { ...current, rotation: [newRot.x, newRot.y, newRot.z, newRot.w], floorY: y / 3 };
}

/** Rotates the scan by `degrees` around a world axis, about the world origin. */
export function rotateFixup(current: Fixup, axis: 'x' | 'y' | 'z', degrees: number): Fixup {
  const v = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const delta = new THREE.Quaternion().setFromAxisAngle(v, THREE.MathUtils.degToRad(degrees));
  const q = delta.multiply(new THREE.Quaternion(...current.rotation)).normalize();
  return { ...current, rotation: [q.x, q.y, q.z, q.w] };
}

function percentile(sorted: Float32Array, f: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(f * (sorted.length - 1))))];
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/**
 * Bounds of the scan in levelled space, ignoring the outermost `trim`
 * fraction of splats on each side so stray floaters do not count.
 * `samples` are raw splat centres (xyz triples); `yaw` rotates the frame
 * the bounds are measured in, matching CropBox.
 */
export function robustBounds(samples: Float32Array, fixup: Fixup, yaw = 0, trim = 0.01): Bounds {
  const n = Math.floor(samples.length / 3);
  if (n === 0) return { min: [-1, -1, -1], max: [1, 1, 1] };
  const m = new THREE.Matrix4()
    .makeRotationY(THREE.MathUtils.degToRad(-yaw))
    .multiply(fixupMatrix(fixup));
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const zs = new Float32Array(n);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]).applyMatrix4(m);
    xs[i] = v.x;
    ys[i] = v.y;
    zs[i] = v.z;
  }
  xs.sort();
  ys.sort();
  zs.sort();
  return {
    min: [percentile(xs, trim), percentile(ys, trim), percentile(zs, trim)],
    max: [percentile(xs, 1 - trim), percentile(ys, 1 - trim), percentile(zs, 1 - trim)],
  };
}

/** Centre, half-size and rotation of a crop box in world space. */
export function cropBoxTransform(crop: CropBox) {
  const rot = new THREE.Quaternion().setFromAxisAngle(UP, THREE.MathUtils.degToRad(crop.yaw));
  const center = new THREE.Vector3(
    (crop.min[0] + crop.max[0]) / 2,
    (crop.min[1] + crop.max[1]) / 2,
    (crop.min[2] + crop.max[2]) / 2,
  ).applyQuaternion(rot);
  const half = new THREE.Vector3(
    Math.max(0.005, (crop.max[0] - crop.min[0]) / 2),
    Math.max(0.005, (crop.max[1] - crop.min[1]) / 2),
    Math.max(0.005, (crop.max[2] - crop.min[2]) / 2),
  );
  return { center, half, rot };
}
