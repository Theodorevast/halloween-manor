// 镜头和标记（2026-10-30 严格玩家那一轮，路 CU）：
// - 吓跑那一刻镜头轻轻偏向逃跑的人（最多 10°、约 0.6 秒，玩家一动鼠标立刻停，减少动态时不做）
// - 往下看时吊臂不再被天花板沿着自己压短（鬼魂不再贴到镜头前糊住三分之一屏幕）
// - 手机竖屏的娃娃屋：房子撑满屏幕宽度（两头的尖角裁掉一点），物件都还在画面里
// - 被瞄准的物件：冷白灰的细线（不再是薄荷绿），镜头钻进物件里时不画外壳（不再整块平涂）；按住设机关时霜从下往上长
// node 里没有 DOM：鬼魂镜头、娃娃屋镜头用 EventTarget 做的假画布 / 假 window / 假 document 接上（和 tests/hints.test.ts 一样）
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUSE_D, HOUSE_W, PROPS, WALL_H, propCenter } from '../src/config/house';
import { TRAP } from '../src/config/visitors';
import { createCameraRig } from '../src/engine/camera';
import { LEAN, LIFT, createGhostRig, ghostCamera, ghostRigDebug, ghostSees, planLean, requestLean, setGhostUi, watchGhostUi } from '../src/engine/ghostRig';
import type { RenderCore } from '../src/engine/types';
import { idleManifest } from '../src/sim/manifest';
import type { NpcState, ScareObjectState, WorldState } from '../src/sim/types';
import { GLOW, GLOW_GHOST, canArm, createPropsView, insideBox, stepCharge, type Charge } from '../src/view/props';
import { createRangeFrost } from '../src/view/rangeFrost';

const DT = 1 / 60;

// 肖像、镜子画在 DOM 的 canvas 上（node 里没有），而且归恐怖画那一路改：物件模块的测试里换成一个方盒子的物件
vi.mock('../src/view/props/portrait', async (orig) => ({ ...(await orig<typeof import('../src/view/props/portrait')>()), createPortrait: () => boxRig() }));
vi.mock('../src/view/props/mirror', async (orig) => ({ ...(await orig<typeof import('../src/view/props/mirror')>()), createMirror: () => boxRig() }));
function boxRig() {
  const geo = new THREE.BoxGeometry(0.6, 1.2, 0.1).translate(0, 1.2, 0);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial());
  const model = new THREE.Group();
  model.add(m);
  return {
    model, hit: { size: [0.6, 1.2, 0.2] as [number, number, number], center: [0, 1.2, 0] as [number, number, number] },
    shells: [{ parent: m, geometry: geo }], trigger() {}, reset() {}, update() {},
  };
}

const DEG = Math.PI / 180;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 假的 window / document / 画布：EventTarget 加上 createGhostRig、createCameraRig 会读的几个字段 */
class FakeTarget extends EventTarget {
  style: Record<string, string> = {};
  clientWidth = 800;
  clientHeight = 600;
  pointerLockElement: unknown = null;
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}
const domEvent = (type: string, init: Record<string, unknown> = {}) => {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(init)) Object.defineProperty(e, k, { value: v });
  return e;
};

