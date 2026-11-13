// Generates public/samples/demo-room.ply: a small synthetic Gaussian splat
// "room" in the standard 3DGS PLY layout. It is deliberately tilted, lifted
// off the origin and surrounded by floating junk, like a raw phone scan, so
// the fix-up tools (up, floor, crop) can be practised and tested without
// real footage. Deterministic: same file every run.
//
//   node scripts/make-demo-room.mjs [output.ply]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const out = process.argv[2] ?? 'public/samples/demo-room.ply';

// --- tiny maths helpers -----------------------------------------------------
let seed = 20281112;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const qAxis = (x, y, z, deg) => {
  const h = (deg * Math.PI) / 360;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
};
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qRot = (q, v) => {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};

// --- scene, built upright in metres with the floor at y = 0 -----------------
// Room: 6 m wide (x), 8 m deep (z), 3 m high. Open at the front (z = +4), no ceiling.
const splats = [];
const IDENT = [0, 0, 0, 1];
const add = (pos, color, scale, quat = IDENT, opacity = 0.97) => splats.push({ pos, color, scale, quat, opacity });
const jitter = (amount) => (rand() - 0.5) * amount;
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

const STEP = 0.07;
const FLAT = 0.006;
const R = STEP * 0.62;

// floor: 1 m checkerboard
for (let x = -3; x < 3; x += STEP) {
  for (let z = -4; z < 4; z += STEP) {
    const dark = (Math.floor(x + 3) + Math.floor(z + 4)) % 2 === 0;
    const base = dark ? [0.36, 0.3, 0.27] : [0.78, 0.72, 0.64];
    add([x + jitter(0.02), 0, z + jitter(0.02)], shade(base, 0.92 + rand() * 0.16), [R, FLAT, R]);
  }
}

// 5x7 bitmap font for the sign on the back wall
const FONT = {
  I: ['111', '010', '010', '010', '010', '010', '111'],
  C: ['0111', '1000', '1000', '1000', '1000', '1000', '0111'],
  S: ['0111', '1000', '1000', '0110', '0001', '0001', '1110'],
  2: ['0110', '1001', '0001', '0010', '0100', '1000', '1111'],
  0: ['0110', '1001', '1001', '1001', '1001', '1001', '0110'],
  8: ['0110', '1001', '1001', '0110', '1001', '1001', '0110'],
  ' ': ['00', '00', '00', '00', '00', '00', '00'],
};
const TEXT = 'ICS 2028';
const CELL = 0.14;
let textWidth = 0;
for (const ch of TEXT) textWidth += (FONT[ch][0].length + 1) * CELL;
const textLeft = -textWidth / 2;
const textTop = 2.35;
const inText = (x, y) => {
  let cx = textLeft;
  for (const ch of TEXT) {
    const glyph = FONT[ch];
    const w = glyph[0].length * CELL;
    if (x >= cx && x < cx + w && y <= textTop && y > textTop - 7 * CELL) {
      const col = Math.floor((x - cx) / CELL);
      const row = Math.floor((textTop - y) / CELL);
      return glyph[row][col] === '1';
    }
    cx += w + CELL;
  }
  return false;
};

// back wall (z = -4) with the sign, readable from inside the room
for (let x = -3; x < 3; x += STEP) {
  for (let y = 0; y < 3; y += STEP) {
    const color = inText(x, y) ? [0.98, 0.3, 0.42] : y < 0.9 ? [0.17, 0.25, 0.38] : [0.86, 0.88, 0.9];
    add([x + jitter(0.02), y + jitter(0.02), -4], shade(color, 0.94 + rand() * 0.12), [R, R, FLAT]);
  }
}
// side walls: left is blue, right is green, so mirroring is obvious
for (const [wx, base] of [[-3, [0.25, 0.47, 0.78]], [3, [0.3, 0.66, 0.45]]]) {
  for (let z = -4; z < 4; z += STEP) {
    for (let y = 0; y < 3; y += STEP) {
      const stripe = y > 1.2 && y < 1.35 ? 1.35 : 1;
      add([wx, y + jitter(0.02), z + jitter(0.02)], shade(base, stripe * (0.92 + rand() * 0.16)), [FLAT, R, R]);
    }
  }
}

