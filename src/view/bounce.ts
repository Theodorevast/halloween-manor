// 手电的反弹光（2026-10-30 ART-1）：手电照到的那一块以外全是死黑（墙纸、木地板的底色线性亮度只有 0.03–0.04，半球光照上去几乎是 0），
// 屋里读不出形状。真实的屋子里，打在地上、墙上的光会再弹回来，把旁边的墙、天花板、屋角带亮一点。
//
// 做法：不加灯（灯的数量一变所有材质都要重编，会卡）。每支手电在它的光轴先碰到的地方（地板或墙）往手电退 pullBack 米，放一个看不见的
// 「反弹点」；墙、地板、家具、天花板的材质里按到反弹点的距离和朝向加一项自发光（乘底色），见 torchBounceAt。
// - 只照落点所在的那个房间（房间地板的范围四边各外扩 pad 米：盖住本房间的墙面，不到墙的另一面），光不会穿墙漏到隔壁
// - 强度跟着那支手电登记表里的 power（已经乘过紧张时的闪烁和现身时的 torchDim）：手电暗，反弹跟着同一刻、同样比例地暗，不多出一下暗闪
// - 没点亮的手电、落点离镜头 7 米外的 w = 0，着色器里整段跳过（uniform 的 If 分支）
// - 只接在第三人称的材质上（walls.ts 的 applyDissolve、house.ts 的地板、frontDoor.ts 的门）：娃娃屋俯视不变
// 每帧在渲染前算一次落点（house.ts 放在 scene.onBeforeRender 里：访客模块写完这一帧的手电之后）。
//
// 跟着手电走，不自己开关（修复第 1 轮，审查 I-1）：落点只按一条光轴算，紧张时光轴在抖（flashlight.ts 的 nervous.jitter，±0.035 弧度、
// 约 3.3 Hz）。扫到门框边、墙的端头时，落点会在「这面墙前」和「隔壁地板上」之间来回跳，一个房间的反弹光就整块开、整块关
// （每秒 3 下多，叠上现身的灯闪就超过 countDips 的 3 下）；落点在离镜头 7 米那一圈上抖时也是一样。所以每支手电留一份平滑过的状态：
// - 落点低通（两级，每级 tau 秒：一级的话抖动只压到约 1/5，离落点 1–3 米的墙面上还剩 ±2–3% 的起伏，叠上手电自己 8% 的紧张闪烁
//   就会被数成一下暗；两级压到约 1/18）；落点跑到别的房间（或者没有落点）时先不跟，要在那边连着占上风 hold 秒才换（漏桶：回到原来的房间按同样的速度往回扣），
//   来回抖的时候就一直不换；真的转过去了才换，换的时候旧房间那一组淡出、新房间那一组淡入（fade 秒），所以每支手电在着色器里占两组
// - 离镜头 camFade[0]..camFade[1] 米淡出（不再 7 米一刀切），淡出的系数再低通 camTau 秒
// - 门外（格子外面）的手电不算：门还关着的时候光照不进来，往外照也没有墙可反弹
import * as THREE from 'three/webgpu';
import { Fn, If, clamp, dot, float, length, max, smoothstep, uniform, vec3 } from 'three/tsl';
import { CELL, ROOMS, WALL_T, inGrid, roomAt, type Rect, type RoomId } from '../config/house';
import { wallDistance } from './flashlight';
import { PALETTE } from './palette';
import { TORCH_COUNT, torchDim, torches, type TorchSample } from './torches';

/**
 * gain：总的倍数；d0：光衰到一半的距离；reach：最远照多远（reach / 2 起慢慢收到 0）；wrap：侧对反弹点的面也亮一点；
 * pullBack：落点从碰到的地方往手电退多少；minY：落点最低多高（贴地的点照不到地板以外的东西）；pad：房间范围四边外扩多少。单位都是米。
 * 跟着手电走（见文件开头）：camFade 离镜头多远开始淡出、多远没有（米）；tau 落点低通每一级的时间常数（两级）、camTau 淡出系数的低通（秒）；
 * hold 落点换到别的房间要连着占上风多久才换、fade 换的时候旧的淡出新的淡入多久（秒）。hold 不能比 fade 短：
 * 上一次换下来的那一组淡完之前不会再换，两组够用，不会有哪一组被顶掉、一下子没了
 */