function rigEnv(opts: { reduced?: boolean } = {}) {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  vi.stubGlobal('addEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.addEventListener(t, cb));
  vi.stubGlobal('removeEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.removeEventListener(t, cb));
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { setTimeout: () => 0 });
  if (opts.reduced !== undefined) vi.stubGlobal('matchMedia', () => ({ matches: opts.reduced }));
  const canvas = new FakeTarget();
  const rig = createGhostRig(canvas as unknown as HTMLCanvasElement);
  const dbg = ghostRigDebug(rig)!;
  return {
    rig, dbg, canvas, doc, win,
    mouse: (dx: number, dy: number) => doc.dispatchEvent(domEvent('mousemove', { movementX: dx, movementY: dy })),
    key: (code: string, type = 'keydown') => win.dispatchEvent(domEvent(type, { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false })),
    pointer: (type: string, button: number, buttons: number) => canvas.dispatchEvent(domEvent(type, { button, buttons, timeStamp: 0, pointerType: 'mouse' })),
    frames: (n: number) => { for (let i = 0; i < n; i++) rig.update(DT); },
  };
}

/** 鬼魂在客厅西半边朝东北、吊臂 1 米，鼠标在操控（假装锁定）；镜头就位 */
function leanEnv(opts: { reduced?: boolean } = {}) {
  const e = rigEnv(opts);
  e.rig.lockPointer();
  e.dbg.fakeLock(true);
  e.dbg.place(6.5, 4.0, -Math.PI / 4, 0.07);
  e.dbg.setDist(1);
  e.frames(30); // 离开场、离上一次输入都够久
  return e;
}
type Env = ReturnType<typeof rigEnv>;
/** 离镜头 dist 米、在视线右边 bearing 度（负数是左边）的点（房屋坐标） */
const off = (e: Env, bearing: number, dist: number) => {
  const v = e.dbg.view();
  const b = v.yaw + bearing * DEG;
  return { x: v.cam.x + Math.cos(b) * dist, z: v.cam.z + Math.sin(b) * dist };
};
/** 在视线一侧（side = 1 右、−1 左）找一个要偏的点：鬼魂看得见（visible）或者隔着墙 */
function pick(e: Env, side: 1 | -1, visible: boolean) {
  const g = { x: e.rig.ghost.x, z: e.rig.ghost.z };
  for (let b = 30; b <= 60; b += 1) {
    for (let d = 2; d <= 6; d += 0.25) {
      const p = off(e, side * b, d);
      if (p.x < 0.5 || p.x > 15.5 || p.z < 0.5 || p.z > 11.5) continue;
      if (ghostSees(g, p) === visible && planLean(e.dbg.leanView(), [p]) !== 0) return p;
    }
  }
  throw new Error('找不到合适的点');
}
const yawDeg = (e: Env) => e.dbg.view().yaw / DEG;

describe('吓跑那一刻镜头轻轻偏向逃跑的人（planLean）', () => {
  const half = 37.59 * DEG; // 800 × 600 画布的半个水平视角
  /** 镜头就在转动中心（没有吊臂、不过肩）：偏多少，人在画面里就挪多少 */
  const flat = { pivot: { x: 0, z: 0 }, back: 0, shoulder: 0, yaw: 0, halfH: half };
  const pt = (deg: number, d = 3) => ({ x: Math.cos(deg * DEG) * d, z: Math.sin(deg * DEG) * d });

  it('人在画面外一点（右边 45°）：往右偏，最多 10°', () => {
    expect(LEAN.max).toBeCloseTo(10 * DEG, 9);
    expect(planLean(flat, [pt(45)])).toBeCloseTo(LEAN.max, 9);
    expect(planLean(flat, [pt(-45)])).toBeCloseTo(-LEAN.max, 9);
  });

  it('人在画面边上（右边 28°）：只偏到他进了画面里舒服的地方，不偏满', () => {
    const d = planLean(flat, [pt(28)]);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(LEAN.max);
    expect(28 * DEG - d).toBeCloseTo(LEAN.comfort * half, 6);
  });

  it('已经在画面里、身后、偏满了也进不了画面：不偏', () => {
    expect(planLean(flat, [pt(15)])).toBe(0);
    expect(planLean(flat, [pt(150)])).toBe(0);
    expect(planLean(flat, [pt(-100)])).toBe(0);
    expect(planLean(flat, [pt(55)])).toBe(0); // 偏满了还在画面外好几度
  });

  it('几个人一起跑：有一个已经在画面里就不偏；都在外面就偏向要偏得最少的那个', () => {
    expect(planLean(flat, [pt(45), pt(10)])).toBe(0);
    const d = planLean(flat, [pt(45), pt(-30)]);
    expect(d).toBeLessThan(0);
    expect(d).toBeGreaterThan(-LEAN.max);
  });

  it('朝向绕了好几圈也照样（yaw 不取模）', () => {
    expect(planLean({ ...flat, yaw: 4 * Math.PI }, [pt(45)])).toBeCloseTo(LEAN.max, 9);
  });

  it('镜头在鬼魂身后绕着转：偏航时镜头也跟着绕，贴在鬼魂身边的人挪得少，偏满了也进不了画面就不偏；远处的人照常', () => {
    const orbit = { pivot: { x: 0, z: 0 }, back: 2.4, shoulder: 0.32, yaw: 0, halfH: half };
    const cam = { x: -2.4, z: 0.32 };
    const at = (deg: number, d: number) => ({ x: cam.x + Math.cos(deg * DEG) * d, z: cam.z + Math.sin(deg * DEG) * d });
    // 鬼魂右后方、离镜头 2 米、在右边 45°：偏 10° 他在画面里只挪三四度，还在画面外
    expect(planLean(orbit, [at(45, 2)])).toBe(0);
    // 前方 9 米、右边 41°：偏满 10°，挪进画面
    expect(planLean(orbit, [at(41, 9)])).toBeCloseTo(LEAN.max, 9);
  });
});

describe('吓跑那一刻镜头轻轻偏向逃跑的人（鬼魂镜头）', () => {
  it('画面外一点的人：约 0.6 秒平滑地偏过去（偏多少按 planLean），偏完停住，不回来', () => {
    const e = leanEnv();
    const y0 = yawDeg(e);
    const p = pick(e, 1, true);
    const planned = planLean(e.dbg.leanView(), [p]) / DEG;
    expect(planned).toBeGreaterThan(2);
    expect(planned).toBeLessThanOrEqual(10 + 1e-9);
    requestLean(e.rig, p);
    const trace: number[] = [];
    for (let i = 0; i < 60; i++) {
      e.frames(1);
      trace.push(yawDeg(e) - y0);
    }
    // 单调往右，0.3 秒时一半左右，0.65 秒时基本到位
    for (let i = 1; i < trace.length; i++) expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1] - 1e-9);
    expect(trace[17] / planned).toBeGreaterThan(0.3);
    expect(trace[17] / planned).toBeLessThan(0.65);
    expect(trace[38] / planned).toBeGreaterThan(0.95);
    e.frames(120);
    expect(yawDeg(e) - y0).toBeCloseTo(planned, 2);
    expect(e.dbg.view().leaning).toBe(false);
  });

  it('偏到一半玩家动鼠标：立刻停，之后只跟鼠标', () => {
    const e = leanEnv();
    const y0 = yawDeg(e);
    const p = pick(e, 1, true);
    const planned = planLean(e.dbg.leanView(), [p]) / DEG;
    requestLean(e.rig, p);
    e.frames(12);
    expect(e.dbg.view().leaning).toBe(true);
    e.mouse(4, 0);
    expect(e.dbg.view().leaning).toBe(false);
    e.frames(60);
    const a = yawDeg(e) - y0;
    e.frames(60);
    expect(yawDeg(e) - y0).toBeCloseTo(a, 6); // 停住了
    // 偏了 0.2 秒（约两成）+ 鼠标 4 像素（约 0.5°），不到原计划
    const mouseDeg = (4 * 0.0022) / DEG;
    expect(a).toBeLessThan(planned * 0.35 + mouseDeg + 0.2);
    expect(a).toBeGreaterThan(mouseDeg);
  });

  it('鼠标事件的位移是 0（有的浏览器会发）：不算动了，接着偏', () => {
    const e = leanEnv();
    requestLean(e.rig, pick(e, 1, true));
    e.frames(6);
    e.mouse(0, 0);
    e.frames(1);
    expect(e.dbg.view().leaning).toBe(true);
  });

  it('按住左键（正在设机关）时有人跑：不偏，准星不能被挪开（挪开手势就作废了）；偏到一半按下左键：立刻停', () => {
    const e = leanEnv();
    const y0 = yawDeg(e);
    const p = pick(e, 1, true);
    e.pointer('pointerdown', 0, 1);
    e.frames(30); // 按下本身也算玩家在操作：过了 calm 再看，不是它挡住的
    requestLean(e.rig, p);
    e.frames(60);
    expect(yawDeg(e) - y0).toBeCloseTo(0, 6);
    e.pointer('pointerup', 0, 0);

    const f = leanEnv();
    requestLean(f.rig, pick(f, 1, true));
    f.frames(6);
    expect(f.dbg.view().leaning).toBe(true);
    f.pointer('pointerdown', 0, 1);
    expect(f.dbg.view().leaning).toBe(false);
    f.pointer('pointerup', 0, 0);
  });

  it('偏到一半 hold（登记簿翻开）：立刻停；放开时视角回到 hold 那一刻', () => {
    const e = leanEnv();
    requestLean(e.rig, pick(e, 1, true));
    e.frames(6);
    const at = e.dbg.view().yaw;
    e.rig.hold(true);
    expect(e.dbg.view().leaning).toBe(false);
    e.frames(30);
    e.rig.hold(false);
    expect(e.dbg.view().yaw).toBeGreaterThanOrEqual(at);
    expect(e.dbg.view().leaning).toBe(false);
  });

  it('方向键转向也算玩家在转：立刻停', () => {
    const e = leanEnv();
    requestLean(e.rig, pick(e, 1, true));
    e.frames(6);
    expect(e.dbg.view().leaning).toBe(true);
    e.key('ArrowLeft');
    e.frames(1);
    expect(e.dbg.view().leaning).toBe(false);
  });

  it('不偏的情形：人已经在画面里、在身后、隔着墙、刚动过鼠标、hold 着、没在操控、减少动态', () => {
    const cases: [string, (e: Env) => void][] = [
      ['在画面里', (e) => requestLean(e.rig, off(e, 8, 3))],
      ['身后', (e) => requestLean(e.rig, off(e, 160, 2))],
      ['隔着墙', (e) => requestLean(e.rig, pick(e, 1, false))],
      ['刚动过鼠标', (e) => { const p = pick(e, 1, true); e.mouse(1, 0); requestLean(e.rig, p); }],
      ['hold 着', (e) => { const p = pick(e, 1, true); e.rig.hold(true); requestLean(e.rig, p); }],
      ['没在操控', (e) => { const p = pick(e, 1, true); e.dbg.fakeLock(false); requestLean(e.rig, p); }],
    ];
    for (const [name, act] of cases) {
      const e = leanEnv();
      const y0 = yawDeg(e);
      act(e);
      e.frames(60);
      expect({ name, moved: Math.abs(yawDeg(e) - y0) > 0.3 }).toEqual({ name, moved: false });
    }
    const r = leanEnv({ reduced: true });
    const y0 = yawDeg(r);
    requestLean(r.rig, pick(r, 1, true));
    r.frames(60);
    expect(yawDeg(r) - y0).toBeCloseTo(0, 9);
  });

  it('刚偏过一次：2.5 秒内再有人跑不再偏（几个人接连逃，镜头不会一路被拽着走）', () => {
    const e = leanEnv();
    const y0 = yawDeg(e);
    requestLean(e.rig, pick(e, 1, true));
    e.frames(60);
    const a = yawDeg(e) - y0;
    expect(a).toBeGreaterThan(2);
    const q = pick(e, 1, true); // 偏完以后右边又一个
    requestLean(e.rig, q);
    e.frames(60);
    expect(yawDeg(e) - y0).toBeCloseTo(a, 3); // 只剩视角平滑最后那一点点收尾
    e.frames(40); // 离第一次开始偏过了 2.5 秒
    requestLean(e.rig, q);
    e.frames(60);
    expect(yawDeg(e) - y0).toBeGreaterThan(a + 1);
  });

  it('范围霜线模块把 flee 事件转给镜头：真的偏向那个逃跑的人', () => {
    const e = leanEnv();
    const y0 = yawDeg(e);
    const core = { scene: new THREE.Scene(), houseRoot: new THREE.Group(), quality: 'high' } as unknown as RenderCore;
    const rf = createRangeFrost(core, e.rig, { reduced: () => false });
    const p = pick(e, -1, true);
    const planned = planLean(e.dbg.leanView(), [p]) / DEG;
    expect(planned).toBeLessThan(-2);
    const npc = { id: 7, pos: p, mode: 'fleeing' } as unknown as NpcState;
    const state = { npcs: [npc], objects: [], manifest: idleManifest(), time: 0, scaredOff: 0, hitStop: 0, avoid: [] } as unknown as WorldState;
    rf.onEvent({ type: 'flee', npc: 7 }, state);
    e.frames(60);
    expect(yawDeg(e) - y0).toBeCloseTo(planned, 2);
    rf.onEvent({ type: 'flee', npc: 99 }, state); // 找不到这个人：什么都不做、不报错
    rf.dispose();
  });
});

