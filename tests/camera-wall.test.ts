// 镜头不进墙（2026-10-30 试玩 playtest.md S1：镜头落在墙体里的时间占 7–23%）。
// 只管落在墙里的那一截：算出来的镜头位置在墙格（或者房子外面）里，就沿吊臂往鬼魂那边滑到刚出墙；过渡是平滑的；
// 隔着墙、但镜头在屋里的情形完全不动（舷窗、剖面照旧）。鬼魂自己飞过墙时不缩一下又退回去。
// 纯函数直接测；鬼魂镜头用假画布接上真的 createGhostRig（和 tests/camera-markers.test.ts 一样）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRID_H, GRID_W, CELL, Tile, buildTiles, cellOf, idx, inGrid } from '../src/config/house';
import { WALL_SLIDE, camBlocked, createGhostRig, ghostRigDebug, newWallSlide, stepWallSlide, wallExit, wallSlideTarget } from '../src/engine/ghostRig';
import type { Vec2 } from '../src/sim/types';

const DT = 1 / 60;
const STILL: Vec2 = { x: 0, z: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
});

// 和 playtest 的 qa-play.mjs 同一个判断：墙格、窗格，或者格子外面
const TILES = buildTiles();
const solidAt = (x: number, z: number) => {
  const [i, j] = cellOf(x, z);
  if (!inGrid(i, j)) return true;
  const t = TILES[idx(i, j)];
  return t === Tile.Wall || t === Tile.Window;
};

/** 走廊北墙（第 9 行格子，z 4.5–5）上不是门洞的一段：x = 3.25 那一格是墙 */
const WALL_Z = { near: 5, far: 4.5 };

describe('哪里算墙（camBlocked）：和试玩的量法同一套格子', () => {
  it('墙格、窗格、格子外面算；地板、门洞不算', () => {
    expect(camBlocked(3.25, 4.75)).toBe(true); // 走廊北墙
    expect(camBlocked(3.25, 5.25)).toBe(false); // 走廊
    expect(camBlocked(2.5, 4.75)).toBe(false); // 书房门洞
    expect(camBlocked(2, 0.25)).toBe(true); // 北外墙的窗
    expect(camBlocked(-0.3, 6)).toBe(true); // 房子外面
    expect(camBlocked(16.2, 6)).toBe(true);
  });

  it('整张格子抽一遍：和试玩脚本的 solidAt 处处一样', () => {
    for (let j = -1; j <= GRID_H; j++) {
      for (let i = -1; i <= GRID_W; i++) {
        const x = (i + 0.5) * CELL, z = (j + 0.5) * CELL;
        expect({ i, j, b: camBlocked(x, z) }).toEqual({ i, j, b: solidAt(x, z) });
      }
    }
  });
});

describe('滑多远才出墙（wallExit）', () => {
  it('不在墙里：0', () => {
    expect(wallExit({ x: 3.25, z: 5.5 }, { x: 3.25, z: 6.5 })).toBe(0);
  });

  it('垂直落在墙里：滑到靠鬼魂这边的墙格边上，再多 pad', () => {
    const d = wallExit({ x: 3.25, z: 4.7 }, { x: 3.25, z: 6.5 })!;
    expect(d).toBeCloseTo(WALL_Z.near - 4.7 + WALL_SLIDE.pad, 1);
    expect(camBlocked(3.25, 4.7 + d)).toBe(false);
  });

  it('斜着落在墙里：沿连线走，走到的点不在墙里', () => {
    const raw = { x: 3.1, z: 4.6 }, p = { x: 4.9, z: 6.2 };
    const d = wallExit(raw, p)!;
    const L = Math.hypot(p.x - raw.x, p.z - raw.z);
    expect(d).toBeGreaterThan(0);
    expect(camBlocked(raw.x + ((p.x - raw.x) * d) / L, raw.z + ((p.z - raw.z) * d) / L)).toBe(false);
  });

  it('落在房子外面：滑回房子里（鬼魂在屋里）', () => {
    const d = wallExit({ x: -0.5, z: 6 }, { x: 1.5, z: 6 })!;
    expect(d).toBeCloseTo(1 + WALL_SLIDE.pad, 1); // 外墙格 x 0–0.5，走到 x = 0.5
  });

  it('贴着墙顺着墙看，滑到离鬼魂 min 米还出不了墙：null（不滑，鬼魂不糊到镜头上）', () => {
    expect(wallExit({ x: 4.25, z: 4.75 }, { x: 3.1, z: 4.75 })).toBeNull(); // 整段都在墙里（鬼魂也在墙里）
    expect(wallExit({ x: 3.25, z: 4.95 }, { x: 3.25 + 0.5, z: 5.02 })).toBeNull(); // 只有贴着鬼魂那一点点才出墙
  });
});

