# ICS Trailer Studio

A free tool that runs entirely in your browser and renders a vertical,
cinematic trailer of a school from 3D scans (Gaussian splats), video clips and
photos. Built for the ICS Milan Class of 2028 TikTok (@icsmilan.class.of.2028).

- **Nothing is uploaded.** Scans, clips and photos are read from your disk by
  the page and never leave your computer. There is no server and no account.
- **Free.** Only open-source libraries (see [NOTICE.md](NOTICE.md)).
- **Real rendering, not screen recording.** Exports are rendered frame by
  frame at 1080 × 1920, 30 fps, to an H.264 MP4, so the result is smooth even
  when the live preview is not.

## Status

| Stage | What | State |
|---|---|---|
| 1 | Load a splat, fix it up, fly, keyframes, export one shot | **Done** |
| 2 | Trailer timeline, beat-synced cuts, video shots | Next |
| 3 | Look: motion blur, grade, vignette, grain | Planned |
| 4 | Photo shots with estimated depth | Planned |
| 5 | End title card, polish | Planned |

## Open it

Use **Google Chrome** on a Mac or PC.

**Online (simplest):** https://emanuelitonobugginbutthuggin.github.io/ics-trailer-studio/

One-time setup so that link works:

1. On GitHub, open this repository, then **Settings** > **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open the **Actions** tab. If the latest "Deploy to GitHub Pages" run is red,
   open it and click **Re-run all jobs**. After about a minute the link works.

Every later change pushed to `main` updates the site by itself.

**On your own computer (no internet needed afterwards):** install
[Node.js](https://nodejs.org) (LTS), download this repository, then in Terminal:

```bash
cd ics-trailer-studio
```

```bash
npm install
```

```bash
npm run dev
```

and open the address it prints (http://localhost:5173).

## How to use it (stage 1)

### 1. Load a scan
Drag `.spz` or `.ply` files from Scaniverse anywhere onto the page (`.splat`
also works). Each file becomes a **scene** in the left panel. No footage yet?
Click **Try the demo room**: a small test room that is deliberately tilted,
upside down and surrounded by floating junk.

### 2. Fix the scan (left panel, top to bottom)
1. **Which way is up.** Click **Level from 3 floor clicks**, then click three
   spots on the floor, spread apart and not on furniture. The scan turns so
   the floor is flat. Fine-tune with the tilt and turn buttons, or use
   **Flip upside down**. Tick **Show floor grid** to check: the grid has 1 m
   squares and should lie on the floor.
2. **Floor level.** Usually set by step 1. Otherwise **Click the floor**,
   **Auto**, or type a height.
3. **Crop box.** Tick **Crop to box**, press **Fit box to scan**, then pull
   the six sliders in until the floating junk is gone. Y is height.

Shots you already made stay glued to the scan if you change the fix-up later.

### 3. Fly

| Input | Action |
|---|---|
| Drag | Look around |
| W A S D or arrow keys | Move forward, left, back, right |
| Q / E | Down / up |
| Scroll | Move along the view direction |
| Shift / Alt | Faster / slower |
| Z / C, X | Roll left / right, level the roll |
| [ / ] | Narrower / wider field of view |
| K | Add a keyframe |
| Space | Play or pause the shot |

The viewport always has the 9:16 shape of the final video. The dashed box is
the approximate area TikTok's buttons and captions do not cover.

### 4. Make a shot
- Click **+ New shot**. Fly to the start, press **K**. Fly to the end, press
  **K**. Add more keyframes in between for a curved path: the camera follows a
  smooth spline through all of them.
- Or frame your subject and click a **one-click move**: push-in, pull-back
  reveal, crane up, orbit, low fly-through.
- **Duration**: 0.5 to 2 s is the fast trailer style.
- **Easing** and **Speed ramp** (slow > fast > slow): *Punch* is how much
  faster the middle is.
- **Dolly zoom**: tick it and click the subject. The subject keeps its size
  while the background stretches. Needs a shot that moves toward or away from
  the subject.
- **Go** jumps to a keyframe, **Set** replaces it with the current view.

### 5. Export
**Export this shot** renders the shot to an MP4 and shows it with a
**Download MP4** button. Keep the tab in front while it renders.

### 6. Save your work
**Save project** downloads a small `.json` file with your scenes' fix-up and
all shots. It contains file names only, never the media. To continue later,
open the tool, drop the `.json` in, then drop the same scan files in again;
they are matched by name. The tool also autosaves in the browser, so a reload
loses nothing.

## Scanning well with Scaniverse

Menu names can differ between app versions; the ideas stay the same.

- Use the **Splat** mode and process at the highest detail the phone allows.
- **Move slowly and overlap.** Walk a loop around the space pointing inward,
  then a second loop at a different height (chest, then above head pointing
  down a little). Every surface should be seen from several directions.
- **Do not stand still and spin.** The app needs the phone to change
  position, not just direction.
- **Even light, no people.** Scan when the space is empty. Moving people,
  screens that are on, mirrors, glass and shiny floors turn into smeared junk.
- **Give it texture.** Blank white walls and ceilings scan badly; include
  posters, furniture and floor edges in the frame as you pass them.
- **One space per scan**, 1 to 3 minutes each. A corridor, a classroom, the
  entrance, the gym: separate scans are easier to fix and faster to render.
- **Include the floor** clearly. The tool levels the scan from it.
- **Export** each scan as `.spz` (small; use this one) and also as `.ply` as a
  backup. Name the files after the place: `gym.spz`, `entrance.spz`.

### Backup video on an iPhone

Settings > Camera > Record Video: **4K at 30 fps**, and turn **HDR Video
off**. Do not use Apple Log or ProRes. Hold the phone vertical, lock focus and
exposure (press and hold on the screen), move slowly, and hold still for two
seconds at the start and end of every clip. (Video shots arrive in stage 2.)

## What has and has not been tested

The tool is developed in a cloud machine with no graphics chip, using a
software-rendered Chromium. In that setup these pass (`npm run test:e2e`):

- loading `.ply` and `.spz` (the synthetic demo room and a public 786,000-splat
  phone scan from the SPZ project);
- levelling from three clicks (within 1 cm over a 6 × 8 m room), crop box,
  flying, keyframes, presets, save / reload / relink;
- export to MP4: H.264 High, 1080 × 1920, constant 30 fps, exact frame count.

**Not tested there, because it needs real hardware:**

- speed and memory with real scans on a real GPU (expected to be much faster:
  the software renderer needs about 12 s per frame for the 786,000-splat scan);
- the Mac's hardware H.264 encoder (the test used Chrome's software encoder);
- Safari. Use Chrome.

## Development

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build && npm run test:e2e
```

`npm run typecheck` checks types. `npm run make-demo` regenerates the demo
room. See [CLAUDE.md](CLAUDE.md) for the project rules and code map.