describe('往下看时吊臂不再被天花板沿着自己压短（eye S-3）', () => {
  /** 鬼魂在走廊里朝西（吊臂往东，一路没有墙），俯仰 pitch、吊臂 dist：镜头离转动中心（不算过肩那 0.32 米）多远、多高 */
  const boom = (pitch: number, dist: number) => {
    const e = rigEnv();
    e.dbg.place(6.0, 6.0, Math.PI, pitch);
    e.dbg.setDist(dist);
    const c = e.dbg.view().cam;
    return { back: c.x - 6.0, y: c.y, len: Math.hypot(c.x - 6.0, c.y - 1.65) };
  };

  it('往下看 30°、48°（吊臂 2.4 / 4 / 1 米）：镜头贴着天花板，离转动中心不近于吊臂长的 0.85', () => {
    for (const [pitch, dist] of [[0.52, 2.4], [0.84, 2.4], [0.52, 4], [0.84, 4], [0.84, 1]]) {
      const b = boom(pitch, dist);
      expect(b.y).toBeLessThanOrEqual(WALL_H - 0.15 + 1e-9);
      expect({ pitch, dist, ok: b.len >= 0.85 * dist - 1e-9 }).toEqual({ pitch, dist, ok: true });
      expect(b.back).toBeGreaterThan(0); // 还在鬼魂身后
    }
  });

  it('往上看、吊臂长时碰到地板也一样：镜头贴着地板，不沿吊臂压近', () => {
    const b = boom(-0.5, 4);
    expect(b.y).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(b.len).toBeGreaterThanOrEqual(0.85 * 4 - 1e-9);
  });

  it('没碰到天花板、地板（默认俯仰）：和原来一样，正好在吊臂上', () => {
    const b = boom(0.07, 2.4);
    expect(b.len).toBeCloseTo(2.4, 9);
  });

  it('滚轮拉近、吊臂短时镜头抬高一点（鬼魂往画面下方让开）；默认吊臂、拉远时不抬；抬高随吊臂长短连续变化', () => {
    const y = (dist: number) => boom(0.07, dist).y;
    const onBoom = (dist: number) => 1.65 + dist * Math.sin(0.07 + 4 * DEG);
    expect(y(1) - onBoom(1)).toBeCloseTo(LIFT.y, 9);
    expect(y(1.2) - onBoom(1.2)).toBeCloseTo(LIFT.y, 9);
    expect(y(2.0)).toBeCloseTo(onBoom(2.0), 9);
    expect(y(2.4)).toBeCloseTo(onBoom(2.4), 9);
    const mid = y(1.6) - onBoom(1.6);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(LIFT.y);
    // 贴着天花板时不抬穿
    expect(boom(0.5, 1).y).toBeLessThanOrEqual(WALL_H - 0.15 + 1e-9);
  });

  it('镜头的位置发布给物件（ghostCamera）：房屋坐标，和调试口看到的一样；每米像素数按画布高度和视角算', () => {
    const e = rigEnv();
    e.dbg.place(9.0, 2.6, Math.PI, 0.3);
    const c = e.dbg.view().cam;
    expect(ghostCamera.active).toBe(true);
    expect(ghostCamera.x).toBeCloseTo(c.x, 9);
    expect(ghostCamera.y).toBeCloseTo(c.y, 9);
    expect(ghostCamera.z).toBeCloseTo(c.z, 9);
    expect(ghostCamera.pxPerM).toBeCloseTo(600 / (2 * Math.tan(30 * DEG)), 6);
  });
});

