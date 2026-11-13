import type { Easing, SpeedRamp } from '../project/schema';

export function ease(kind: Easing, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  switch (kind) {
    case 'easeIn':
      return t * t * t;
    case 'easeOut':
      return 1 - (1 - t) ** 3;
    case 'easeInOut':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    default:
      return t;
  }
}

const RAMP_STEPS = 512;

/** Relative speed at shot fraction x for a slow > fast > slow ramp. */
export function rampSpeed(ramp: SpeedRamp, x: number): number {
  const half = Math.max(1e-3, ramp.width) / 2;
  const d = Math.min(1, Math.abs(x - ramp.center) / half);
  const bump = 0.5 * (1 + Math.cos(Math.PI * d));
  return 1 + (Math.max(1, ramp.strength) - 1) * bump;
}

/** Cumulative, normalised integral of the ramp speed: maps shot fraction
 *  to path fraction, 0 > 0 and 1 > 1, always increasing. */
export function buildRampTable(ramp: SpeedRamp): Float64Array {
  const table = new Float64Array(RAMP_STEPS + 1);
  let sum = 0;
  for (let i = 0; i < RAMP_STEPS; i++) {
    sum += rampSpeed(ramp, (i + 0.5) / RAMP_STEPS);
    table[i + 1] = sum;
  }
  for (let i = 1; i <= RAMP_STEPS; i++) table[i] /= sum;
  return table;
}

export function sampleTable(table: Float64Array, x: number): number {
  const t = Math.min(1, Math.max(0, x)) * (table.length - 1);
  const i = Math.min(table.length - 2, Math.floor(t));
  return table[i] + (table[i + 1] - table[i]) * (t - i);
}

/** Maps time within a shot (0..1) to progress along its path (0..1). */
export class ShotTiming {
  private table: Float64Array | null;

  constructor(
    private easing: Easing,
    ramp: SpeedRamp,
  ) {
    this.table = ramp.enabled ? buildRampTable(ramp) : null;
  }

  progress(tau: number): number {
    const eased = ease(this.easing, tau);
    return this.table ? sampleTable(this.table, eased) : eased;
  }
}
