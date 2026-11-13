import { App } from './app';
import { button, h, toast } from './ui/dom';
import { renderLeftPanel } from './ui/leftPanel';
import { renderRightPanel } from './ui/rightPanel';
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
    button('Open…', () => filePick.click(), { title: 'Open a project .json, or add scans' }),
    button('Save project', () => app.saveProjectFile(), { title: 'Download the project as a .json file' }),
    h('span', { class: 'spacer' }),
    status,
  );

  // ---- transport ----
  const playBtn = button('▶ Play', () => app.togglePlay(), { title: 'Preview the shot (Space)' });
  const scrub = h('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.001',
    value: '0',
    'aria-label': 'Scrub through the shot',
    onInput: () => {
      app.stop();
      app.scrub(Number(scrub.value));
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
  $('transport').append(playBtn, scrub, time, h('label', { class: 'speed' }, 'Fly speed', speed), safeToggle);

  // ---- rendering of UI state ----
  function refreshHud() {
    const cam = app.viewer.camera;
    hud.textContent = `fov ${cam.fov.toFixed(0)}°  speed ${app.controls.speed.toFixed(1)} m/s`;
    const shot = app.activeShot;
    scrub.value = String(app.playTau);
    time.textContent = shot ? `${(app.playTau * shot.duration).toFixed(2)} / ${shot.duration.toFixed(2)} s` : '';
  }

  function refresh() {
    renderLeftPanel(app, left);
    renderRightPanel(app, right);
    if (document.activeElement !== nameInput) nameInput.value = app.project.name;

    const hasScenes = app.project.scenes.length > 0;
    empty.hidden = hasScenes;
    safe.style.display = app.showSafe ? '' : 'none';
    safeToggle.classList.toggle('active', app.showSafe);
    playBtn.textContent = app.playing ? '❚❚ Pause' : '▶ Play';
    playBtn.disabled = !app.activeShot || app.activeShot.keyframes.length === 0;
    scrub.disabled = playBtn.disabled;
    speed.value = String(Math.log2(app.controls.speed));

    const missing = app.missingScenes;
    status.textContent = app.busy ?? (missing.length ? `Missing media: drop ${missing.map((s) => s.fileName).join(', ')}` : 'WASD move · drag look · Q/E down/up · K keyframe · Space play');
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
      h('h1', null, 'Drop your scans here'),
      h('p', null, 'Gaussian splat files from Scaniverse: .spz or .ply (also .splat). Everything stays on this computer; nothing is uploaded.'),
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