export const TORCH_BOUNCE = {
  gain: 1.6, d0: 1.3, reach: 3.6, wrap: 0.5, pullBack: 0.3, minY: 0.15, color: new THREE.Color(PALETTE.torchHalo), pad: 0.05,
  camFade: [6, 7] as [number, number],
  tau: 0.2,
  camTau: 0.5,
  hold: 0.3,
  fade: 0.3,
};

/** 着色器里的组数：每支手电两组（现在照着的房间、刚换下来正在淡出的房间） */
export const BOUNCE_SLOTS = TORCH_COUNT * 2;

/** 墙体之外、墙格之内的那一条（地板伸进墙格这么多，正好接到墙面） */
const M = (CELL - WALL_T) / 2;

/** 房间地板的米坐标范围：向四周伸进墙格 M，正好接到墙面（house.ts 的地板、月光光斑也用这一份） */
export const floorRect = (r: Rect) => ({ x0: r.x0 * CELL - M, z0: r.z0 * CELL - M, x1: r.x1 * CELL + M, z1: r.z1 * CELL + M });

/**
 * 每组一份（房屋坐标）：bounceQ = 落点 xyz、强度 w（0 = 不算）；bounceRoom = 照亮的范围 (x0, z0, x1, z1)。
 * 第 i 支手电用第 2i 组（现在的）、第 2i + 1 组（正在淡出的）
 */
export const bounceQ = Array.from({ length: BOUNCE_SLOTS }, () => uniform(new THREE.Vector4(0, -100, 0, 0)));
export const bounceRoom = Array.from({ length: BOUNCE_SLOTS }, () => uniform(new THREE.Vector4(0, 0, 0, 0)));

type P3 = { x: number; y: number; z: number };
type Rect4 = { x0: number; z0: number; x1: number; z1: number };

export interface BounceHit {
  /** 落点（房屋坐标，y 为离地高度） */
  x: number; y: number; z: number;
  /** 照亮哪个房间、范围（地板范围四边各外扩 pad） */
  room: RoomId;
  rect: Rect4;
}

const roomOf = (x: number, z: number) => roomAt(Math.floor(x / CELL), Math.floor(z / CELL));

/**
 * 一支手电此刻的反弹点（纯函数，没有平滑）：光轴先碰到地板还是墙（在格子地图上量，和光锥截断同一个 wallDistance），往手电退 pullBack 米，
 * 不低于 minY；房间按落点算，落在门洞里（不属于任何房间）就用手电自己所在的房间。
 * 手电没点亮、手电在门外（格子外面）、手电和落点都不在房间里：返回 null
 */
export function bounceTarget(t: TorchSample): BounceHit | null {
  const B = TORCH_BOUNCE;
  if (!(t.power > 0)) return null;
  if (!inGrid(Math.floor(t.x / CELL), Math.floor(t.z / CELL))) return null;
  const horiz = Math.hypot(t.dx, t.dz);
  const tFloor = t.y / Math.max(-t.dy, 1e-3);
  const tWall = horiz > 1e-6 ? wallDistance(t.x, t.z, Math.atan2(t.dz, t.dx), t.range) / horiz : Infinity;
  // 贴着墙拿手电时退过头会退到手电背后：最多退回到手电本身
  const s = Math.max(0, Math.min(tFloor, tWall, t.range) - B.pullBack);
  const x = t.x + t.dx * s, y = Math.max(B.minY, t.y + t.dy * s), z = t.z + t.dz * s;
  const room = roomOf(x, z) ?? roomOf(t.x, t.z);
  if (!room) return null;
  const r = floorRect(ROOMS[room]);
  return { x, y, z, room, rect: { x0: r.x0 - B.pad, z0: r.z0 - B.pad, x1: r.x1 + B.pad, z1: r.z1 + B.pad } };
}

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 落点离镜头 d 米时的系数：camFade[0] 米以内 1，camFade[1] 米以外 0，中间 smoothstep */
export const bounceCamFade = (d: number) => 1 - sm(TORCH_BOUNCE.camFade[0], TORCH_BOUNCE.camFade[1], d);

