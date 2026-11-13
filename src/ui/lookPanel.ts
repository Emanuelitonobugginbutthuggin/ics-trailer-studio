import type { App } from '../app';
import { LOOK_PRESETS, blurSamples } from '../look/look';
import { button, checkRow, h, section, sliderRow } from './dom';

type GradeKey = 'exposure' | 'contrast' | 'saturation' | 'warmth' | 'splitTone' | 'fade' | 'vignette' | 'grain';

/** The Look tab: one look for the whole trailer. */
export function lookSections(app: App) {
  const look = app.project.look;
  const slider = (label: string, key: GradeKey, min: number, max: number, step: number, format: (v: number) => string, title?: string) =>
    sliderRow(label, { min, max, step, value: look[key], format, title }, (v) => {
      look[key] = v;
      app.touch(); // the live preview picks it up on the next frame
    });
  const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
  const percent = (v: number) => `${Math.round(v * 100)}%`;

  const master = section(
    'Look of the whole trailer',
    h('p', { class: 'hint' }, 'Applies to every shot, in the preview and in every export.'),
    checkRow('Use the look', look.enabled, (v) => {
      look.enabled = v;
      app.changed();
    }, 'Untick to see and export the untouched picture'),
    h('div', { class: 'presets' }, LOOK_PRESETS.map((p) => button(p.label, () => app.applyLookPreset(p.id), { class: 'btn small', title: p.hint }))),
  );
  if (!look.enabled) return [master];

  const grade = section(
    'Grade',
    slider('Exposure', 'exposure', -1, 1, 0.01, signed, 'Brighter or darker, in stops'),
    slider('Contrast', 'contrast', 0.7, 1.8, 0.01, (v) => `${v.toFixed(2)}×`),
    slider('Saturation', 'saturation', 0, 2, 0.01, (v) => `${v.toFixed(2)}×`),
    slider('Warmth', 'warmth', -1, 1, 0.01, signed, 'Cooler (blue) or warmer (orange)'),
    slider('Teal & orange', 'splitTone', 0, 1, 0.01, percent, 'Teal shadows and orange highlights, the blockbuster look'),
    slider('Faded blacks', 'fade', 0, 0.3, 0.005, percent, 'Lifts the darkest tones for a soft, milky look'),
  );

  const finish = section(
    'Vignette and grain',
    slider('Vignette', 'vignette', 0, 1, 0.01, percent, 'Darker corners pull the eye to the middle'),
    slider('Grain', 'grain', 0, 1, 0.01, percent, 'Film grain. A little hides the too-clean 3D look; a lot costs sharpness once TikTok compresses the video'),
  );

  const mb = look.motionBlur;
  const cost = h('p', { class: 'hint' });
  const refreshCost = () => {
    const n = blurSamples(look);
    cost.textContent = n > 1 ? `Camera shots are rendered ${n} times per frame, so they take about ${n}× longer to export. Video clips keep their own blur.` : '';
  };
  refreshCost();
  const blur = section(
    'Motion blur',
    h('p', { class: 'hint' }, 'Fast camera moves get real blur: each frame is the average of several moments while the shutter is open. Export only; the live preview stays sharp.'),
    checkRow('Motion blur on camera shots', mb.enabled, (v) => {
      mb.enabled = v;
      app.changed();
    }),
    mb.enabled
      ? [
          sliderRow('Samples', { min: 2, max: 32, step: 1, value: mb.samples, format: (v) => String(v), title: 'More samples make smoother blur and slower exports. 8 suits most shots; raise it if fast moves show stepping.' }, (v) => {
            mb.samples = v;
            app.touch();
            refreshCost();
          }),
          sliderRow('Shutter', { min: 0.1, max: 1, step: 0.05, value: mb.shutter, format: (v) => `${Math.round(v * 360)}°`, title: 'How long the shutter stays open. 180° is the film standard; 360° is very smeary.' }, (v) => {
            mb.shutter = v;
            app.touch();
          }),
          cost,
        ]
      : null,
  );

  const test = section(
    'Check before exporting',
    h('p', { class: 'hint' }, 'Renders the frame under the playhead exactly as the export will, including motion blur, and shows it until you move.'),
    button(app.rendering ? 'Rendering…' : 'Render test frame', () => void app.renderTestFrame(), { class: 'btn primary wide', disabled: app.rendering }),
  );

  return [master, grade, finish, blur, test];
}
