# ICS Trailer Studio: plan and decisions (saved 12 Nov 2026)

Status: stack approved on 12 Nov 2026. Stage 1 is built; see README.md for current state.

## Decisions so far
- **Browser:** Chrome on the MacBook Pro (Safari checked later, in stage 5).
- **Hosting:** GitHub Pages from a free public repo (to be created, steps below).
- **Language:** English UI and README.
- **Budget:** 0 EUR, open-source libraries only, no accounts, no uploads of media.

## Creating the repository
1. Sign in at github.com (free account).
2. **+** (top right) > **New repository**. Name `ics-trailer-studio`, **Public**,
   tick **Add a README**, then **Create repository**.
3. Open https://claude.ai/connect-github, connect GitHub and install the Claude
   GitHub App on that repository.
4. Tell Claude the name (e.g. `yourname/ics-trailer-studio`) so it can attach it
   and push. If attaching fails, start a new session with the repo selected.
5. Later, once: repo Settings > Pages > Source: GitHub Actions.

Only the tool's code is public. Scans, clips and photos never leave the Mac.

## Proposed stack (versions checked 12 Nov 2026)
| Job | Choice | Licence |
|---|---|---|
| Build | Vite 8.3 + TypeScript, plain DOM UI (no framework) | MIT |
| 3D | three.js 0.187 | MIT |
| Splats | Spark 2.4.0 (`@sparkjsdev/spark`) | MIT |
| MP4 writing, clip reading | Mediabunny 1.65 | MPL-2.0 |
| Encoding | browser WebCodecs `VideoEncoder`, H.264 High | built in |
| Photo depth | Transformers.js 4.3 + Depth Anything V2 Small (WebGPU, WASM fallback) | Apache-2.0 |
| Beats | `web-audio-beat-detector` 8.2 + manual BPM / tap | MIT |
| Tests | Vitest (maths), Playwright (load splat, export clip) | MIT |

Notes:
- **SuperSplat** (3.8.1, MIT) renders video like this: set camera from timeline,
  wait for the splat sort, render offscreen, read pixels, feed a `VideoEncoder`
  with backpressure into Mediabunny, under a Web Lock. Port that with
  attribution. Source: `src/render.ts` and `src/video-config.ts`.
- **Spark** documents the matching offline calls:
  `await spark.update({ scene, camera })` > `renderTarget()` > `readTarget()`.
  Loading from dropped files uses `new SplatMesh({ fileBytes, fileType })`.
  Crop uses `SplatEdit` with a `BOX` shape (multiply opacity by 0, inverted).
- **Depth model** downloads from Hugging Face on first use, then is cached.
  Download only; photos are never sent. Option: put the model in the repo.
- **Motion blur** = N accumulated sub-frames, so N times the render time.
  Default 8, adjustable.

## File structure
```
ics-trailer-studio/
  index.html
  src/
    main.ts              app shell, drag & drop routing
    project/             schema.ts, saveLoad.ts (JSON, media matched by file name)
    scene/               viewer.ts, splatLoader.ts, fixup.ts, flyControls.ts
    shots/               keyframes.ts, spline.ts, easing.ts, presets.ts,
                         splatShot.ts, videoShot.ts, photoShot.ts, depth.worker.ts
    timeline/            timeline.ts, beats.ts, transitions.ts
    look/                grade.ts, motionBlur.ts, titleCard.ts
    export/              frameLoop.ts, encoder.ts, h264Levels.ts
    ui/                  panels, timeline strip, styles.css
  tests/                 unit/ and e2e/
  public/samples/        small public sample splat
  .github/workflows/deploy.yml
  README.md  CLAUDE.md  NOTICE
```

## Stages
1. Load a splat, fix-up (up, floor, crop), fly, keyframes, export one shot.
2. Timeline, beat cuts, video shots.
3. Look and motion blur.
4. Photo depth shots.
5. Title card and polish.

## What the cloud container can and cannot test
Measured in its headless Chromium 153 (software rendering, no GPU):
- **Works:** WebGL2, H.264 encode at 1080x1920 (`avc1.640033`), H.264 decode,
  VP9 and AV1, a software WebGPU adapter.
- **Not available:** HEVC decode or encode, so iPhone HEVC and HDR clips are
  untestable there. Also untestable: real GPU speed and memory, the Mac's
  hardware H.264 encoder, WebGPU on Apple silicon, Safari.
- **Blocked hosts:** huggingface.co, sparkjs.dev, mediabunny.dev, jsdelivr,
  unpkg. Hugging Face must be allowed before stage 4 can be tested.
- **Sample splat that is reachable:**
  https://raw.githubusercontent.com/nianticlabs/spz/main/samples/hornedlizard.spz (18 MB)

## Capture checklist for tomorrow
- **iPhone video:** Settings > Camera > Record Video > **HDR Video off**,
  4K at 30 fps. No Apple Log, no ProRes. HEVC itself is fine in Chrome.
- **Filming:** vertical, lock focus and exposure, move slowly, hold 2 s still at
  the start and end of each clip.
- **Scaniverse:** Splat mode, slow overlapping loops at two or three heights.
  Avoid people, mirrors and glass. Export **.spz**, plus .ply as a backup.
