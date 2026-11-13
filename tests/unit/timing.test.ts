import { describe, expect, it } from 'vitest';
import { ShotTiming, buildRampTable, ease, rampSpeed, sampleTable } from '../../src/shots/timing';

const ramp = { enabled: true, strength: 4, center: 0.5, width: 0.6 };

describe('easing', () => {
  it('hits both ends and stays monotonic', () => {
    for (const kind of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(ease(kind, 0)).toBeCloseTo(0);
      expect(ease(kind, 1)).toBeCloseTo(1);
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const v = ease(kind, i / 100);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe('speed ramp', () => {
  it('is slow at the ends and fast in the middle', () => {
    expect(rampSpeed(ramp, 0)).toBeCloseTo(1);
    expect(rampSpeed(ramp, 1)).toBeCloseTo(1);
    expect(rampSpeed(ramp, 0.5)).toBeCloseTo(4);
  });

  it('covers the whole path exactly once', () => {
    const table = buildRampTable(ramp);
    expect(sampleTable(table, 0)).toBe(0);
    expect(sampleTable(table, 1)).toBeCloseTo(1, 10);
    let prev = 0;
    for (let i = 1; i <= 200; i++) {
      const v = sampleTable(table, i / 200);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('moves faster in the middle than at the start', () => {
    const t = new ShotTiming('linear', ramp);
    const startStep = t.progress(0.05) - t.progress(0);
    const midStep = t.progress(0.525) - t.progress(0.475);
    expect(midStep / startStep).toBeGreaterThan(3);
  });

  it('is the identity when disabled', () => {
    const t = new ShotTiming('linear', { ...ramp, enabled: false });
    expect(t.progress(0.37)).toBeCloseTo(0.37);
  });
});
