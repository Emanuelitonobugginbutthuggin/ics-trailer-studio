// Tiny DOM helpers: no framework needed for a tool this size.

type Child = Node | string | number | null | undefined | false;
/** children may be nested in arrays, so helpers can return several rows */
export type Children = Child | Children[];
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Children[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in el && key !== 'list') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else el.setAttribute(key, String(value));
    }
  }
  for (const child of (children as unknown[]).flat(Infinity) as Child[]) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function button(label: string, onClick: () => void, opts: { class?: string; title?: string; disabled?: boolean } = {}) {
  return h('button', { type: 'button', class: opts.class ?? 'btn', title: opts.title, disabled: opts.disabled, onClick }, label);
}

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  title?: string;
}

/** Label, range slider and live value in one row. */
export function sliderRow(label: string, o: SliderOptions, onInput: (v: number) => void, onCommit?: () => void) {
  const format = o.format ?? ((v: number) => String(v));
  const out = h('output', null, format(o.value));
  const input = h('input', {
    type: 'range',
    min: String(o.min),
    max: String(o.max),
    step: String(o.step),
    value: String(o.value),
    'aria-label': label,
    onInput: () => {
      const v = Number(input.value);
      out.textContent = format(v);
      onInput(v);
    },
    onChange: () => onCommit?.(),
  });
  return h('label', { class: 'row slider', title: o.title }, h('span', null, label), input, out);
}

export function numberRow(
  label: string,
  o: { min?: number; max?: number; step: number; value: number; unit?: string; title?: string },
  onChange: (v: number) => void,
) {
  const input = h('input', {
    type: 'number',
    min: o.min === undefined ? undefined : String(o.min),
    max: o.max === undefined ? undefined : String(o.max),
    step: String(o.step),
    value: String(o.value),
    'aria-label': label,
    onChange: () => {
      let v = Number(input.value);
      if (!Number.isFinite(v)) v = o.value;
      if (o.min !== undefined) v = Math.max(o.min, v);
      if (o.max !== undefined) v = Math.min(o.max, v);
      input.value = String(v);
      onChange(v);
    },
  });
  return h('label', { class: 'row', title: o.title }, h('span', null, label), input, o.unit ? h('span', { class: 'unit' }, o.unit) : null);
}

export function checkRow(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string) {
  const input = h('input', { type: 'checkbox', checked, onChange: () => onChange(input.checked) });
  return h('label', { class: 'row check', title }, input, h('span', null, label));
}

export function section(title: string, ...children: Children[]) {
  return h('section', { class: 'panel-section' }, h('h3', null, title), ...children);
}

let toastTimer = 0;
export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = ''), kind === 'error' ? 7000 : 3500);
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
