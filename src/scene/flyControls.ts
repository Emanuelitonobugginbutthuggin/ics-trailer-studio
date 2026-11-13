import * as THREE from 'three';
import { MAX_FOV, MIN_FOV } from '../shots/path';

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, -1],
  KeyS: [0, 0, 1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyE: [0, 1, 0],
  KeyQ: [0, -1, 0],
  ArrowUp: [0, 0, -1],
  ArrowDown: [0, 0, 1],
  ArrowLeft: [-1, 0, 0],
  ArrowRight: [1, 0, 0],
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return type === 'text' || type === 'number' || type === 'search';
}

/**
 * Fly camera: drag to look, WASD to move, Q/E down/up, Z/C roll,
 * Shift fast, Alt slow, wheel to move along the view direction.
 * Movement is in metres per second, so it feels the same at any frame rate.
 */
export class FlyControls {
  enabled = true;
  /** metres per second */
  speed = 1.5;
  /** called with the clicked position when the pointer was pressed and released without dragging */
  onClick: ((clientX: number, clientY: number) => void) | null = null;
  /** called whenever the user moves the camera */
  onMove: (() => void) | null = null;

  private keys = new Set<string>();
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
  private move = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.dom.setPointerCapture(e.pointerId);
    this.drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 4) d.moved = true;
    if (!this.enabled || !d.moved) return;
    // one viewport height of drag turns the camera by one field of view
    const radPerPx = THREE.MathUtils.degToRad(this.camera.fov) / Math.max(1, this.dom.clientHeight);
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.euler.y -= dx * radPerPx * 1.5;
    this.euler.x = THREE.MathUtils.clamp(this.euler.x - dy * radPerPx * 1.5, -1.55, 1.55);
    this.camera.quaternion.setFromEuler(this.euler);
    this.onMove?.();
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (d && !d.moved && e.type === 'pointerup') this.onClick?.(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.enabled) return;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.addScaledVector(forward, -e.deltaY * 0.002 * this.speed);
    this.onMove?.();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
    if (e.code in MOVE_KEYS || e.code === 'KeyZ' || e.code === 'KeyC') {
      this.keys.add(e.code);
      e.preventDefault();
    }
    if (!this.enabled) return;
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const step = e.code === 'BracketLeft' ? -2 : 2;
      this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + step, MIN_FOV, MAX_FOV);
      this.camera.updateProjectionMatrix();
      this.onMove?.();
    }
    if (e.code === 'KeyX') {
      this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.euler.z = 0;
      this.camera.quaternion.setFromEuler(this.euler);
      this.onMove?.();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  /** true while a key that moves the camera is held */
  update(dt: number, shift: boolean, alt: boolean): boolean {
    if (!this.enabled || this.keys.size === 0) return false;
    this.move.set(0, 0, 0);
    let roll = 0;
    for (const code of this.keys) {
      const m = MOVE_KEYS[code];
      if (m) this.move.x += m[0], (this.move.y += m[1]), (this.move.z += m[2]);
      if (code === 'KeyZ') roll += 1;
      if (code === 'KeyC') roll -= 1;
    }
    const boost = (shift ? 4 : 1) * (alt ? 0.25 : 1);
    if (this.move.lengthSq() > 0) {
      const vertical = this.move.y;
      this.move.y = 0;
      this.move.applyQuaternion(this.camera.quaternion); // forward and sideways follow the view
      this.move.y += vertical; // up and down follow the world
      this.move.normalize().multiplyScalar(this.speed * boost * dt);
      this.camera.position.add(this.move);
    }
    if (roll !== 0) {
      this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.euler.z += roll * dt * 0.8;
      this.camera.quaternion.setFromEuler(this.euler);
    }
    this.onMove?.();
    return true;
  }
}
