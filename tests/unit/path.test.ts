import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { newSplatShot, type Keyframe } from '../../src/project/schema';
import { CameraPath, ShotSampler, newPose } from '../../src/shots/path';
import { PRESETS, buildPreset } from '../../src/shots/presets';

const ident: [number, number, number, number] = [0, 0, 0, 1];
const yaw = (deg: number): [number, number, number, number] => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
  return [q.x, q.y, q.z, q.w];
};

describe('CameraPath', () => {
  it('passes through the first and last keyframes', () => {
    const kfs: Keyframe[] = [
      { position: [0, 1, 0], quaternion: ident, fov: 60 },
      { position: [1, 1, -2], quaternion: yaw(20), fov: 50 },
      { position: [4, 2, -3], quaternion: yaw(60), fov: 40 },
    ];
    const path = new CameraPath(kfs);
    const a = path.evaluate(0, newPose());
    const b = path.evaluate(1, newPose());
    expect(a.position.toArray()).toEqual([0, 1, 0]);
    expect(a.fov).toBeCloseTo(60);
    expect(b.position.distanceTo(new THREE.Vector3(4, 2, -3))).toBeLessThan(1e-6);
    expect(b.fov).toBeCloseTo(40);
    expect(b.quaternion.angleTo(new THREE.Quaternion(...yaw(60)))).toBeLessThan(1e-4);
  });

  it('travels at constant speed even with unevenly spaced keyframes', () => {
    const kfs: Keyframe[] = [
      { position: [0, 0, 0], quaternion: ident, fov: 60 },
      { position: [0.2, 0, 0], quaternion: ident, fov: 60 },
      { position: [10, 0, 0], quaternion: ident, fov: 60 },
    ];
    const path = new CameraPath(kfs);
    const steps: number[] = [];
    let prev = path.evaluate(0, newPose()).position.clone();
    for (let i = 1; i <= 50; i++) {
      const p = path.evaluate(i / 50, newPose()).position.clone();
      steps.push(p.distanceTo(prev));
      prev = p;
    }
    const min = Math.min(...steps);
    const max = Math.max(...steps);
    expect(max / min).toBeLessThan(1.05);
  });

  it('gives a pure rotation time to play out', () => {
    const kfs: Keyframe[] = [
      { position: [0, 0, 0], quaternion: yaw(0), fov: 60 },
      { position: [0, 0, 0], quaternion: yaw(90), fov: 60 },
    ];
    const path = new CameraPath(kfs);
    const mid = path.evaluate(0.5, newPose());
    const angle = THREE.MathUtils.radToDeg(mid.quaternion.angleTo(new THREE.Quaternion(...yaw(0))));
    expect(angle).toBeGreaterThan(40);
    expect(angle).toBeLessThan(50);
  });

  it('handles a single keyframe as a locked-off shot', () => {
    const path = new CameraPath([{ position: [1, 2, 3], quaternion: ident, fov: 35 }]);
    const p = path.evaluate(0.7, newPose());
    expect(p.position.toArray()).toEqual([1, 2, 3]);
    expect(p.fov).toBe(35);
  });
});

describe('dolly zoom', () => {
  it('keeps the subject the same size on screen', () => {
    const shot = newSplatShot('s', 'dolly');
    shot.keyframes = [
      { position: [0, 0, 4], quaternion: ident, fov: 40 },
      { position: [0, 0, 2], quaternion: ident, fov: 40 },
    ];
    shot.dolly = { enabled: true, target: [0, 0, 0] };
    const sampler = new ShotSampler(shot);
    const size = (tau: number) => {
      const p = sampler.sample(tau, newPose());
      return p.position.z * Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
    };
    expect(size(0)).toBeCloseTo(size(0.5), 5);
    expect(size(0)).toBeCloseTo(size(1), 5);
    expect(sampler.sample(1, newPose()).fov).toBeGreaterThan(70);
  });
});

describe('presets', () => {
  it('all build at least two finite keyframes', () => {
    const pose = { position: new THREE.Vector3(0, 1.5, 3), quaternion: new THREE.Quaternion(), fov: 60 };
    const pivot = new THREE.Vector3(0, 1, 0);
    for (const { id } of PRESETS) {
      const r = buildPreset(id, pose, pivot);
      expect(r.keyframes.length).toBeGreaterThanOrEqual(2);
      for (const k of r.keyframes) {
        for (const v of [...k.position, ...k.quaternion, k.fov]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('orbit keeps its distance to the subject', () => {
    const pose = { position: new THREE.Vector3(0, 1, 3), quaternion: new THREE.Quaternion(), fov: 60 };
    const pivot = new THREE.Vector3(0, 1, 0);
    for (const k of buildPreset('orbit', pose, pivot).keyframes) {
      expect(new THREE.Vector3(...k.position).distanceTo(pivot)).toBeCloseTo(3, 5);
    }
  });
});