describe('按住左键：发布给物件（GhostUi.pressing），机关的蓄力看它', () => {
  it('操控时按下左键 → pressing；松开（pointerup，或 pointermove 里左键位没了）→ 不按；右键、hold、没操控时不算', () => {
    const e = rigEnv();
    let pressing = false;
    const off = watchGhostUi((s) => { pressing = s.pressing; });
    e.rig.lockPointer();
    e.dbg.fakeLock(true);
    e.pointer('pointerdown', 0, 1);
    expect(pressing).toBe(true);
    e.pointer('pointerup', 0, 0);
    expect(pressing).toBe(false);
    e.pointer('pointerdown', 0, 1);
    e.pointer('pointermove', 2, 2); // 左键松了、右键还按着（叠加按键时的松手）
    expect(pressing).toBe(false);
    e.pointer('pointerdown', 2, 2);
    expect(pressing).toBe(false);
    e.rig.hold(true);
    e.pointer('pointerdown', 0, 1);
    expect(pressing).toBe(false);
    e.rig.hold(false);
    e.pointer('pointerdown', 0, 1);
    expect(pressing).toBe(true);
    e.rig.hold(true); // 按着的时候 hold：松掉
    expect(pressing).toBe(false);
    e.rig.hold(false);
    e.dbg.fakeLock(false);
    e.pointer('pointerdown', 0, 1);
    expect(pressing).toBe(false);
    off();
    setGhostUi({ pressing: false });
  });
});

