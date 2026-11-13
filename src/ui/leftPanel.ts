import type { App } from '../app';
import { button, checkRow, formatBytes, h, numberRow, section, sliderRow } from './dom';

/** Scenes list and the scan fix-up tools (up, floor, crop). */
export function renderLeftPanel(app: App, root: HTMLElement) {
  const scroll = root.scrollTop;
  root.replaceChildren(scenesSection(app), ...fixupSections(app));
  root.scrollTop = scroll;
}

function scenesSection(app: App) {
  const items = app.project.scenes.map((scene) => {
    const loaded = app.loaded.get(scene.id);
    const sub = loaded
      ? `${loaded.numSplats.toLocaleString()} splats · ${formatBytes(scene.fileSize)}`
      : `Missing: drop ${scene.fileName} here`;
    return h(
      'li',
      {
        class: `${scene.id === app.activeSceneId ? 'active' : ''} ${loaded ? '' : 'missing'}`,
        onClick: () => app.selectScene(scene.id),
      },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, scene.name), h('div', { class: 'sub' }, sub)),
      button('✕', () => app.removeScene(scene.id), { class: 'btn small icon', title: 'Remove from project' }),
    );
  });
  return section(
    'Scenes',
    items.length ? h('ul', { class: 'list' }, items) : h('p', { class: 'hint' }, 'No scans yet. Drop .spz or .ply files anywhere.'),
    app.busy ? h('p', { class: 'hint' }, app.busy) : null,
    h(
      'div',
      { class: 'btns' },
      button('Add files…', () => document.getElementById('filepick')!.click()),
      button('Frame scan', () => app.frameScene(), { disabled: !app.activeScene || !app.isLoaded(app.activeSceneId!), title: 'Move the camera so the whole scan is in view' }),
    ),
  );
}

function nudgeRow(app: App, label: string, axis: 'x' | 'y' | 'z', steps: number[]) {
  return h(
    'div',
    { class: 'nudge' },
    h('span', null, label),
    steps.map((deg) => button(`${deg > 0 ? '+' : ''}${deg}°`, () => app.rotateScene(axis, deg), { class: 'btn small' })),
  );
}

function fixupSections(app: App) {
  const scene = app.activeScene;
  if (!scene || !app.isLoaded(scene.id)) return [];
  const { fixup } = scene;
  const crop = fixup.crop;

  const up = section(
    '1 · Which way is up',
    h('p', { class: 'hint' }, 'Easiest: click three spots on the floor and the scan levels itself.'),
    h(
      'div',
      { class: 'btns' },
      button(app.pickMode === 'floor3' ? `Click floor (${app.pickPoints.length}/3)…` : 'Level from 3 floor clicks', () => {
        app.setPickMode(app.pickMode === 'floor3' ? null : 'floor3');
        app.changed();
      }, { class: app.pickMode === 'floor3' ? 'btn active' : 'btn primary' }),
      button('Flip upside down', () => app.rotateScene('x', 180)),
    ),
    nudgeRow(app, 'Tilt forward / back', 'x', [-5, -1, 1, 5]),
    nudgeRow(app, 'Tilt left / right', 'z', [-5, -1, 1, 5]),
    nudgeRow(app, 'Turn', 'y', [-15, -1, 1, 15]),
    h('div', { class: 'btns' }, button('Quarter turn X', () => app.rotateScene('x', 90), { class: 'btn small' }), button('Quarter turn Z', () => app.rotateScene('z', 90), { class: 'btn small' }), button('Reset', () => app.resetFixup(), { class: 'btn small' })),
    checkRow('Show floor grid (1 m squares) and crop box', app.showGrid, (v) => {
      app.showGrid = v;
      app.syncHelpers();
    }),
  );

  const floor = section(
    '2 · Floor level',
    numberRow('Floor height', { step: 0.01, value: Math.round(fixup.floorY * 1000) / 1000, unit: 'm', title: 'Height of the floor in the raw scan. The scan is shifted so the floor sits on the grid.' }, (v) => app.setFloor(v)),
    h(
      'div',
      { class: 'btns' },
      button(app.pickMode === 'floor1' ? 'Click the floor…' : 'Click the floor', () => {
        app.setPickMode(app.pickMode === 'floor1' ? null : 'floor1');
        app.changed();
      }, { class: app.pickMode === 'floor1' ? 'btn active' : 'btn' }),
      button('Auto', () => app.autoFloor(), { title: 'Use the lowest dense layer of splats' }),
    ),
  );

  // slider ranges: the whole scan plus some margin
  const extent = app.sceneBounds(scene.id, 0.001, crop.yaw) ?? { min: crop.min, max: crop.max };
  const axes = ['X', 'Y', 'Z'] as const;
  const fmt = (v: number) => v.toFixed(2);
  const sliders = axes.flatMap((name, i) => {
    const size = Math.max(0.5, extent.max[i] - extent.min[i]);
    const lo = Math.min(extent.min[i] - size * 0.15, crop.min[i]);
    const hi = Math.max(extent.max[i] + size * 0.15, crop.max[i]);
    const step = Math.max(0.005, Math.round((size / 400) * 1000) / 1000);
    return [
      sliderRow(`${name} min`, { min: lo, max: hi, step, value: crop.min[i], format: fmt }, (v) => {
        crop.min[i] = Math.min(v, crop.max[i] - step);
        app.updateCrop();
      }),
      sliderRow(`${name} max`, { min: lo, max: hi, step, value: crop.max[i], format: fmt }, (v) => {
        crop.max[i] = Math.max(v, crop.min[i] + step);
        app.updateCrop();
      }),
    ];
  });

  const cropSection = section(
    '3 · Crop box',
    h('p', { class: 'hint' }, 'Hides everything outside the box, such as floating junk. Y is height.'),
    checkRow('Crop to box', crop.enabled, (v) => {
      crop.enabled = v;
      if (v) app.showGrid = true;
      app.updateCrop();
      app.changed();
    }),
    h('div', { class: 'btns' }, button('Fit box to scan', () => app.fitCrop(), { title: 'Wraps the box around 98% of the splats' })),
    crop.enabled ? sliders : null,
    crop.enabled
      ? sliderRow('Turn box', { min: -90, max: 90, step: 1, value: crop.yaw, format: (v) => `${v}°` }, (v) => {
          crop.yaw = v;
          app.updateCrop();
        }, () => app.changed())
      : null,
  );

  return [up, floor, cropSection];
}