describe('滑多少（wallSlideTarget、stepWallSlide）', () => {
  it('隔着墙、但落点在屋里：完全不动（舷窗、剖面照旧）', () => {
    const raw = { x: 3.25, z: 3.5 }, p = { x: 3.25, z: 6.0 }; // 落点在书房，鬼魂在走廊，中间隔着墙
    const st = newWallSlide();
    for (let i = 0; i < 120; i++) stepWallSlide(st, raw, p, STILL, DT);
    expect(st.s).toBe(0);
  });

  it('落点停在墙里：很快滑出来（0.3 秒内），之后稳在墙外，每帧走得不多（不跳）', () => {
    const raw = { x: 3.25, z: 4.55 }, p = { x: 3.25, z: 6.8 };
    const st = newWallSlide();
    let last = 0, maxStep = 0, outAt = -1;
    for (let i = 0; i < 90; i++) {
      stepWallSlide(st, raw, p, STILL, DT);
      maxStep = Math.max(maxStep, Math.abs(st.s - last));
      last = st.s;
      if (outAt < 0 && !camBlocked(raw.x, raw.z + st.s)) outAt = i * DT;
    }
    expect(outAt).toBeGreaterThanOrEqual(0);
    expect(outAt).toBeLessThan(0.3);
    expect(camBlocked(raw.x, raw.z + st.s)).toBe(false);
    expect(st.s).toBeLessThan(WALL_Z.near - raw.z + 0.1); // 只滑那一截
    expect(maxStep).toBeLessThan(0.15);
  });

  it('鬼魂带着镜头飞过墙（全速 2.2 米/秒）：不缩一下又退回去', () => {
    // 鬼魂往南飞，镜头落点跟在后面 2.4 米，从书房穿过走廊北墙
    const st = newWallSlide();
    const v = { x: 0, z: 2.2 };
    let maxS = 0, inWall = 0;
    for (let t = 0; t < 1.5; t += DT) {
      const p = { x: 3.25, z: 6 + 2.2 * t };
      const raw = { x: 3.25, z: p.z - 2.4 };
      stepWallSlide(st, raw, p, v, DT);
      maxS = Math.max(maxS, st.s);
      if (camBlocked(raw.x, raw.z + st.s)) inWall += DT;
    }
    expect(maxS).toBeLessThan(0.02);
    expect(inWall).toBeLessThan(0.3); // 穿过去本来就只要约 0.23 秒
  });

  it('慢慢退（0.4 米/秒）进墙：一路贴着墙面，不进墙；退到墙那边再过一点才放开，放开时也是平滑地过去', () => {
    const st = newWallSlide();
    const v = { x: 0, z: -0.4 };
    let inWall = 0, maxStep = 0, last = 0, maxHeld = 0;
    // 落点从走廊（z 5.3）一路退到书房（z 3.7）；鬼魂在落点南边 2.4 米
    for (let t = 0; t < 4; t += DT) {
      const raw = { x: 3.25, z: 5.3 - 0.4 * t };
      const p = { x: 3.25, z: raw.z + 2.4 };
      stepWallSlide(st, raw, p, v, DT);
      maxStep = Math.max(maxStep, Math.abs(st.s - last));
      last = st.s;
      maxHeld = Math.max(maxHeld, st.s);
      if (raw.z > 4.45 && camBlocked(raw.x, raw.z + st.s)) inWall += DT;
    }
    expect(inWall).toBeLessThan(0.15);
    expect(maxHeld).toBeGreaterThan(0.45);
    expect(maxStep).toBeLessThan(0.15);
    expect(st.s).toBe(0); // 退远了，放开了：镜头到了书房（隔着墙，照旧）
  });

  it('落点刚从墙那边探出去一点又回来（转视角）：不来回穿墙', () => {
    const st = newWallSlide();
    const p = { x: 3.25, z: 6.8 };
    for (let i = 0; i < 60; i++) stepWallSlide(st, { x: 3.25, z: 4.6 }, p, STILL, DT);
    const held = st.s;
    expect(held).toBeGreaterThan(0.3);
    // 探出墙那边 0.1 米（z 4.4），没到 hold：还留在这边
    expect(wallSlideTarget({ x: 3.25, z: 4.5 - 0.1 }, p, st.s, STILL)).toBeGreaterThan(0.5);
    // 探出去 hold 以上：放开
    expect(wallSlideTarget({ x: 3.25, z: 4.5 - WALL_SLIDE.hold - 0.05 }, p, st.s, STILL)).toBe(0);
    // 没滑过的镜头（一直在书房那边）：探出墙那边就是不滑
    expect(wallSlideTarget({ x: 3.25, z: 4.4 }, p, 0, STILL)).toBe(0);
  });

  it('落点从靠鬼魂这一面进墙（目标连续）：3 米/秒也一点不落后，镜头一直贴着墙面', () => {
    const st = newWallSlide();
    const p = { x: 3.25, z: 7.0 };
    let inWall = 0, last = 0, maxStep = 0;
    for (let t = 0; t < 0.15; t += DT) {
      const raw = { x: 3.25, z: 5.1 - 3 * t }; // 落点从走廊往北，0.03 秒以后进墙
      stepWallSlide(st, raw, p, STILL, DT);
      if (camBlocked(raw.x, raw.z + st.s)) inWall++;
      maxStep = Math.max(maxStep, Math.abs(st.s - last));
      last = st.s;
    }
    expect(inWall).toBe(0);
    expect(maxStep).toBeLessThanOrEqual(WALL_SLIDE.ramp * DT + 1e-9); // 碰到墙面那一下也不跳：一帧最多 10 厘米
  });

  it('目标跳变（落点从墙那边进墙）、视角没怎么转：一帧最多走十几厘米，不瞬移；0.15 秒内出墙', () => {
    const st = newWallSlide();
    const raw = { x: 3.25, z: 4.52 }, p = { x: 3.25, z: 6.9 };
    let last = 0, maxStep = 0, outFrames = -1;
    for (let i = 0; i < 30; i++) {
      stepWallSlide(st, raw, p, STILL, DT);
      maxStep = Math.max(maxStep, st.s - last);
      last = st.s;
      if (outFrames < 0 && !camBlocked(raw.x, raw.z + st.s)) outFrames = i + 1;
    }
    expect(maxStep).toBeLessThan(0.15);
    expect(outFrames).toBeGreaterThan(1);
    expect(outFrames * DT).toBeLessThan(0.15);
  });

  it('视角转得很快（3 弧度/秒以上，画面本来就糊）：不等弹簧，这一帧就到位；转得慢时照常平滑', () => {
    const raw = { x: 3.25, z: 4.52 }, p = { x: 3.25, z: 6.9 };
    const fast = newWallSlide();
    stepWallSlide(fast, raw, p, STILL, DT, 5);
    expect(camBlocked(raw.x, raw.z + fast.s)).toBe(false);
    const slow = newWallSlide();
    stepWallSlide(slow, raw, p, STILL, DT, 0.5);
    expect(camBlocked(raw.x, raw.z + slow.s)).toBe(true);
  });

  it('吊臂要缩一大截（约 1 米）、视角没怎么转：一帧最多 15 厘米；刚转完很快那几帧的弹簧速度也不带过来，不冲过头', () => {
    const raw = { x: 3.25, z: 4.52 }, far = { x: 3.25, z: 6.9 };
    const st = newWallSlide();
    let last = 0, maxStep = 0;
    // 斜着贴墙：出墙要走很长（目标约 0.9 米）
    const a = { x: 7.0, z: 4.85 }, p = { x: 5.25, z: 5.15 };
    const want = wallExit(a, p)!;
    expect(want).toBeGreaterThan(0.8);
    for (let i = 0; i < 40; i++) {
      stepWallSlide(st, a, p, STILL, DT);
      maxStep = Math.max(maxStep, Math.abs(st.s - last));
      last = st.s;
    }
    expect(maxStep).toBeLessThanOrEqual(WALL_SLIDE.cap * DT + 1e-9);
    expect(st.s).toBeCloseTo(want, 2);
    // 快转那一帧到位，下一帧转慢、目标回 0：一帧也不超过 cap
    const q = newWallSlide();
    stepWallSlide(q, raw, far, STILL, DT, 5);
    const at = q.s;
    expect(at).toBeGreaterThan(0.4);
    stepWallSlide(q, { x: 3.25, z: 5.5 }, far, STILL, DT, 0);
    expect(at - q.s).toBeLessThanOrEqual(WALL_SLIDE.cap * DT + 1e-9);
    expect(q.s).toBeGreaterThanOrEqual(0);
  });

  it('dt 是 0（暂停的那一帧）：不动、不出 NaN', () => {
    const st = newWallSlide();
    stepWallSlide(st, { x: 3.25, z: 4.6 }, { x: 3.25, z: 6.8 }, STILL, 0);
    expect(Number.isFinite(st.s)).toBe(true);
    expect(st.s).toBe(0);
  });
});