describe('手机竖屏的娃娃屋：房子撑满屏幕宽度，访客更大（eye S-6、newbie S3）', () => {
  /** 原来的取景（整栋房子 + 7% 边距，横屏按高度、竖屏按宽度）：视平面上的半宽、半高 */
  function oldFit(w: number, h: number) {
    const elev = 35 * DEG;
    let xMax = 0, yMin = Infinity, yMax = -Infinity;
    const se = Math.sin(elev), ce = Math.cos(elev);
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4]) {
      const dx = Math.cos(a), dz = Math.sin(a);
      for (const px of [-HOUSE_W / 2, HOUSE_W / 2]) for (const pz of [-HOUSE_D / 2, HOUSE_D / 2]) for (const py of [0, WALL_H]) {
        const vx = px * dz - pz * dx;
        const vy = -se * (px * dx + pz * dz) + ce * py;
        xMax = Math.max(xMax, Math.abs(vx));
        yMin = Math.min(yMin, vy);
        yMax = Math.max(yMax, vy);
      }
    }
    let hw = xMax * 1.07, hh = ((yMax - yMin) / 2) * 1.07;
    if (hw / hh > w / h) hh = hw / (w / h);
    else hw = hh * (w / h);
    return { hw, hh };
  }
  function doll(w: number, h: number) {
    const canvas = new FakeTarget();
    canvas.clientWidth = w;
    canvas.clientHeight = h;
    const rig = createCameraRig(canvas as unknown as HTMLCanvasElement);
    const cam = rig.camera as THREE.OrthographicCamera;
    return { rig, cam, hw: (cam.right - cam.left) / 2, hh: (cam.top - cam.bottom) / 2 };
  }

  it('竖屏 390 × 844：比原来放大至少 1.2 倍', () => {
    const d = doll(390, 844);
    expect(oldFit(390, 844).hw / d.hw).toBeGreaterThanOrEqual(1.2);
  });

  it('竖屏：四个方位转一圈，9 个物件都还在画面里（离左右边至少 10 像素）', () => {
    const d = doll(390, 844);
    for (let q = 0; q < 4; q++) {
      for (const p of PROPS) {
        const s = d.rig.toScreen(propCenter(p), 0.5);
        expect({ q, id: p.id, inside: s.x >= 10 && s.x <= 390 - 10 && s.y > 0 && s.y < 844 }).toEqual({ q, id: p.id, inside: true });
      }
      d.rig.rotate(1);
      d.rig.update(1);
    }
  });

  it('平板（4:3 竖着、横着）和窄手机：物件也都在画面里', () => {
    for (const [w, h] of [[768, 1024], [1024, 768], [320, 640]]) {
      const d = doll(w, h);
      for (let q = 0; q < 4; q++) {
        for (const p of PROPS) {
          const s = d.rig.toScreen(propCenter(p), 0.5);
          expect({ w, q, id: p.id, inside: s.x >= 8 && s.x <= w - 8 && s.y > 0 && s.y < h }).toEqual({ w, q, id: p.id, inside: true });
        }
        d.rig.rotate(1);
        d.rig.update(1);
      }
    }
  });

  it('横屏手机、桌面 ?dollhouse（本来就按高度取景）：和原来一模一样', () => {
    for (const [w, h] of [[844, 390], [1280, 800], [1920, 1080]]) {
      const d = doll(w, h);
      const o = oldFit(w, h);
      expect(d.hw).toBeCloseTo(o.hw, 9);
      expect(d.hh).toBeCloseTo(o.hh, 9);
    }
  });
});

