// 射线拾取：鼠标悬停 → onHover（同时改光标），一次「点击」→ onPick。
// 点击的判定：按下和抬起间隔 < 400 ms、位移 < 6 px，这样拖一下、按住不放都不会误触发附身。
// 触屏没有悬停：按下时先按落点更新一次悬停（叠层能显示物件名），抬起时再判定点击
import * as THREE from 'three/webgpu';
import type { CameraRig } from './types';

const CLICK_MS = 400;
const CLICK_PX = 6;
/** 镜头动起来后多久内跟着刷新悬停：旋转过渡 0.45 秒、缩放平滑约 0.4 秒，各留一点余量 */
const REFRESH_ROTATE_MS = 600;
const REFRESH_ZOOM_MS = 500;
/** 触屏轻点后，悬停标签停留多久（毫秒） */
const TOUCH_HOVER_MS = 1500;

export interface Picker {
  onHover(cb: (id: string | null) => void): void;
  onPick(cb: (id: string) => void): void;
  dispose(): void;
}

export function createPicker(canvas: HTMLCanvasElement, rig: CameraRig, getTargets: () => THREE.Object3D[]): Picker {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hoverCbs: ((id: string | null) => void)[] = [];
  const pickCbs: ((id: string) => void)[] = [];
  let hover: string | null = null;
  let down: { id: number; x: number; y: number; t: number } | null = null;
  let touchHoverTimer = 0;

  // 触屏上不让浏览器把手指拖动当成滚动 / 缩放（否则会发 pointercancel，抬起事件收不到）
  const prevTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  const propIdOf = (obj: THREE.Object3D): string | null => {
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
      const id = o.userData.propId;
      if (typeof id === 'string') return id;
    }
    return null;
  };

  /**
   * 屏幕点下的物件 id。点击盒故意做得比物件大，相邻物件的盒子会互相重叠（转了镜头以后厨房门的盒子会挡住摇椅、
   * 台灯的盒子会挡住八音盒）。所以不取第一个命中，而是在射线穿过的所有盒子里，选盒子中心离射线最近的那个
   */
  const idAt = (clientX: number, clientY: number): string | null => {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, rig.camera);
    let best: string | null = null;
    let bestD = Infinity;
    for (const hit of ray.intersectObjects(getTargets(), true)) {
      const id = propIdOf(hit.object);
      if (!id || id === best) continue;
      box.setFromObject(hit.object).getCenter(center);
      const d = ray.ray.distanceSqToPoint(center);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };

  const setHover = (id: string | null) => {
    if (id === hover) return;
    hover = id;
    canvas.style.cursor = id ? 'pointer' : '';
    for (const cb of hoverCbs) cb(id);
  };

  // 鼠标不动、镜头在动（Q / E 旋转、滚轮缩放）时，光标下的物件会变：镜头动的这段时间里每帧按上次的鼠标位置重新检测
  let mouse: { x: number; y: number } | null = null;
  let refreshUntil = 0;
  let refreshing = false;
  let disposed = false;
  const refreshTick = () => {
    if (disposed) return;
    if (mouse) setHover(idAt(mouse.x, mouse.y));
    if (performance.now() < refreshUntil) requestAnimationFrame(refreshTick);
    else refreshing = false;
  };
  const refreshFor = (ms: number) => {
    if (!mouse || disposed) return;
    refreshUntil = Math.max(refreshUntil, performance.now() + ms);
    if (!refreshing) {
      refreshing = true;
      requestAnimationFrame(refreshTick);
    }
  };
  rig.onRotate(() => refreshFor(REFRESH_ROTATE_MS));
  const onWheel = () => refreshFor(REFRESH_ZOOM_MS);

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // 手指拖动不算悬停
    mouse = { x: e.clientX, y: e.clientY };
    setHover(idAt(e.clientX, e.clientY));
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    if (e.pointerType === 'touch') setHover(idAt(e.clientX, e.clientY));
  };
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || d.id !== e.pointerId) return;
    if (performance.now() - d.t >= CLICK_MS) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_PX) return;
    const id = idAt(e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      // 触屏没有悬停：轻点时借悬停标签显示物件名和冷却，1.5 秒后自己收起，不然会一直挂在屏幕上
      setHover(id);
      clearTimeout(touchHoverTimer);
      if (id) touchHoverTimer = window.setTimeout(() => setHover(null), TOUCH_HOVER_MS);
    }
    if (id) for (const cb of pickCbs) cb(id);
  };
  const onCancel = () => { down = null; };
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    mouse = null;
    setHover(null);
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: true });

  return {
    onHover(cb) { hoverCbs.push(cb); },
    onPick(cb) { pickCbs.push(cb); },
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      clearTimeout(touchHoverTimer);
      disposed = true;
      canvas.style.cursor = '';
      canvas.style.touchAction = prevTouchAction;
      hoverCbs.length = 0;
      pickCbs.length = 0;
    },
  };
}
