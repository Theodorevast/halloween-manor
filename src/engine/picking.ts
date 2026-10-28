// 射线拾取：鼠标悬停 → onHover（同时改光标），一次「点击」→ onPick。
// 点击的判定：按下和抬起间隔 < 400 ms、位移 < 6 px，这样拖一下、按住不放都不会误触发附身。
// 触屏没有悬停：按下时先按落点更新一次悬停（叠层能显示物件名），抬起时再判定点击。
// 第三人称（ghostRig）换一套：准星（画面正中）对着的、离鬼魂 4 米以内、鬼魂看得见的物件是悬停，
// 指针锁定时点一下（按下后不到 TRAP.holdToArm 秒松开）附身，在松开那一刻；按住满 TRAP.holdToArm 秒设机关（onArm）；
// 按住期间准星对着的物件变了就作废。没锁定时那一下是「点一下继续」（ghostRig 重新锁定），不附身
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W } from '../config/house';
import { TRAP } from '../config/visitors';
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
  /**
   * 第三人称：对着物件按住左键满 TRAP.holdToArm 秒（期间准星一直对着它）→ 设下机关，在按满的那一刻（不用等松手）。
   * 点一下（不到这么久就松手）仍然是 onPick，只是改到松手那一刻才发。触屏 / 娃娃屋没有这一手，永远不会调
   */
  onArm(cb: (id: string) => void): void;
  dispose(): void;
}

/** 按住手势的结果：点一下（附身）、按满（设机关）；id 是物件 */
export type HoldAction = { type: 'pick' | 'arm'; id: string };

/**
 * 按住手势（第三人称的准星用）：按下时记下对准的物件和时间；
 * 按满 holdMs 还对着同一个物件 → 'arm'（tick 里发，只发一次，不用等松手）；不到就松手 → 'pick'（松手那一刻）；
 * 按住期间对准的物件变了（包括准星移开了）→ 作废，之后怎么样都不发。
 * 纯状态机，时间（毫秒）由调用方传进来，所以好测；picking.ts 之外没人用
 */
export function createHoldGesture(holdMs: number) {
  let held: { id: string; t0: number; armed: boolean } | null = null;
  return {
    /** 按下：准星对着物件才开始记；没对着就什么都不发 */
    down(aimed: string | null, now: number) {
      held = aimed ? { id: aimed, t0: now, armed: false } : null;
    },
    /** 每帧调：准星此刻对着谁。变了就作废；刚好按满了就返回 'arm'（只返回这一次） */
    tick(aimed: string | null, now: number): HoldAction | null {
      if (!held) return null;
      if (aimed !== held.id) {
        held = null;
        return null;
      }
      if (!held.armed && now - held.t0 >= holdMs) {
        held.armed = true;
        return { type: 'arm', id: held.id };
      }
      return null;
    },
    /**
     * 松手：准星此刻对着谁。对着原来那个：不到 holdMs 是 'pick'；到了但 tick 还没来得及发（两帧之间松的手）补发 'arm'；
     * 已经在 tick 里设下了、作废了、本来就没对准，都是 null
     */
    up(aimed: string | null, now: number): HoldAction | null {
      const h = held;
      held = null;
      if (!h || h.armed || aimed !== h.id) return null;
      return { type: now - h.t0 >= holdMs ? 'arm' : 'pick', id: h.id };
    },
    /** 作废（丢了指针锁定、窗口失焦、pointercancel） */
    cancel() {
      held = null;
    },
    get holding() {
      return held !== null;
    },
  };
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
    onArm() {}, // 触屏 / 娃娃屋没有「按住设机关」：点一下只会附身
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
  const armCbs: ((id: string) => void)[] = [];
  const hold = createHoldGesture(TRAP.holdToArm * 1000);
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

  const fire = (act: HoldAction | null) => {
    if (act) for (const cb of act.type === 'pick' ? pickCbs : armCbs) cb(act.id);
  };

  // 镜头每帧都在动（跟随、转向），悬停每帧重算一次：8 个盒子的一条射线，很便宜。按住时也在这里看有没有按满、准星有没有移开
  const tick = () => {
    if (disposed) return;
    const id = aimed();
    setHover(id);
    fire(hold.tick(id, performance.now()));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // 丢了锁定：下一帧 aimed() 返回 null，悬停自己收起；按着的手势也作废（Esc 之后松手，松手事件到不了这里）
  const unwatch = watchGhostUi((s) => {
    locked = s.locked;
    if (!s.locked) hold.cancel();
  });

  // 按下不立刻附身：要等松手（不到 holdToArm 秒）才算「点一下」，按满了就是设机关
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !locked) return;
    const id = aimed();
    setHover(id);
    hold.down(id, performance.now());
  };
  const onUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    fire(hold.up(aimed(), performance.now()));
  };
  const onCancel = () => hold.cancel();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  addEventListener('blur', onCancel);

  return {
    onHover(cb) { hoverCbs.push(cb); },
    onPick(cb) { pickCbs.push(cb); },
    onArm(cb) { armCbs.push(cb); },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      removeEventListener('blur', onCancel);
      unwatch();
      disposed = true;
      hold.cancel();
      setHover(null);
      hoverCbs.length = 0;
      pickCbs.length = 0;
      armCbs.length = 0;
    },
  };
}
