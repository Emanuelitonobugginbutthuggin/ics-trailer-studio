import type { App } from '../app';
import { shotFrameCount } from '../export/exportSequence';
import type { Easing, Shot, SplatShot, Transition, VideoShot } from '../project/schema';
import { PRESETS } from '../shots/presets';
import { button, checkRow, h, numberRow, section, sliderRow } from './dom';
import { openExportDialog } from './exportDialog';

/** Shots list, shot settings, presets, keyframes and export. */
export function renderRightPanel(app: App, root: HTMLElement) {
  const scroll = root.scrollTop;
  root.replaceChildren(shotsSection(app), ...shotSections(app));
  root.scrollTop = scroll;
}

function shotSource(app: App, shot: Shot): string {
  if (shot.type === 'splat') return app.project.scenes.find((s) => s.id === shot.sceneId)?.name ?? '?';
  return app.project.videos.find((v) => v.id === shot.videoId)?.name ?? '?';
}

function shotsSection(app: App) {
  const shots = app.project.shots;
  const items = shots.map((shot, i) => {
    const detail = shot.type === 'splat' ? `${shot.keyframes.length} keyframes` : 'clip';
    return h(
      'li',
      { class: `${shot.id === app.activeShotId ? 'active' : ''} ${app.shotReady(shot) ? '' : 'missing'} ${shot.inTrailer ? '' : 'off'}`, onClick: () => app.selectShot(shot.id) },
      h('span', { class: 'num' }, shot.inTrailer ? i + 1 : '–'),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'title' }, shot.name),
        h('div', { class: 'sub' }, `${shot.duration.toFixed(2)} s · ${detail} · ${shotSource(app, shot)}`),
      ),
      button('↑', () => app.moveShot(shot.id, -1), { class: 'btn small icon', title: 'Earlier in the trailer', disabled: i === 0 }),
      button('↓', () => app.moveShot(shot.id, 1), { class: 'btn small icon', title: 'Later in the trailer', disabled: i === shots.length - 1 }),
      button('⧉', () => app.duplicateShot(shot.id), { class: 'btn small icon', title: 'Duplicate shot' }),
      button('✕', () => app.deleteShot(shot.id), { class: 'btn small icon', title: 'Delete shot' }),
    );
  });
  const canAdd = !!app.activeScene && app.isLoaded(app.activeSceneId!);
  return section(
    'Shots (in trailer order)',
    items.length ? h('ul', { class: 'list' }, items) : h('p', { class: 'hint' }, 'A shot is one camera move through a scan, or a piece of a video clip.'),
    h('div', { class: 'btns' }, button('+ New camera shot', () => app.addShot(), { disabled: !canAdd, title: 'A new camera move through the selected scan' })),
  );
}

/** Name, duration, easing, speed ramp, transition: the same for every kind of shot. */
function commonSettings(app: App, shot: Shot, speedNote: HTMLElement | null) {
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
  const transition = h(
    'select',
    {
      'aria-label': 'Transition into this shot',
      onChange: () => {
        shot.transition = transition.value as Transition;
        app.changed();
      },
    },
    ([
      ['cut', 'Hard cut'],
      ['flash', 'Flash'],
      ['whipLeft', 'Whip left'],
      ['whipRight', 'Whip right'],
    ] as const).map(([value, label]) => h('option', { value, selected: shot.transition === value }, label)),
  );
  const durationRow = numberRow('Duration', { min: 0.2, max: 20, step: 0.05, value: Math.round(shot.duration * 100) / 100, title: 'With beat snapping on, the end of the shot jumps to the nearest beat' }, (v) => {
    app.setShotDuration(shot, v);
    app.shotEdited();
    app.changed();
  });
  durationRow.append(frames);

  return [
    h('label', { class: 'row' }, h('span', null, 'Name'), nameInput),
    durationRow,
    speedNote,
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
    h('label', { class: 'row', title: 'How the trailer cuts into this shot from the one before' }, h('span', null, 'Cut in with'), transition),
    checkRow('Use in the trailer', shot.inTrailer, (v) => {
      shot.inTrailer = v;
      app.changed();
    }),
  ];
}

