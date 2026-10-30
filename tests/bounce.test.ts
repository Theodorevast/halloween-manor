// 手电的反弹光（2026-10-30 ART-1，src/view/bounce.ts）：每支手电的「反弹点」怎么算、怎么跟着手电走。
// 着色器那一半（torchBounceAt）靠截图验收；这里测 CPU 上的事：
// - 落点（bounceTarget）：光轴先碰到地板还是墙、往手电退 pullBack、落点在哪个房间（门洞里用手电自己的房间）、门外的手电不算
// - 跟着手电走（updateBounce，修复第 1 轮）：落点低通、换房间要占上风一阵才换、换的时候旧的淡出新的淡入、离镜头 6–7 米淡出。
//   按 60 Hz 走真的手电（createFlashlight，紧张时光轴在抖）、真的灯闪（lightfx + ghost.ts 的 manifestLights），
//   用 bounceLevelAt（CPU 上照着色器算的同一个量）取一个固定表面点上的反弹亮度，countDips 数「暗一下」
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { CELL, ROOMS, roomAt } from '../src/config/house';
import { MANIFEST } from '../src/config/visitors';
import type { RenderCore } from '../src/engine/types';
import type { WorldState } from '../src/sim/types';
import {
  BOUNCE_SLOTS, TORCH_BOUNCE, bounceCamFade, bounceLevelAt, bounceQ, bounceRoom, bounceTarget, clearBounce, floorRect, updateBounce,
} from '../src/view/bounce';
import { createFlashlight, wallDistance } from '../src/view/flashlight';
import { manifestLights } from '../src/view/ghost';
import { countDips, createLightFx } from '../src/view/lightfx';
import { TORCH_COUNT, torchDim, torches, type TorchSample } from '../src/view/torches';

const B = TORCH_BOUNCE;
const HZ = 60;
const DT = 1 / HZ;
/** 照 flashlight.ts：光轴指向 lookDir 方向 aim 米外的地面 */
function torch(x: number, y: number, z: number, aimX: number, aimY: number, aimZ: number, power = 1): TorchSample {
  const dx = aimX - x, dy = aimY - y, dz = aimZ - z;
  const l = Math.hypot(dx, dy, dz);
  return { x, y, z, dx: dx / l, dy: dy / l, dz: dz / l, angle: 0.58, range: 9.1, power };
}
const near = { x: 6, y: 1.8, z: 6 };
/** 房间地板的范围四边各外扩 pad：盖住本房间的墙面，不到墙另一面 */
const padded = (id: keyof typeof ROOMS) => {
  const r = floorRect(ROOMS[id]);
  return { x0: r.x0 - B.pad, z0: r.z0 - B.pad, x1: r.x1 + B.pad, z1: r.z1 + B.pad };
};
const saved = torches.map((t) => ({ ...t }));
afterEach(() => {
  torches.forEach((t, i) => Object.assign(t, saved[i]));
  for (let i = 0; i < TORCH_COUNT; i++) torchDim[i] = 1;
  clearBounce();
});

