// 手电的反弹光（2026-10-30 ART-1）：手电照到的那一块以外全是死黑（墙纸、木地板的底色线性亮度只有 0.03–0.04，半球光照上去几乎是 0），
// 屋里读不出形状。真实的屋子里，打在地上、墙上的光会再弹回来，把旁边的墙、天花板、屋角带亮一点。
//
// 做法：不加灯（灯的数量一变所有材质都要重编，会卡）。每支手电在它的光轴先碰到的地方（地板或墙）往手电退 pullBack 米，放一个看不见的
// 「反弹点」；墙、地板、家具、天花板的材质里按到反弹点的距离和朝向加一项自发光（乘底色），见 torchBounceAt。
// - 只照落点所在的那个房间（房间地板的范围四边各外扩 pad 米：盖住本房间的墙面，不到墙的另一面），光不会穿墙漏到隔壁
// - 强度就是那支手电登记表里的 power（已经乘过紧张时的闪烁和现身时的 torchDim）：手电暗，反弹跟着同一刻、同样比例地暗，不多出一下暗闪
// - 没点亮的手电、落点离镜头超过 camReach 米的手电 w = 0，着色器里整段跳过（uniform 的 If 分支）
// - 只接在第三人称的材质上（walls.ts 的 applyDissolve、house.ts 的地板）：娃娃屋俯视不变
// 每帧在渲染前算一次落点（house.ts 放在 scene.onBeforeRender 里：访客模块写完这一帧的手电之后）。
import * as THREE from 'three/webgpu';
import { Fn, If, clamp, dot, float, length, max, smoothstep, uniform, vec3 } from 'three/tsl';
import { CELL, ROOMS, WALL_T, roomAt, type Rect, type RoomId } from '../config/house';
import { wallDistance } from './flashlight';
import { PALETTE } from './palette';
import { TORCH_COUNT, torches, type TorchSample } from './torches';

/**
 * gain：总的倍数；d0：光衰到一半的距离；reach：最远照多远（reach / 2 起慢慢收到 0）；wrap：侧对反弹点的面也亮一点；
 * pullBack：落点从碰到的地方往手电退多少；minY：落点最低多高（贴地的点照不到地板以外的东西）；
 * camReach：落点离镜头超过这么远就不算；pad：房间范围四边外扩多少。单位都是米
 */
export const TORCH_BOUNCE = {
  gain: 1.6, d0: 1.3, reach: 3.6, wrap: 0.5, pullBack: 0.3, minY: 0.15, color: new THREE.Color(PALETTE.torchHalo),
  camReach: 7, pad: 0.05,
};

/** 墙体之外、墙格之内的那一条（地板伸进墙格这么多，正好接到墙面） */
const M = (CELL - WALL_T) / 2;

/** 房间地板的米坐标范围：向四周伸进墙格 M，正好接到墙面（house.ts 的地板、月光光斑也用这一份） */
export const floorRect = (r: Rect) => ({ x0: r.x0 * CELL - M, z0: r.z0 * CELL - M, x1: r.x1 * CELL + M, z1: r.z1 * CELL + M });

/** 每支手电一组（房屋坐标）：bounceQ = 落点 xyz、强度 w（0 = 不算）；bounceRoom = 照亮的范围 (x0, z0, x1, z1) */
export const bounceQ = Array.from({ length: TORCH_COUNT }, () => uniform(new THREE.Vector4(0, -100, 0, 0)));
export const bounceRoom = Array.from({ length: TORCH_COUNT }, () => uniform(new THREE.Vector4(0, 0, 0, 0)));

export interface BounceHit {
  /** 落点（房屋坐标，y 为离地高度） */
  x: number; y: number; z: number;
  /** 照亮哪个房间、范围（地板范围四边各外扩 pad） */
  room: RoomId;
  rect: { x0: number; z0: number; x1: number; z1: number };
}

const roomOf = (x: number, z: number) => roomAt(Math.floor(x / CELL), Math.floor(z / CELL));

/**
 * 一支手电的反弹点（纯函数）：光轴先碰到地板还是墙（在格子地图上量，和光锥截断同一个 wallDistance），往手电退 pullBack 米，
 * 不低于 minY；房间按落点算，落在门洞里（不属于任何房间）就用手电自己所在的房间。
 * 手电没点亮、落点离镜头 cam 超过 camReach 米、手电和落点都不在房间里（门外）：返回 null
 */
