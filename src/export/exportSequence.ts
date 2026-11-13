import type { SplatMesh } from '@sparkjsdev/spark';
import { blurSamples, shutterOffsets, type LookSettings } from '../look/look';
import type { VideoClip } from '../media/videoClip';
import { FPS, HEIGHT, WIDTH, type Fixup, type Shot, type SplatShot, type VideoShot } from '../project/schema';
import type { Viewer } from '../scene/viewer';
import { ShotSampler, newPose } from '../shots/path';
import { VideoShotSampler } from '../shots/videoTime';
import { frameFx, type Timeline } from '../timeline/timeline';
import { Mp4Encoder } from './encoder';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  /** seconds since the export started */
  elapsed: number;
}

export interface ExportOptions {
  /** grade, vignette, grain and motion blur; null renders the plain picture */
  look?: LookSettings | null;
  bitrate?: number;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  frames: number;
  seconds: number;
  codec: string;
}

/** Where the export finds the loaded media for a shot. */
export interface ExportMedia {
  scene(shot: SplatShot): { mesh: SplatMesh; fixup: Fixup } | null;
  clip(shot: VideoShot): VideoClip | null;
}

export function shotFrameCount(shot: Shot): number {
  return Math.max(1, Math.round(shot.duration * FPS));
}

/** A timeline holding just one shot, for exporting it on its own. */
export function singleShotTimeline(shot: Shot): Timeline {
  const frames = shotFrameCount(shot);
  return { entries: [{ shot, startFrame: 0, endFrame: frames }], totalFrames: frames };
}

/** Decoding more than the frame needs is wasted work; this leaves room for zoom. */
const MAX_DECODE_HEIGHT = Math.round(HEIGHT * 1.5);

/**
 * Draws finished frames of one timeline entry onto the canvas, exactly:
 * splats sorted for every camera position, video frames decoded for their
 * timestamp, motion blur from averaged sub-frames, then transitions and the
 * look. `frames` are frame numbers within the entry, in increasing order;
 * `onFrame` is called while each finished frame is on the canvas.
 */
export async function renderEntryFrames(
  viewer: Viewer,
  media: ExportMedia,
  timeline: Timeline,
  index: number,
  frames: number[],
  look: LookSettings | null,
  onFrame: (frameInEntry: number) => Promise<void> | void,
  checkCancelled: () => void = () => {},
) {
  const { shot, startFrame, endFrame } = timeline.entries[index];
  const count = endFrame - startFrame;
  // sample the middle of each frame's time slot
  const tauOf = (i: number) => (i + 0.5) / count;
  const fxOf = (i: number) => (timeline.entries.length > 1 ? frameFx(timeline, index, startFrame + i) : null);

  if (shot.type === 'splat') {
    const scene = media.scene(shot);
    if (!scene) throw new Error(`The scan for shot "${shot.name}" is not loaded.`);
    viewer.setMesh(scene.mesh);
    viewer.applyFixup(scene.fixup);
    const sampler = new ShotSampler(shot);
    const pose = newPose();
    // a locked-off shot has nothing to blur
    const samples = shot.keyframes.length > 1 && viewer.canAccumulate ? blurSamples(look) : 1;
    const offsets = shutterOffsets(samples, look?.motionBlur.shutter ?? 0);
    for (const i of frames) {
      if (samples > 1) {
        // open the shutter: render the sub-frames and average them
        viewer.accumBegin();
        for (const offset of offsets) {
          checkCancelled();
          const tau = Math.min(1, Math.max(0, (i + 0.5 + offset) / count));
          viewer.setPose(sampler.sample(tau, pose));
          await viewer.renderExact();
          viewer.accumAdd(1 / samples);
        }
        viewer.present(fxOf(i), look, startFrame + i, 'accum');
      } else {
        checkCancelled();
        viewer.setPose(sampler.sample(tauOf(i), pose));
        await viewer.renderExact();
        viewer.present(fxOf(i), look, startFrame + i);
      }
      await onFrame(i);
    }
    return;
  }

  const clip = media.clip(shot);
  if (!clip) throw new Error(`The clip for shot "${shot.name}" is not loaded.`);
  const sampler = new VideoShotSampler(shot, clip.info.duration);
  const times = frames.map((i) => sampler.timeAt(tauOf(i)));
  let n = 0;
  for await (const canvas of clip.frames(times, MAX_DECODE_HEIGHT)) {
    checkCancelled();
    const i = frames[n++];
    viewer.drawVideoCanvas(canvas, shot.framing);
    viewer.present(fxOf(i), look, startFrame + i);
    await onFrame(i);
  }
  if (n !== frames.length) throw new Error(`Only ${n} of ${frames.length} frames of "${shot.name}" could be decoded.`);
}

/**
 * Renders a timeline (one shot or the whole trailer) offline, frame by
 * frame, to an H.264 MP4. Not a screen recording: every frame is rendered at
 * exactly 1080x1920, however long that takes, so the result is identical on
 * a fast or a slow machine.
 */
export async function exportTimeline(viewer: Viewer, media: ExportMedia, timeline: Timeline, options: ExportOptions = {}): Promise<ExportResult> {
  const run = async (): Promise<ExportResult> => {
    const { entries, totalFrames } = timeline;
    const started = performance.now();
    const encoder = await Mp4Encoder.create({ width: WIDTH, height: HEIGHT, fps: FPS, bitrate: options.bitrate ?? 16_000_000 });
    let done = 0;
    const checkCancelled = () => {
      if (options.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    };

    viewer.beginExport(WIDTH, HEIGHT);
    try {
      for (let index = 0; index < entries.length; index++) {
        const count = entries[index].endFrame - entries[index].startFrame;
        const frames = Array.from({ length: count }, (_, i) => i);
        await renderEntryFrames(viewer, media, timeline, index, frames, options.look ?? null, async () => {
          await encoder.addCanvasFrame(viewer.canvas);
          options.onProgress?.({ frame: ++done, totalFrames, elapsed: (performance.now() - started) / 1000 });
        }, checkCancelled);
      }
      const blob = await encoder.finish();
      return { blob, frames: totalFrames, seconds: totalFrames / FPS, codec: encoder.codec };
    } catch (error) {
      await encoder.cancel();
      throw error;
    } finally {
      viewer.endExport();
    }
  };

  // A Web Lock tells the browser this tab is busy, which reduces background
  // throttling and codec reclamation during long renders (as in SuperSplat).
  if (navigator.locks) return navigator.locks.request('ics-trailer-studio-export', run);
  return run();
}
