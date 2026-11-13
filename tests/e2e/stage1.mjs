// End-to-end test of stage 1 in a real (headless) Chromium:
// load a scan > level it > crop > fly > keyframes > save > reload > relink > export MP4.
//
//   npm run build && npm run test:e2e
//
// Needs Playwright with a Chromium that has WebGL 2 (software rendering is
// enough) and, for the file checks, ffmpeg/ffprobe on the PATH.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'tests/output');
const demoPly = resolve(root, 'public/samples/demo-room.ply');
const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// --- the demo room's known geometry (see scripts/make-demo-room.mjs) --------
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
const OFFSET = [0.7, 1.9, -0.4];
/** room coordinates (upright, floor at y = 0) > coordinates in the raw file */
const raw = (p) => qRot(TILT, p).map((v, i) => v + OFFSET[i]);

// --- helpers that run inside the page ---------------------------------------
/** world position of a raw-file point under the scene's current fix-up */
const worldOf = (page, rawPoint) =>
  page.evaluate((r) => {
    const a = window.__app;
    a.viewer.fixGroup.updateMatrixWorld(true);
    return a.viewer.camera.position.clone().set(r[0], r[1], r[2]).applyMatrix4(a.viewer.fixGroup.matrixWorld).toArray();
  }, rawPoint);

/** where a world point appears on screen, in client pixels */
const screenOf = (page, world) =>
  page.evaluate((w) => {
    const a = window.__app;
    a.viewer.camera.updateMatrixWorld(true);
    const ndc = a.viewer.camera.position.clone().set(w[0], w[1], w[2]).project(a.viewer.camera);
    const r = a.viewer.canvas.getBoundingClientRect();
    return [r.left + ((ndc.x + 1) / 2) * r.width, r.top + ((1 - ndc.y) / 2) * r.height];
  }, world);

const lookFrom = (page, eye, target, up = [0, 1, 0]) =>
  page.evaluate(
    ([e, t, u]) => {
      const cam = window.__app.viewer.camera;
      cam.up.set(u[0], u[1], u[2]);
      cam.position.set(e[0], e[1], e[2]);
      cam.lookAt(t[0], t[1], t[2]);
      cam.up.set(0, 1, 0);
    },
    [eye, target, up],
  );

