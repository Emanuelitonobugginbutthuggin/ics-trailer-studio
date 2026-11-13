// H.264 level selection, adapted from SuperSplat (MIT, PlayCanvas Ltd.)
// https://github.com/playcanvas/supersplat/blob/main/src/video-config.ts
//
// A codec string declares a level, and a level caps frame size and pixel
// rate. Too low a level makes the encoder reject the configuration.

// [level_idc, max frame size in 16x16 macroblocks, max macroblocks per second]
// (Rec. ITU-T H.264 Table A-1)
const H264_LEVELS: [number, number, number][] = [
  [40, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600],
];

/** Smallest level that fits, e.g. 40 for 1080x1920 at 30 fps. */
export function h264Level(width: number, height: number, fps: number): number {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  return (H264_LEVELS.find(([, maxFs, maxRate]) => macroblocks <= maxFs && macroblocks * fps <= maxRate) ?? [52])[0];
}

/**
 * Codec strings to try, best first: High profile at the fitting level and
 * above (some hardware encoders only accept 5.1+ for 1080p-tall frames, which
 * is what SuperSplat uses), then Main and Constrained Baseline as fallbacks.
 */
export function h264CandidateList(width: number, height: number, fps: number): string[] {
  const min = h264Level(width, height, fps);
  const levels = [...new Set([min, 42, 51, 52].filter((l) => l >= min))].sort((a, b) => a - b);
  const hex = (l: number) => l.toString(16).padStart(2, '0');
  return [
    ...levels.map((l) => `avc1.6400${hex(l)}`), // High
    ...levels.map((l) => `avc1.4d00${hex(l)}`), // Main
    ...levels.map((l) => `avc1.42e0${hex(l)}`), // Constrained Baseline
  ];
}
