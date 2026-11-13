import { guess } from 'web-audio-beat-detector';

let context: AudioContext | null = null;
function audioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}

export const PEAKS_PER_SECOND = 100;

/**
 * The song used to find the beat and to preview cuts against. It is only
 * played in the browser; exports are silent (the sound is added in TikTok).
 */
export class Music {
  /** loudest sample in each 10 ms slice, for drawing the waveform */
  readonly peaks: Float32Array;
  private source: AudioBufferSourceNode | null = null;

  private constructor(
    readonly fileName: string,
    readonly buffer: AudioBuffer,
  ) {
    const step = Math.floor(buffer.sampleRate / PEAKS_PER_SECOND);
    const n = Math.floor(buffer.length / step);
    this.peaks = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) {
        let max = this.peaks[i];
        for (let j = i * step, end = j + step; j < end; j += 4) {
          const v = Math.abs(data[j]);
          if (v > max) max = v;
        }
        this.peaks[i] = max;
      }
    }
  }

  static async load(file: File): Promise<Music> {
    let buffer: AudioBuffer;
    try {
      buffer = await audioContext().decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new Error('the browser could not decode this audio file (try .mp3, .m4a or .wav)');
    }
    return new Music(file.name, buffer);
  }

  get duration(): number {
    return this.buffer.duration;
  }

  /** Tempo and the song time of the first beat, from the first 30 seconds. */
  async detectBeat(): Promise<{ bpm: number; firstBeat: number }> {
    const { bpm, offset } = await guess(this.buffer, 0, Math.min(30, this.buffer.duration));
    return { bpm, firstBeat: offset };
  }

  /** Starts playback at a song time (seconds). */
  play(songTime: number) {
    this.stop();
    const ctx = audioContext();
    void ctx.resume();
    if (songTime >= this.buffer.duration) return;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(ctx.destination);
    source.start(0, Math.max(0, songTime));
    this.source = source;
  }

  stop() {
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source?.disconnect();
    this.source = null;
  }
}
