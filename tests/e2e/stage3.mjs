// End-to-end test of stage 3 in a real (headless) Chromium:
// colour grade, vignette, grain, motion blur, test frame.
//
//   npm run build && npm run test:e2e3

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'tests/output');
const fixtures = resolve(root, 'tests/fixtures');
const PORT = 4181;
mkdirSync(outDir, { recursive: true });
mkdirSync(fixtures, { recursive: true });

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 });
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A portrait clip of four flat bands, top to bottom: grey 64, grey 128,
// grey 192 and a red (200, 60, 60). Known values in, measured values out.
const bands = resolve(fixtures, 'bands.mp4');
const pick = (a, b, c, d) => `if(lt(Y,160),${a},if(lt(Y,320),${b},if(lt(Y,480),${c},${d})))`;
ffmpeg(
  '-f', 'lavfi', '-i', `nullsrc=s=360x640:r=30:d=1,format=gbrp,geq=r='${pick(64, 128, 192, 200)}':g='${pick(64, 128, 192, 60)}':b='${pick(64, 128, 192, 60)}'`,
  '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv444p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '4', '-g', '30', bands,
);

const NEUTRAL = { exposure: 0, contrast: 1, saturation: 1, warmth: 0, splitTone: 0, fade: 0, vignette: 0, grain: 0 };
const setLook = (page, look) =>
  page.evaluate((look) => {
    const a = window.__app;
    Object.assign(a.project.look, look);
    a.touch();
  }, look);

/**
 * Draws a live frame and measures regions of it. Regions are
 * [x0, y0, x1, y1] as fractions of the frame (y from the top).
 * Returns mean r, g, b and the standard deviation of brightness per region.
 */
const measure = (page, regions) =>
  page.evaluate(async (regions) => {
    const a = window.__app;
    // software rendering is slow here: drive the loop by hand until the clip has settled
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 80 && stable < 3; i++) {
      a.frame(0);
      await new Promise((r) => setTimeout(r, 100));
      const el = a.liveClip?.el;
      if (!el) break;
      stable = !el.seeking && el.readyState >= 2 && el.currentTime === last ? stable + 1 : 0;
      last = el.currentTime;
    }
    await new Promise((r) => setTimeout(r, 300));
    a.frame(0);
    const src = a.viewer.canvas;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    return regions.map(([x0, y0, x1, y1]) => {
      const x = Math.round(x0 * c.width);
      const y = Math.round(y0 * c.height);
      const w = Math.max(1, Math.round((x1 - x0) * c.width));
      const h = Math.max(1, Math.round((y1 - y0) * c.height));
      const d = ctx.getImageData(x, y, w, h).data;
      let r = 0, g = 0, b = 0, s = 0, s2 = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        s += l;
        s2 += l * l;
      }
      return { r: r / n, g: g / n, b: b / n, std: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) };
    });
  }, regions);

// centre patches of the four bands, and a patch in the top-left corner
const DARK = [0.4, 0.09, 0.6, 0.16];
const MID = [0.4, 0.34, 0.6, 0.41];
const LIGHT = [0.4, 0.59, 0.6, 0.66];
const RED = [0.4, 0.84, 0.6, 0.91];
const CORNER = [0.0, 0.0, 0.06, 0.04];
const CENTRE = [0.47, 0.47, 0.53, 0.49];