export function bounceTarget(t: TorchSample, cam: { x: number; y: number; z: number }): BounceHit | null {
  const B = TORCH_BOUNCE;
  if (!(t.power > 0)) return null;
  const horiz = Math.hypot(t.dx, t.dz);
  const tFloor = t.y / Math.max(-t.dy, 1e-3);
  const tWall = horiz > 1e-6 ? wallDistance(t.x, t.z, Math.atan2(t.dz, t.dx), t.range) / horiz : Infinity;
  // 贴着墙拿手电时退过头会退到手电背后：最多退回到手电本身
  const s = Math.max(0, Math.min(tFloor, tWall, t.range) - B.pullBack);
  const x = t.x + t.dx * s, y = Math.max(B.minY, t.y + t.dy * s), z = t.z + t.dz * s;
  if (Math.hypot(x - cam.x, y - cam.y, z - cam.z) > B.camReach) return null;
  const room = roomOf(x, z) ?? roomOf(t.x, t.z);
  if (!room) return null;
  const r = floorRect(ROOMS[room]);
  return { x, y, z, room, rect: { x0: r.x0 - B.pad, z0: r.z0 - B.pad, x1: r.x1 + B.pad, z1: r.z1 + B.pad } };
}

/** 每帧（渲染前）调一次：按 torches.ts 的登记表把每支手电的反弹点写进 uniform。cam：镜头位置（房屋坐标） */
export function updateBounce(cam: { x: number; y: number; z: number }) {
  for (let i = 0; i < TORCH_COUNT; i++) {
    const t = torches[i];
    const h = bounceTarget(t, cam);
    const q = bounceQ[i].value;
    if (!h) {
      q.w = 0;
      continue;
    }
    q.set(h.x, h.y, h.z, t.power);
    bounceRoom[i].value.set(h.rect.x0, h.rect.z0, h.rect.x1, h.rect.z1);
  }
}

/** 全部关掉（视图销毁时） */
export function clearBounce() {
  for (const q of bounceQ) q.value.w = 0;
}

type V3n = THREE.Node<'vec3'>;

/**
 * 反弹光照到 P 点（法线 N，都是房屋坐标）的量：乘上底色就是要加的自发光。每支手电：
 *   fall = 1 / (1 + (d / d0)²) × (1 − smoothstep(reach / 2, reach, d))，nl = (N·L + wrap) / (1 + wrap)，
 *   inRoom = P 在 bounceRoom 里（四边 ±pad 的软边）；acc += color × w × fall × nl × inRoom
 * 每支包一层 If(w > 0)：没亮的手电不算。P、N 先存进变量再进分支（共享节点第一次在分支里生成、分支外读到 0 的坑，见 walls.ts 的 dissolveAt）
 */
export function torchBounceAt(P: V3n, N: V3n): V3n {
  const B = TORCH_BOUNCE;
  const col = vec3(B.color.r, B.color.g, B.color.b);
  return Fn(() => {
    const p = P.toVar();
    const n = N.toVar();
    const acc = vec3(0, 0, 0).toVar();
    for (let i = 0; i < TORCH_COUNT; i++) {
      const q = bounceQ[i], r = bounceRoom[i];
      If(q.w.greaterThan(0), () => {
        const L = q.xyz.sub(p);
        const d = length(L);
        const nl = clamp(dot(n, L.div(max(d, 1e-3))).add(B.wrap).div(1 + B.wrap), 0, 1);
        const k = d.div(B.d0);
        const fall = float(1).div(k.mul(k).add(1)).mul(float(1).sub(smoothstep(B.reach * 0.5, B.reach, d)));
        const e = B.pad;
        const inRoom = smoothstep(-e, e, p.x.sub(r.x)).mul(smoothstep(-e, e, r.z.sub(p.x)))
          .mul(smoothstep(-e, e, p.z.sub(r.y))).mul(smoothstep(-e, e, r.w.sub(p.z)));
        acc.addAssign(col.mul(q.w.mul(fall).mul(nl).mul(inRoom)));
      });
    }
    return acc.mul(B.gain);
  })() as unknown as V3n;
}