describe('被瞄准的物件：冷白灰的细线，不平涂（eye S-5）', () => {
  it('外壳的颜色是冷白灰（第三人称、娃娃屋都是）：饱和度很低、很亮，不再是薄荷绿', () => {
    for (const g of [GLOW, GLOW_GHOST]) {
      const hsl = new THREE.Color(g.tint).getHSL({ h: 0, s: 0, l: 0 });
      expect(hsl.s).toBeLessThan(0.2);
      expect(hsl.l).toBeGreaterThan(0.6);
    }
  });

  it('第三人称的外壳按屏幕像素算粗细（远近一样细），不按米', () => {
    expect(GLOW_GHOST.px).toBeGreaterThan(0.5);
    expect(GLOW_GHOST.px).toBeLessThanOrEqual(1.6);
    expect(GLOW_GHOST.hoverPx).toBeLessThanOrEqual(2);
  });

  it('镜头钻进物件（拾取盒外扩一点）里：判断在不在盒子里', () => {
    const size: [number, number, number] = [0.5, 1.6, 0.5];
    const center: [number, number, number] = [0, 0.8, 0];
    expect(insideBox(new THREE.Vector3(0, 1, 0), size, center, 0.2)).toBe(true);
    expect(insideBox(new THREE.Vector3(0.4, 1, 0), size, center, 0.2)).toBe(true); // 盒子外 0.15 米，算在外扩里
    expect(insideBox(new THREE.Vector3(0.5, 1, 0), size, center, 0.2)).toBe(false);
    expect(insideBox(new THREE.Vector3(0, 1.75, 0), size, center, 0.2)).toBe(true); // 盒顶上 0.15 米
    expect(insideBox(new THREE.Vector3(0, 2.1, 0), size, center, 0.2)).toBe(false);
  });
});