const exportShot = async (page, file) => {
  await page.evaluate(() => (window.__lastExport = null));
  await page.getByRole('button', { name: 'Shots', exact: true }).click();
  await page.getByRole('button', { name: 'Export this shot' }).click();
  await page.waitForFunction(() => !!window.__lastExport, null, { timeout: 900_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MP4' }).click()]);
  writeFileSync(file, readFileSync(await download.path()));
  await page.getByRole('button', { name: 'Close' }).click();
};
/** one frame of an MP4 as brightness values, read with the colours the file declares */
const grayFrame = (file, index, w = 108, h = 192) => ({
  w,
  h,
  data: ffmpeg('-i', file, '-vf', `select=eq(n\\,${index}),scale=${w}:${h}:flags=area:in_color_matrix=bt709:in_range=tv,format=gbrp,colorchannelmixer=.2126:.7152:.0722:0:.2126:.7152:.0722:0:.2126:.7152:.0722:0,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'),
});
const regionMean = ({ w, h, data }, [x0, y0, x1, y1]) => {
  let sum = 0;
  let n = 0;
  for (let y = Math.round(y0 * h); y < Math.max(Math.round(y0 * h) + 1, Math.round(y1 * h)); y++) {
    for (let x = Math.round(x0 * w); x < Math.max(Math.round(x0 * w) + 1, Math.round(x1 * w)); x++) {
      sum += data[y * w + x];
      n++;
    }
  }
  return sum / n;
};
const detail = ({ w, h, data }) => {
  let sum = 0;
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) sum += Math.abs(data[y * w + x] - data[y * w + x - 1]);
  return sum / (h * (w - 1));
};
const verticalDetail = ({ w, h, data }) => {
  let sum = 0;
  for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) sum += Math.abs(data[y * w + x] - data[(y - 1) * w + x]);
  return sum / (w * (h - 1));
};
/** mean amount of light in a frame (display values converted to linear light) */
const lightOf = ({ data }) => data.reduce((a, b) => a + (b / 255) ** 2.2, 0) / data.length;

// the demo room's known tilt (see scripts/make-demo-room.mjs), to level it exactly
const qAxis = (x, y, z, deg) => {
  const h = (deg * Math.PI) / 360;
  return [x * Math.sin(h), y * Math.sin(h), z * Math.sin(h), Math.cos(h)];
};
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qRot = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const TILT = qMul(qAxis(1, 0, 0, 197), qAxis(0, 0, 1, 11));
const UNTILT = [-TILT[0], -TILT[1], -TILT[2], TILT[3]];
const SHIFT = qRot(UNTILT, [0.7, 1.9, -0.4]);
/** room coordinates (floor at 0, back wall at z = -4) > world coordinates once levelled */
const inRoom = ([x, y, z]) => [x + SHIFT[0], y, z + SHIFT[2]];

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  for (let i = 0; ; i++) {
    try {
      await page.goto(`http://localhost:${PORT}/`);
      break;
    } catch (error) {
      if (i > 40) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  console.log('\nGrade (measured on the live picture)');
  const defaults = await page.evaluate(() => window.__app.project.look);
  check(defaults.enabled && defaults.contrast > 1 && defaults.vignette > 0 && defaults.grain > 0 && defaults.motionBlur.enabled, 'a new project starts with the cinematic look and motion blur on');
  await page.locator('#filepick').setInputFiles(bands);
  await page.waitForFunction(() => window.__app.clips.size === 1 && !window.__app.busy, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const a = window.__app;
    a.project.timeline.snap = false;
    a.setShotDuration(a.activeShot, 1);
    a.scrub(0.5);
  });

  await setLook(page, { ...NEUTRAL });
  let [dark, mid, light, red, corner, centre] = await measure(page, [DARK, MID, LIGHT, RED, CORNER, CENTRE]);
  check(near(dark.r, 64, 4) && near(mid.r, 128, 4) && near(light.r, 192, 4) && near(red.r, 200, 6) && near(red.g, 60, 6), 'with the "None" look the picture is untouched', `greys ${dark.r.toFixed(0)}, ${mid.r.toFixed(0)}, ${light.r.toFixed(0)}; red ${red.r.toFixed(0)}, ${red.g.toFixed(0)}, ${red.b.toFixed(0)}`);
  check(mid.std < 1.5, 'and it has no grain', `noise ${mid.std.toFixed(2)}`);
  const plainCorner = corner.r;

  await setLook(page, { ...NEUTRAL, contrast: 1.5 });
  [dark, mid, light] = await measure(page, [DARK, MID, LIGHT]);
  // (v - 0.45) * 1.5 + 0.45 on 64 and 192 of 255
  check(near(dark.r, 38.6, 5) && near(light.r, 230.6, 5) && dark.r < 60 && light.r > 196, 'contrast pushes darks down and lights up', `64 > ${dark.r.toFixed(0)}, 192 > ${light.r.toFixed(0)}`);

  await setLook(page, { ...NEUTRAL, exposure: 1 });
  [dark] = await measure(page, [DARK]);
  check(near(dark.r, 128, 5), 'exposure +1 stop doubles the brightness', `64 > ${dark.r.toFixed(0)}`);

  await setLook(page, { ...NEUTRAL, saturation: 0 });
  [red] = await measure(page, [RED]);
  check(near(red.r, red.g, 3) && near(red.g, red.b, 3), 'saturation 0 gives black and white', `red > ${red.r.toFixed(0)}, ${red.g.toFixed(0)}, ${red.b.toFixed(0)}`);

  await setLook(page, { ...NEUTRAL, warmth: 1 });
  [mid] = await measure(page, [MID]);
  check(mid.r > mid.g + 6 && mid.g > mid.b + 6, 'warmth shifts grey toward orange', `${mid.r.toFixed(0)}, ${mid.g.toFixed(0)}, ${mid.b.toFixed(0)}`);

  await setLook(page, { ...NEUTRAL, splitTone: 1 });
  [dark, light] = await measure(page, [DARK, LIGHT]);
  check(dark.b > dark.r + 8 && light.r > light.b + 8, 'teal & orange: shadows go teal, highlights go orange', `dark ${dark.r.toFixed(0)}/${dark.b.toFixed(0)}, light ${light.r.toFixed(0)}/${light.b.toFixed(0)} (red/blue)`);

  await setLook(page, { ...NEUTRAL, vignette: 1 });
  [corner, centre] = await measure(page, [CORNER, CENTRE]);
  check(corner.r < plainCorner * 0.6 && near(centre.r, 128, 4), 'the vignette darkens the corners and leaves the middle alone', `corner ${plainCorner.toFixed(0)} > ${corner.r.toFixed(0)}, centre ${centre.r.toFixed(0)}`);

  await setLook(page, { ...NEUTRAL, grain: 1 });
  [mid] = await measure(page, [MID]);
  check(mid.std > 5 && near(mid.r, 128, 3), 'grain adds noise without changing the brightness', `noise ${mid.std.toFixed(1)}, mean ${mid.r.toFixed(1)}`);

  console.log('\nLook panel');
  await page.getByRole('button', { name: 'Look', exact: true }).click();
  await page.getByRole('button', { name: 'Punchy' }).click();
  let look = await page.evaluate(() => window.__app.project.look);
  check(look.contrast === 1.35 && look.saturation === 1.3, 'a preset button sets the whole grade');
  await page.getByRole('button', { name: 'None' }).click();
  look = await page.evaluate(() => window.__app.project.look);
  check(look.contrast === 1 && look.grain === 0 && look.vignette === 0, '"None" clears it');
  await page.getByRole('button', { name: 'Cinematic' }).click();
  await page.getByLabel('Contrast').fill('1.5');
  look = await page.evaluate(() => window.__app.project.look);
  check(look.contrast === 1.5 && look.splitTone === 0.4, 'the sliders change one setting at a time');
  await page.screenshot({ path: resolve(outDir, '7-look-panel.png') });

  console.log('\nThe look in the export');
  await setLook(page, { ...NEUTRAL, contrast: 1.5, vignette: 1 });
  const live = await measure(page, [DARK, LIGHT, CORNER]);
  const lookMp4 = resolve(outDir, 'stage3-look.mp4');
  await exportShot(page, lookMp4);
  const frame = grayFrame(lookMp4, 10);
  const exp = [DARK, LIGHT, CORNER].map((r) => regionMean(frame, r));
  check(live.every((l, i) => near(l.r, exp[i], 7)), 'the exported file has the same grade and vignette as the preview', `dark ${live[0].r.toFixed(0)}/${exp[0].toFixed(0)}, light ${live[1].r.toFixed(0)}/${exp[1].toFixed(0)}, corner ${live[2].r.toFixed(0)}/${exp[2].toFixed(0)} (preview/export)`);

  console.log('\nMotion blur');
  await page.getByRole('button', { name: 'Try the demo room' }).click().catch(() => {});
  await page.evaluate(() => window.__app.addSplatFromUrl('./samples/demo-room.ply', 'demo-room.ply'));
  await page.waitForFunction(() => window.__app.loaded.size === 1 && !window.__app.busy, null, { timeout: 120_000 });
  const canAccumulate = await page.evaluate(() => window.__app.viewer.canAccumulate);
  check(canAccumulate, 'this browser can accumulate sub-frames (float render target)');
  // level the room exactly, then a fast sideways move facing the wall with the lettering
  await page.evaluate(
    ([rotation, floorY, from, to]) => {
      const a = window.__app;
      a.selectScene(a.project.scenes[0].id);
      a.setFixup({ ...a.activeScene.fixup, rotation, floorY });
      const shot = a.addShot();
      const q = [0, 0, 0, 1]; // looking along -z, at the back wall
      shot.keyframes = [
        { position: from, quaternion: q, fov: 60 },
        { position: to, quaternion: q, fov: 60 },
      ];
      a.setShotDuration(shot, 0.2);
      Object.assign(a.project.look, { exposure: 0, contrast: 1, saturation: 1, warmth: 0, splitTone: 0, fade: 0, vignette: 0, grain: 0 });
      a.project.look.motionBlur = { enabled: false, samples: 6, shutter: 1 };
      a.refreshPath();
      a.changed();
    },
    [UNTILT, SHIFT[1], inRoom([-0.6, 1.6, 0.5]), inRoom([0.6, 1.6, 0.5])],
  );
  const sharpMp4 = resolve(outDir, 'stage3-sharp.mp4');
  await exportShot(page, sharpMp4);
  await page.evaluate(() => {
    window.__app.project.look.motionBlur.enabled = true;
    window.__app.changed();
  });
  const blurMp4 = resolve(outDir, 'stage3-blurred.mp4');
  const started = Date.now();
  await exportShot(page, blurMp4);
  const sharp = grayFrame(blurMp4.replace('blurred', 'sharp'), 3);
  const blurred = grayFrame(blurMp4, 3);
  check(detail(blurred) < detail(sharp) * 0.75, 'a fast sideways move is smeared sideways', `sideways detail ${detail(sharp).toFixed(1)} sharp, ${detail(blurred).toFixed(1)} blurred; ${((Date.now() - started) / 1000).toFixed(0)} s to render 6 frames x 6 samples here`);
  check(verticalDetail(blurred) > verticalDetail(sharp) * 0.8, 'and stays sharp across the direction of travel', `vertical detail ${verticalDetail(sharp).toFixed(1)} sharp, ${verticalDetail(blurred).toFixed(1)} blurred`);
  check(Math.abs(lightOf(blurred) - lightOf(sharp)) / lightOf(sharp) < 0.05, 'blur keeps the amount of light in the frame', `${(lightOf(sharp) * 100).toFixed(1)}% sharp, ${(lightOf(blurred) * 100).toFixed(1)}% blurred`);
  ffmpeg('-i', sharpMp4, '-i', blurMp4, '-filter_complex', '[0]select=eq(n\\,3),scale=360:-1[a];[1]select=eq(n\\,3),scale=360:-1[b];[a][b]hstack', '-frames:v', '1', resolve(outDir, '8-motion-blur-off-on.png'));

  // the same camera position at both ends: the average of identical sub-frames must equal one frame
  await page.evaluate(() => {
    const a = window.__app;
    a.activeShot.keyframes[1] = { ...a.activeShot.keyframes[0] };
    a.refreshPath();
    a.changed();
  });
  const stillBlurMp4 = resolve(outDir, 'stage3-still-blur.mp4');
  await exportShot(page, stillBlurMp4);
  await page.evaluate(() => {
    window.__app.project.look.motionBlur.enabled = false;
    window.__app.changed();
  });
  const stillMp4 = resolve(outDir, 'stage3-still.mp4');
  await exportShot(page, stillMp4);
  const a1 = grayFrame(stillBlurMp4, 2);
  const a2 = grayFrame(stillMp4, 2);
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < a1.data.length; i++) {
    const d = Math.abs(a1.data[i] - a2.data[i]);
    worst = Math.max(worst, d);
    sum += d;
  }
  check(sum / a1.data.length < 1 && worst <= 4, 'averaging identical sub-frames gives back the same picture (no colour or brightness shift)', `mean difference ${(sum / a1.data.length).toFixed(2)}, worst ${worst} of 255`);

  console.log('\nTest frame');
  await page.evaluate(() => {
    const a = window.__app;
    a.activeShot.keyframes[1].position = [a.activeShot.keyframes[0].position[0] + 1.2, 1.6, a.activeShot.keyframes[0].position[2]];
    a.project.look.motionBlur.enabled = true;
    a.refreshPath();
    a.changed();
    a.scrub(0.5);
  });
  await page.getByRole('button', { name: 'Look', exact: true }).click();
  await page.getByRole('button', { name: 'Render test frame' }).click();
  await page.waitForFunction(() => window.__app.still && !window.__app.rendering, null, { timeout: 120_000 });
  const hud = await page.locator('#hud').textContent();
  check(/test frame/.test(hud), 'the test frame is rendered and held on screen', hud);
  await page.screenshot({ path: resolve(outDir, '9-test-frame.png') });
  await page.evaluate(() => window.__app.scrub(0.6));
  check(await page.evaluate(() => !window.__app.still), 'moving the playhead returns to the live preview');

  check(errors.length === 0, 'no errors in the browser console', errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
