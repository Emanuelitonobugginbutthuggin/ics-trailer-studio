// H.264 MP4 encoding in the browser: WebCodecs VideoEncoder for the video
// stream, Mediabunny for the MP4 container.
//
// The structure (own VideoEncoder feeding an EncodedVideoPacketSource,
// chained muxer writes for backpressure, recovery when the browser reclaims
// the codec) is ported from SuperSplat's video export (MIT, PlayCanvas Ltd.)
// https://github.com/playcanvas/supersplat/blob/main/src/render.ts

import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny';
import { h264CandidateList } from './h264Levels';

// backpressure high-water mark for the encoder queue and pending muxer writes
const MAX_QUEUE_SIZE = 5;

export interface EncoderSettings {
  width: number;
  height: number;
  fps: number;
  /** bits per second */
  bitrate: number;
}

export class EncoderUnsupportedError extends Error {}

/** Finds an H.264 configuration this browser can encode, or null. */
export async function findH264Config(s: EncoderSettings): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of h264CandidateList(s.width, s.height, s.fps)) {
    const config: VideoEncoderConfig = {
      codec,
      width: s.width,
      height: s.height,
      bitrate: s.bitrate,
      framerate: s.fps,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      // MP4 wants length-prefixed NAL units plus a separate avcC description
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export class Mp4Encoder {
  readonly codec: string;
  private output: Output;
  private target = new BufferTarget();
  private source = new EncodedVideoPacketSource('avc');
  private encoder: VideoEncoder | null = null;
  private encoderError: Error | null = null;
  private muxerError: Error | null = null;
  private muxerWrites: Promise<void> = Promise.resolve();
  private muxerQueueSize = 0;
  private frameIndex = 0;
  private forceKeyFrame = false;

  private constructor(
    private settings: EncoderSettings,
    private config: VideoEncoderConfig,
  ) {
    this.codec = config.codec;
    this.output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: this.target });
    this.output.addVideoTrack(this.source, { rotation: 0, frameRate: settings.fps });
  }

  static async create(settings: EncoderSettings): Promise<Mp4Encoder> {
    const config = await findH264Config(settings);
    if (!config) {
      throw new EncoderUnsupportedError(
        `This browser cannot encode H.264 at ${settings.width}x${settings.height}. Use a current version of Chrome.`,
      );
    }
    const enc = new Mp4Encoder(settings, config);
    await enc.output.start();
    enc.encoder = enc.createEncoder();
    return enc;
  }

  private createEncoder(): VideoEncoder {
    this.encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        this.muxerQueueSize++;
        // WebCodecs ignores a Promise returned from this callback, so chain
        // the writes: failures surface through muxerError, the queue size
        // drives backpressure, and finish() can wait for every write.
        this.muxerWrites = this.muxerWrites
          .then(async () => {
            if (!this.muxerError) await this.source.add(packet, meta);
          })
          .catch((error) => {
            this.muxerError = error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            this.muxerQueueSize--;
          });
      },
      error: (error) => {
        this.encoderError = error;
      },
    });
    encoder.configure(this.config);
    return encoder;
  }

  /** Adds the next frame from a canvas. Frames are timestamped at a constant frame rate. */
  async addCanvasFrame(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const { fps } = this.settings;
    const index = this.frameIndex++;
    // exact integer microseconds so 30 fps never drifts
    const timestamp = Math.round((index * 1e6) / fps);
    const next = Math.round(((index + 1) * 1e6) / fps);
    // Must be created in the same task as the render, before the browser
    // presents and clears the drawing buffer.
    const frame = new VideoFrame(canvas, { timestamp, duration: next - timestamp, alpha: 'discard' });

    try {
      while (this.encoder!.state === 'configured' && this.encoder!.encodeQueueSize > MAX_QUEUE_SIZE) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      while (this.muxerQueueSize > MAX_QUEUE_SIZE) await this.muxerWrites;

      // if the browser reclaimed the codec (tab in the background), start a
      // new encoder and continue with a key frame
      if (this.encoder!.state === 'closed' && this.encoderError?.message?.includes('reclaimed')) {
        this.encoder = this.createEncoder();
        this.forceKeyFrame = true;
      }
      if (this.encoderError || this.muxerError) throw this.encoderError ?? this.muxerError;

      // a key frame every second keeps the file easy to scrub and cut
      const keyFrame = this.forceKeyFrame || index % Math.round(fps) === 0;
      this.forceKeyFrame = false;
      this.encoder!.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }

  get framesAdded(): number {
    return this.frameIndex;
  }

  /** Flushes everything and returns the finished MP4 file. */
  async finish(): Promise<Blob> {
    await this.encoder!.flush();
    await this.muxerWrites;
    if (this.encoderError || this.muxerError) throw this.encoderError ?? this.muxerError;
    await this.output.finalize();
    this.encoder!.close();
    return new Blob([this.target.buffer!], { type: 'video/mp4' });
  }

  /** Stops encoding and discards the partial file. */
  async cancel() {
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
      await this.muxerWrites;
      await this.output.cancel();
    } catch {
      // already finished or closed
    }
  }
}
