import { App } from './app';
import { button, h, toast } from './ui/dom';
import { renderLeftPanel } from './ui/leftPanel';
import { renderRightPanel } from './ui/rightPanel';
import { TimelineView } from './ui/timeline';
import './ui/styles.css';

const PUBLIC_SAMPLE_URL = 'https://raw.githubusercontent.com/nianticlabs/spz/main/samples/hornedlizard.spz';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function boot() {
  const canvas = $<HTMLCanvasElement>('view');
  let app: App;
  try {
    app = new App(canvas, $('stage'));
  } catch (error) {
    console.error(error);
    $('empty').replaceChildren(
      h('h1', null, 'This browser cannot start the 3D view'),
      h('p', null, 'ICS Trailer Studio needs WebGL 2. Open it in a current version of Chrome on your Mac.'),
    );
    return;
  }
  (window as unknown as { __app: App }).__app = app; // for automated tests and debugging

  const left = $('left');
  const right = $('right');
  const hud = $('hud');
  const pickHint = $('pickhint');
  const empty = $('empty');
  const safe = $('safe');
  const filePick = $<HTMLInputElement>('filepick');

  // ---- top bar ----
  const nameInput = h('input', {
    type: 'text',
    class: 'name',
    'aria-label': 'Project name',
    onInput: () => {
      app.project.name = nameInput.value;
      app.touch();
    },
  });
  const status = h('span', { class: 'status' });
  $('topbar').append(
    h('span', { class: 'brand' }, h('b', null, 'ICS'), ' Trailer Studio'),
    nameInput,
    button('New', () => app.newProject(), { title: 'Start an empty project' }),
    button('Open…', () => filePick.click(), { title: 'Open a project .json, or add scans, clips and music' }),
    button('Save project', () => app.saveProjectFile(), { title: 'Download the project as a .json file' }),
    h('span', { class: 'spacer' }),
    status,
  );

  // ---- transport ----
  const shotView = button('Shot', () => app.setMode('shot'), { title: 'Edit and preview the selected shot (T switches)' });
  const trailerView = button('Trailer', () => app.setMode('trailer'), { title: 'Preview the whole trailer with cuts, transitions and music (T switches)' });
  const playBtn = button('▶ Play', () => app.togglePlay(), { title: 'Play or pause (Space)' });
  const scrub = h('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.0005',
    value: '0',
    'aria-label': 'Scrub',
    onInput: () => {
      app.stop();
      if (app.mode === 'trailer') app.scrubTrailer(Number(scrub.value) * app.trailerSeconds);
      else app.scrub(Number(scrub.value));
    },
  });
  const time = h('span', { class: 'time' });
  const speed = h('input', {
    type: 'range',
    min: '-3',
    max: '3',
    step: '0.05',
    'aria-label': 'Fly speed',
    onInput: () => {
      app.controls.speed = 2 ** Number(speed.value);
      refreshHud();
    },
  });
  const safeToggle = button('Safe area', () => {
    app.showSafe = !app.showSafe;
    refresh();
  });
  $('transport').append(
    h('span', { class: 'seg', role: 'group', 'aria-label': 'View' }, shotView, trailerView),
    playBtn,
    scrub,
    time,
    h('label', { class: 'speed' }, 'Fly speed', speed),
    safeToggle,
  );
  const timelineView = new TimelineView(app, $('timeline'));

  // ---- rendering of UI state ----
  function refreshHud() {
    const cam = app.viewer.camera;
    const shot = app.activeShot;
    const flying = app.mode === 'shot' && shot?.type !== 'video';
    hud.textContent = flying ? `fov ${cam.fov.toFixed(0)}°  speed ${app.controls.speed.toFixed(1)} m/s` : app.mode === 'trailer' ? 'trailer preview' : 'video clip';
    if (app.mode === 'trailer') {
      const total = app.trailerSeconds;
      scrub.value = String(total > 0 ? app.trailerTime / total : 0);
      time.textContent = `${app.trailerTime.toFixed(2)} / ${total.toFixed(2)} s`;
    } else {
      scrub.value = String(app.playTau);
      time.textContent = shot ? `${(app.playTau * shot.duration).toFixed(2)} / ${shot.duration.toFixed(2)} s` : '';
    }
    timelineView.updatePlayhead();
  }

  function refresh() {
    renderLeftPanel(app, left);
    renderRightPanel(app, right);
    timelineView.render();
    if (document.activeElement !== nameInput) nameInput.value = app.project.name;

    const shot = app.activeShot;
    empty.hidden = app.project.scenes.length > 0 || app.project.videos.length > 0;
    safe.style.display = app.showSafe ? '' : 'none';
    safeToggle.classList.toggle('active', app.showSafe);
    shotView.classList.toggle('active', app.mode === 'shot');
    trailerView.classList.toggle('active', app.mode === 'trailer');
    playBtn.textContent = app.playing ? '❚❚ Pause' : '▶ Play';
    const canPlay = app.mode === 'trailer' ? app.timeline.entries.length > 0 : !!shot && (shot.type === 'video' || shot.keyframes.length > 0);
    playBtn.disabled = !canPlay;
    scrub.disabled = !canPlay;
    speed.value = String(Math.log2(app.controls.speed));

    const missing = app.missingFiles;
    status.textContent = app.busy ?? (missing.length ? `Missing media: drop ${missing.join(', ')}` : 'WASD move · drag look · K keyframe · Space play · T trailer view');
    status.style.color = missing.length && !app.busy ? 'var(--warn)' : '';

    pickHint.textContent =
      app.pickMode === 'floor3'
        ? `Click 3 spots on the floor, spread apart (${app.pickPoints.length}/3) · Esc cancels`
        : app.pickMode === 'floor1'
          ? 'Click the floor · Esc cancels'
          : app.pickMode === 'dolly'
            ? 'Click the subject that should keep its size · Esc cancels'
            : '';
    refreshHud();
  }

  empty.append(
    h(
      'div',
      { class: 'drop' },
      h('h1', null, 'Drop your scans and clips here'),
      h('p', null, 'Gaussian splat scans from Scaniverse (.spz or .ply), video clips (.mp4, .mov) and your music (.mp3, .m4a, .wav). Everything stays on this computer; nothing is uploaded.'),
      h(
        'div',
        { class: 'btns' },
        button('Choose files…', () => filePick.click(), { class: 'btn primary' }),
        button('Try the demo room', () => app.addSplatFromUrl('./samples/demo-room.ply', 'demo-room.ply'), { title: 'A small tilted test room with floating junk, to practise fix-up' }),
        button('Public sample (18 MB)', () => app.addSplatFromUrl(PUBLIC_SAMPLE_URL, 'hornedlizard.spz'), { title: 'Downloads a real phone scan from the open-source SPZ repository' }),
      ),
    ),
  );

  app.onChange(refresh);
  app.onTime(refreshHud);
  refresh();

  // ---- files: drag and drop anywhere, or the file picker ----
  const veil = $('dropveil');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    veil.classList.add('show');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) veil.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil.classList.remove('show');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void app.addFiles(files);
  });
  filePick.addEventListener('change', () => {
    const files = [...(filePick.files ?? [])];
    filePick.value = '';
    if (files.length) void app.addFiles(files);
  });

  // A button clicked with the mouse must not keep keyboard focus, or the next
  // Space (play/pause) would press it again. Keyboard users keep normal focus.
  document.addEventListener('click', (e) => {
    if (e.detail > 0) (e.target as HTMLElement).closest?.('button')?.blur();
  });

  // an accidental tab close must not lose keyframes: write the autosave now
  window.addEventListener('pagehide', () => app.saveNow());

  if (typeof VideoEncoder === 'undefined') {
    toast('This browser has no WebCodecs video encoder, so export will not work. Use Chrome.', 'error');
  }
}

boot();