// furniture: boxes made of surface splats
const box = (cx, cz, w, hgt, d, color) => {
  const s = 0.05;
  const r = s * 0.62;
  for (let x = -w / 2; x <= w / 2; x += s) {
    for (let z = -d / 2; z <= d / 2; z += s) add([cx + x, hgt, cz + z], shade(color, 1.1), [r, FLAT, r]);
    for (let y = 0; y <= hgt; y += s) {
      add([cx + x, y, cz + d / 2], shade(color, 0.9), [r, r, FLAT]);
      add([cx + x, y, cz - d / 2], shade(color, 0.6), [r, r, FLAT]);
    }
  }
  for (let z = -d / 2; z <= d / 2; z += s) {
    for (let y = 0; y <= hgt; y += s) {
      add([cx - w / 2, y, cz + z], shade(color, 0.75), [FLAT, r, r]);
      add([cx + w / 2, y, cz + z], shade(color, 0.75), [FLAT, r, r]);
    }
  }
};
box(-1.8, -2.6, 1.2, 0.75, 0.7, [0.95, 0.72, 0.2]); // desk
box(1.6, -1.2, 0.6, 1.8, 0.5, [0.85, 0.25, 0.3]); // locker
box(0.3, 1.4, 0.8, 0.45, 0.8, [0.55, 0.4, 0.8]); // bench

// floating junk: big soft blobs outside the room, like a real scan
for (let i = 0; i < 900; i++) {
  const side = rand();
  let pos;
  if (side < 0.4) pos = [jitter(9), 3.6 + rand() * 2.5, jitter(11)]; // above
  else if (side < 0.7) pos = [(rand() < 0.5 ? -1 : 1) * (3.7 + rand() * 2.5), rand() * 4 - 0.5, jitter(11)]; // beside
  else if (side < 0.9) pos = [jitter(9), rand() * 4 - 0.5, -4.8 - rand() * 2.5]; // behind
  else pos = [jitter(8), -0.5 - rand() * 1.5, jitter(10)]; // below the floor
  const g = 0.35 + rand() * 0.4;
  const size = 0.08 + rand() * 0.22;
  add(pos, [g, g * (0.9 + rand() * 0.2), g], [size, size * (0.4 + rand()), size], qAxis(rand(), rand(), rand(), rand() * 180), 0.25 + rand() * 0.4);
}

// --- make it look like a raw scan: upside down, tilted, off-centre ----------
const TILT = qMul(qAxis(1, 0, 0, 180 + 17), qAxis(0, 0, 1, 11));
const OFFSET = [0.7, 1.9, -0.4];

// --- write the 3DGS PLY ------------------------------------------------------
const PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${splats.length}`, ...PROPS.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
const body = new Float32Array(splats.length * PROPS.length);
const SH_C0 = 0.28209479177387814;
const clamp01 = (v) => Math.min(0.999, Math.max(0.001, v));
splats.forEach((s, i) => {
  const p = qRot(TILT, s.pos);
  const q = qMul(TILT, s.quat);
  const o = clamp01(s.opacity);
  body.set(
    [
      p[0] + OFFSET[0], p[1] + OFFSET[1], p[2] + OFFSET[2],
      (clamp01(s.color[0]) - 0.5) / SH_C0, (clamp01(s.color[1]) - 0.5) / SH_C0, (clamp01(s.color[2]) - 0.5) / SH_C0,
      Math.log(o / (1 - o)), // stored as a logit
      Math.log(s.scale[0]), Math.log(s.scale[1]), Math.log(s.scale[2]), // stored as logs
      q[3], q[0], q[1], q[2], // w first
    ],
    i * PROPS.length,
  );
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body.buffer)]));
console.log(`${out}: ${splats.length} splats, ${((header.length + body.byteLength) / 1024 / 1024).toFixed(2)} MB`);
