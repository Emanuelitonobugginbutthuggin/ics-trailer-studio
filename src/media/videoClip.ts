import { ALL_FORMATS, BlobSource, CanvasSink, Input, type InputVideoTrack } from 'mediabunny';
import * as THREE from 'three';

export interface VideoInfo {
  /** seconds */
  duration: number;
  /** display size, after rotation metadata */
  width: number;
  height: number;
  codec: string | null;
  /** WebCodecs can decode it, so it can be exported */
  canDecode: boolean;
  hdr: boolean;
  /** the file does not say which colour standard it uses (never the case for phone footage) */
  untaggedColor: boolean;
  fps: number | null;
}

export type FrameCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * One video file from the user's disk.
 * Preview uses a normal <video> element (real time, frames may drop).
 * Export uses Mediabunny + WebCodecs to decode the exact frame for every
 * output frame, with the clip's rotation metadata applied.
 */
export class VideoClip {
  readonly url: string;
  readonly el: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
  /** the <video> element could load the clip, so live preview works */
  previewOk = false;

  private constructor(
    readonly file: File,
    private input: Input,
    private track: InputVideoTrack,
    readonly info: VideoInfo,
    private firstTimestamp: number,
  ) {
    this.url = URL.createObjectURL(file);
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.playsInline = true;
    this.el.preload = 'auto';
    this.el.src = this.url;
    this.texture = new THREE.VideoTexture(this.el);
    // pixels pass through untouched: the whole pipeline works on display (sRGB) values
    this.texture.colorSpace = THREE.NoColorSpace;
  }

  static async open(file: File): Promise<VideoClip> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    let track: InputVideoTrack | null;
    try {
      track = await input.getPrimaryVideoTrack();
    } catch {
      throw new Error('this is not a video file the tool can read (use .mp4 or .mov)');
    }
    if (!track) throw new Error('the file has no video track');

    const [duration, width, height, codec, canDecode, hdr, firstTimestamp, colorSpace] = await Promise.all([
      track.computeDuration(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getCodecParameterString().catch(() => null),
      track.canDecode().catch(() => false),
      track.hasHighDynamicRange().catch(() => false),
      track.getFirstTimestamp().catch(() => 0),
      track.getColorSpace().catch(() => ({}) as VideoColorSpaceInit),
    ]);
    let fps: number | null = null;
    try {
      fps = (await track.computePacketStats(60)).averagePacketRate;
    } catch {
      // frame rate is only shown as information
    }
    const clip = new VideoClip(file, input, track, { duration: duration - firstTimestamp, width, height, codec, canDecode, hdr, untaggedColor: !colorSpace.matrix, fps }, firstTimestamp);
    clip.previewOk = await clip.waitForElement();
    return clip;
  }

  private waitForElement(): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(this.el.readyState >= 2), 8000);
      this.el.addEventListener('loadeddata', () => done(true), { once: true });
      this.el.addEventListener('error', () => done(false), { once: true });
    });
  }

  /**
   * Live preview: keeps the <video> element at `time` (clip seconds).
   * While playing it runs at `rate` and is only re-seeked when it drifts;
   * while paused every change is a seek.
   */
  sync(time: number, playing: boolean, rate: number) {
    if (!this.previewOk) return;
    const el = this.el;
    const t = Math.min(Math.max(0, time), Math.max(0, this.info.duration - 0.02));
    const playable = playing && rate >= 0.07 && rate <= 16;
    if (playable) {
      if (Math.abs(el.playbackRate - rate) > 0.02) el.playbackRate = rate;
      if (el.paused) void el.play().catch(() => {});
      if (Math.abs(el.currentTime - t) > 0.25 && !el.seeking) el.currentTime = t;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - t) > 1 / 120 && !el.seeking) el.currentTime = t;
    }
  }

  pause() {
    if (!this.el.paused) this.el.pause();
  }

  /**
   * Export: yields a canvas with the exact frame for every requested time
   * (clip seconds, in playback order). The canvas is reused between frames,
   * so use it before asking for the next one. `maxHeight` limits the decode
   * size; a 4K clip does not need all its pixels for a 1080 x 1920 frame.
   */
  async *frames(timestamps: number[], maxHeight: number): AsyncGenerator<FrameCanvas> {
    const scale = Math.min(1, maxHeight / this.info.height);
    const sink = new CanvasSink(this.track, {
      width: Math.max(2, Math.round(this.info.width * scale)),
      height: Math.max(2, Math.round(this.info.height * scale)),
      fit: 'fill',
      poolSize: 1,
    });
    let last: FrameCanvas | null = null;
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps.map((t) => t + this.firstTimestamp))) {
      if (wrapped) last = wrapped.canvas;
      if (!last) throw new Error(`could not decode a frame of ${this.file.name}`);
      yield last;
    }
  }

  dispose() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.texture.dispose();
    URL.revokeObjectURL(this.url);
    this.input.dispose();
  }
}

/** Plain-language problems with a clip, for the UI. Empty when all is fine. */
export function clipWarnings(info: VideoInfo, previewOk: boolean): string[] {
  const out: string[] = [];
  const hevc = !!info.codec && /^(hev1|hvc1|dvh1|dvhe)/.test(info.codec);
  if (!info.canDecode) {
    out.push(
      hevc
        ? 'This browser cannot decode HEVC, so this clip cannot be exported here. Use Chrome on a Mac, or record with Settings > Camera > Formats > Most Compatible.'
        : `This browser cannot decode this clip (${info.codec ?? 'unknown codec'}), so it cannot be exported.`,
    );
  } else if (!previewOk) {
    out.push('The live preview cannot play this clip, but export can still decode it.');
  }
  if (info.untaggedColor && info.canDecode) {
    out.push('This file does not say which colour standard it uses, so exported colours can differ slightly from the preview. Clips straight from a phone do not have this problem.');
  }
  if (info.hdr) {
    out.push('HDR clip: the browser converts it to standard range and it may look flat or too bright. For best results record with Settings > Camera > Record Video > HDR Video off.');
  }
  return out;
}