describe('按住设机关的蓄力：物件上的薄霜从下往上长，0.5 秒长满', () => {
  const obj = (id: string, o: Partial<ScareObjectState> = {}): ScareObjectState => ({
    id, type: 'lamp', pos: { x: 0, z: 0 }, facing: 0, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0, ...o,
  });
  const idle: Charge = { id: null, t: 0, void: false };
  const run = (c: Charge, pressing: boolean, hovered: string | null, s: number, can = (_id: string) => true) => {
    for (let t = 0; t < s - 1e-9; t += DT) c = stepCharge(c, pressing, hovered, can, DT);
    return c;
  };
  const progress = (c: Charge) => (c.id ? Math.min(1, c.t / TRAP.holdToArm) : 0);

  it('对着物件按住：0.25 秒一半，0.5 秒长满；松手就没了', () => {
    let c = run(idle, true, 'lamp', 0.25);
    expect(c.id).toBe('lamp');
    expect(progress(c)).toBeCloseTo(0.5, 1);
    c = run(c, true, 'lamp', 0.3);
    expect(progress(c)).toBe(1);
    c = run(c, false, 'lamp', DT);
    expect(c.id).toBeNull();
  });

  it('按住期间准星移开：作废，移回来也不再长（和拾取器的手势一样）；松手再按才重新开始', () => {
    let c = run(idle, true, 'lamp', 0.2);
    c = run(c, true, null, DT);
    expect(c.id).toBeNull();
    expect(c.void).toBe(true);
    c = run(c, true, 'lamp', 0.3);
    expect(c.id).toBeNull();
    c = run(c, false, 'lamp', DT);
    c = run(c, true, 'lamp', 0.1);
    expect(c.id).toBe('lamp');
  });

  it('按下时没对着物件、或者这个物件设不了（冷却中、已经设着、机关满了）：不长', () => {
    expect(run(idle, true, null, 0.3).id).toBeNull();
    expect(run(idle, true, 'lamp', 0.3, () => false).id).toBeNull();
    const objects = [obj('lamp'), obj('mirror', { armed: 30 }), obj('portrait', { armed: 12 }), obj('bed', { cooldown: 3 })];
    expect(canArm(objects, 'lamp')).toBe(false); // 已经设下 2 个（TRAP.max）
    expect(canArm(objects, 'mirror')).toBe(false); // 自己设着
    expect(canArm(objects.slice(0, 2), 'lamp')).toBe(true);
    expect(canArm(objects, 'bed')).toBe(false); // 冷却中
    expect(canArm(objects, 'nope')).toBe(false);
  });
});

