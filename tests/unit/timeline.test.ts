import { describe, expect, it } from 'vitest';
import { defaultTimeline, newProject, newSplatShot } from '../../src/project/schema';
import { beatOffsetFromAudio, buildTimeline, entryIndexAtFrame, frameFx, gridStep, snapDurations, snapTime } from '../../src/timeline/timeline';

function projectWith(durations: number[]) {
  const p = newProject();
  durations.forEach((d, i) => {
    const s = newSplatShot('scene', `s${i}`);
    s.duration = d;
    p.shots.push(s);
  });
  return p;
}

describe('timeline layout', () => {
  it('places cuts on whole frames without drift', () => {
    // 128 bpm: one beat is 14.0625 frames
    const beat = 60 / 128;
    const tl = buildTimeline(projectWith(Array(32).fill(beat)));
    expect(tl.totalFrames).toBe(Math.round(32 * beat * 30));
    tl.entries.forEach((e, i) => {
      expect(Math.abs(e.endFrame - (i + 1) * beat * 30)).toBeLessThanOrEqual(0.5);
    });
  });

  it('skips shots that are not in the trailer', () => {
    const p = projectWith([1, 1, 1]);
    p.shots[1].inTrailer = false;
    const tl = buildTimeline(p);
    expect(tl.entries.length).toBe(2);
    expect(tl.totalFrames).toBe(60);
    expect(entryIndexAtFrame(tl, 29)).toBe(0);
    expect(entryIndexAtFrame(tl, 30)).toBe(1);
  });
});

describe('beat snapping', () => {
  const t = { ...defaultTimeline(), bpm: 120, beatOffset: 0, division: 1 };

  it('knows the grid', () => {
    expect(gridStep(t)).toBeCloseTo(0.5);
    expect(gridStep({ ...t, division: 0.5 })).toBeCloseTo(0.25);
    expect(snapTime(t, 1.19)).toBeCloseTo(1.0);
    expect(snapTime({ ...t, beatOffset: 0.1 }, 1.19)).toBeCloseTo(1.1);
  });

  it('moves every cut onto a beat and keeps the order', () => {
    const snapped = snapDurations([0.9, 1.3, 0.1, 2.05], t);
    let end = 0;
    for (const d of snapped) {
      expect(d).toBeGreaterThanOrEqual(0.5 - 1e-6);
      end += d;
      expect(Math.abs(end / 0.5 - Math.round(end / 0.5))).toBeLessThan(1e-6);
    }
    expect(snapped[0]).toBeCloseTo(1.0);
  });

  it('is stable: snapping twice changes nothing', () => {
    const once = snapDurations([0.7, 1.6, 1.1], t);
    expect(snapDurations(once, t)).toEqual(once);
  });

  it('derives the trailer beat offset from the song', () => {
    // first beat at 0.30 s in the song, trailer starts 1.0 s into the song, 120 bpm
    expect(beatOffsetFromAudio(120, 0.3, 1.0)).toBeCloseTo(0.3);
    expect(beatOffsetFromAudio(120, 0.3, 0.3)).toBeCloseTo(0);
  });
});

describe('transition effects', () => {
  it('a plain cut has no effect', () => {
    const tl = buildTimeline(projectWith([1, 1]));
    for (let f = 0; f < 60; f++) expect(frameFx(tl, entryIndexAtFrame(tl, f), f)).toEqual({ flash: 0, whip: 0 });
  });

  it('a flash peaks on the first frame after the cut and fades', () => {
    const p = projectWith([1, 1]);
    p.shots[1].transition = 'flash';
    const tl = buildTimeline(p);
    const at = (f: number) => frameFx(tl, entryIndexAtFrame(tl, f), f).flash;
    expect(at(20)).toBe(0);
    expect(at(29)).toBeGreaterThan(0.3);
    expect(at(30)).toBe(1);
    expect(at(31)).toBeLessThan(at(30));
    expect(at(36)).toBe(0);
  });

  it('a whip blurs out one way and comes in from the other', () => {
    const p = projectWith([1, 1]);
    p.shots[1].transition = 'whipLeft';
    const tl = buildTimeline(p);
    const at = (f: number) => frameFx(tl, entryIndexAtFrame(tl, f), f).whip;
    expect(at(24)).toBe(0);
    expect(at(29)).toBeLessThan(-0.8);
    expect(at(30)).toBeGreaterThan(0.8);
    expect(Math.abs(at(33))).toBeLessThan(Math.abs(at(30)));
    expect(at(35)).toBe(0);
  });

  it('the first shot of the trailer never has an incoming transition', () => {
    const p = projectWith([1, 1]);
    p.shots[0].transition = 'flash';
    const tl = buildTimeline(p);
    expect(frameFx(tl, 0, 0).flash).toBe(0);
  });
});

import { newVideoShot } from '../../src/project/schema';
import { VideoShotSampler, framingTransform } from '../../src/shots/videoTime';

describe('video shots', () => {
  const video = { id: 'v', name: 'clip', fileName: 'clip.mp4', fileSize: 1, duration: 10, width: 2160, height: 3840 };

  it('plays the trimmed part over the shot duration', () => {
    const shot = newVideoShot(video, 'clip');
    Object.assign(shot, { trimIn: 2, trimOut: 6, duration: 1 });
    const s = new VideoShotSampler(shot, 10);
    expect(s.timeAt(0)).toBeCloseTo(2);
    expect(s.timeAt(0.5)).toBeCloseTo(4);
    expect(s.timeAt(1)).toBeCloseTo(6);
    expect(s.averageRate).toBeCloseTo(4);
    expect(s.rateAt(0.5)).toBeCloseTo(4, 1);
  });

  it('speed ramps a clip: slow at the ends, fast in the middle, same in and out points', () => {
    const shot = newVideoShot(video, 'clip');
    Object.assign(shot, { trimIn: 0, trimOut: 4, duration: 2, ramp: { enabled: true, strength: 6, center: 0.5, width: 0.6 } });
    const s = new VideoShotSampler(shot, 10);
    expect(s.timeAt(0)).toBeCloseTo(0);
    expect(s.timeAt(1)).toBeCloseTo(4);
    expect(s.rateAt(0.5) / s.rateAt(0.02)).toBeGreaterThan(4);
  });

  it('never reads past the end of the clip', () => {
    const shot = newVideoShot(video, 'clip');
    Object.assign(shot, { trimIn: 8, trimOut: 14 });
    expect(new VideoShotSampler(shot, 10).timeAt(1)).toBeCloseTo(10);
  });

  it('cover fills a 9:16 frame from a 16:9 clip by cropping the sides', () => {
    const { scale, offset } = framingTransform({ fit: 'cover', zoom: 1, panX: 0, panY: 0 }, 16 / 9, 9 / 16);
    expect(scale[1]).toBe(1);
    expect(scale[0]).toBeCloseTo((9 / 16) / (16 / 9));
    expect(offset).toEqual([0, 0]);
    const panned = framingTransform({ fit: 'cover', zoom: 1, panX: 1, panY: 0 }, 16 / 9, 9 / 16);
    // fully panned: the visible window touches the clip's right edge
    expect(0.5 + panned.scale[0] / 2 + panned.offset[0]).toBeCloseTo(1);
  });

  it('contain shows the whole clip', () => {
    const { scale } = framingTransform({ fit: 'contain', zoom: 1, panX: 0, panY: 0 }, 16 / 9, 9 / 16);
    expect(scale[0]).toBe(1);
    expect(scale[1]).toBeGreaterThan(1);
  });
});
