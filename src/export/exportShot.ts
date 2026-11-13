import { FPS, HEIGHT, WIDTH, type SplatShot } from '../project/schema';
import type { Viewer } from '../scene/viewer';
import { ShotSampler, newPose } from '../shots/path';
import { Mp4Encoder } from './encoder';

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  /** seconds since the export started */
  elapsed: number;
}

export interface ExportOptions {
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

export function shotFrameCount(shot: SplatShot): number {
  return Math.max(1, Math.round(shot.duration * FPS));
}

/**
 * Renders one splat shot offline, frame by frame, to an H.264 MP4.
 * Not a screen recording: every frame is rendered at exactly 1080x1920,
 * only after the splats are sorted for that camera position, however long
 * that takes. The result is identical on a fast or a slow machine.
 */
export async function exportSplatShot(viewer: Viewer, shot: SplatShot, options: ExportOptions = {}): Promise<ExportResult> {
  const run = async (): Promise<ExportResult> => {
    const totalFrames = shotFrameCount(shot);
    const sampler = new ShotSampler(shot);
    const pose = viewer.getPose(newPose());
    const restore = viewer.getPose(newPose());
    const started = performance.now();
    const encoder = await Mp4Encoder.create({ width: WIDTH, height: HEIGHT, fps: FPS, bitrate: options.bitrate ?? 16_000_000 });

    viewer.beginExport(WIDTH, HEIGHT);
    try {
      for (let frame = 0; frame < totalFrames; frame++) {
        if (options.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        // sample the middle of each frame's time slot
        sampler.sample((frame + 0.5) / totalFrames, pose);
        viewer.setPose(pose);
        await viewer.renderExact();
        await encoder.addCanvasFrame(viewer.canvas);
        options.onProgress?.({ frame: frame + 1, totalFrames, elapsed: (performance.now() - started) / 1000 });
      }
      const blob = await encoder.finish();
      return { blob, frames: totalFrames, seconds: totalFrames / FPS, codec: encoder.codec };
    } catch (error) {
      await encoder.cancel();
      throw error;
    } finally {
      viewer.endExport();
      viewer.setPose(restore);
    }
  };

  // A Web Lock tells the browser this tab is busy, which reduces background
  // throttling and codec reclamation during long renders (as in SuperSplat).
  if (navigator.locks) return navigator.locks.request('ics-trailer-studio-export', run);
  return run();
}