describe('物件模块（真的 three 场景，不渲染）：镜头钻进物件不画外壳；按住设机关时霜从下往上长', () => {
  function propsEnv() {
    const scene = new THREE.Scene();
    const houseRoot = new THREE.Group();
    houseRoot.position.set(-8, 0, -6);
    scene.add(houseRoot);
    const core = { scene, houseRoot, quality: 'high' } as unknown as RenderCore;
    setGhostUi({ active: true, pressing: false });
    const view = createPropsView(core, {});
    const objects: ScareObjectState[] = PROPS.map((p) => ({ id: p.id, type: p.type, pos: propCenter(p), facing: p.facing, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 }));
    const state = { objects, npcs: [], manifest: idleManifest(), time: 0, scaredOff: 0, hitStop: 0, avoid: [] } as unknown as WorldState;
    let t = 0;
    const frames = (n: number) => { for (let i = 0; i < n; i++) { t += DT; view.update!({ dt: DT, time: t, state }); } };
    const meshes = (id: string, name: string) => {
      const out: THREE.Mesh[] = [];
      scene.getObjectByName(`prop:${id}`)!.traverse((o) => { if (o.name === name) out.push(o as THREE.Mesh); });
      return out;
    };
    return { view, state, frames, meshes, objects };
  }

  it('镜头在客厅台灯的拾取盒里：它的外壳不画；镜头挪开就画', () => {
    const e = propsEnv();
    const lamp = propCenter(PROPS.find((p) => p.id === 'lamp-living')!);
    Object.assign(ghostCamera, { active: true, x: lamp.x + 0.1, y: 1.2, z: lamp.z, pxPerM: 700 });
    e.view.setHover('lamp-living');
    e.frames(10);
    expect(e.meshes('lamp-living', 'glow-shell').every((m) => !m.visible)).toBe(true);
    Object.assign(ghostCamera, { x: lamp.x + 2.5 });
    e.frames(10);
    expect(e.meshes('lamp-living', 'glow-shell').some((m) => m.visible)).toBe(true);
    e.view.dispose!();
    setGhostUi({ active: false });
  });

  it('物件转过 90° 时（镜子朝东）也按它自己的局部坐标判断：沿镜面方向 0.4 米算在里面，沿法线方向 0.6 米不算', () => {
    const e = propsEnv();
    const m = propCenter(PROPS.find((p) => p.id === 'mirror')!);
    e.view.setHover('mirror');
    Object.assign(ghostCamera, { active: true, x: m.x, y: 1.2, z: m.z + 0.4, pxPerM: 700 });
    e.frames(5);
    expect(e.meshes('mirror', 'glow-shell').every((s) => !s.visible)).toBe(true);
    Object.assign(ghostCamera, { x: m.x + 0.6, z: m.z });
    e.frames(5);
    expect(e.meshes('mirror', 'glow-shell').some((s) => s.visible)).toBe(true);
    e.view.dispose!();
    setGhostUi({ active: false });
  });

  it('按满、模拟设下的那一刻：霜整层就位、很快退回设下的浓度（一直按着也不会一直亮着）；前沿不再亮', () => {
    const e = propsEnv();
    Object.assign(ghostCamera, { active: true, x: 1, y: 1.8, z: 1, pxPerM: 700 });
    e.view.setHover('lamp-living');
    e.frames(2);
    setGhostUi({ pressing: true });
    e.frames(31);
    e.objects.find((o) => o.id === 'lamp-living')!.armed = 60;
    e.frames(1);
    const f = e.meshes('lamp-living', 'frost-shell')[0];
    expect(f.userData.frostFront).toBe(0);
    e.frames(30); // 还按着
    expect(f.userData.frostAmount).toBeCloseTo(1, 1);
    expect(f.userData.frostTop).toBeGreaterThan(100); // 整层
    setGhostUi({ pressing: false, active: false });
    e.view.dispose!();
  });

  it('按住对着台灯：霜的前沿 0.25 秒到一半高、0.5 秒过顶；松手没设下就化掉；设不了的物件不长', () => {
    const e = propsEnv();
    Object.assign(ghostCamera, { active: true, x: 1, y: 1.8, z: 1, pxPerM: 700 });
    e.view.setHover('lamp-living');
    e.frames(2);
    const frost = () => e.meshes('lamp-living', 'frost-shell');
    expect(frost().every((m) => !m.visible)).toBe(true);
    setGhostUi({ pressing: true });
    e.frames(15);
    const f = frost()[0];
    expect(f.visible).toBe(true);
    const y = new THREE.Box3().setFromObject(e.view.pickTargets().find((h) => h.userData.propId === 'lamp-living')!.parent!.children[0]);
    const mid = (y.min.y + y.max.y) / 2;
    expect(Math.abs(f.userData.frostTop - mid)).toBeLessThan(0.25);
    expect(f.userData.frostFront).toBe(1);
    e.frames(16);
    expect(f.userData.frostTop).toBeGreaterThan(y.max.y);
    setGhostUi({ pressing: false });
    e.frames(60);
    expect(frost().every((m) => !m.visible)).toBe(true);
    // 冷却中的物件：按住也不长
    e.objects.find((o) => o.id === 'lamp-living')!.cooldown = 5;
    setGhostUi({ pressing: true });
    e.frames(20);
    expect(frost().every((m) => !m.visible)).toBe(true);
    setGhostUi({ pressing: false, active: false });
    e.view.dispose!();
  });
});
