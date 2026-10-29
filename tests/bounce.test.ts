// 手电的反弹光（2026-10-30 ART-1，src/view/bounce.ts）：每支手电的「反弹点」怎么算。
// 着色器那一半（torchBounceAt）靠截图验收；这里测 CPU 上的落点：光轴先碰到地板还是墙、往手电退 pullBack、
// 落点在哪个房间（门洞里用手电自己的房间）、手电关着或者落点离镜头太远就不算，以及 updateBounce 写进 uniform 的值。
import { afterEach, describe, expect, it } from 'vitest';
import { CELL, ROOMS, roomAt } from '../src/config/house';
import { TORCH_BOUNCE, bounceQ, bounceRoom, bounceTarget, floorRect, updateBounce } from '../src/view/bounce';
import { wallDistance } from '../src/view/flashlight';
import { TORCH_COUNT, torches, type TorchSample } from '../src/view/torches';

const B = TORCH_BOUNCE;
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

describe('手电的反弹点（bounceTarget）', () => {
  it('落在地板上：光轴碰到地面的地方往手电退 pullBack 米，高度不低于 minY；房间是落点所在的房间', () => {
    // 走廊（z 5–7 米）里往东照 3.5 米外的地面，东边 10 米内没有墙
    const t = torch(4, 1, 6, 7.5, 0, 6);
    const h = bounceTarget(t, near)!;
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
    const h = bounceTarget(t, near)!;
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
    expect(bounceTarget(torch(4, 1, 6, 7.5, 0, 6, 0), near)).toBeNull();
    expect(bounceTarget(torch(4, 1, 6, 7.5, 0, 6, -0.1), near)).toBeNull();
  });

  it('落点离镜头超过 7 米：不算（省掉看不见的那几支）；7 米以内照算', () => {
    const t = torch(4, 1, 6, 7.5, 0, 6);
    const h = bounceTarget(t, near)!;
    const far = { x: h.x + 7.2, y: 1.8, z: h.z };
    expect(Math.hypot(far.x - h.x, far.y - h.y, far.z - h.z)).toBeGreaterThan(B.camReach);
    expect(bounceTarget(t, far)).toBeNull();
    expect(bounceTarget(t, { x: h.x + 6.5, y: h.y, z: h.z })).not.toBeNull();
  });

  it('落点在门洞里（不属于任何房间）：用手电自己所在的房间', () => {
    // 走廊里朝客厅的门洞（第 15、16 列，第 9 行）往下照，落点退回来以后还在门洞那一格
    const t = torch(8, 1, 6.5, 8, 0, 4.5);
    const h = bounceTarget(t, near)!;
    expect(roomAt(Math.floor(h.x / CELL), Math.floor(h.z / CELL))).toBeNull();
    expect(Math.floor(h.z / CELL)).toBe(9);
    expect(h.room).toBe('hall');
    expect(h.rect).toEqual(padded('hall'));
  });

  it('穿过门洞照进隔壁的地板：落点在哪个房间就用哪个房间（只照亮那一边）', () => {
    // 走廊里往北照，光从客厅的门洞穿过去，落在客厅的地板上
    const t = torch(8, 1, 6.2, 8, 0, 2.7);
    const h = bounceTarget(t, near)!;
    expect(h.room).toBe('living');
    expect(h.rect).toEqual(padded('living'));
  });

  it('手电和落点都不在房间里（门外的台阶上）：没有反弹', () => {
    // 门外往南照
    expect(bounceTarget(torch(8, 1, 13.2, 8, 0, 16.7), { x: 8, y: 1.8, z: 12 })).toBeNull();
  });
});

describe('updateBounce：每支手电写一组 uniform', () => {
  const saved = torches.map((t) => ({ ...t }));
  afterEach(() => {
    torches.forEach((t, i) => Object.assign(t, saved[i]));
    updateBounce(near);
  });

  it('点亮的写落点和强度（w = power，已经乘过紧张闪烁和 torchDim）、房间范围；没点亮的 w = 0', () => {
    for (const t of torches) t.power = 0;
    Object.assign(torches[1], torch(4, 1, 6, 7.5, 0, 6, 0.8));
    updateBounce(near);
    const h = bounceTarget(torches[1], near)!;
    const q = bounceQ[1].value, r = bounceRoom[1].value;
    expect([q.x, q.y, q.z, q.w]).toEqual([h.x, h.y, h.z, 0.8]);
    expect([r.x, r.y, r.z, r.w]).toEqual([h.rect.x0, h.rect.z0, h.rect.x1, h.rect.z1]);
    for (let i = 0; i < TORCH_COUNT; i++) if (i !== 1) expect(bounceQ[i].value.w).toBe(0);
    // 关掉以后下一帧就是 0
    torches[1].power = 0;
    updateBounce(near);
    expect(bounceQ[1].value.w).toBe(0);
  });
});