/** 一组反弹（一个房间）：room 为 null = 空着；x, y, z 低通过的落点（m* 是第一级）；k 淡入淡出（0..1）；cam 离镜头远近的淡出系数（低通过的） */
interface Glow { room: RoomId | null; rect: Rect4; x: number; y: number; z: number; mx: number; my: number; mz: number; k: number; cam: number }
/** 一支手电的平滑状态：now 现在照着的房间、old 刚换下来正在淡出的房间；pend / pendT 落点跑到哪个房间（null = 没有落点）、在那边占上风多久了 */
interface Track { now: Glow; old: Glow; pend: RoomId | null | undefined; pendT: number; dropped: boolean }

const idleGlow = (): Glow => ({ room: null, rect: { x0: 0, z0: 0, x1: 0, z1: 0 }, x: 0, y: -100, z: 0, mx: 0, my: -100, mz: 0, k: 0, cam: 0 });
const tracks: Track[] = Array.from({ length: TORCH_COUNT }, () => ({ now: idleGlow(), old: idleGlow(), pend: undefined, pendT: 0, dropped: false }));

const camDist = (g: P3, cam: P3) => Math.hypot(g.x - cam.x, g.y - cam.y, g.z - cam.z);

function place(g: Glow, h: BounceHit, cam: P3) {
  g.room = h.room;
  g.rect = { ...h.rect };
  g.x = g.mx = h.x; g.y = g.my = h.y; g.z = g.mz = h.z;
  g.k = 0;
  g.cam = bounceCamFade(camDist(h, cam));
}

function write(slot: number, g: Glow, power: number) {
  const w = g.room ? power * g.k * g.cam : 0;
  bounceQ[slot].value.set(g.x, g.y, g.z, w > 0 ? w : 0);
  bounceRoom[slot].value.set(g.rect.x0, g.rect.z0, g.rect.x1, g.rect.z1);
}

/**
 * 每帧（渲染前）调一次：按 torches.ts 的登记表推进每支手电的平滑状态（见文件开头），写进 uniform。
 * cam：镜头位置（房屋坐标）；dt：这一帧的秒数
 */
export function updateBounce(cam: P3, dt: number) {
  const B = TORCH_BOUNCE;
  const kPoint = 1 - Math.exp(-dt / B.tau), kCam = 1 - Math.exp(-dt / B.camTau), step = dt / B.fade;
  for (let i = 0; i < TORCH_COUNT; i++) {
    const t = torches[i], tr = tracks[i];
    if (!(t.power > 0)) {
      // 灭了（空闲的手电、访客淡入的第一帧）：w 本来就是 0，状态清掉，下一次点亮从落点重新开始
      tr.now = idleGlow();
      tr.old = idleGlow();
      tr.pend = undefined;
      tr.pendT = 0;
      tr.dropped = false;
    } else {
      const h = bounceTarget(t);
      const now = tr.now;
      if (now.room === null) {
        // 第一次点亮直接放下；因为落点没了才空着的（dropped），也要在新房间占上风 hold 秒才放下（复审 M-5）：
        // 不然落点在「没有落点」和某个房间之间抖、而且没有落点占多数时，会一圈圈地清空、放下、再清空
        if (h && !tr.dropped) {
          place(now, h, cam);
          tr.pend = undefined;
          tr.pendT = 0;
        } else if (h) {
          if (h.room === tr.pend) tr.pendT += dt;
          else {
            tr.pend = h.room;
            tr.pendT = dt;
          }
          if (tr.pendT >= B.hold - 1e-9) {
            place(now, h, cam);
            tr.dropped = false;
            tr.pend = undefined;
            tr.pendT = 0;
          }
        } else tr.pendT = Math.max(0, tr.pendT - dt);
      } else if (h && h.room === now.room) {
        // 还在这个房间：落点两级低通着跟过去
        now.mx += (h.x - now.mx) * kPoint;
        now.my += (h.y - now.my) * kPoint;
        now.mz += (h.z - now.mz) * kPoint;
        now.x += (now.mx - now.x) * kPoint;
        now.y += (now.my - now.y) * kPoint;
        now.z += (now.mz - now.z) * kPoint;
        tr.pendT = Math.max(0, tr.pendT - dt);
      } else {
        // 落点跑到别的房间（或者没有落点了）：先不跟，在那边连着占上风 hold 秒才换。
        // 现身的灯闪正压着这支手电（torchDim < 1）时只攒着（最多攒满 hold）、不换（整体审查 I-1）：旧房间那一组淡出是实打实的一下暗，
        // 现身自己已经用满了任意 1 秒 3 下，落在落下后那一秒里就是第 4 下。压暗松开（torchDim 回到 1）再换；新房间那一组淡入是变亮，不算
        const r = h ? h.room : null;
        if (r === tr.pend) tr.pendT = Math.min(B.hold, tr.pendT + dt);
        else {
          tr.pend = r;
          tr.pendT = dt;
        }
        if (tr.pendT >= B.hold - 1e-9 && torchDim[i] >= 1) {
          if (h && tr.old.room === h.room && tr.old.k > 0) {
            // 换回刚换下来、还没淡完的那个房间：两组对调，各自接着现在的亮度走
            tr.now = tr.old;
            tr.old = now;
          } else {
            tr.old = now;
            tr.now = idleGlow();
            if (h) place(tr.now, h, cam);
            else tr.dropped = true;
          }
          tr.pend = undefined;
          tr.pendT = 0;
        }
      }
      if (tr.now.room) tr.now.k = Math.min(1, tr.now.k + step);
      tr.old.k = Math.max(0, tr.old.k - step);
      if (tr.old.k === 0) tr.old.room = null;
      for (const g of [tr.now, tr.old]) if (g.room) g.cam += (bounceCamFade(camDist(g, cam)) - g.cam) * kCam;
    }
    write(2 * i, tr.now, t.power);
    write(2 * i + 1, tr.old, t.power);
  }
}

