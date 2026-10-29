// 射线拾取：鼠标悬停 → onHover（同时改光标），一次「点击」→ onPick。
// 点击的判定：按下和抬起间隔 < 400 ms、位移 < 6 px，这样拖一下、按住不放都不会误触发附身。
// 「按了多久」都按指针事件自己的时间戳算（eventTime），不按处理事件那一刻的时钟：主线程卡一帧、事件排在后面才处理，不会把点一下读成按住。
// 触屏没有悬停：按下时先按落点更新一次悬停（叠层能显示物件名），抬起时再判定点击。
// 第三人称（ghostRig）换一套：准星（画面正中）对着的、离鬼魂 4 米以内、鬼魂看得见的物件是悬停，
// 指针锁定时点一下（按下后不到 TRAP.holdToArm 秒松开）附身，在松开那一刻；按住满 TRAP.holdToArm 秒设机关（onArm）；
// 按住期间准星对着的物件变了就作废；叠加按键（按住左键再按右键）时，左键一松开手势就结束，右键不开始也不打断（见 createHoldInput）。
// 没锁定时那一下是「点一下继续」（ghostRig 重新锁定），不附身。
// 开场遮罩还挂着（ghostRig 的 hold，界面状态 held）：指针虽然锁上了，也不悬停、不附身。
// 够不着（2026-10-30 试玩报告 P2-3，上手那一路的 refused('tooFar')）：准星对着一个看得见的物件、但离鬼魂超过 4 米，按下左键时回调 onTooFar；
// 而且每帧都把它写进界面状态 GhostUi.aimFar（2026-10-30 手感分析 FEEL-7）：对准时标签就写 Too far away.、准星外圈变虚线，不用等点下去
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W } from '../config/house';
import { TRAP } from '../config/visitors';
import { ghostSees, setGhostUi, watchGhostUi } from './ghostRig';
import { isGhostRig, type CameraRig, type GhostRig } from './types';

const CLICK_MS = 400;
const CLICK_PX = 6;
/** 事件时间戳可信的范围（毫秒）：比现在早不过 maxAge、比现在晚不过 futureSlack，才当它和 performance.now() 在同一条时间轴上 */
export const EVENT_STAMP = { maxAge: 2000, futureSlack: 100 };

/**
 * 指针事件发生的时刻（毫秒，和 performance.now() 同一条时间轴）。主线程卡了一下（着色器编译、垃圾回收），事件排在后面才被处理时，
 * 处理那一刻的 performance.now() 比事件真正发生的晚得多；按它算「按了多久」，按下和松手之间卡一下就会把点一下读成按住。
 * 事件自己的 timeStamp 不受这个影响。不可信的（不是有限数、比现在晚过 futureSlack、比现在早过 maxAge：个别浏览器的 timeStamp 不在这条时间轴上）退回 now
 */
export function eventTime(stamp: number, now: number): number {
  if (!Number.isFinite(stamp) || stamp > now + EVENT_STAMP.futureSlack || now - stamp > EVENT_STAMP.maxAge) return now;
  return Math.min(stamp, now);
}
/** 触屏轻点后，悬停标签停留多久（毫秒） */
const TOUCH_HOVER_MS = 1500;
/** 第三人称：准星对着的物件离鬼魂（水平距离，米）这么近才够得着（物件的幽光也按它：够不着的不亮，见 view/props.ts） */
export const AIM_RANGE = 4;
/**
 * 第三人称：够不着、但还算「对着它」的最远距离（米）。和叠层的物件标记完全淡出的距离一样（view/overlays.ts 的 FADE_FAR）：
 * 再远，眼睛、圆环都不显示了，点一下不回应
 */
const FAR_RANGE = 10;

