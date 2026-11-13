// End-to-end test of stage 2 in a real (headless) Chromium:
// video clips > beat detection > snap cuts > transitions > trailer export.
//
//   npm run build && npm run test:e2e2
//
// Needs Playwright (Chromium with WebGL 2 and H.264) and ffmpeg/ffprobe,
// which also generate the test media.

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
const PORT = 4180;
const BPM = 128;
const BEAT = 60 / BPM;
mkdirSync(outDir, { recursive: true });
mkdirSync(fixtures, { recursive: true });

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 });

// --- test media ---------------------------------------------------------------
// landscape clip that shows its own frame number: frame N has a white bar at
// row N of 120 (3 px tall in a 360 px frame), on black
const counted = resolve(fixtures, 'counted-landscape.mp4');
ffmpeg('-f', 'lavfi', '-i', "nullsrc=s=640x360:r=30:d=4,format=gray,geq=lum='if(between(Y,N*3,N*3+2),235,16)',format=yuv420p", '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-g', '30', counted);
// detailed clip stored sideways with rotation metadata, like a phone held upright
const sideways = resolve(fixtures, 'sideways-tmp.mp4');
const rotated = resolve(fixtures, 'rotated-portrait.mp4');
ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-g', '30', sideways);
ffmpeg('-display_rotation', '90', '-i', sideways, '-c', 'copy', rotated);
// an HEVC clip, as iPhones record by default
const hevc = resolve(fixtures, 'iphone-style-hevc.mp4');
ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2,format=yuv420p', '-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', hevc);
// 20 s kick drum at 128 BPM, first beat at 0.25 s
const beatWav = resolve(fixtures, 'beat-128.wav');
{
  const sr = 44100;
  const n = sr * 20;
  const d = new Int16Array(n);
  for (let b = 0; ; b++) {
    const s0 = Math.round((0.25 + b * BEAT) * sr);
    if (s0 >= n) break;
    for (let i = 0; i < sr * 0.18 && s0 + i < n; i++) {
      const t = i / sr;
      d[s0 + i] += Math.round(26000 * Math.exp(-t * 22) * Math.sin(2 * Math.PI * (120 * Math.exp(-t * 18) + 45) * t));
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + n * 2, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(n * 2, 40);
  writeFileSync(beatWav, Buffer.concat([h, Buffer.from(d.buffer)]));
}

// --- helpers --------------------------------------------------------------------
const drop = async (page, file) => {
  await page.locator('#filepick').setInputFiles(file);
  await page.waitForFunction(() => !window.__app.busy, null, { timeout: 60_000 });
  await page.waitForTimeout(200);
};
/** for every frame of an MP4 made from the counted clip: which clip frame it shows (row of the bar) */
const clipFramePerFrame = (file) => {
  const data = ffmpeg('-i', file, '-vf', 'scale=1:120:flags=area,format=gray', '-f', 'rawvideo', '-');
  const out = [];
  for (let f = 0; f * 120 < data.length; f++) {
    const column = data.subarray(f * 120, (f + 1) * 120);
    out.push(column.indexOf(Math.max(...column)));
  }
  return out;
};
const barRow = (gray, w, h) => {
  const rows = Array.from({ length: h }, (_, y) => gray[y * w]);
  return rows.indexOf(Math.max(...rows));
};
/** mean brightness per frame of an MP4 (one byte per frame) */
const lumaPerFrame = (file) => [...ffmpeg('-i', file, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-')];
/** one frame as a small gray image */
const grayFrame = (file, index, w = 54, h = 96) => ({
  w,
  h,
  // via RGB with the file's declared BT.709 colours, then the same luma weights the live frame uses
  data: ffmpeg('-i', file, '-vf', `select=eq(n\\,${index}),scale=${w}:${h}:flags=area:in_color_matrix=bt709:in_range=tv,format=gbrp,colorchannelmixer=.2126:.7152:.0722:0:.2126:.7152:.0722:0:.2126:.7152:.0722:0,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'),
});
/** how much fine horizontal detail an image has */
const horizontalDetail = ({ w, h, data }) => {
  let sum = 0;
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) sum += Math.abs(data[y * w + x] - data[y * w + x - 1]);
  return sum / (h * (w - 1));
};
const exportAndSave = async (page, buttonName, file) => {
  await page.evaluate(() => (window.__lastExport = null));
  await page.getByRole('button', { name: buttonName }).click();
  await page.waitForFunction(() => !!window.__lastExport, null, { timeout: 900_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MP4' }).click()]);
  writeFileSync(file, readFileSync(await download.path()));
  await page.getByRole('button', { name: 'Close' }).click();
  return page.evaluate(() => ({ frames: window.__lastExport.frames, seconds: window.__lastExport.seconds }));
};
/** the live canvas, drawn now, as a small gray image */
const liveFrame = (page, w = 54, h = 96) =>
  page.evaluate(
    async ([w, h]) => {
      const a = window.__app;
      // software rendering runs at about one frame a second here, so drive
      // the frame loop by hand: draw (which seeks the clip), wait for the
      // seek, give the video texture a moment, then draw the frame to keep
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
      await new Promise((r) => setTimeout(r, 400));
      a.frame(0);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(a.viewer.canvas, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const out = [];
      for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]));
      return out;
    },
    [w, h],
  );
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// --- run ------------------------------------------------------------------------
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

  console.log('\nMedia');
  await page.getByRole('button', { name: 'Try the demo room' }).click();
  await page.waitForFunction(() => window.__app.loaded.size === 1 && !window.__app.busy, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const a = window.__app;
    a.rotateScene('x', 197);
    a.autoFloor();
    a.frameScene();
    a.applyPreset('pushIn');
    a.stop();
  });
  await drop(page, counted);
  await drop(page, rotated);
  let state = await page.evaluate(() => ({ videos: window.__app.project.videos, shots: window.__app.project.shots.map((s) => s.type) }));
  check(state.videos.length === 2 && state.shots.join() === 'splat,video,video', 'dropping a clip adds it and makes a shot from it');
  check(state.videos[0].width === 640 && state.videos[0].height === 360 && Math.abs(state.videos[0].duration - 4) < 0.05, 'clip size and length are read', `${state.videos[0].width}x${state.videos[0].height}, ${state.videos[0].duration.toFixed(2)} s`);
  check(state.videos[1].width === 360 && state.videos[1].height === 640, 'a clip filmed upright (rotation metadata) is seen as portrait', `${state.videos[1].width}x${state.videos[1].height}`);

  await drop(page, hevc);
  const hevcState = await page.evaluate(() => {
    const a = window.__app;
    const shot = a.project.shots[a.project.shots.length - 1];
    const clip = a.clips.get(shot.videoId);
    return { canDecode: clip.info.canDecode, codec: clip.info.codec, problem: a.shotProblem(shot), toast: document.getElementById('toast').textContent };
  });
  if (hevcState.canDecode) check(hevcState.problem === null, 'this browser decodes HEVC, the clip is usable', hevcState.codec);
  else check(/HEVC/.test(hevcState.problem ?? '') && /HEVC/.test(hevcState.toast), 'this browser cannot decode HEVC and the tool says so plainly instead of failing', hevcState.codec);
  await page.evaluate(() => {
    const a = window.__app;
    a.removeVideo(a.project.videos[2].id); // confirm dialog is accepted
  });

  console.log('\nBeat');
  await drop(page, beatWav);
  const t = await page.evaluate(() => window.__app.project.timeline);
  check(Math.abs(t.bpm - BPM) <= 1, 'the tempo of the music is detected', `${t.bpm} BPM, real ${BPM}`);
  check(Math.abs(t.audio.firstBeat - 0.25) < 0.03, 'the first beat is found', `${t.audio.firstBeat.toFixed(3)} s, real 0.250 s`);
  check(Math.abs(t.beatOffset) < 0.01 || Math.abs(t.beatOffset - BEAT) < 0.01, 'the trailer starts on a beat');

  await page.evaluate(() => {
    const a = window.__app;
    const [, clip, upright] = a.project.shots;
    Object.assign(clip, { trimIn: 1, trimOut: 2, transition: 'flash' });
    Object.assign(upright, { trimIn: 0.51, trimOut: 2.51, transition: 'whipLeft' });
    a.changed();
  });
  await page.getByRole('button', { name: 'Snap all cuts' }).click();
  const tl = await page.evaluate(() => {
    const a = window.__app;
    return { durations: a.project.shots.map((s) => s.duration), entries: a.timeline.entries.map((e) => [e.startFrame, e.endFrame]), total: a.timeline.totalFrames };
  });
  let cut = 0;
  let worstBeat = 0;
  let worstFrame = 0;
  tl.durations.forEach((d, i) => {
    cut += d;
    worstBeat = Math.max(worstBeat, Math.abs(cut / BEAT - Math.round(cut / BEAT)));
    worstFrame = Math.max(worstFrame, Math.abs(tl.entries[i][1] - cut * 30));
  });
  check(worstBeat < 0.01, 'after "Snap all cuts" every cut is on a beat', `worst ${(worstBeat * BEAT * 1000).toFixed(1)} ms off`);
  check(worstFrame <= 0.5, 'cuts are rounded to the nearest whole frame, without drift', `worst ${worstFrame.toFixed(2)} frame`);

  console.log('\nPreview');
  await page.evaluate(() => {
    const a = window.__app;
    a.selectShot(a.project.shots[1].id);
    a.scrub(0.5);
  });
  const previewRow = barRow(await liveFrame(page, 1, 120), 1, 120);
  // halfway through a shot that plays clip seconds 1 to 2 is clip time 1.5 s: frame 45
  check(previewRow === 45, 'scrubbing a video shot shows the right moment of the clip', `clip frame ${previewRow}, expected 45`);
  await page.evaluate(() => {
    const a = window.__app;
    a.setMode('trailer');
    a.scrubTrailer((a.timeline.entries[1].startFrame + 0.5) / 30);
  });
  const flash = mean(await liveFrame(page));
  check(flash > 235, 'trailer view shows the flash on the cut', `brightness ${flash.toFixed(0)}`);
  await page.screenshot({ path: resolve(outDir, '5-trailer-timeline.png') });

  // drag the right edge of the first block: the cut follows and lands on a beat
  const before = await page.evaluate(() => window.__app.project.shots[0].duration);
  const handle = await page.locator('.tl-block .tl-handle').first().boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + 10);
  await page.mouse.down();
  await page.mouse.move(handle.x + 43, handle.y + 10, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__app.project.shots[0].duration);
  check(after > before && Math.abs(after / BEAT - Math.round(after / BEAT)) < 0.01, 'dragging the edge of a shot on the timeline changes its length, snapped to the beat', `${before.toFixed(2)} s > ${after.toFixed(2)} s`);

  // real-time trailer playback with the music
  await page.evaluate(() => window.__app.scrubTrailer(0));
  await page.getByRole('button', { name: /Play/ }).click();
  await page.waitForTimeout(2500);
  const playingState = await page.evaluate(() => ({ playing: window.__app.playing, time: window.__app.trailerTime }));
  await page.keyboard.press('Space');
  const stopped = await page.evaluate(() => window.__app.playing);
  check(playingState.playing && playingState.time > 0.1 && !stopped, 'the trailer plays in real time and Space pauses it', `reached ${playingState.time.toFixed(2)} s`);

  console.log('\nExport: one video shot');
  await page.evaluate(() => {
    const a = window.__app;
    a.setMode('shot');
    a.project.timeline.snap = false;
    a.selectShot(a.project.shots[1].id);
    a.setShotDuration(a.activeShot, 1); // 1 s of clip in 1 s: every output frame is the next clip frame
    a.changed();
  });
  const shotMp4 = resolve(outDir, 'stage2-video-shot.mp4');
  const shotResult = await exportAndSave(page, 'Export this shot', shotMp4);
  const shown = clipFramePerFrame(shotMp4);
  check(shotResult.frames === 30 && shown.length === 30, 'a 1 s video shot exports 30 frames');
  check(shown.every((frame, i) => frame === 30 + i), 'frame-accurate: output frame i is exactly clip frame 30 + i, no repeats or skips', `clip frames ${shown[0]} to ${shown[29]}`);

  console.log('\nExport: rotated clip matches its preview');
  await page.evaluate(() => {
    const a = window.__app;
    a.selectShot(a.project.shots[2].id);
    a.setShotDuration(a.activeShot, 0.2);
    a.scrub(0.5 / 6); // middle of the first exported frame
    a.changed();
  });
  const livePortrait = await liveFrame(page);
  const portraitMp4 = resolve(outDir, 'stage2-rotated-shot.mp4');
  await exportAndSave(page, 'Export this shot', portraitMp4);
  const exported = grayFrame(portraitMp4, 0);
  let diff = 0;
  for (let i = 0; i < exported.data.length; i++) diff += Math.abs(exported.data[i] - livePortrait[i]);
  diff /= exported.data.length;
  check(diff < 6, 'the exported frame matches the preview: same orientation, framing and colours', `mean difference ${diff.toFixed(1)} of 255`);

  console.log('\nExport: trailer');
  await page.evaluate(() => {
    const a = window.__app;
    a.project.timeline.snap = true;
    a.snapAllCuts();
  });
  const plan = await page.evaluate(() => window.__app.timeline.entries.map((e) => [e.startFrame, e.endFrame]));
  const trailerMp4 = resolve(outDir, 'stage2-trailer.mp4');
  const started = Date.now();
  const trailer = await exportAndSave(page, 'Export trailer', trailerMp4);
  const total = plan[plan.length - 1][1];
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames', '-of', 'json', trailerMp4]));
  const v = probe.streams[0];
  check(trailer.frames === total && Number(v.nb_read_frames) === total, 'the trailer has exactly the planned number of frames', `${total} frames, ${((Date.now() - started) / 1000).toFixed(0)} s to render here`);
  check(v.codec_name === 'h264' && v.width === 1080 && v.height === 1920 && v.avg_frame_rate === '30/1', 'H.264, 1080 x 1920, constant 30 fps');
  check(probe.streams.length === 1, 'the file has no audio track (sound is added in TikTok)');
  const tLuma = lumaPerFrame(trailerMp4);
  const cutIn = plan[1][0];
  check(tLuma[cutIn] > 225 && tLuma[cutIn] > tLuma[cutIn + 2] && tLuma[cutIn + 8] < 150, 'the flash peaks on the first frame after the cut and fades', `brightness ${tLuma.slice(cutIn - 1, cutIn + 7).join(', ')}`);
  const whipCut = plan[2][0];
  const detailWhip = horizontalDetail(grayFrame(trailerMp4, whipCut));
  const detailSharp = horizontalDetail(grayFrame(trailerMp4, whipCut + 12));
  check(detailWhip < detailSharp * 0.6, 'the whip smears the frames around its cut sideways', `horizontal detail ${detailWhip.toFixed(1)} vs ${detailSharp.toFixed(1)} when sharp`);
  ffmpeg('-i', trailerMp4, '-vf', `select='eq(n,10)+eq(n,${cutIn})+eq(n,${cutIn + 10})+eq(n,${whipCut - 1})+eq(n,${whipCut + 1})+eq(n,${whipCut + 10})',scale=216:-1,tile=6x1`, '-frames:v', '1', resolve(outDir, '6-trailer-frames.png'));

  console.log('\nSave, reload, relink');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project' }).click()]);
  const saved = JSON.parse(readFileSync(await download.path(), 'utf8'));
  check(saved.videos.length === 2 && saved.timeline.audio.fileName === 'beat-128.wav' && saved.shots[1].transition === 'flash', 'clips, music and transitions are saved by name');
  await page.reload();
  await page.waitForFunction(() => !!window.__app);
  const missing = await page.evaluate(() => window.__app.missingFiles);
  check(missing.length === 4, 'after a reload the tool lists every file it needs', missing.join(', '));
  for (const f of [resolve(root, 'public/samples/demo-room.ply'), counted, rotated, beatWav]) await drop(page, f);
  await page.waitForFunction(() => window.__app.loaded.size === 1, null, { timeout: 60_000 });
  const back = await page.evaluate(() => {
    const a = window.__app;
    return { missing: a.missingFiles.length, bpm: a.project.timeline.bpm, total: a.timeline.totalFrames, shots: a.project.shots.length, videos: a.project.videos.length };
  });
  check(back.missing === 0 && back.bpm === t.bpm && back.total === total && back.shots === 3 && back.videos === 2, 'dropping the files again relinks everything; the cut is unchanged');

  check(errors.length === 0, 'no errors in the browser console', errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
