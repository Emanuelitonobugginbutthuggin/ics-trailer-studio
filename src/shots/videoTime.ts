import type { Framing, VideoShot } from '../project/schema';
import { ShotTiming } from './timing';

/** Maps time within a video shot to time within its clip. */
export class VideoShotSampler {
  private timing: ShotTiming;
  private in: number;
  private out: number;

  constructor(
    private shot: VideoShot,
    clipDuration: number,
  ) {
    this.timing = new ShotTiming(shot.easing, shot.ramp);
    this.in = Math.min(Math.max(0, shot.trimIn), clipDuration);
    this.out = Math.min(Math.max(this.in, shot.trimOut), clipDuration);
  }

  /** tau in 0..1 of the shot > clip seconds */
  timeAt(tau: number): number {
    return this.in + this.timing.progress(tau) * (this.out - this.in);
  }

  /** playback speed at tau, relative to real time */
  rateAt(tau: number): number {
    const d = 0.01;
    const a = Math.max(0, Math.min(1 - d, tau));
    return (this.timeAt(a + d) - this.timeAt(a)) / (d * this.shot.duration);
  }

  /** average speed of the whole shot */
  get averageRate(): number {
    return (this.out - this.in) / this.shot.duration;
  }
}

/**
 * Texture-coordinate scale and offset that place a clip of the given aspect
 * ratio (width / height) in a frame of `frameAspect`: uv' = (uv - 0.5) * scale + 0.5 + offset.
 */
export function framingTransform(f: Framing, clipAspect: number, frameAspect: number) {
  let sx = 1;
  let sy = 1;
  const wider = clipAspect > frameAspect;
  if (f.fit === 'cover') {
    if (wider) sx = frameAspect / clipAspect;
    else sy = clipAspect / frameAspect;
  } else if (wider) sy = clipAspect / frameAspect;
  else sx = frameAspect / clipAspect;
  const zoom = Math.max(1, f.zoom);
  sx /= zoom;
  sy /= zoom;
  // pan moves the visible window across the part of the clip that is cropped away
  const ox = (f.panX * Math.max(0, 1 - sx)) / 2;
  const oy = (f.panY * Math.max(0, 1 - sy)) / 2;
  return { scale: [sx, sy] as [number, number], offset: [ox, oy] as [number, number] };
}