/** 全部关掉、状态清掉（视图销毁时；测试之间） */
export function clearBounce() {
  for (const tr of tracks) {
    tr.now = idleGlow();
    tr.old = idleGlow();
    tr.pend = undefined;
    tr.pendT = 0;
    tr.dropped = false;
  }
  for (const q of bounceQ) q.value.w = 0;
}

/**
 * CPU 上照着色器（torchBounceAt）算的同一个量（不带颜色，乘上 color 才是着色器加的自发光倍数）：读此刻的 uniform。
 * 测试按 60 Hz 数一个固定表面点上的反弹亮度（countDips）用；P、N 是房屋坐标
 */
export function bounceLevelAt(P: P3, N: P3): number {
  const B = TORCH_BOUNCE;
  let acc = 0;
  for (let i = 0; i < BOUNCE_SLOTS; i++) {
    const q = bounceQ[i].value, r = bounceRoom[i].value;
    if (!(q.w > 0)) continue;
    const lx = q.x - P.x, ly = q.y - P.y, lz = q.z - P.z;
    const d = Math.hypot(lx, ly, lz);
    const nl = Math.min(1, Math.max(0, ((N.x * lx + N.y * ly + N.z * lz) / Math.max(d, 1e-3) + B.wrap) / (1 + B.wrap)));
    const k = d / B.d0;
    const fall = (1 / (1 + k * k)) * (1 - sm(B.reach * 0.5, B.reach, d));
    const e = B.pad;
    const inRoom = sm(-e, e, P.x - r.x) * sm(-e, e, r.z - P.x) * sm(-e, e, P.z - r.y) * sm(-e, e, r.w - P.z);
    acc += q.w * fall * nl * inRoom;
  }
  return acc * B.gain;
}

type V3n = THREE.Node<'vec3'>;

/**
 * 反弹光照到 P 点（法线 N，都是房屋坐标）的量：乘上底色就是要加的自发光。每一组：
 *   fall = 1 / (1 + (d / d0)²) × (1 − smoothstep(reach / 2, reach, d))，nl = (N·L + wrap) / (1 + wrap)，
 *   inRoom = P 在 bounceRoom 里（四边 ±pad 的软边）；acc += color × w × fall × nl × inRoom
 * 每组包一层 If(w > 0)：没亮的、没在淡出的组不算（平时 8 组里只有亮着的手电那几组在算）。
 * P、N 先存进变量再进分支（共享节点第一次在分支里生成、分支外读到 0 的坑，见 walls.ts 的 dissolveAt）
 */
export function torchBounceAt(P: V3n, N: V3n): V3n {
  const B = TORCH_BOUNCE;
  const col = vec3(B.color.r, B.color.g, B.color.b);
  return Fn(() => {
    const p = P.toVar();
    const n = N.toVar();
    const acc = vec3(0, 0, 0).toVar();
    for (let i = 0; i < BOUNCE_SLOTS; i++) {
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
