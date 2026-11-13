import { describe, expect, it } from 'vitest';
import { LOOK_PRESETS, blurSamples, completeLook, defaultLook, gradeActive, shutterOffsets } from '../../src/look/look';
import { parseProject, serializeProject } from '../../src/project/saveLoad';
import { newProject } from '../../src/project/schema';

describe('look settings', () => {
  it('defaults to the cinematic grade with motion blur', () => {
    const look = defaultLook();
    expect(look.enabled).toBe(true);
    expect(look.contrast).toBeGreaterThan(1);
    expect(look.vignette).toBeGreaterThan(0);
    expect(look.grain).toBeGreaterThan(0);
    expect(blurSamples(look)).toBe(8);
    expect(gradeActive(look)).toBe(true);
  });

  it('the "None" preset and the master switch leave the picture untouched', () => {
    const none = { ...defaultLook(), ...LOOK_PRESETS.find((p) => p.id === 'neutral')!.grade };
    expect(gradeActive(none)).toBe(false);
    const off = { ...defaultLook(), enabled: false };
    expect(gradeActive(off)).toBe(false);
    expect(blurSamples(off)).toBe(1);
    expect(gradeActive(null)).toBe(false);
  });

  it('spreads sub-frames evenly inside the open shutter, centred on the frame', () => {
    const o = shutterOffsets(4, 0.5);
    expect(o).toEqual([-0.1875, -0.0625, 0.0625, 0.1875]);
    expect(o.reduce((a, b) => a + b, 0)).toBeCloseTo(0);
    expect(shutterOffsets(1, 0.5)).toEqual([0]);
    expect(Math.max(...shutterOffsets(16, 1).map(Math.abs))).toBeLessThan(0.5);
  });

  it('is saved with the project, and older projects get the default look', () => {
    const p = newProject();
    p.look.contrast = 1.5;
    p.look.motionBlur.samples = 16;
    const back = parseProject(serializeProject(p));
    expect(back.look.contrast).toBe(1.5);
    expect(back.look.motionBlur.samples).toBe(16);

    const old = JSON.parse(serializeProject(p));
    delete old.look;
    expect(parseProject(JSON.stringify(old)).look).toEqual(defaultLook());
    expect(completeLook({ grain: 0.5 }).motionBlur.shutter).toBe(0.5);
  });
});
