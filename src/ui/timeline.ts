import type { App } from '../app';
import { PEAKS_PER_SECOND } from '../media/music';
import { FPS } from '../project/schema';
import { gridStep } from '../timeline/timeline';
import { button, checkRow, h } from './dom';
import { openExportDialog } from './exportDialog';

const TARGET_MIN = 15;
const TARGET_MAX = 25;
const RULER = 16;
const BLOCKS = 46;
const WAVE = 30;
const HEIGHT = RULER + BLOCKS + WAVE;

/** Trailer timeline: beat settings, music, and the strip of shots. */
export class TimelineView {
  private controls = h('div', { class: 'tl-controls' });
  private scroller = h('div', { class: 'tl-scroll' });
  private track = h('div', { class: 'tl-track' });
  private canvas = h('canvas', { class: 'tl-canvas' });
  private blocks = h('div', { class: 'tl-blocks' });
  private playhead = h('div', { class: 'tl-playhead' });
  /** zoom factor on top of "fit everything" */
  private zoom = 1;
  private pps = 40;

  constructor(
    private app: App,
    root: HTMLElement,
  ) {
    this.track.append(this.canvas, this.blocks, this.playhead);
    this.scroller.append(this.track);
    root.append(this.controls, this.scroller);
    new ResizeObserver(() => this.renderStrip()).observe(this.scroller);

    // click or drag on the ruler or the waveform: jump there in trailer view
    let scrubbing = false;
    const scrubTo = (e: PointerEvent) => {
      const x = e.clientX - this.track.getBoundingClientRect().left;
      this.app.setMode('trailer');
      this.app.scrubTrailer(x / this.pps);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      this.canvas.setPointerCapture(e.pointerId);
      scrubTo(e);
    });
    this.canvas.addEventListener('pointermove', (e) => scrubbing && scrubTo(e));
    this.canvas.addEventListener('pointerup', () => (scrubbing = false));
    this.canvas.addEventListener('pointercancel', () => (scrubbing = false));
  }

  render() {
    this.renderControls();
    this.renderStrip();
  }

  private renderControls() {
    const app = this.app;
    const t = app.project.timeline;
    const total = app.trailerSeconds;
    const inRange = total >= TARGET_MIN && total <= TARGET_MAX;

    const bpm = h('input', {
      type: 'number',
      min: '40',
      max: '240',
      step: '0.1',
      value: String(t.bpm),
      'aria-label': 'Beats per minute',
      onChange: () => {
        t.bpm = Math.min(240, Math.max(40, Number(bpm.value) || 120));
        app.updateBeatOffset();
        app.changed();
      },
    });
    const division = h(
      'select',
      {
        'aria-label': 'Snap cuts to',
        onChange: () => {
          t.division = Number(division.value);
          app.changed();
        },
      },
      ([
        [0.5, 'every half beat'],
        [1, 'every beat'],
        [2, 'every 2 beats'],
        [4, 'every 4 beats'],
      ] as const).map(([value, label]) => h('option', { value: String(value), selected: t.division === value }, label)),
    );

    let music;
    if (t.audio) {
      const start = h('input', {
        type: 'number',
        min: '0',
        step: '0.01',
        value: String(t.audio.start),
        'aria-label': 'Song time at trailer start, seconds',
        title: 'Where in the song the trailer starts',
        onChange: () => {
          t.audio!.start = Math.max(0, Number(start.value) || 0);
          app.updateBeatOffset();
          app.changed();
        },
      });
      music = [
        h('span', { class: app.music ? 'tl-file' : 'tl-file missing', title: t.audio.fileName }, app.music ? `♪ ${t.audio.fileName}` : `Missing: drop ${t.audio.fileName}`),
        h('label', { class: 'tl-field' }, 'from', start, 's'),
        button('Find beat', () => void app.detectBeat(), { class: 'btn small', disabled: !app.music, title: 'Detect the tempo and first beat again' }),
        button('✕', () => app.removeMusic(), { class: 'btn small icon', title: 'Remove the music' }),
      ];
    } else {
      music = button('Load music…', () => document.getElementById('filepick')!.click(), { class: 'btn small', title: 'An .mp3, .m4a or .wav of your sound. Used to find the beat and to preview; exports stay silent.' });
    }

    const zoom = h('input', {
      type: 'range',
      min: '1',
      max: '8',
      step: '0.1',
      value: String(this.zoom),
      'aria-label': 'Timeline zoom',
      onInput: () => {
        this.zoom = Number(zoom.value);
        this.renderStrip();
      },
    });

    this.controls.replaceChildren(
      h('label', { class: 'tl-field' }, 'BPM', bpm),
      button('Tap', () => app.tapTempo(), { class: 'btn small', title: 'Tap along with the music a few times' }),
      h('label', { class: 'tl-field' }, 'Cuts snap', division),
      checkRow('Snap', t.snap, (v) => {
        t.snap = v;
        app.changed();
      }, 'When on, changing a shot length lands its end on the beat grid'),
      button('Snap all cuts', () => app.snapAllCuts(), { class: 'btn small', disabled: !app.timeline.entries.length, title: 'Move every cut to the nearest beat line' }),
      h('span', { class: 'tl-sep' }),
      ...[music].flat(),
      h('span', { class: 'spacer' }),
      h('span', { class: `tl-length ${inRange ? 'ok' : ''}`, title: 'Target length for the trailer' }, `${total.toFixed(2)} s · target ${TARGET_MIN} to ${TARGET_MAX} s${inRange ? ' ✓' : ''}`),
      h('label', { class: 'tl-field' }, 'Zoom', zoom),
      button('Export trailer', () => openExportDialog(app, 'trailer'), { class: 'btn primary', disabled: !app.timeline.entries.length }),
    );
  }

  private renderStrip() {
    const app = this.app;
    const timeline = app.timeline;
    const t = app.project.timeline;
    const total = app.trailerSeconds;
    const visible = Math.max(200, this.scroller.clientWidth - 2);
    // "fit" shows the whole trailer, or at least 20 seconds
    const span = Math.max(20, total + 1);
    this.pps = Math.min(600, (visible / span) * this.zoom);
    const width = Math.min(15000, Math.max(visible, Math.ceil((total + 2) * this.pps)));
    this.track.style.width = `${width}px`;
    this.track.style.height = `${HEIGHT}px`;

    // ---- background: target zone, beat lines, ruler, waveform ----
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(HEIGHT * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${HEIGHT}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.fillStyle = 'rgba(82, 214, 138, 0.10)';
    ctx.fillRect(TARGET_MIN * this.pps, 0, (TARGET_MAX - TARGET_MIN) * this.pps, RULER);

    const beat = 60 / Math.max(20, t.bpm);
    const step = gridStep(t);
    const seconds = width / this.pps;
    if (beat * this.pps >= 3) {
      const first = ((t.beatOffset % beat) + beat) % beat;
      for (let i = 0, time = first; time < seconds; i++, time = first + i * beat) {
        const onGrid = Math.abs(time / step - Math.round((time - (t.beatOffset % step)) / step) - (t.beatOffset % step) / step) < 1e-3;
        ctx.fillStyle = i % 4 === 0 ? 'rgba(255,255,255,0.30)' : onGrid ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
        ctx.fillRect(Math.round(time * this.pps), RULER, 1, HEIGHT - RULER);
      }
    }
    ctx.fillStyle = '#98a0b0';
    ctx.font = '10px system-ui, sans-serif';
    const labelEvery = this.pps >= 60 ? 1 : this.pps >= 25 ? 2 : 5;
    for (let s = 0; s < seconds; s++) {
      ctx.fillRect(Math.round(s * this.pps), RULER - (s % labelEvery === 0 ? 6 : 3), 1, s % labelEvery === 0 ? 6 : 3);
      if (s % labelEvery === 0) ctx.fillText(`${s}s`, s * this.pps + 3, 9);
    }
    if (app.music && t.audio) {
      const { peaks } = app.music;
      const mid = RULER + BLOCKS + WAVE / 2;
      ctx.fillStyle = 'rgba(76, 201, 240, 0.55)';
      for (let x = 0; x < width; x++) {
        const from = Math.floor((t.audio.start + x / this.pps) * PEAKS_PER_SECOND);
        const to = Math.max(from + 1, Math.floor((t.audio.start + (x + 1) / this.pps) * PEAKS_PER_SECOND));
        if (from >= peaks.length) break;
        let peak = 0;
        for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
        const hgt = Math.max(1, peak * (WAVE - 2));
        ctx.fillRect(x, mid - hgt / 2, 1, hgt);
      }
    }

    // ---- shots ----
    const marks: Record<string, string> = { flash: '⚡', whipLeft: '«', whipRight: '»' };
    this.blocks.replaceChildren(
      ...timeline.entries.map((entry, index) => {
        const { shot } = entry;
        const left = (entry.startFrame / FPS) * this.pps;
        const w = ((entry.endFrame - entry.startFrame) / FPS) * this.pps;
        const handle = h('span', { class: 'tl-handle', title: 'Drag to change the length' });
        const block = h(
          'div',
          {
            class: `tl-block ${shot.type} ${shot.id === app.activeShotId ? 'active' : ''} ${app.shotReady(shot) ? '' : 'missing'} ${index > 0 && shot.transition !== 'cut' ? 'marked' : ''}`,
            style: `left:${left}px;width:${Math.max(3, w - 1)}px;top:${RULER + 2}px;height:${BLOCKS - 4}px`,
            title: `${shot.name} · ${shot.duration.toFixed(2)} s`,
            onClick: () => app.selectShot(shot.id),
          },
          index > 0 && shot.transition !== 'cut' ? h('span', { class: 'tl-mark' }, marks[shot.transition]) : null,
          h('span', { class: 'tl-name' }, shot.name),
          h('span', { class: 'tl-dur' }, `${shot.duration.toFixed(2)} s`),
          handle,
        );
        this.attachResize(handle, shot.id, left);
        return block;
      }),
    );
    this.updatePlayhead();
  }

  private attachResize(handle: HTMLElement, shotId: string, blockLeft: number) {
    let dragging = false;
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      this.app.stop();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const shot = this.app.project.shots.find((s) => s.id === shotId);
      if (!shot) return;
      const x = e.clientX - this.track.getBoundingClientRect().left;
      this.app.setShotDuration(shot, (x - blockLeft) / this.pps);
      // live feedback without rebuilding the panels (that would drop the drag)
      const el = handle.parentElement!;
      el.style.width = `${Math.max(3, shot.duration * this.pps - 1)}px`;
      el.querySelector('.tl-dur')!.textContent = `${shot.duration.toFixed(2)} s`;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      this.app.changed();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** Called on every playback tick: only moves the playhead. */
  updatePlayhead() {
    const app = this.app;
    let time: number | null = null;
    if (app.mode === 'trailer') time = app.trailerTime;
    else {
      const entry = app.timeline.entries.find((e) => e.shot.id === app.activeShotId);
      if (entry) time = (entry.startFrame + app.playTau * (entry.endFrame - entry.startFrame)) / FPS;
    }
    this.playhead.style.display = time === null ? 'none' : '';
    if (time === null) return;
    const x = time * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    // keep the playhead in view while the trailer plays
    if (app.playing && app.mode === 'trailer') {
      const { scrollLeft, clientWidth } = this.scroller;
      if (x < scrollLeft || x > scrollLeft + clientWidth - 40) this.scroller.scrollLeft = Math.max(0, x - 60);
    }
  }
}