describe('手电的反弹点（bounceTarget）', () => {
  it('落在地板上：光轴碰到地面的地方往手电退 pullBack 米，高度不低于 minY；房间是落点所在的房间', () => {
    // 走廊（z 5–7 米）里往东照 3.5 米外的地面，东边 10 米内没有墙
    const t = torch(4, 1, 6, 7.5, 0, 6);
    const h = bounceTarget(t)!;
    expect(h).not.toBeNull();
    const tFloor = t.y / -t.dy;
    const s = tFloor - B.pullBack;
    expect(h.x).toBeCloseTo(t.x + t.dx * s, 6);
    expect(h.z).toBeCloseTo(t.z + t.dz * s, 6);
    expect(t.y + t.dy * s).toBeLessThan(B.minY);
    expect(h.y).toBe(B.minY);
    expect(h.room).toBe('hall');
    expect(h.rect).toEqual(padded('hall'));
  });

  it('落在墙上：碰墙的地方往手电退 pullBack 米（沿光轴），落点还在手电这一侧的房间里', () => {
    // 走廊里往北照：北墙（客厅和走廊之间，z 4.5–5 那一格）比地面先碰到
    const t = torch(6.4, 1, 6.4, 6.4, 0, 2.9);
    const h = bounceTarget(t)!;
    const horiz = Math.hypot(t.dx, t.dz);
    const tWall = wallDistance(t.x, t.z, Math.atan2(t.dz, t.dx), t.range) / horiz;
    expect(tWall).toBeLessThan(t.y / -t.dy);
    const s = tWall - B.pullBack;
    expect(h.x).toBeCloseTo(t.x + t.dx * s, 6);
    expect(h.y).toBeCloseTo(t.y + t.dy * s, 6);
    expect(h.z).toBeCloseTo(t.z + t.dz * s, 6);
    // 离碰墙那一点正好 pullBack 米
    const hit = { x: t.x + t.dx * tWall, y: t.y + t.dy * tWall, z: t.z + t.dz * tWall };
    expect(Math.hypot(hit.x - h.x, hit.y - h.y, hit.z - h.z)).toBeCloseTo(B.pullBack, 6);
    expect(roomAt(Math.floor(h.x / CELL), Math.floor(h.z / CELL))).toBe('hall');
    expect(h.room).toBe('hall');
  });

  it('手电关着（power ≤ 0）：没有反弹', () => {
    expect(bounceTarget(torch(4, 1, 6, 7.5, 0, 6, 0))).toBeNull();
    expect(bounceTarget(torch(4, 1, 6, 7.5, 0, 6, -0.1))).toBeNull();
  });

  it('落点在门洞里（不属于任何房间）：用手电自己所在的房间', () => {
    // 走廊里朝客厅的门洞（第 15、16 列，第 9 行）往下照，落点退回来以后还在门洞那一格
    const t = torch(8, 1, 6.5, 8, 0, 4.5);
    const h = bounceTarget(t)!;
    expect(roomAt(Math.floor(h.x / CELL), Math.floor(h.z / CELL))).toBeNull();
    expect(Math.floor(h.z / CELL)).toBe(9);
    expect(h.room).toBe('hall');
    expect(h.rect).toEqual(padded('hall'));
  });

  it('穿过门洞照进隔壁的地板：落点在哪个房间就用哪个房间（只照亮那一边）', () => {
    // 走廊里往北照，光从客厅的门洞穿过去，落在客厅的地板上
    const t = torch(8, 1, 6.2, 8, 0, 2.7);
    const h = bounceTarget(t)!;
    expect(h.room).toBe('living');
    expect(h.rect).toEqual(padded('living'));
  });

  it('门外的手电（格子外面）不算：朝屋里照时门还关着、照不进来；往外照也没有墙可反弹', () => {
    // 访客在门外 (8.0, 13.2) 出现，手电照 3.5 米外的地面：以前落点算在门厅地板上，门还没推开门厅就先亮一块
    expect(bounceTarget(torch(8, 0.8, 13.2, 8, 0, 9.7))).toBeNull();
    expect(bounceTarget(torch(8, 1, 13.2, 8, 0, 16.7))).toBeNull();
    // 进了门（格子里，门槛那一格）就照算
    expect(bounceTarget(torch(8, 0.8, 11.8, 8, 0, 8.3))?.room).toBe('foyer');
  });
});

describe('离镜头 6–7 米淡出（bounceCamFade）', () => {
  it('6 米以内是 1，7 米以外是 0，中间一路只往下、没有台阶', () => {
    expect(bounceCamFade(0)).toBe(1);
    expect(bounceCamFade(B.camFade[0])).toBe(1);
    expect(bounceCamFade(B.camFade[1])).toBe(0);
    expect(bounceCamFade(9)).toBe(0);
    let prev = 1;
    for (let d = B.camFade[0]; d <= B.camFade[1] + 1e-9; d += 0.01) {
      const v = bounceCamFade(d);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      expect(prev - v).toBeLessThan(0.03);
      prev = v;
    }
  });
});