/** mean brightness (0..255) of an exactly sorted frame from the current camera */
const frameBrightness = (page) =>
  page.evaluate(async () => {
    const v = window.__app.viewer;
    await v.renderExact();
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 112;
    const ctx = c.getContext('2d');
    ctx.drawImage(v.canvas, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (d.length / 4) / 3;
  });

const waitLoaded = (page) => page.waitForFunction(() => window.__app.loaded.size === 1 && !window.__app.busy, null, { timeout: 120_000 });

// --- run ----------------------------------------------------------------------
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());

  for (let i = 0; ; i++) {
    try {
      await page.goto(URL);
      break;
    } catch (error) {
      if (i > 40) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  console.log('\nLoad');
  // this test checks the plain pipeline; the look (grade, grain, motion blur) has its own test
  await page.evaluate(() => {
    window.__app.project.look.enabled = false;
    window.__app.changed();
  });
  await page.getByRole('button', { name: 'Try the demo room' }).click();
  await waitLoaded(page);
  const splats = await page.evaluate(() => window.__app.loaded.get(window.__app.activeSceneId).numSplats);
  check(splats === 28793, 'demo room loads from a .ply', `${splats} splats`);
  await page.screenshot({ path: resolve(outDir, '1-raw-scan.png') });

  console.log('\nFix-up: which way is up, floor level');
  // stand inside the (tilted, upside-down) raw room and look at its floor
  await lookFrom(page, raw([0, 1.7, 3.2]), raw([0, 0, 0.3]), qRot(TILT, [0, 1, 0]));
  await page.getByRole('button', { name: 'Level from 3 floor clicks' }).click();
  const view = await page.locator('#view').boundingBox();
  for (const p of [[-0.5, 0, 0.9], [-0.7, 0, -0.3], [0.1, 0, -1.4]]) { // clear of the furniture
    const [x, y] = await screenOf(page, raw(p));
    if (x < view.x || x > view.x + view.width || y < view.y || y > view.y + view.height) throw new Error('test click is outside the viewport');
    await page.mouse.click(x, y);
  }
  await page.waitForFunction(() => window.__app.pickMode === null, null, { timeout: 10_000 });
  let worst = 0;
  for (const p of [[0, 0, 0], [2.5, 0, 3.5], [-2.5, 0, -3.5], [2.5, 0, -3.5]]) worst = Math.max(worst, Math.abs((await worldOf(page, raw(p)))[1]));
  check(worst < 0.03, 'three floor clicks make the floor flat at height 0', `worst error ${(worst * 100).toFixed(1)} cm`);
  const head = (await worldOf(page, raw([0, 2, 0])))[1];
  check(Math.abs(head - 2) < 0.05, 'up is up: a point 2 m above the floor is at height 2', head.toFixed(3));
  const roll = await page.evaluate(() => {
    const a = window.__app;
    return a.viewer.camera.position.clone().set(1, 0, 0).applyQuaternion(a.viewer.camera.quaternion).y;
  });
  check(Math.abs(roll) < 1e-3, 'the camera is upright after levelling');
  await page.screenshot({ path: resolve(outDir, '2-levelled.png') });

  console.log('\nFix-up: crop box');
  const centre = await worldOf(page, raw([0, 1.5, 0]));
  await lookFrom(page, centre, [centre[0], centre[1] + 5, centre[2] + 0.01]); // straight up at the junk above the room
  const before = await frameBrightness(page);
  await page.getByRole('button', { name: 'Fit box to scan' }).click();
  await page.evaluate(() => {
    const a = window.__app;
    Object.assign(a.activeScene.fixup.crop, { enabled: true, min: [-20, -0.3, -20], max: [20, 3.2, 20] });
    a.updateCrop();
  });
  const after = await frameBrightness(page);
  check(before > 8 && after < 1, 'the crop box hides floating junk above the room', `brightness ${before.toFixed(1)} > ${after.toFixed(2)}`);

  console.log('\nFly');
  const stand = await worldOf(page, raw([0, 1.6, 3]));
  await lookFrom(page, stand, await worldOf(page, raw([0, 1.2, -4])));
  await page.locator('#view').focus();
  const pos0 = await page.evaluate(() => window.__app.viewer.camera.position.toArray());
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  const pos1 = await page.evaluate(() => window.__app.viewer.camera.position.toArray());
  const moved = Math.hypot(pos1[0] - pos0[0], pos1[1] - pos0[1], pos1[2] - pos0[2]);
  check(moved > 0.05, 'W moves the camera forward', `${moved.toFixed(2)} m`);
  const q0 = await page.evaluate(() => window.__app.viewer.camera.quaternion.toArray());
  const box = await page.locator('#view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 10, { steps: 6 });
  await page.mouse.up();
  const q1 = await page.evaluate(() => window.__app.viewer.camera.quaternion.toArray());
  check(q0.some((v, i) => Math.abs(v - q1[i]) > 1e-3), 'dragging turns the camera');

  console.log('\nShots and keyframes');
  await lookFrom(page, stand, await worldOf(page, raw([0, 1.2, -4])));
  await page.getByRole('button', { name: '+ New camera shot' }).click();
  await page.keyboard.press('KeyK');
  await lookFrom(page, await worldOf(page, raw([0.5, 1.4, 0])), await worldOf(page, raw([0, 1.4, -4])));
  await page.getByRole('button', { name: /Add keyframe here/ }).click();
  let shot = await page.evaluate(() => window.__app.activeShot);
  check(shot.keyframes.length === 2, 'K and the button each add a keyframe');
  await page.getByRole('button', { name: 'Push-in' }).click(); // confirm dialog is accepted above
  await page.evaluate(() => window.__app.stop());
  shot = await page.evaluate(() => window.__app.activeShot);
  check(shot.keyframes.length === 2 && shot.ramp.enabled, 'the push-in preset builds a ramped two-keyframe move');
  await page.screenshot({ path: resolve(outDir, '3-shot.png') });

  console.log('\nSave, reload, relink');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project' }).click()]);
  const saved = JSON.parse(readFileSync(await download.path(), 'utf8'));
  check(saved.app === 'ics-trailer-studio' && saved.scenes[0].fileName === 'demo-room.ply' && saved.shots.length === 1, 'the project saves as JSON with media by file name only');
  check(!JSON.stringify(saved).includes('base64') && JSON.stringify(saved).length < 20_000, 'no media is embedded in the project file');
  await page.reload();
  await page.waitForFunction(() => !!window.__app);
  const restored = await page.evaluate(() => ({ scenes: window.__app.project.scenes.length, missing: window.__app.missingScenes.length, shots: window.__app.project.shots.length }));
  check(restored.scenes === 1 && restored.missing === 1 && restored.shots === 1, 'after a reload the project is back and asks for its missing scan');
  await page.locator('#filepick').setInputFiles(demoPly);
  await waitLoaded(page);
  const relinked = await page.evaluate(() => {
    const a = window.__app;
    return { scenes: a.project.scenes.length, missing: a.missingScenes.length, floorY: a.activeScene.fixup.floorY, crop: a.activeScene.fixup.crop.enabled };
  });
  check(relinked.scenes === 1 && relinked.missing === 0 && relinked.floorY === saved.scenes[0].fixup.floorY && relinked.crop, 'dropping the same file again relinks it, fix-up intact');

  console.log('\nExport');
  await page.evaluate(() => {
    const a = window.__app;
    a.selectShot(a.project.shots[0].id);
    a.activeShot.duration = 0.5;
    a.shotEdited();
    a.changed();
  });
  const started = Date.now();
  await page.getByRole('button', { name: 'Export this shot' }).click();
  await page.waitForFunction(() => !!window.__lastExport, null, { timeout: 600_000 });
  const seconds = (Date.now() - started) / 1000;
  await page.screenshot({ path: resolve(outDir, '4-exported.png') });
  const [mp4Download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MP4' }).click()]);
  const mp4 = resolve(outDir, 'stage1-shot.mp4');
  writeFileSync(mp4, readFileSync(await mp4Download.path()));
  const result = await page.evaluate(() => ({ frames: window.__lastExport.frames, codec: window.__lastExport.codec }));
  check(result.frames === 15, 'a 0.5 s shot exports exactly 15 frames', `${seconds.toFixed(0)} s to render here`);

  try {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,profile,width,height,avg_frame_rate,nb_read_frames,pix_fmt', '-of', 'json', mp4]);
    const s = JSON.parse(probe).streams[0];
    check(s.codec_name === 'h264' && s.pix_fmt === 'yuv420p', 'the file is H.264, 4:2:0', `${s.profile}, ${result.codec}`);
    check(s.width === 1080 && s.height === 1920, 'the frame is 1080 x 1920');
    check(s.avg_frame_rate === '30/1' && Number(s.nb_read_frames) === 15, 'constant 30 fps, every frame decodes');
    const md5 = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-f', 'framemd5', '-']).toString().split('\n').filter((l) => l && !l.startsWith('#'));
    const hashes = md5.map((l) => l.split(',').pop().trim());
    check(new Set(hashes).size === hashes.length, 'every frame is different (the camera really moves)');
    const gray = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-vf', 'scale=32:56,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']);
    const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
    check(mean > 15, 'the picture is not black', `mean brightness ${mean.toFixed(0)}`);
  } catch (error) {
    console.log(`  skip  file checks (ffmpeg/ffprobe not available: ${error.message.split('\n')[0]})`);
  }

  check(errors.length === 0, 'no errors in the browser console', errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
