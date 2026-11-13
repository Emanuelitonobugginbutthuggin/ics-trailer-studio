import type { App } from '../app';
import { shotFrameCount } from '../export/exportShot';
import type { Easing } from '../project/schema';
import { PRESETS } from '../shots/presets';
import { button, checkRow, h, numberRow, section, sliderRow } from './dom';
import { openExportDialog } from './exportDialog';

/** Shots list, shot settings, presets, keyframes and export. */
export function renderRightPanel(app: App, root: HTMLElement) {
  const scroll = root.scrollTop;
  root.replaceChildren(shotsSection(app), ...shotSections(app));
  root.scrollTop = scroll;
}

function shotsSection(app: App) {
  const items = app.project.shots.map((shot) => {
    const scene = app.project.scenes.find((s) => s.id === shot.sceneId);
    return h(
      'li',
      { class: shot.id === app.activeShotId ? 'active' : '', onClick: () => app.selectShot(shot.id) },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'title' }, shot.name),
        h('div', { class: 'sub' }, `${shot.duration.toFixed(1)} s · ${shot.keyframes.length} keyframes · ${scene?.name ?? '?'}`),
      ),
      button('⧉', () => app.duplicateShot(shot.id), { class: 'btn small icon', title: 'Duplicate shot' }),
      button('✕', () => app.deleteShot(shot.id), { class: 'btn small icon', title: 'Delete shot' }),
    );
  });
  const canAdd = !!app.activeScene && app.isLoaded(app.activeSceneId!);
  return section(
    'Shots',
    items.length ? h('ul', { class: 'list' }, items) : h('p', { class: 'hint' }, 'A shot is one camera move through a scan.'),
    h('div', { class: 'btns' }, button('+ New shot', () => app.addShot(), { disabled: !canAdd })),
  );
}

function shotSections(app: App) {
  const shot = app.activeShot;
  if (!shot) return [];
  const sceneLoaded = app.isLoaded(shot.sceneId);
  const frames = h('span', { class: 'unit' }, `s = ${shotFrameCount(shot)} frames`);

  const nameInput = h('input', {
    type: 'text',
    value: shot.name,
    'aria-label': 'Shot name',
    onInput: () => {
      shot.name = nameInput.value;
      app.touch();
    },
    onChange: () => app.changed(),
  });
  const easing = h(
    'select',
    {
      'aria-label': 'Easing',
      onChange: () => {
        shot.easing = easing.value as Easing;
        app.shotEdited();
      },
    },
    ([
      ['linear', 'Constant speed'],
      ['easeIn', 'Ease in (start slow)'],
      ['easeOut', 'Ease out (end slow)'],
      ['easeInOut', 'Ease in and out'],
    ] as const).map(([value, label]) => h('option', { value, selected: shot.easing === value }, label)),
  );

  const durationRow = numberRow('Duration', { min: 0.2, max: 20, step: 0.1, value: shot.duration }, (v) => {
    shot.duration = v;
    frames.textContent = `s = ${shotFrameCount(shot)} frames`;
    app.shotEdited();
    app.changed();
  });
  durationRow.append(frames);

  const settings = section(
    'Shot settings',
    h('label', { class: 'row' }, h('span', null, 'Name'), nameInput),
    durationRow,
    h('label', { class: 'row' }, h('span', null, 'Easing'), easing),
    checkRow('Speed ramp: slow > fast > slow', shot.ramp.enabled, (v) => {
      shot.ramp.enabled = v;
      app.shotEdited();
      app.changed();
    }),
    shot.ramp.enabled
      ? [
          sliderRow('Punch', { min: 1, max: 12, step: 0.5, value: shot.ramp.strength, format: (v) => `${v}×`, title: 'How much faster the middle is than the ends' }, (v) => {
            shot.ramp.strength = v;
            app.shotEdited();
          }),
          sliderRow('Fast part at', { min: 0.1, max: 0.9, step: 0.05, value: shot.ramp.center, format: (v) => `${Math.round(v * 100)}%` }, (v) => {
            shot.ramp.center = v;
            app.shotEdited();
          }),
          sliderRow('Fast part width', { min: 0.1, max: 1.5, step: 0.05, value: shot.ramp.width, format: (v) => `${Math.round(v * 100)}%` }, (v) => {
            shot.ramp.width = v;
            app.shotEdited();
          }),
        ]
      : null,
    checkRow('Dolly zoom (subject stays the same size)', shot.dolly.enabled, (v) => {
      shot.dolly.enabled = v;
      if (v && !shot.dolly.target) app.setPickMode('dolly');
      app.shotEdited();
      app.changed();
    }),
    shot.dolly.enabled
      ? h(
          'div',
          { class: 'btns' },
          button(app.pickMode === 'dolly' ? 'Click the subject…' : shot.dolly.target ? 'Change subject' : 'Click the subject', () => {
            app.setPickMode(app.pickMode === 'dolly' ? null : 'dolly');
            app.changed();
          }, { class: app.pickMode === 'dolly' ? 'btn active' : 'btn' }),
          h('span', { class: 'hint' }, shot.dolly.target ? 'Zoom follows the camera distance.' : 'No subject yet.'),
        )
      : null,
  );

  const presets = section(
    'One-click moves',
    h('p', { class: 'hint' }, 'Frame your subject first. The move is built from where you are looking.'),
    h('div', { class: 'btns grid2' }, PRESETS.map((p) => button(p.label, () => app.applyPreset(p.id), { title: p.hint, disabled: !sceneLoaded }))),
  );

  const kfItems = shot.keyframes.map((k, i) =>
    h(
      'li',
      { class: 'kf' },
      h('span', { class: 'num' }, i + 1),
      h('span', { class: 'grow sub' }, `fov ${k.fov.toFixed(0)}°`),
      button('Go', () => app.gotoKeyframe(i), { class: 'btn small', title: 'Move the camera to this keyframe' }),
      button('Set', () => app.updateKeyframe(i), { class: 'btn small', title: 'Replace this keyframe with the current view' }),
      button('↑', () => app.moveKeyframe(i, -1), { class: 'btn small icon', title: 'Earlier', disabled: i === 0 }),
      button('↓', () => app.moveKeyframe(i, 1), { class: 'btn small icon', title: 'Later', disabled: i === shot.keyframes.length - 1 }),
      button('✕', () => app.deleteKeyframe(i), { class: 'btn small icon', title: 'Delete keyframe' }),
    ),
  );
  const keyframes = section(
    'Keyframes',
    kfItems.length
      ? h('ul', { class: 'list' }, kfItems)
      : h('p', { class: 'hint' }, 'Fly to a view and press K. Two or more keyframes make a move; one makes a locked-off shot.'),
    h('div', { class: 'btns' }, button('+ Add keyframe here (K)', () => app.addKeyframe(), { disabled: !sceneLoaded })),
  );

  const canExport = sceneLoaded && shot.keyframes.length > 0;
  const exportSection = section(
    'Export',
    h('p', { class: 'hint' }, `1080 × 1920, 30 fps, H.264 MP4. Rendered frame by frame, so it is smooth even if the preview stutters.`),
    !sceneLoaded ? h('p', { class: 'hint warn' }, 'Drop the scan for this shot in first.') : null,
    button('Export this shot', () => openExportDialog(app), { class: 'btn primary wide', disabled: !canExport }),
  );

  return [settings, presets, keyframes, exportSection];
}