// ── 真的鬼魂镜头 ──
class FakeTarget extends EventTarget {
  style: Record<string, string> = {};
  clientWidth = 1280;
  clientHeight = 800;
  pointerLockElement: unknown = null;
}
const domEvent = (type: string, init: Record<string, unknown> = {}) => {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(init)) Object.defineProperty(e, k, { value: v });
  return e;
};
function rigEnv() {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  vi.stubGlobal('addEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.addEventListener(t, cb));
  vi.stubGlobal('removeEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.removeEventListener(t, cb));
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { setTimeout: () => 0 });
  const canvas = new FakeTarget();
  const rig = createGhostRig(canvas as unknown as HTMLCanvasElement);
  const dbg = ghostRigDebug(rig)!;
  rig.lockPointer();
  dbg.fakeLock(true);
  return {
    rig, dbg,
    key: (code: string, type = 'keydown') => win.dispatchEvent(domEvent(type, { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false })),
    mouse: (dx: number, dy: number) => doc.dispatchEvent(domEvent('mousemove', { movementX: dx, movementY: dy })),
    frames: (n: number) => { for (let i = 0; i < n; i++) rig.update(DT); },
  };
}
const UP = 0.07 + (4 * Math.PI) / 180;

describe('真的鬼魂镜头', () => {
  /** 鬼魂在走廊朝南（heading π/2），吊臂往北；back = 吊臂水平长度 */
  const backOf = (dist: number) => dist * Math.cos(UP);

  it('落点在墙里：摆好就在墙外（调试口立刻就位），鬼魂的朝向、视角不变；滑的是那一截', () => {
    const e = rigEnv();
    const z = 4.75 + backOf(2.4);
    e.dbg.place(3.8, z, Math.PI / 2, 0.07); // 过肩以后终点在 x ≈ 3.48，是墙（不是门洞）
    const v = e.dbg.view();
    expect(camBlocked(v.cam.x, v.cam.z)).toBe(false);
    expect(v.slide).toBeGreaterThan(0.2);
    expect(v.slide).toBeLessThan(0.45);
    expect(v.yaw).toBeCloseTo(Math.PI / 2, 9);
    expect(v.pitch).toBeCloseTo(0.07, 9);
  });

  it('隔着墙、落点在书房里：和没有这个功能时一样（舷窗照旧）', () => {
    const e = rigEnv();
    // 鬼魂贴着走廊北墙，落点穿过墙到书房
    const z = 5.4;
    e.dbg.place(3.8, z, Math.PI / 2, 0.07);
    const v = e.dbg.view();
    expect(v.slide).toBe(0);
    expect(v.cam.z).toBeCloseTo(z - backOf(2.4), 6);
    expect(v.cam.z).toBeLessThan(WALL_Z.far);
  });

  it('按 S 退着走进墙：镜头不进墙，也不跳', () => {
    const e = rigEnv();
    e.dbg.place(3.5, 6.9, Math.PI / 2, 0.07); // 走廊南边，朝南，吊臂往北
    e.dbg.setDist(1.4); // 吊臂短：落点在走廊里，退的时候碰到北墙
    e.frames(10);
    e.key('KeyS');
    let last = e.dbg.view().cam, maxStep = 0, inWall = 0, n = 0;
    for (let i = 0; i < 40; i++) {
      e.frames(1);
      const c = e.dbg.view().cam;
      maxStep = Math.max(maxStep, Math.hypot(c.x - last.x, c.y - last.y, c.z - last.z));
      last = c;
      n++;
      if (camBlocked(c.x, c.z)) inWall++;
    }
    e.key('KeyS', 'keyup');
    e.frames(40); // 停下来：不管停在哪，落点在墙里就滑出来
    expect(maxStep).toBeLessThan(0.2);
    expect(inWall / n).toBeLessThan(0.5);
    const c = e.dbg.view().cam;
    expect(camBlocked(c.x, c.z)).toBe(false);
  });

  it('按 W 飞过走廊北墙（从书房进走廊，吊臂一路跟着）：吊臂不缩一下又退回去', () => {
    const e = rigEnv();
    e.dbg.place(3.8, 3.4, Math.PI / 2, 0.07); // 书房里朝南；过肩以后吊臂的终点在 x ≈ 3.48，那一列是墙（不是门洞）
    e.frames(10);
    e.key('KeyW');
    let maxSlide = 0;
    for (let i = 0; i < 150; i++) {
      e.frames(1);
      if (e.rig.ghost.z > 8) break;
      maxSlide = Math.max(maxSlide, e.dbg.view().slide);
    }
    e.key('KeyW', 'keyup');
    expect(maxSlide).toBeLessThan(0.1);
  });

  it('走得快但在转视角：落点是转进墙的，不算「鬼魂带着穿墙」，照样滑出来', () => {
    const noSpin = wallSlideTarget({ x: 3.25, z: 4.7 }, { x: 3.25, z: 6.9 }, 0, { x: 0, z: 2.2 });
    expect(noSpin).toBe(0); // 不转：鬼魂带着穿，不滑
    const e = rigEnv();
    e.dbg.place(3.8, 6.7, Math.PI / 2, 0.07); // 走廊里朝南，吊臂往北，落点在书房
    e.frames(5);
    e.key('KeyD'); // 往西飘（右手边），鬼魂一直在走
    e.frames(20);
    expect(e.rig.ghost.speed).toBeGreaterThan(1);
    let slid = 0;
    for (let i = 0; i < 40; i++) {
      e.mouse(-14, 0); // 每帧转 1.8 度（约 1.8 弧度/秒）：落点从书房转回走廊，路上穿过北墙
      e.frames(1);
      slid = Math.max(slid, e.dbg.view().slide);
    }
    e.key('KeyD', 'keyup');
    expect(slid).toBeGreaterThan(0.1);
  });

  it('停下来以后，落点不管停在哪面墙里都滑出来；转开就放回去（四个方向、外墙也一样）', () => {
    for (const [x, z, h] of [[8, 1.9, Math.PI / 2], [8, 10.1, -Math.PI / 2], [1.9, 6, 0], [14.1, 6, Math.PI]] as const) {
      const e = rigEnv();
      e.dbg.place(x, z, h, 0.07);
      const v = e.dbg.view();
      expect({ x, z, out: camBlocked(v.cam.x, v.cam.z) }).toEqual({ x, z, out: false });
      expect(v.slide).toBeGreaterThan(0);
      e.mouse(((Math.PI / 2) / 0.0022), 0); // 转 90°：落点离开那面墙
      e.frames(60);
      const w = e.dbg.view();
      expect(camBlocked(w.cam.x, w.cam.z)).toBe(false);
    }
  });

  it('调试口挪开、落点不在墙里：滑的量清零', () => {
    const e = rigEnv();
    e.dbg.place(3.8, 4.75 + backOf(2.4), Math.PI / 2, 0.07);
    expect(e.dbg.view().slide).toBeGreaterThan(0);
    e.dbg.place(8, 6, 0, 0.07);
    expect(e.dbg.view().slide).toBe(0);
  });
});