function exportSection(app: App, shot: Shot) {
  const problem = app.shotProblem(shot);
  return section(
    'Export this shot',
    h('p', { class: 'hint' }, '1080 × 1920, 30 fps, H.264 MP4. Rendered frame by frame, so it is smooth even if the preview stutters.'),
    problem ? h('p', { class: 'hint warn' }, problem) : null,
    button('Export this shot', () => openExportDialog(app, 'shot'), { class: 'btn primary wide', disabled: !!problem }),
  );
}

function shotSections(app: App) {
  const shot = app.activeShot;
  if (!shot) return [];
  return shot.type === 'splat' ? splatShotSections(app, shot) : videoShotSections(app, shot);
}

function splatShotSections(app: App, shot: SplatShot) {
  const sceneLoaded = app.isLoaded(shot.sceneId);

  const settings = section(
    'Shot settings',
    commonSettings(app, shot, null),
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
    h('div', { class: 'btns' }, button('+ Add keyframe here (K)', () => app.addKeyframe(), { disabled: !sceneLoaded || app.mode !== 'shot' })),
  );

  return [settings, presets, keyframes, exportSection(app, shot)];
}

function videoShotSections(app: App, shot: VideoShot) {
  const video = app.project.videos.find((v) => v.id === shot.videoId);
  const clipLength = app.clips.get(shot.videoId)?.info.duration ?? video?.duration ?? shot.trimOut;
  const seconds = (v: number) => `${v.toFixed(2)} s`;
  const speedText = () => {
    const rate = app.videoShotRate(shot);
    const kind = rate > 1.02 ? 'fast motion' : rate < 0.98 ? 'slow motion' : 'real time';
    return `Plays ${(shot.trimOut - shot.trimIn).toFixed(2)} s of the clip at ${rate.toFixed(2)}× (${kind}).`;
  };
  const speedNote = h('p', { class: 'hint' }, speedText());
  const refreshSpeed = () => (speedNote.textContent = speedText());
  const step = 1 / 30;

  const trim = section(
    'Which part of the clip',
    sliderRow('Starts at', { min: 0, max: clipLength, step, value: shot.trimIn, format: seconds }, (v) => {
      shot.trimIn = Math.min(v, shot.trimOut - step);
      app.shotEdited();
      app.scrub(0);
      refreshSpeed();
    }, () => app.changed()),
    sliderRow('Ends at', { min: 0, max: clipLength, step, value: shot.trimOut, format: seconds }, (v) => {
      shot.trimOut = Math.max(v, shot.trimIn + step);
      app.shotEdited();
      app.scrub(1);
      refreshSpeed();
    }, () => app.changed()),
    h(
      'div',
      { class: 'btns' },
      button('Real-time length', () => {
        app.setShotDuration(shot, shot.trimOut - shot.trimIn);
        app.shotEdited();
        app.changed();
      }, { title: 'Set the shot duration so the clip plays at normal speed' }),
    ),
  );

  const f = shot.framing;
  const fit = h(
    'select',
    {
      'aria-label': 'Fit',
      onChange: () => {
        f.fit = fit.value as 'cover' | 'contain';
        app.shotEdited();
      },
    },
    h('option', { value: 'cover', selected: f.fit === 'cover' }, 'Fill the frame (crop)'),
    h('option', { value: 'contain', selected: f.fit === 'contain' }, 'Show the whole clip (black bars)'),
  );
  const framing = section(
    'Framing',
    h('label', { class: 'row' }, h('span', null, 'Fit'), fit),
    sliderRow('Zoom', { min: 1, max: 3, step: 0.01, value: f.zoom, format: (v) => `${v.toFixed(2)}×` }, (v) => {
      f.zoom = v;
      app.shotEdited();
    }),
    sliderRow('Left / right', { min: -1, max: 1, step: 0.01, value: f.panX, format: (v) => v.toFixed(2) }, (v) => {
      f.panX = v;
      app.shotEdited();
    }),
    sliderRow('Down / up', { min: -1, max: 1, step: 0.01, value: f.panY, format: (v) => v.toFixed(2) }, (v) => {
      f.panY = v;
      app.shotEdited();
    }),
  );

  const problems = app.clipProblems(shot.videoId);
  const settings = section('Shot settings', problems.map((p) => h('p', { class: 'hint warn' }, p)), commonSettings(app, shot, speedNote));
  return [settings, trim, framing, exportSection(app, shot)];
}