describe('updateBounce：每支手电写进 uniform（每支两组：现在的、正在淡出的）', () => {
  it('点亮的手电走 1 秒以后：落点 = bounceTarget、w = power（已经乘过紧张闪烁和 torchDim）、房间范围；没点亮的、淡出那一组 w = 0', () => {
    for (const t of torches) t.power = 0;
    Object.assign(torches[1], torch(4, 1, 6, 7.5, 0, 6, 0.8));
    for (let k = 0; k < HZ; k++) updateBounce(near, DT);
    const h = bounceTarget(torches[1])!;
    const q = bounceQ[2].value, r = bounceRoom[2].value;
    expect(q.x).toBeCloseTo(h.x, 9);
    expect(q.y).toBeCloseTo(h.y, 9);
    expect(q.z).toBeCloseTo(h.z, 9);
    expect(q.w).toBeCloseTo(0.8, 9);
    expect([r.x, r.y, r.z, r.w]).toEqual([h.rect.x0, h.rect.z0, h.rect.x1, h.rect.z1]);
    for (let i = 0; i < BOUNCE_SLOTS; i++) if (i !== 2) expect(bounceQ[i].value.w).toBe(0);
    // 灯一灭（power 0）同一帧就是 0：和手电同一刻暗
    torches[1].power = 0;
    updateBounce(near, DT);
    expect(bounceQ[2].value.w).toBe(0);
  });

  it('第一次点亮：从 0 慢慢起来（fade 秒），不一下子跳满', () => {
    for (const t of torches) t.power = 0;
    Object.assign(torches[0], torch(4, 1, 6, 7.5, 0, 6, 1));
    const w: number[] = [];
    for (let k = 0; k < HZ; k++) {
      updateBounce(near, DT);
      w.push(bounceQ[0].value.w);
    }
    expect(w[0]).toBeLessThan(0.1);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThanOrEqual(w[i - 1]);
    expect(w[Math.ceil(B.fade * HZ) + 1]).toBeCloseTo(1, 9);
  });
});

// ── 按 60 Hz 数一个固定表面点上的反弹亮度 ─────────────────────────────────────────────

/** 真的手电（这个文件里只建这一支，登记表的槽在第一次 update 之后找） */
const lamp = createFlashlight(new THREE.Group(), 'high', 1.7);

type P3 = { x: number; y: number; z: number };
interface Probe { P: P3; N: P3 }
interface Run {
  /** 手电的位置（房屋坐标，高 0.8 米）、照向（方向角，可以随时间转：访客转身）；一直紧张 */
  pose: { x: number; z: number; dir: number | ((time: number) => number) };
  /** 镜头（房屋坐标），可以随时间动 */
  cam: (time: number) => P3;
  probes: Probe[];
  /** 先走 warm 秒（紧张程度起来、落点稳下来），再记 seconds 秒 */
  warm: number;
  seconds: number;
  /** 附近现身（真的 lightfx，中心在手电那里）：蓄力在记录开始后这么多秒 */
  manifest?: number;
}

