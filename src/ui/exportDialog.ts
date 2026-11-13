import type { App } from '../app';
import type { ExportResult } from '../export/exportShot';
import { button, downloadBlob, formatBytes, h, toast } from './dom';

/** Runs the export of the active shot with progress, then shows the result. */
export async function openExportDialog(app: App) {
  const shot = app.activeShot;
  if (!shot) return;
  const modal = document.getElementById('modal')!;
  const abort = new AbortController();
  const bar = h('progress', { max: 1, value: 0 });
  const status = h('p', { class: 'hint' }, 'Preparing encoder…');
  const dialog = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Export' },
    h('h2', null, `Rendering "${shot.name}"`),
    bar,
    status,
    h('p', { class: 'hint' }, 'Keep this tab in front until it finishes. Every frame waits for the splats to sort, so this is slower than real time.'),
    h('div', { class: 'actions' }, button('Cancel', () => abort.abort())),
  );
  modal.replaceChildren(dialog);
  modal.hidden = false;

  let url: string | null = null;
  const close = () => {
    modal.hidden = true;
    modal.replaceChildren();
    if (url) URL.revokeObjectURL(url);
  };

  let result: ExportResult;
  try {
    result = await app.exportActiveShot((p) => {
      bar.value = p.frame / p.totalFrames;
      const perFrame = p.elapsed / p.frame;
      const left = Math.max(0, Math.round(perFrame * (p.totalFrames - p.frame)));
      status.textContent = `Frame ${p.frame} of ${p.totalFrames} · about ${left} s left`;
    }, abort.signal);
  } catch (error) {
    close();
    if ((error as Error).name === 'AbortError') toast('Export cancelled.');
    else {
      console.error(error);
      toast(`Export failed: ${(error as Error).message}`, 'error');
    }
    return;
  }

  url = URL.createObjectURL(result.blob);
  const fileName = `${shot.name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || 'shot'}.mp4`;
  dialog.replaceChildren(
    h('h2', null, 'Shot rendered'),
    h('video', { src: url, controls: true, loop: true, autoplay: true, muted: true, playsInline: true }),
    h(
      'dl',
      null,
      h('dt', null, 'Length'),
      h('dd', null, `${result.seconds.toFixed(2)} s (${result.frames} frames at 30 fps)`),
      h('dt', null, 'Size'),
      h('dd', null, `1080 × 1920 · ${formatBytes(result.blob.size)}`),
      h('dt', null, 'Codec'),
      h('dd', null, `H.264 (${result.codec})`),
    ),
    h(
      'div',
      { class: 'actions' },
      button('Close', close),
      button('Download MP4', () => downloadBlob(result.blob, fileName), { class: 'btn primary' }),
    ),
  );
  // exposed for automated tests
  (window as unknown as { __lastExport?: ExportResult }).__lastExport = result;
}
