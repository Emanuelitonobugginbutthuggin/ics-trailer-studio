import type { App } from '../app';
import type { ExportResult } from '../export/exportSequence';
import { button, downloadBlob, formatBytes, h, toast } from './dom';

const safeName = (name: string, fallback: string) => name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || fallback;

/** Renders the active shot or the whole trailer with progress, then shows the result. */
export async function openExportDialog(app: App, what: 'shot' | 'trailer') {
  const shot = app.activeShot;
  if (what === 'shot' && !shot) return;
  const title = what === 'shot' ? `"${shot!.name}"` : 'the trailer';
  const fileName = what === 'shot' ? `${safeName(shot!.name, 'shot')}.mp4` : `${safeName(app.project.name, 'trailer')}.mp4`;

  const modal = document.getElementById('modal')!;
  const abort = new AbortController();
  const bar = h('progress', { max: 1, value: 0 });
  const status = h('p', { class: 'hint' }, 'Preparing encoder…');
  const dialog = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Export' },
    h('h2', null, `Rendering ${title}`),
    bar,
    status,
    h('p', { class: 'hint' }, 'Keep this tab in front until it finishes. Every frame is rendered exactly, so this is slower than real time.'),
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
    const onProgress = (p: { frame: number; totalFrames: number; elapsed: number }) => {
      bar.value = p.frame / p.totalFrames;
      const left = Math.max(0, Math.round((p.elapsed / p.frame) * (p.totalFrames - p.frame)));
      status.textContent = `Frame ${p.frame} of ${p.totalFrames} · about ${left} s left`;
    };
    result = what === 'shot' ? await app.exportActiveShot(onProgress, abort.signal) : await app.exportTrailer(onProgress, abort.signal);
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
  const parts: (HTMLElement | null)[] = [
    h('h2', null, what === 'shot' ? 'Shot rendered' : 'Trailer rendered'),
    h('video', { src: url, controls: true, loop: true, autoplay: true, muted: true, playsInline: true }),
    h(
      'dl',
      null,
      h('dt', null, 'Length'),
      h('dd', null, `${result.seconds.toFixed(2)} s (${result.frames} frames at 30 fps)`),
      h('dt', null, 'Size'),
      h('dd', null, `1080 × 1920 · ${formatBytes(result.blob.size)}`),
      h('dt', null, 'Codec'),
      h('dd', null, `H.264 (${result.codec}), no sound`),
    ),
    what === 'trailer' ? h('p', { class: 'hint' }, 'The file is silent on purpose: add your sound in TikTok and line it up with the first cut.') : null,
    h(
      'div',
      { class: 'actions' },
      button('Close', close),
      button('Download MP4', () => downloadBlob(result.blob, fileName), { class: 'btn primary' }),
    ),
  ];
  dialog.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  // exposed for automated tests
  (window as unknown as { __lastExport?: ExportResult }).__lastExport = result;
}