/** 每个探测点一串亮度（按这一串里最亮的一帧归一），外加手电自己的 power（同样归一），每秒 60 个；peak 是归一之前的最亮值 */
function record(s: Run): { probes: number[][]; power: number[]; peak: number[] } {
  clearBounce();
  const fx = s.manifest !== undefined ? createLightFx({ scene: new THREE.Scene(), houseRoot: new THREE.Group() } as unknown as RenderCore) : null;
  const at = { x: s.pose.x, z: s.pose.z };
  const windup = s.manifest !== undefined ? Math.round((s.warm + s.manifest) * HZ) : -1;
  const drop = windup + Math.round(MANIFEST.windup * HZ), end = drop + Math.round(MANIFEST.hold * HZ);
  let release: (() => void) | null = null;
  const probes: number[][] = s.probes.map(() => []);
  const power: number[] = [];
  let slot = -1;
  try {
    const total = Math.round((s.warm + s.seconds) * HZ);
    for (let k = 0; k < total; k++) {
      const time = k / HZ;
      if (fx && k === windup) manifestLights(fx, 'windup', at);
      if (fx && k === drop) release = manifestLights(fx, 'drop', at);
      if (fx && k === end) {
        release?.();
        manifestLights(fx, 'end', at);
      }
      // 主循环里的顺序：访客（手电）先写登记表，灯闪后写 torchDim（手电下一帧才乘上），渲染前算反弹
      const dir = typeof s.pose.dir === 'function' ? s.pose.dir(time) : s.pose.dir;
      lamp.update({ x: s.pose.x, y: 0.8, z: s.pose.z, dir, power: 1, nervous: true }, DT, time);
      if (slot < 0) slot = torches.findIndex((t) => t.x === s.pose.x && t.z === s.pose.z && t.power > 0);
      fx?.update({ dt: DT, time, state: {} as WorldState });
      updateBounce(s.cam(time), DT);
      if (k < s.warm * HZ) continue;
      s.probes.forEach((p, i) => probes[i].push(bounceLevelAt(p.P, p.N)));
      power.push(torches[slot].power);
    }
  } finally {
    fx?.dispose();
    lamp.park();
  }
  const norm = (a: number[]) => {
    const m = Math.max(...a);
    return m > 0 ? a.map((v) => v / m) : a;
  };
  return { probes: probes.map(norm), power: norm(power), peak: probes.map((a) => Math.max(...a)) };
}

/** 一个探测点在不在这一次的反弹光里（亮度够得上）：不在的那一边整段是 0，数不出东西 */
const lit = (peak: number) => peak > 0.01;

