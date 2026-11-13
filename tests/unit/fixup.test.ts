import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { defaultFixup } from '../../src/project/schema';
import { cropBoxTransform, fixupFromFloorPoints, fixupMatrix, robustBounds, rotateFixup } from '../../src/scene/fixup';

describe('floor from three points', () => {
  it('levels a tilted, lifted floor to y = 0', () => {
    // a raw scan whose floor is tilted 25 degrees and sits 1.3 below origin
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.2, THREE.MathUtils.degToRad(25)));
    const rawFloor = (x: number, z: number) => new THREE.Vector3(x, -1.3, z).applyQuaternion(tilt);
    const current = defaultFixup();
    const above = new THREE.Vector3(0, 0.4, 0).applyQuaternion(tilt);
    const fixed = fixupFromFloorPoints(current, rawFloor(0, 0), rawFloor(2, 0.3), rawFloor(-0.5, 1.7), above)!;
    const m = fixupMatrix(fixed);
    for (const [x, z] of [[0, 0], [3, -2], [-4, 5]]) {
      expect(rawFloor(x, z).applyMatrix4(m).y).toBeCloseTo(0, 5);
    }
    // what was above the floor is still above it
    expect(above.clone().applyMatrix4(m).y).toBeGreaterThan(1);
  });

  it('works when applied on top of an earlier fix-up', () => {
    const first = rotateFixup({ ...defaultFixup(), floorY: 0.5 }, 'x', 180);
    const m1 = fixupMatrix(first);
    const world = (x: number, z: number) => new THREE.Vector3(x, 2 + 0.1 * x, z); // sloped plane in current world
    const fixed = fixupFromFloorPoints(first, world(0, 0), world(1, 0), world(0, 1), new THREE.Vector3(0, 9, 0))!;
    const toNew = fixupMatrix(fixed).multiply(m1.clone().invert());
    expect(world(2, -3).applyMatrix4(toNew).y).toBeCloseTo(0, 5);
  });

  it('rejects three points on one line', () => {
    const p = (x: number) => new THREE.Vector3(x, 0, 0);
    expect(fixupFromFloorPoints(defaultFixup(), p(0), p(1), p(2), new THREE.Vector3(0, 1, 0))).toBeNull();
  });
});

describe('bounds and crop', () => {
  it('ignores far-away floaters', () => {
    const n = 2000;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pts[i * 3] = (i % 20) / 10 - 1;
      pts[i * 3 + 1] = (i % 7) / 7;
      pts[i * 3 + 2] = (i % 13) / 13;
    }
    pts.set([500, 500, 500], 0);
    pts.set([-500, -500, -500], 3);
    const b = robustBounds(pts, defaultFixup());
    expect(b.max[0]).toBeLessThan(2);
    expect(b.min[0]).toBeGreaterThan(-2);
  });

  it('places a yawed crop box around its own centre', () => {
    const { center, half } = cropBoxTransform({ enabled: true, min: [1, 0, -1], max: [3, 2, 1], yaw: 90 });
    expect(half.toArray()).toEqual([1, 1, 1]);
    // (2, 1, 0) rotated 90 degrees about Y lands on (0, 1, -2)
    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(1);
    expect(center.z).toBeCloseTo(-2);
  });
});