export interface Picker {
  onHover(cb: (id: string | null) => void): void;
  onPick(cb: (id: string) => void): void;
  /**
   * 第三人称：对着物件按住左键满 TRAP.holdToArm 秒（期间准星一直对着它）→ 设下机关，在按满的那一刻（不用等松手）。
   * 点一下（不到这么久就松手）仍然是 onPick，只是改到松手那一刻才发。触屏 / 娃娃屋没有这一手，永远不会调
   */
  onArm(cb: (id: string) => void): void;
  /**
   * 第三人称：准星对着一个看得见的物件，但离鬼魂太远（AIM_RANGE 到 FAR_RANGE 米）够不着，按下左键的那一刻回调（每按一下一次）。
   * main.ts 接到 hints.refused('tooFar')。触屏 / 娃娃屋没有准星，永远不会调
   */
  onTooFar(cb: (id: string) => void): void;
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

export interface HoldInputOptions {
  /** 按住多久算设机关（毫秒） */
  holdMs: number;
  /** 准星此刻对着谁（拾取器的射线）。只在按下、手势结束时调；每帧的那一次由 frame 的参数传进来，不重复算 */
  aimed(): string | null;
  /** 现在（毫秒）。down / buttons 没给事件时刻时用它；每帧（frame）判断按满了没有也用它 */
  now(): number;
  /** 点一下：附身，在松手那一刻 */
  onPick(id: string): void;
  /** 按满：设机关，在按满的那一帧（两帧之间就松了手的，在松手那一刻补发） */
  onArm(id: string): void;
}

/**
 * 按住手势的输入层（第三人称）：把指针事件的 button / buttons、丢锁定、失焦、pointercancel 翻译成手势的调用。
 * 不碰 DOM，时间和准星由调用方给，所以好测；createAimPicker 只负责把真事件接进来。
 *
 * 叠加按键（按住左键再按右键）：Pointer Events 只在第一个键按下时发 pointerdown、最后一个键松开时发 pointerup，
 * 中途按下 / 松开某个键发的是 pointermove（button 是变的那个键，buttons 是之后还按着的键）。真 Chrome 里指针锁定下实测过：
 *   左按 → 右按 → 左松 → 右松：pointerdown(0, 1) · pointermove(2, 3) · pointermove(0, 2) · pointerup(2, 0)
 * 先松的左键只出现在那个 pointermove 里，pointerup 的 button 是右键。所以松手不看 button，看 buttons 的左键位（最低位）：
 * pointermove、pointerup 都查，(buttons & 1) === 0 就是左键已经不按着了，手势在这一刻结束——
 * 不到 holdMs 算点一下（附身）、按满了算设机关（帧里多半已经发过，补发也只会发一次）、对准的物件变了就作废。
 * 右键 / 中键按下不开始手势，也不打断已经在按着的左键；右键自己按下、松开（左键还按着时）都不影响手势。
 *
 * 丢了指针锁定、pointercancel、窗口失焦：手势作废，不附身也不设机关。没锁定时按下不开始（那一下是「点一下继续」）
 */
export function createHoldInput(o: HoldInputOptions) {
  const hold = createHoldGesture(o.holdMs);
  let locked = false;
  const fire = (act: HoldAction | null) => {
    if (!act) return;
    if (act.type === 'pick') o.onPick(act.id);
    else o.onArm(act.id);
  };
  return {
    /**
     * pointerdown：只有左键（button 0）、而且鼠标在操控鬼魂（锁定中）才开始手势。
     * at = 这个事件发生的时刻（毫秒，和 now() 同一条时间轴，见 eventTime）；不给就用 now()
     */
    down(button: number, at?: number) {
      if (button !== 0 || !locked) return;
      hold.down(o.aimed(), at ?? o.now());
    },
    /**
     * pointermove / pointerup：buttons 是这个事件之后还按着的键（位：1 = 左键，2 = 右键）；左键位是 0 就结束手势。
     * at 同 down：按了多久按事件自己的时刻算，卡了一下才处理的松手不会把点一下读成按住
     */
    buttons(buttons: number, at?: number) {
      if (!hold.holding || (buttons & 1) !== 0) return;
      fire(hold.up(o.aimed(), at ?? o.now()));
    },
    /** 每帧：准星此刻对着谁（拾取器已经算好）。看按满了没有、准星有没有移开 */
    frame(aimed: string | null) {
      fire(hold.tick(aimed, o.now()));
    },
    /** 指针锁定变了：丢了就作废手势 */
    setLocked(on: boolean) {
      locked = on;
      if (!on) hold.cancel();
    },
    /** pointercancel、窗口失焦、dispose：作废 */
    cancel() {
      hold.cancel();
    },
    get holding() {
      return hold.holding;
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
    // 先排下一帧、再发回调：订阅者抛了异常，循环也不会就此停掉（停了的话 watching 还卡在 true，之后 pointermove 再也起不了这个循环）
    requestAnimationFrame(watchTick);
    if (camMoved()) setHover(idAt(mouse.x, mouse.y));
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
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: eventTime(e.timeStamp, performance.now()) };
    if (e.pointerType === 'touch') setHover(idAt(e.clientX, e.clientY));
  };
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || d.id !== e.pointerId) return;
    if (eventTime(e.timeStamp, performance.now()) - d.t >= CLICK_MS) return;
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
    onTooFar() {}, // 没有准星：点到的就是够得着的
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
 * 鬼魂看得见（中间没有墙，见 ghostRig.ts 的 ghostSees）的：墙全高以后，隔着墙的物件看不见，标签也不该凭空冒出来。
 * 看得见、但在 AIM_RANGE 到 FAR_RANGE 米之间的，另记一个「够不着的」：按下左键时没有够得着的、只有它，就回调 onTooFar
 */
function createAimPicker(canvas: HTMLCanvasElement, rig: GhostRig, getTargets: () => THREE.Object3D[]): Picker {
  const ray = new THREE.Raycaster();
  const centre = new THREE.Vector2(0, 0);
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  const hoverCbs: ((id: string | null) => void)[] = [];
  const pickCbs: ((id: string) => void)[] = [];
  const armCbs: ((id: string) => void)[] = [];
  const farCbs: ((id: string) => void)[] = [];
  let hover: string | null = null;
  let locked = false;
  let disposed = false;

  /** 准星对着的：够得着的（near）、看得见但够不着的（far），各挑盒子中心离射线最近的那个。没锁定（或开场遮罩还挂着）时都是 null */
  const scan = (): { near: string | null; far: string | null } => {
    if (!locked) return { near: null, far: null };
    ray.setFromCamera(centre, rig.camera);
    const g = rig.ghost;
    let near: string | null = null, far: string | null = null;
    let nearD = Infinity, farD = Infinity;
    for (const hit of ray.intersectObjects(getTargets(), true)) {
      const id = propIdOf(hit.object);
      if (!id || id === near) continue;
      box.setFromObject(hit.object).getCenter(c);
      // 世界坐标 → 房屋米坐标
      const p = { x: c.x + HOUSE_W / 2, z: c.z + HOUSE_D / 2 };
      const dist = Math.hypot(p.x - g.x, p.z - g.z);
      if (dist > FAR_RANGE || !ghostSees(g, p)) continue;
      const d = ray.ray.distanceSqToPoint(c);
      if (dist <= AIM_RANGE) {
        if (d < nearD) {
          nearD = d;
          near = id;
        }
      } else if (d < farD) {
        farD = d;
        far = id;
      }
    }
    return { near, far };
  };
  const aimed = (): string | null => scan().near;

  /**
   * 准星此刻对着的：够得着的是悬停（通知订阅者、写 GhostUi.aim）；没有够得着的、只有看得见但够不着的，写 GhostUi.aimFar
   * （2026-10-30 手感分析 FEEL-7：标签写 Too far away.、准星外圈变虚线，不用等按下去才知道）。setGhostUi 只在变化时通知
   */
  const setAim = (near: string | null, far: string | null) => {
    setGhostUi({ aim: near, aimFar: near ? null : far });
    if (near === hover) return;
    hover = near;
    for (const cb of hoverCbs) cb(near);
  };

  // 按住手势的输入层（规则和叠加按键的细节见 createHoldInput）
  const input = createHoldInput({
    holdMs: TRAP.holdToArm * 1000,
    aimed,
    now: () => performance.now(),
    onPick: (id) => { for (const cb of pickCbs) cb(id); },
    onArm: (id) => { for (const cb of armCbs) cb(id); },
  });

  // 镜头每帧都在动（跟随、转向），悬停每帧重算一次：8 个盒子的一条射线，很便宜。按住时也在这里看有没有按满、准星有没有移开。
  // 先排下一帧、再算和发回调：订阅者（悬停、附身、设机关的回调）抛了异常，每帧的循环也不会就此停掉
  const tick = () => {
    if (disposed) return;
    requestAnimationFrame(tick);
    const { near, far } = scan();
    setAim(near, far);
    input.frame(near);
  };
  requestAnimationFrame(tick);
  // 丢了锁定：下一帧 aimed() 返回 null，悬停自己收起；按着的手势也作废（Esc 之后松手，松手事件到不了这里）。
  // 开场遮罩还挂着（held）当作没锁定：不悬停、按下不开始手势
  const unwatch = watchGhostUi((s) => {
    locked = s.locked && !s.held;
    input.setLocked(locked);
  });

  // 按下不立刻附身：要等松手（不到 holdToArm 秒）才算「点一下」，按满了就是设机关。
  // 松手要听 pointermove 和 pointerup：叠加按键时（按住左键再按右键）先松的左键只出现在 pointermove 里（buttons 变了），
  // pointerup 要等最后一个键松开才发，button 还是右键
  const onDown = (e: PointerEvent) => {
    if (e.button === 0 && locked) {
      const { near, far } = scan();
      setAim(near, far);
      // 够不着：这一下做不到，回应一句（hints.refused）；够得着的照常开始手势
      if (!near && far) for (const cb of farCbs) cb(far);
    }
    input.down(e.button, eventTime(e.timeStamp, performance.now()));
  };
  const onButtons = (e: PointerEvent) => input.buttons(e.buttons, eventTime(e.timeStamp, performance.now()));
  const onCancel = () => input.cancel();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onButtons);
  canvas.addEventListener('pointerup', onButtons);
  canvas.addEventListener('pointercancel', onCancel);
  addEventListener('blur', onCancel);

  return {
    onHover(cb) { hoverCbs.push(cb); },
    onPick(cb) { pickCbs.push(cb); },
    onArm(cb) { armCbs.push(cb); },
    onTooFar(cb) { farCbs.push(cb); },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onButtons);
      canvas.removeEventListener('pointerup', onButtons);
      canvas.removeEventListener('pointercancel', onCancel);
      removeEventListener('blur', onCancel);
      unwatch();
      disposed = true;
      input.cancel();
      setAim(null, null);
      hoverCbs.length = 0;
      pickCbs.length = 0;
      armCbs.length = 0;
      farCbs.length = 0;
    },
  };
}
