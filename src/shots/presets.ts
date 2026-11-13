import * as THREE from 'three';
import type { Easing, Keyframe, SpeedRamp } from '../project/schema';
import type { Pose } from './path';

export type PresetId = 'pushIn' | 'pullBack' | 'craneUp' | 'orbit' | 'lowFly';

export const PRESETS: { id: PresetId; label: string; hint: string }[] = [
  { id: 'pushIn', label: 'Push-in', hint: 'Starts at your current view and drives toward what you are looking at.' },
  { id: 'pullBack', label: 'Pull-back reveal', hint: 'Starts at your current view and pulls back and up to reveal the space.' },
  { id: 'craneUp', label: 'Crane up', hint: 'Rises from your current view while staying aimed at the subject.' },
  { id: 'orbit', label: 'Orbit', hint: 'Arcs around what you are looking at; your current view is the middle.' },
  { id: 'lowFly', label: 'Low fly-through', hint: 'Skims 30 cm above the floor in the direction you are facing.' },
];

export interface PresetResult {
  keyframes: Keyframe[];
  duration: number;
  easing: Easing;
  ramp: SpeedRamp;
}

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();

function lookAtQuat(eye: THREE.Vector3, target: THREE.Vector3): THREE.Quaternion {
  _m.lookAt(eye, target, UP);
  return new THREE.Quaternion().setFromRotationMatrix(_m);
}

function kf(position: THREE.Vector3, quaternion: THREE.Quaternion, fov: number): Keyframe {
  return {
    position: [position.x, position.y, position.z],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    fov,
  };
}

/**
 * Builds keyframes for a one-click move, relative to the current camera
 * pose and the point it is looking at (`pivot`). The floor is y = 0.
 */
export function buildPreset(id: PresetId, pose: Pose, pivot: THREE.Vector3): PresetResult {
  const pos = pose.position.clone();
  const quat = pose.quaternion.clone();
  const fov = pose.fov;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  const dist = THREE.MathUtils.clamp(pivot.distanceTo(pos), 0.3, 30);
  const hype: SpeedRamp = { enabled: true, strength: 4, center: 0.5, width: 0.6 };
  const noRamp: SpeedRamp = { ...hype, enabled: false };

  switch (id) {
    case 'pushIn': {
      const end = pos.clone().addScaledVector(forward, dist * 0.6);
      return { keyframes: [kf(pos, quat, fov), kf(end, quat, fov)], duration: 1.5, easing: 'linear', ramp: hype };
    }
    case 'pullBack': {
      const end = pos.clone().addScaledVector(forward, -dist).addScaledVector(UP, dist * 0.2);
      const mid = pos.clone().lerp(end, 0.5);
      return {
        keyframes: [kf(pos, quat, fov), kf(mid, lookAtQuat(mid, pivot), fov), kf(end, lookAtQuat(end, pivot), fov)],
        duration: 2,
        easing: 'easeOut',
        ramp: noRamp,
      };
    }
    case 'craneUp': {
      const rise = dist * 0.6;
      const mid = pos.clone().addScaledVector(UP, rise * 0.5);
      const end = pos.clone().addScaledVector(UP, rise);
      return {
        keyframes: [kf(pos, quat, fov), kf(mid, lookAtQuat(mid, pivot), fov), kf(end, lookAtQuat(end, pivot), fov)],
        duration: 2,
        easing: 'easeInOut',
        ramp: noRamp,
      };
    }
    case 'orbit': {
      const offset = pos.clone().sub(pivot);
      const keyframes: Keyframe[] = [];
      for (const deg of [-30, -15, 0, 15, 30]) {
        const p = offset.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(deg)).add(pivot);
        // the middle keyframe keeps the exact framing you chose
        keyframes.push(kf(p, deg === 0 ? quat : lookAtQuat(p, pivot), fov));
      }
      return { keyframes, duration: 2, easing: 'linear', ramp: hype };
    }
    case 'lowFly': {
      const flat = new THREE.Vector3(forward.x, 0, forward.z);
      if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
      flat.normalize();
      const start = new THREE.Vector3(pos.x, 0.3, pos.z);
      const end = start.clone().addScaledVector(flat, dist * 1.5);
      const mid = start.clone().lerp(end, 0.5);
      // look slightly upward along the direction of travel
      const aim = flat.clone().addScaledVector(UP, 0.08);
      const q = lookAtQuat(start, start.clone().add(aim));
      const wide = Math.max(fov, 70);
      return {
        keyframes: [kf(start, q, wide), kf(mid, q, wide), kf(end, q, wide)],
        duration: 1.5,
        easing: 'linear',
        ramp: hype,
      };
    }
  }
}
