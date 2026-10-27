// 射线拾取：鼠标悬停 → onHover（同时改光标），一次「点击」→ onPick。
// 点击的判定：按下和抬起间隔 < 400 ms、位移 < 6 px，这样拖一下、按住不放都不会误触发附身。
// 触屏没有悬停：按下时先按落点更新一次悬停（叠层能显示物件名），抬起时再判定点击。
// 第三人称（ghostRig）换一套：准星（画面正中）对着的、离鬼魂 4 米以内、鬼魂看得见的物件是悬停，
// 指针锁定时按下左键附身；没锁定时那一下是「点一下继续」（ghostRig 重新锁定），不附身
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W } from '../config/house';
import { ghostSees, setGhostUi, watchGhostUi } from './ghostRig';
import { isGhostRig, type CameraRig, type GhostRig } from './types';

const CLICK_MS = 400;
const CLICK_PX = 6;
/** 触屏轻点后，悬停标签停留多久（毫秒） */
const TOUCH_HOVER_MS = 1500;
/** 第三人称：准星对着的物件离鬼魂（水平距离，米）这么近才够得着 */
const AIM_RANGE = 4;

export interface Picker {
  onHover(cb: (id: string | null) => void): void;
  onPick(cb: (id: string) => void): void;
  dispose(): void;
}

const propIdOf = (obj: THREE.Object3D): string | null => {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    const id = o.userData.propId;
    if (typeof id === 'string') return id;
  }
  return null;
};

export function createPicker(canvas: HTMLCanvasElement, rig: CameraRig, getTargets: () => THREE.Object3D[]): Picker {
  if (isGhostRig(rig)) return createAimPicker(canvas, rig, getTargets);
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

  // 鼠标不动、镜头在动（旋转、缩放、开场、冲镜、震动）时，光标下的物件会变。不去一样样猜镜头什么时候在动、动多久：
  // 鼠标在画布上时每帧比一下相机的投影和位置，变了就按上次的鼠标位置重新检测。不动的帧只比 32 个数，不做射线
  let mouse: { x: number; y: number } | null = null;
  let watching = false;
  let disposed = false;
  const lastCam = new Float64Array(32);
  const camMoved = () => {
    const p = rig.camera.projectionMatrix.elements, w = rig.camera.matrixWorld.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) {
      if (p[i] !== lastCam[i] || w[i] !== lastCam[16 + i]) moved = true;
      lastCam[i] = p[i];
      lastCam[16 + i] = w[i];
    }
    return moved;
  };
  const watchTick = () => {
    if (disposed || !mouse) {
      watching = false;
      return;
    }
    if (camMoved()) setHover(idAt(mouse.x, mouse.y));
    requestAnimationFrame(watchTick);
  };
  const watch = () => {
    if (watching || disposed) return;
    watching = true;
    camMoved(); // 刚按当前镜头检测过，以此为起点
    requestAnimationFrame(watchTick);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // 手指拖动不算悬停
    mouse = { x: e.clientX, y: e.clientY };
    setHover(idAt(e.clientX, e.clientY));
    watch();
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

  return {
    onHover(cb) { hoverCbs.push(cb); },
    onPick(cb) { pickCbs.push(cb); },
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      clearTimeout(touchHoverTimer);
      disposed = true;
      canvas.style.cursor = '';
      canvas.style.touchAction = prevTouchAction;
      hoverCbs.length = 0;
      pickCbs.length = 0;
    },
  };
}

/**
 * 第三人称的拾取：每帧从镜头沿准星（画面正中）打一条射线。穿过的拾取盒里，挑盒子中心离射线最近的那个
 * （和俯视一样：相邻物件的盒子会一起被穿过，比如卧室的台灯和八音盒），但只算离鬼魂 AIM_RANGE 米以内、
 * 鬼魂看得见（中间没有墙，见 ghostRig.ts 的 ghostSees）的：墙全高以后，隔着墙的物件看不见，标签也不该凭空冒出来
 */
function createAimPicker(canvas: HTMLCanvasElement, rig: GhostRig, getTargets: () => THREE.Object3D[]): Picker {
  const ray = new THREE.Raycaster();
  const centre = new THREE.Vector2(0, 0);
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  const hoverCbs: ((id: string | null) => void)[] = [];
  const pickCbs: ((id: string) => void)[] = [];
  let hover: string | null = null;
  let locked = false;
  let disposed = false;

  const aimed = (): string | null => {
    if (!locked) return null;
    ray.setFromCamera(centre, rig.camera);
    const g = rig.ghost;
    let best: string | null = null;
    let bestD = Infinity;
    for (const hit of ray.intersectObjects(getTargets(), true)) {
      const id = propIdOf(hit.object);
      if (!id || id === best) continue;
      box.setFromObject(hit.object).getCenter(c);
      // 世界坐标 → 房屋米坐标
      const p = { x: c.x + HOUSE_W / 2, z: c.z + HOUSE_D / 2 };
      if (Math.hypot(p.x - g.x, p.z - g.z) > AIM_RANGE || !ghostSees(g, p)) continue;
      const d = ray.ray.distanceSqToPoint(c);
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
    setGhostUi({ aim: id });
    for (const cb of hoverCbs) cb(id);
  };

  // 镜头每帧都在动（跟随、转向），悬停每帧重算一次：7 个盒子的一条射线，很便宜
  const tick = () => {
    if (disposed) return;
    setHover(aimed());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // 丢了锁定：下一帧 aimed() 返回 null，悬停自己收起
  const unwatch = watchGhostUi((s) => { locked = s.locked; });

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !locked) return;
    const id = aimed();
    setHover(id);
    if (id) for (const cb of pickCbs) cb(id);
  };
  canvas.addEventListener('pointerdown', onDown);

  return {
    onHover(cb) { hoverCbs.push(cb); },
    onPick(cb) { pickCbs.push(cb); },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      unwatch();
      disposed = true;
      setHover(null);
      hoverCbs.length = 0;
      pickCbs.length = 0;
    },
  };
}
