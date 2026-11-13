import { FPS, type Project, type Shot, type TimelineSettings, type Transition } from '../project/schema';

/** One shot placed on the trailer timeline, in whole frames. */
export interface TimelineEntry {
  shot: Shot;
  startFrame: number;
  /** exclusive */
  endFrame: number;
}

export interface Timeline {
  entries: TimelineEntry[];
  totalFrames: number;
}

export const MIN_SHOT_SECONDS = 0.2;

/**
 * Lays the trailer shots end to end. Cut points are rounded to whole frames
 * from the running total, so rounding never accumulates into drift.
 */
export function buildTimeline(project: Project): Timeline {
  const entries: TimelineEntry[] = [];
  let time = 0;
  let frame = 0;
  for (const shot of project.shots) {
    if (!shot.inTrailer) continue;
    time += shot.duration;
    const endFrame = Math.max(frame + 1, Math.round(time * FPS));
    entries.push({ shot, startFrame: frame, endFrame });
    frame = endFrame;
  }
  return { entries, totalFrames: frame };
}

export function entryIndexAtFrame(timeline: Timeline, frame: number): number {
  const { entries } = timeline;
  for (let i = 0; i < entries.length; i++) if (frame < entries[i].endFrame) return i;
  return entries.length - 1;
}

/** Seconds between snap lines. */
export function gridStep(t: TimelineSettings): number {
  return (60 / Math.max(20, t.bpm)) * t.division;
}

/** Nearest snap line to a trailer time. */
export function snapTime(t: TimelineSettings, time: number): number {
  const step = gridStep(t);
  const origin = ((t.beatOffset % step) + step) % step;
  return origin + Math.round((time - origin) / step) * step;
}

/**
 * Moves every cut to the nearest snap line. Each shot keeps at least one
 * grid step (and the minimum length), so shots never collapse or reorder.
 * Returns the new durations.
 */
export function snapDurations(durations: number[], t: TimelineSettings): number[] {
  const step = gridStep(t);
  const out: number[] = [];
  let originalEnd = 0;
  let snappedEnd = 0;
  for (const d of durations) {
    originalEnd += d;
    let end = snapTime(t, originalEnd);
    while (end - snappedEnd < Math.max(MIN_SHOT_SECONDS, step * 0.999)) end += step;
    out.push(Math.round((end - snappedEnd) * 1e6) / 1e6);
    snappedEnd = end;
  }
  return out;
}

/** Song position (seconds) of the first beat > trailer time of a beat. */
export function beatOffsetFromAudio(bpm: number, firstBeat: number, audioStart: number): number {
  const beat = 60 / Math.max(20, bpm);
  return (((firstBeat - audioStart) % beat) + beat) % beat;
}

/** Post effects for one frame, driven by the cuts around it. */
export interface FrameFx {
  /** 0..1 white-out */
  flash: number;
  /** -1..1: horizontal whip blur and slide; the sign is the direction */
  whip: number;
}

const FLASH_IN = 6; // frames the flash takes to fade after the cut
const FLASH_OUT = 2; // frames it builds up before the cut
const WHIP = 5; // frames of whip on each side of the cut

function whipSign(t: Transition): number {
  return t === 'whipLeft' ? -1 : t === 'whipRight' ? 1 : 0;
}

/**
 * Transition effects at `frame`. A transition belongs to the cut INTO a
 * shot: the outgoing shot builds it up over its last frames and the incoming
 * shot releases it over its first frames. The cut itself stays a hard cut,
 * hidden under the brightest or most blurred frames.
 */
export function frameFx(timeline: Timeline, index: number, frame: number): FrameFx {
  const entry = timeline.entries[index];
  const next = timeline.entries[index + 1];
  const fx: FrameFx = { flash: 0, whip: 0 };
  if (!entry) return fx;
  const length = entry.endFrame - entry.startFrame;
  const since = frame - entry.startFrame; // 0 on the first frame of the shot
  const until = entry.endFrame - frame; // 1 on the last frame of the shot

  // incoming side (never on the very first shot of the trailer)
  if (index > 0) {
    const t = entry.shot.transition;
    if (t === 'flash' && since < Math.min(FLASH_IN, length)) fx.flash = Math.max(fx.flash, (1 - since / FLASH_IN) ** 2);
    const sign = whipSign(t);
    if (sign && since < Math.min(WHIP, length)) fx.whip = -sign * (1 - (since + 0.5) / WHIP) ** 1.5;
  }
  // outgoing side
  if (next) {
    const t = next.shot.transition;
    if (t === 'flash' && until <= Math.min(FLASH_OUT, length)) fx.flash = Math.max(fx.flash, 0.3 * (FLASH_OUT + 1 - until));
    const sign = whipSign(t);
    if (sign && until <= Math.min(WHIP, length)) fx.whip = sign * (1 - (until - 0.5) / WHIP) ** 1.5;
  }
  return fx;
}

export function fxActive(fx: FrameFx): boolean {
  return fx.flash > 0.001 || Math.abs(fx.whip) > 0.001;
}