describe('反弹光不跟着手电以外的东西开关（countDips 按 60 Hz 数）', () => {
  // 走廊里正对客厅门洞的西门框（x = 7.5）往北照：紧张时光轴左右抖，一下打在门框西边的墙上（走廊），一下穿过门洞落在客厅地板上
  const doorFrame: Run = {
    pose: { x: 7.5, z: 6.4, dir: -Math.PI / 2 },
    cam: () => ({ x: 9.5, y: 1.9, z: 6.6 }),
    probes: [
      { P: { x: 7.25, y: 1.0, z: 4.85 }, N: { x: 0, y: 0, z: 1 } }, // 走廊北墙，门框西边
      { P: { x: 8.0, y: 0, z: 4.0 }, N: { x: 0, y: 1, z: 0 } }, // 客厅地板，门洞北边
    ],
    warm: 1.5,
    seconds: 3,
  };

  it('紧张的手电扫在门框边上：门框两边的墙面、地板上都数不出一下暗（落点去抖、房间不来回换）', () => {
    const r = record(doorFrame);
    expect(r.peak.some(lit)).toBe(true);
    r.probes.forEach((levels, i) => {
      if (lit(r.peak[i])) expect(countDips(levels, HZ)).toBe(0);
    });
  });

  it('紧张的手电扫在墙的端头上（客厅里斜着照向门洞东边的墙角）：墙这一边、门洞那一边都数不出一下暗', () => {
    const corner = { x: 8.5, z: 4.5 };
    const from = { x: 9.5, z: 3.3 };
    const r = record({
      pose: { ...from, dir: Math.atan2(corner.z - from.z, corner.x - from.x) },
      cam: () => ({ x: 11.5, y: 1.9, z: 2.2 }),
      probes: [
        { P: { x: 8.9, y: 1.0, z: 4.65 }, N: { x: 0, y: 0, z: -1 } }, // 客厅南墙，门洞东边
        { P: { x: 7.6, y: 0, z: 6.2 }, N: { x: 0, y: 1, z: 0 } }, // 走廊地板
      ],
      warm: 1.5,
      seconds: 3,
    });
    expect(r.peak.some(lit)).toBe(true);
    r.probes.forEach((levels, i) => {
      if (lit(r.peak[i])) expect(countDips(levels, HZ)).toBe(0);
    });
  });

  it('落点在离镜头 7 米那一圈上抖（以前一刀切）：镜头慢慢退开、离落点从 5.9 米走到 7.7 米，最多是一次慢慢变暗', () => {
    // 走廊里往东照，落点约在 (6.2, 0.15, 6.0)；镜头在它南边（房子外面）慢慢退开
    const landing = { x: 6.21, z: 6.0 };
    const dist = (time: number) => 5.9 + Math.max(0, time - 1.5) * 0.45;
    const r = record({
      pose: { x: 3.0, z: 6.0, dir: 0 },
      cam: (time) => ({ x: landing.x, y: 1.8, z: landing.z + Math.sqrt(dist(time) ** 2 - 1.65 ** 2) }),
      probes: [{ P: { x: 6.0, y: 0, z: 5.6 }, N: { x: 0, y: 1, z: 0 } }],
      warm: 1.5,
      seconds: 4,
    });
    expect(lit(r.peak[0])).toBe(true);
    expect(countDips(r.probes[0], HZ)).toBeLessThanOrEqual(1);
    // 退到 7.7 米时已经淡完
    expect(r.probes[0].at(-1)).toBeLessThan(0.01);
  });

  it('镜头停在淡出带中间（6.5 米），落点还在抖：数不出一下暗', () => {
    const landing = { x: 6.21, z: 6.0 };
    const r = record({
      pose: { x: 3.0, z: 6.0, dir: 0 },
      cam: () => ({ x: landing.x, y: 1.8, z: landing.z + Math.sqrt(6.5 ** 2 - 1.65 ** 2) }),
      probes: [{ P: { x: 6.0, y: 0, z: 5.6 }, N: { x: 0, y: 1, z: 0 } }],
      warm: 1.5,
      seconds: 3,
    });
    expect(lit(r.peak[0])).toBe(true);
    expect(countDips(r.probes[0], HZ)).toBe(0);
  });

  it('叠上附近现身的灯闪（真的 lightfx，按 manifestLights 调），手电还扫在门框边上：反弹光暗下去的次数不超过手电自己的，任意 1 秒最多 3 下', () => {
    for (const at of [0.2, 0.55, 0.9]) {
      const r = record({ ...doorFrame, seconds: 3.4, manifest: at });
      const own = countDips(r.power, HZ);
      expect(own).toBeLessThanOrEqual(3);
      expect(r.peak.some(lit)).toBe(true);
      r.probes.forEach((levels, i) => {
        if (!lit(r.peak[i])) return;
        const n = countDips(levels, HZ);
        expect(n).toBeLessThanOrEqual(3);
        expect(n).toBeLessThanOrEqual(own);
      });
    }
  });

  it('现身落下后访客转身、光轴扫过门洞照进隔壁（落下后 0–0.6 秒逐帧起步）：旧房间墙上那一点任意 1 秒最多 3 下，压暗松开以后才淡出（整体审查 I-1）', () => {
    // 走廊里站在门洞正南，斜着照北墙（门洞西边），落下以后转过去、穿过门洞照客厅地板。蓄力两下 + 落下一下已经是 3 下：
    // 旧房间那一组要是在落下后那一秒里淡出，就是第 4 下
    const pose = { x: 8.0, z: 6.4 };
    const from = Math.atan2(2.9 - pose.z, 6.4 - pose.x), to = -Math.PI / 2;
    const warm = 1.5, at = 0.3, turn = 0.15;
    const dropAt = (Math.round((warm + at) * HZ) + Math.round(MANIFEST.windup * HZ)) / HZ;
    const probe = { P: { x: 6.9, y: 1.0, z: 4.85 }, N: { x: 0, y: 0, z: 1 } }; // 走廊北墙，门框西边
    for (let f = 0; f <= Math.round(MANIFEST.windup * HZ); f++) {
      const t0 = dropAt + f / HZ;
      const r = record({
        pose: { ...pose, dir: (time) => from + (to - from) * Math.min(1, Math.max(0, (time - t0) / turn)) },
        cam: () => ({ x: 8.5, y: 1.9, z: 7.0 }),
        probes: [probe],
        warm,
        seconds: 4.5,
        manifest: at,
      });
      expect(lit(r.peak[0])).toBe(true);
      expect(countDips(r.probes[0], HZ)).toBeLessThanOrEqual(3);
      // 压暗松开以后照样换过去：旧房间最后淡完
      expect(r.probes[0].at(-1)).toBeLessThan(0.01);
    }
  });

  it('落点九成时间没有（比如手电站在门洞格里斜擦门洞侧面）、一成落在房间里：只淡出一次，不会一圈圈地清空、放下、再清空（复审 M-5）', () => {
    clearBounce();
    for (const t of torches) t.power = 0;
    const inside = torch(8, 0.8, 11.8, 8, 0, 8.3); // 门槛那一格往北照：落在门厅地板上
    const outside = torch(8, 0.8, 13.2, 8, 0, 9.7); // 门外：没有落点
    const probe = { P: { x: 8.3, y: 0, z: 9.0 }, N: { x: 0, y: 1, z: 0 } };
    Object.assign(torches[0], inside);
    for (let k = 0; k < HZ; k++) updateBounce(near, DT);
    const top = bounceLevelAt(probe.P, probe.N);
    expect(top).toBeGreaterThan(0.01);
    const levels: number[] = [];
    for (let k = 0; k < 3 * HZ; k++) {
      Object.assign(torches[0], k % 10 === 9 ? inside : outside);
      updateBounce(near, DT);
      levels.push(bounceLevelAt(probe.P, probe.N) / top);
    }
    expect(countDips([1, ...levels], HZ)).toBe(1);
    expect(levels.at(-1)).toBeLessThan(0.01);
  });

  it('真的转过去照隔壁（不是抖）：旧房间慢慢淡出（不少于 0.2 秒，一路只往下），新房间慢慢亮起来', () => {
    clearBounce();
    for (const t of torches) t.power = 0;
    // 先照走廊北墙，再转向穿过门洞照客厅地板
    const wall = torch(6.4, 0.8, 6.4, 6.4, 0, 2.9);
    const through = torch(8.0, 0.8, 6.4, 8.0, 0, 2.9);
    const probe = { P: { x: 6.4, y: 1.0, z: 4.85 }, N: { x: 0, y: 0, z: 1 } };
    Object.assign(torches[0], wall);
    for (let k = 0; k < HZ; k++) updateBounce(near, DT);
    const top = bounceLevelAt(probe.P, probe.N);
    expect(top).toBeGreaterThan(0.01);
    Object.assign(torches[0], through);
    const levels: number[] = [];
    for (let k = 0; k < 2 * HZ; k++) {
      updateBounce(near, DT);
      levels.push(bounceLevelAt(probe.P, probe.N) / top);
    }
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] + 1e-9);
    const from = levels.findIndex((v) => v < 0.9), to = levels.findIndex((v) => v < 0.1);
    expect(to - from).toBeGreaterThanOrEqual(0.2 * HZ);
    expect(levels.at(-1)).toBeLessThan(0.01);
    expect(countDips([1, ...levels], HZ)).toBe(1);
    // 新房间那一组亮起来了
    expect(bounceLevelAt({ x: 8.0, y: 0, z: 3.6 }, { x: 0, y: 1, z: 0 })).toBeGreaterThan(0.01);
  });
});
