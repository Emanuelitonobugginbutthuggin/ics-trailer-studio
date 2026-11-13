// The look of the whole trailer: colour grade, vignette, grain and motion blur.
// Plain data here; the shader that applies it is in scene/viewer.ts.

export interface MotionBlur {
  enabled: boolean;
  /** sub-frames rendered and averaged per output frame */
  samples: number;
  /** how long the virtual shutter stays open, as a fraction of one frame (0.5 = the classic 180 degree film shutter) */
  shutter: number;
}

export interface LookSettings {
  /** master switch: off shows and exports the untouched picture */
  enabled: boolean;
  /** stops, 0 = unchanged */
  exposure: number;
  /** 1 = unchanged */
  contrast: number;
  /** 1 = unchanged, 0 = black and white */
  saturation: number;
  /** -1 cool .. 1 warm */
  warmth: number;
  /** 0..1: teal shadows and orange highlights */
  splitTone: number;
  /** 0..0.3: lifted, milky blacks */
  fade: number;
  /** 0..1: darker corners */
  vignette: number;
  /** 0..1: film grain */
  grain: number;
  motionBlur: MotionBlur;
}

type Grade = Omit<LookSettings, 'enabled' | 'motionBlur'>;

export const NEUTRAL_GRADE: Grade = { exposure: 0, contrast: 1, saturation: 1, warmth: 0, splitTone: 0, fade: 0, vignette: 0, grain: 0 };

export const LOOK_PRESETS: { id: string; label: string; hint: string; grade: Grade }[] = [
  { id: 'cinematic', label: 'Cinematic', hint: 'Contrasty, teal and orange, light vignette and grain', grade: { exposure: 0, contrast: 1.22, saturation: 1.08, warmth: 0.05, splitTone: 0.4, fade: 0.03, vignette: 0.3, grain: 0.12 } },
  { id: 'punchy', label: 'Punchy', hint: 'Bright, saturated, very contrasty', grade: { exposure: 0.1, contrast: 1.35, saturation: 1.3, warmth: 0, splitTone: 0.1, fade: 0, vignette: 0.2, grain: 0.05 } },
  { id: 'moody', label: 'Moody', hint: 'Darker, cooler, faded blacks, heavy vignette', grade: { exposure: -0.15, contrast: 1.25, saturation: 0.85, warmth: -0.2, splitTone: 0.5, fade: 0.06, vignette: 0.45, grain: 0.18 } },
  { id: 'warm', label: 'Warm', hint: 'Golden and friendly', grade: { exposure: 0.05, contrast: 1.15, saturation: 1.1, warmth: 0.4, splitTone: 0.15, fade: 0.02, vignette: 0.25, grain: 0.1 } },
  { id: 'neutral', label: 'None', hint: 'No grade, vignette or grain', grade: { ...NEUTRAL_GRADE } },
];

export function defaultLook(): LookSettings {
  return { enabled: true, ...LOOK_PRESETS[0].grade, motionBlur: { enabled: true, samples: 8, shutter: 0.5 } };
}

/** Fills in anything missing, e.g. from a project saved before the look existed. */
export function completeLook(look: Partial<LookSettings> | undefined): LookSettings {
  const base = defaultLook();
  return { ...base, ...look, motionBlur: { ...base.motionBlur, ...look?.motionBlur } };
}

/** True when the grade, vignette or grain would change the picture at all. */
export function gradeActive(look: LookSettings | null): boolean {
  if (!look || !look.enabled) return false;
  return (Object.keys(NEUTRAL_GRADE) as (keyof Grade)[]).some((k) => Math.abs(look[k] - NEUTRAL_GRADE[k]) > 1e-4);
}

/** Sub-frames to render for one output frame (1 = no motion blur). */
export function blurSamples(look: LookSettings | null): number {
  if (!look || !look.enabled || !look.motionBlur.enabled) return 1;
  return Math.max(1, Math.min(64, Math.round(look.motionBlur.samples)));
}

/**
 * Positions of the sub-frames of one output frame, in frames relative to
 * the frame's centre. They are spread evenly across the open shutter.
 */
export function shutterOffsets(samples: number, shutter: number): number[] {
  if (samples <= 1) return [0];
  return Array.from({ length: samples }, (_, i) => ((i + 0.5) / samples - 0.5) * Math.min(1, Math.max(0, shutter)));
}
