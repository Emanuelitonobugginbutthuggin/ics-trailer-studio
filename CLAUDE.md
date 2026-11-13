# ICS Trailer Studio: rules for working on this project

A static web app that renders a vertical cinematic trailer of a school from
Gaussian splat scans, video clips and photos. Owner: a student at ICS Milan,
for the class TikTok (@icsmilan.class.of.2028). The school has given
permission to film and publish.

## Hard rules

1. **Everything runs in the user's browser.** No backend. Rendering, depth
   estimation and video encoding are client-side (MacBook Pro M5, Chrome).
2. **Nothing the user loads may be uploaded anywhere.** No analytics, no
   telemetry, no third-party requests carrying user data. Downloads of public
   assets (a sample splat, model weights) are fine; say so in the UI.
3. **Budget is 0 EUR.** Only free, open-source libraries. No paid APIs, no
   accounts, no API keys.
4. **Check current docs before using a library.** Do not rely on memory for
   versions or APIs. Read the installed package's types and the project's own
   repository. Versions of runtime dependencies are pinned exactly.
5. **Never fake a capability.** If something is not achievable in a browser,
   say so and propose the closest real alternative.
6. **Export is offline and frame by frame, never a screen recording:**
   1080 x 1920, 30 fps, H.264 MP4 via WebCodecs. Wait for the splat sort to
   finish before capturing each frame (`Viewer.renderExact`).
7. **Media stays on disk.** The project JSON stores file names only. On
   reopen, ask the user to drop the files in again and match by name.
8. **Build in stages and show each one working** before starting the next:
   (1) load, fix-up, fly, keyframes, export one shot [done];
   (2) timeline, beat cuts, video shots; (3) look and motion blur;
   (4) photo depth shots; (5) title card and polish.
9. **Test with public sample splats** (the user's files are not visible from
   the cloud). After every stage, state clearly what could not be tested
   without a graphics chip.
10. **Ask before big decisions**: questions first, then propose the stack and
    structure, then build. The UI and docs are in English.

## Trailer style (for stages 2 to 5)

Fast and hype: shots of 0.5 to 2 s, speed ramps, whip and flash transitions,
a strong 1-second hook first, total 15 to 25 s, cuts snapped to the beat.
End card: "ICS Milan · Class of 2028" plus the handle, inside TikTok safe
margins. Sound is added in TikTok, so exports are silent.

## Commands

- `npm run dev`: local dev server
- `npm run typecheck`, `npm test`: types and unit tests (Vitest)
- `npm run build`: production build to `dist/`
- `npm run test:e2e`: headless Chromium end-to-end test (needs a build;
  uses the pre-installed Playwright, software WebGL, ffprobe)
- `npm run make-demo`: regenerate `public/samples/demo-room.ply`

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`).
The user chose to push straight to `main`. Run typecheck, unit tests and the
e2e test before every push.

## Code map

- `src/app.ts`: all state and actions (scenes, fix-up, shots, playback, export)
- `src/project/`: JSON schema, save/load, browser autosave
- `src/scene/viewer.ts`: canvas, three.js scene, Spark renderer, exact rendering
- `src/scene/fixup.ts`: up / floor / crop maths (pure, unit-tested)
- `src/scene/flyControls.ts`: WASD + drag camera
- `src/shots/path.ts`: spline camera path, dolly zoom (pure, unit-tested)
- `src/shots/timing.ts`: easing and speed ramps (pure, unit-tested)
- `src/shots/presets.ts`: one-click moves
- `src/export/`: WebCodecs + Mediabunny MP4 encoder (ported from SuperSplat,
  MIT), offline export loop
- `src/ui/`: plain DOM panels, no framework
- `tests/unit/`, `tests/e2e/`, `scripts/make-demo-room.mjs`

## Conventions and facts worth knowing

- World space is levelled: +Y is up, the floor is y = 0, units are metres.
  A scan's fix-up is `translate(0, -floorY, 0) * rotation * raw`.
- Keyframes are stored in world space. `App.setFixup` moves existing
  keyframes with the scan so shots keep their framing.
- Camera field of view is the vertical FOV of the 9:16 frame.
- Spark specifics (v2.4): `spark.update()` returns early if a sort is already
  running, so wait for `spark.sorting` to clear first; set
  `spark.autoUpdate = false` during export. A box `SplatEditSdf` takes its
  half-size from `.scale`. Splat meshes are not loaded with LoD, so frames
  are deterministic.
- Spark loads `.spz` upright (y up). Classic 3DGS `.ply` files are often
  upside down; the UI has a flip button and three-click levelling.
- H.264 config is chosen by trying candidates with
  `VideoEncoder.isConfigSupported` (`src/export/h264Levels.ts`).
- In the cloud container there is no GPU: Chromium renders with SwiftShader
  (slow, about 1 s per frame for the demo room) and has no HEVC decoder.
  `huggingface.co` is blocked there; it must be allowed to test stage 4.
- Credit third-party code and data in `NOTICE.md`.
