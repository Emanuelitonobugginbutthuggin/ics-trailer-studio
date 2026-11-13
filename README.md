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
| 2 | Trailer timeline, beat-synced cuts, video shots, flash and whip transitions | **Done** |
| 3 | Look: motion blur, grade, vignette, grain | **Done** |
| 4 | Photo shots with estimated depth | Next |
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

## How to use it

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
| Space | Play or pause |
| T | Switch between shot view and trailer view |

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

### 5. Use real footage: video shots
Drop an `.mp4` or `.mov` clip anywhere. It appears under **Video clips** and a
shot is made from it. Select the shot and set:

- **Starts at / Ends at**: the part of the clip to use. The picture follows
  the slider.
- **Duration**: how long that part lasts in the trailer. Shorter than the
  trimmed part is fast motion, longer is slow motion; the panel tells you the
  speed. **Real-time length** resets it to normal speed.
- **Easing** and **Speed ramp** work exactly as for camera shots.
- **Framing**: fill the 9:16 frame (cropping the clip) or show the whole
  clip, plus zoom and position.

**+ Shot** next to a clip makes another shot from a different part of it.

### 6. Build the trailer on the timeline
The strip at the bottom is the trailer. Shots play in the order of the
**Shots** list; move them with the arrow buttons. Untick **Use in the
trailer** to keep a shot out of it.

- **Music and beat.** Drop in an `.mp3`, `.m4a` or `.wav` of your sound, or
  press **Load music…**. The tool finds the tempo (BPM) and the first beat,
  and draws the beat lines and the waveform. Always check the BPM against the
  song: you can type it, or press **Tap** in time with the music. **from**
  sets where in the song the trailer starts.
- **Snap cuts to the beat.** With **Snap** ticked, changing a shot's length
  makes it end on the nearest beat line. **Snap all cuts** moves every cut at
  once. **Cuts snap** chooses every beat, half beat, 2 or 4 beats.
- **Change a length** by dragging the right edge of a block, or with
  **Duration** in the shot settings.
- **Transitions.** **Cut in with** on a shot sets how the trailer cuts into
  it: hard cut, flash, or whip left / right.
- **Preview.** Switch from **Shot** to **Trailer** (or press T) and press
  Play: the whole cut plays with the music. Click the time ruler to jump.
  The preview can stutter; the export never does.
- The green zone on the ruler is the 15 to 25 second target.

A good pattern for the fast style: a strong 1-second hook first, then shots
of 1, 2 or 4 beats, a flash or whip every few cuts rather than on every cut.

### 7. Set the look
The **Look** tab (top of the right panel) styles the whole trailer at once.
What you set there is what you see in the preview and get in every export.

- **Presets**: Cinematic (the default), Punchy, Moody, Warm, None.
- **Grade**: exposure, contrast, saturation, warmth, teal & orange (teal
  shadows, orange highlights), faded blacks.
- **Vignette and grain**. Keep grain light: TikTok compresses video hard and
  heavy grain turns into mush.
- **Motion blur** gives fast camera moves real blur. Each frame is the
  average of several moments while a virtual shutter is open. **Samples** is
  how many moments (8 suits most shots; raise it if a very fast move shows
  stepping); **Shutter** is how long it stays open (180° is the film
  standard). It applies to camera shots only: video clips keep the blur they
  were filmed with. It is not shown in the live preview, and it makes camera
  shots take about as many times longer to export as there are samples.
- **Render test frame** shows the frame under the playhead exactly as the
  export will make it, motion blur included. Use it to judge the blur before
  a long export.
- Untick **Use the look** to see and export the untouched picture.

### 8. Export
**Export trailer** (bottom right) renders the whole trailer; **Export this
shot** renders one shot. Both give an MP4 with a **Download MP4** button.
Keep the tab in front while it renders. The file is silent on purpose: add
the same sound in TikTok and line it up with the first cut.

### 9. Save your work
**Save project** downloads a small `.json` file with every setting. It
contains file names only, never the media. To continue later, open the tool,
drop the `.json` in, then drop the same scans, clips and music in again; they
are matched by name and the status line lists what is still missing. The
tool also autosaves in the browser, so a reload loses nothing.

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

### Video clips from an iPhone

Settings > Camera > Record Video: **4K at 30 fps**, and turn **HDR Video
off**. Do not use Apple Log or ProRes. Hold the phone vertical, lock focus and
exposure (press and hold on the screen), move slowly, and hold still for two
seconds at the start and end of every clip.

- **HEVC is fine in Chrome on a Mac.** iPhones record HEVC by default
  (Settings > Camera > Formats > High Efficiency) and Chrome on macOS decodes
  it. If the tool says it cannot decode a clip, switch Formats to **Most
  Compatible** (H.264) and film again, or use a clip you already have in
  H.264.
- **HDR is the one to avoid.** An HDR clip still loads, with a warning: the
  browser squeezes it into standard range and it can look flat or too
  bright. Turning HDR Video off before filming avoids this completely.
- Clips at 60 fps or slow-motion clips work; the export picks the exact frame
  for each of its 30 frames per second.

## What has and has not been tested

The tool is developed in a cloud machine with no graphics chip, using a
software-rendered Chromium. In that setup these pass (`npm run test:e2e`):

- loading `.ply` and `.spz` (the synthetic demo room and a public 786,000-splat
  phone scan from the SPZ project);
- levelling from three clicks (within 1 cm over a 6 × 8 m room), crop box,
  flying, keyframes, presets, save / reload / relink;
- export to MP4: H.264 High, 1080 × 1920, constant 30 fps, exact frame count,
  no audio track;
- video shots from H.264 clips: export is frame-accurate (every output frame
  is exactly the right frame of the clip), a clip with rotation metadata
  (filmed upright) comes out upright, and exported colours match the preview;
- beat detection on a 128 BPM test track (found 128 BPM, first beat within
  3 ms), cuts snapped to the beat and rounded to whole frames without drift;
- flash and whip transitions in the exported file, and real-time trailer
  playback;
- the look: each grade control measured against known colours, vignette,
  grain, the exported file matching the preview, and motion blur (a fast
  sideways move smears sideways only, keeps the amount of light, and
  averaging identical sub-frames changes nothing).

**Not tested there, because it needs real hardware or real files:**

- speed and memory with real scans on a real GPU (expected to be much faster:
  the software renderer needs about 12 s per frame for the 786,000-splat scan);
- the Mac's hardware H.264 encoder (the test used Chrome's software encoder);
- how long motion blur takes on real scans, and whether 8 samples is enough
  for your fastest moves (check with **Render test frame**);
- how the grain survives TikTok's own compression;
- **HEVC and HDR iPhone clips.** The test browser has no HEVC decoder, so it
  could only confirm that an undecodable clip is reported clearly. Decoding
  real iPhone footage, and how an HDR clip looks, is untested;
- 4K clips (the test clips are small) and how smoothly they preview;
- beat detection on real songs. It is a simple detector that works best on
  music with a clear kick; always check the BPM it reports;
- music playback staying in sync over a whole trailer on a real machine;
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

The end-to-end tests need Playwright with Chromium, and ffmpeg (it generates
the test clips and checks the exported files).

`npm run typecheck` checks types. `npm run make-demo` regenerates the demo
room. See [CLAUDE.md](CLAUDE.md) for the project rules and code map.
