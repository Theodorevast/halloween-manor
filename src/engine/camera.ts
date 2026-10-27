// 正交斜俯视相机：90° 旋转（缓入缓出、可连按）、滚轮缩放、开场下降镜头、惊吓落下时的冲镜，
// 再加两种只转不移的小动作：没人操作时极慢的「呼吸」，受惊时摄影师式地一抖（创伤值震动）。
// 画面始终按「整栋房子 + 边距」取景（横屏按高度、竖屏按宽度），缩放在这个基准上乘。
// 正交相机平移只是整张画平着滑，看不出纵深；只有小角度的转动能让前后的东西互相错开，所以呼吸和震动都只用旋转
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W, WALL_H } from '../config/house';
import type { Vec2 } from '../sim/types';
import type { CameraRig } from './types';

const DEG = Math.PI / 180;
/** 正常仰角 */
const ELEV = 35 * DEG;
/** 开场起点：更高、更远 */
const INTRO_ELEV = 55 * DEG;
const INTRO_ZOOM = 0.6;
/** 旋转 90° 的过渡时长（秒） */
const ROT_TIME = 0.45;
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 1.6;
/** 缩放平滑：每秒逼近的速率（越大越跟手） */
const ZOOM_RATE = 12;
/** 取景边距：房子外接框每边多留的比例 */
const MARGIN = 0.07;
/** 相机离转动中心的距离：正交相机只影响裁剪面，够远就行 */
const DIST = 40;
/**
 * 冲镜：惊吓落在访客身上时，镜头推近并偏向那个物件，停一下再退回。下面是 strength = 1 的幅度，弱的按比例缩小。
 * - 推近 1.2 倍：景深拉焦（juice.ts）分担了一部分强调，推近本身收一点（Nesky「50 个镜头错误」#41 视野快速变化、#45 快速换机位）
 * - 画面中心往物件挪 60%：比「以物件为中心缩放」（物件原地不动）多走一截，物件被拉向画面中间
 * - 0.12 秒推进（像倒吸一口气），停 0.5 秒让人看清，0.8 秒缓缓退回：退得比进得慢很多，余韵比冲击长
 * juice.ts 的拉焦按这里的推进 + 停留时长松开，所以导出
 */
export const PUNCH = {
  zoom: 1.2,
  pan: 0.6,
  attack: 0.12,
  hold: 0.5,
  release: 0.8,
  /** 已经推进去时换目标：焦点用这么久平滑滑过去，而不是在 0.12 秒里甩过去 */
  glide: 0.35,
  /** 焦点离地高度（米），大致是物件中部（和调试接口 screenOf 一样） */
  height: 0.8,
};
/** 呼吸和震动绕着转的点：房子中心、离地这么高（米）。和冲镜焦点一样在物件、人的中部，地板和墙头朝相反方向错开 */
const PIVOT_Y = 0.8;
/**
 * 呼吸：没人操作时镜头极慢地漂，像三脚架后面有人在呼吸（《小小梦魇》娃娃屋镜头的轻微晃动、Henry Heffernan 作品集的待机绕转）。
 * - 只转不移：方位角最多 ±0.5°、仰角最多 ±0.25°，绕上面的转动中心转；取景框不变，画面不会跟着缩放「呼吸」
 * - 每个轴两条正弦，频率互不成整数比（周期 19–43 秒），几分钟内不重复；最快约 0.12°/秒，盯着看才察觉得到
 *   （Messenger 的教训：自动运镜要极慢、速度连续）
 * - 幅度按缩放倍数反比缩小：推近时画面放大，同样的角度在屏幕上走得更远
 * - 旋转、冲镜、开场期间 0.35 秒淡出，结束后 2.5 秒淡回；系统设置了「减少动态效果」时不呼吸
 */
const BREATH = {
  yaw: 0.5 * DEG,
  pitch: 0.25 * DEG,
  yawHz: [0.031, 0.053],
  pitchHz: [0.023, 0.041],
  /** 各条正弦的初相（弧度）：两个轴不同时过零 */
  yawPhase: [0, 1.7],
  pitchPhase: [0.6, 2.9],
  /** 两条正弦的权重（和为 1，叠加后不超过上面的幅度） */
  mix: [0.65, 0.35],
  fadeOut: 0.35,
  fadeIn: 2.5,
};
/**
 * 震动：Squirrel Eiserloh「Juicing Your Cameras With Math」的创伤值模型。事件往创伤值（0..1）里加（juice.ts），
 * 创伤值每秒线性减 1；画面转角 = 最大角 × 创伤值² × 平滑噪声（不用随机数，不会一帧一跳）。
 * 平方让小惊吓几乎不晃、吓跑才明显，尾巴也自然收掉。只转不移：横滚为主，方位、仰角各带一点，
 * 读起来是摄影师被吓得手一缩，不是地震。幅度同样按缩放倍数反比缩小
 */
const SHAKE = {
  roll: 0.6 * DEG,
  yaw: 0.25 * DEG,
  pitch: 0.2 * DEG,
  /** 来回的频率（Hz）：手抖大约 8–12 Hz。三个轴频率略错开、在噪声里错开位置取样，彼此不同步 */
  hz: [9.3, 10.7, 8.1],
  /** 三个轴（横滚、方位、仰角）在噪声里的取样起点 */
  seed: [83, 11, 47],
  /** 创伤值每秒减少多少 */
  decay: 1,
};

const azimuthOf = (quarterUnwrapped: number) => Math.PI / 4 + (quarterUnwrapped * Math.PI) / 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const TAU = Math.PI * 2;

/** 整数 → 0..1 的伪随机数（整数哈希，同一个格点永远同一个值） */
const hash01 = (i: number) => {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ 0x165667b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 0xffffffff;
};
/**
 * 抖动用的一维平滑噪声，x 每走 1 是半个来回：格点上的值正负交替、大小在 0.4–1 之间随机，格点之间五次平滑插值。
 * 和普通的 Perlin 噪声一样连续、不重复，但每个来回都真的摆得开（Perlin 一维大多在 ±0.3 以内，乘上创伤值² 就看不见了）
 */
const tremor = (x: number) => {
  const i = Math.floor(x), f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const v0 = (i & 1 ? -1 : 1) * (0.4 + 0.6 * hash01(i));
  const v1 = (i & 1 ? 1 : -1) * (0.4 + 0.6 * hash01(i + 1));
  return v0 + (v1 - v0) * u;
};

/** 一段方位角过渡：三次 Hermite，起点带上一段的速度、终点速度为 0。
 *  第一次按旋转时起点速度为 0，就是标准的缓入缓出；过渡中再按，从当前位置和速度接着转，不跳、不顿 */
interface RotSeg { p0: number; p1: number; v0: number; t: number }
const segPos = (s: RotSeg, u: number) => {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * s.p0 + (u3 - 2 * u2 + u) * ROT_TIME * s.v0 + (-2 * u3 + 3 * u2) * s.p1;
};
const segVel = (s: RotSeg, u: number) => {
  const u2 = u * u;
  return ((6 * u2 - 6 * u) * s.p0 + (3 * u2 - 4 * u + 1) * ROT_TIME * s.v0 + (-6 * u2 + 6 * u) * s.p1) / ROT_TIME;
};

/** 一段冲镜：幅度从 a0 推到 peak、停、退回 0；焦点（房屋米坐标）从 from 滑到 to */
interface Punch { from: Vec2; to: Vec2; a0: number; peak: number; glide: number; t: number }

export function createCameraRig(canvas: HTMLCanvasElement): CameraRig {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, DIST * 2.5);
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let quarterU = 0; // 不取模的累计值，方位角跟着它连续走，绕一圈也不会反向转回去
  let az = azimuthOf(0);
  let seg: RotSeg | null = null;
  let zoomTarget = 1;
  let zoomCur = 1;
  let intro: { t: number; dur: number } | null = null;
  let elev = ELEV;
  let introZoom = 1;
  /** 创伤值 0..1 */
  let trauma = 0;
  /** 呼吸的淡入淡出进度 0..1（线性走，用的时候过一遍 smoothstep，起停都没有速度突变） */
  let breathW = 0;
  let punch: Punch | null = null;
  /** 此刻的冲镜幅度 0..1 和焦点。焦点存房屋坐标而不是屏幕坐标：冲镜中转镜头，焦点仍跟着那个物件 */
  let punchA = 0;
  const punchF: Vec2 = { x: HOUSE_W / 2, z: HOUSE_D / 2 };
  let clock = 0;
  let width = Math.max(1, canvas.clientWidth);
  let height = Math.max(1, canvas.clientHeight);
  const cbs: ((q: number) => void)[] = [];
  // viewDir 只跟着旋转走，不含呼吸和震动：月光方向、降墙都按它算，不该跟着晃
  const viewDir: Vec2 = { x: Math.cos(az), z: Math.sin(az) };

  // 取景：房子外接盒（16 × 12 米、高到 WALL_H）在相机视平面上的范围。
  // 四个方位里 45° 和 135° 两种朝向就涵盖了全部（另外两个是镜像），取两者的最大值，
  // 这样旋转前后、过渡中取景都不变，画面不会「呼吸」
  const fit = { cx: 0, cy: 0, hw: 1, hh: 1 };
  const computeFit = () => {
    let xMax = 0, yMin = Infinity, yMax = -Infinity;
    const se = Math.sin(elev), ce = Math.cos(elev);
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4]) {
      const dx = Math.cos(a), dz = Math.sin(a);
      for (const px of [-HOUSE_W / 2, HOUSE_W / 2]) for (const pz of [-HOUSE_D / 2, HOUSE_D / 2]) for (const py of [0, WALL_H]) {
        // 相机坐标系：x 轴 = (dz, 0, -dx)，y 轴 = (-sinE·dx, cosE, -sinE·dz)
        const vx = px * dz - pz * dx;
        const vy = -se * (px * dx + pz * dz) + ce * py;
        xMax = Math.max(xMax, Math.abs(vx));
        yMin = Math.min(yMin, vy);
        yMax = Math.max(yMax, vy);
      }
    }
    let hw = xMax * (1 + MARGIN);
    let hh = ((yMax - yMin) / 2) * (1 + MARGIN);
    const aspect = width / height;
    if (hw / hh > aspect) hh = hw / aspect; // 竖屏：宽度是瓶颈
    else hw = hh * aspect; // 横屏：高度是瓶颈
    fit.cx = 0;
    fit.cy = (yMax + yMin) / 2;
    fit.hw = hw;
    fit.hh = hh;
  };

  const place = () => {
    viewDir.x = Math.cos(az);
    viewDir.z = Math.sin(az);

    // 取景框（视平面坐标，原点 = 房子中心的地面点，和 computeFit 同一套）
    const z = zoomCur * introZoom;
    let hw = fit.hw / z, hh = fit.hh / z;
    let cx = fit.cx, cy = fit.cy;
    if (punchA > 0) {
      // 冲镜：焦点投到视平面，画面中心往它挪，再推近。
      // 挪动量限制在「推近后的框仍落在推近前的框里」：只是往里裁，不会把房子推出画面，也不会露出原本看不到的黑边
      const zp = 1 + punchA * (PUNCH.zoom - 1);
      const se = Math.sin(elev), ce = Math.cos(elev);
      const px = punchF.x - HOUSE_W / 2, pz = punchF.z - HOUSE_D / 2;
      const vx = px * viewDir.z - pz * viewDir.x;
      const vy = -se * (px * viewDir.x + pz * viewDir.z) + ce * PUNCH.height;
      const room = 1 - 1 / zp;
      cx += clamp(punchA * PUNCH.pan * (vx - cx), -hw * room, hw * room);
      cy += clamp(punchA * PUNCH.pan * (vy - cy), -hh * room, hh * room);
      hw /= zp;
      hh /= zp;
    }

    // 呼吸 + 震动：取景算完之后再叠上去，只改相机朝向，不改取景框的大小
    const zs = 1 / zoomCur;
    const b = smoothstep(breathW) * zs;
    const [m0, m1] = BREATH.mix;
    const sway = (hz: number[], ph: number[]) => m0 * Math.sin(TAU * hz[0] * clock + ph[0]) + m1 * Math.sin(TAU * hz[1] * clock + ph[1]);
    let yaw = b * BREATH.yaw * sway(BREATH.yawHz, BREATH.yawPhase);
    let pitch = b * BREATH.pitch * sway(BREATH.pitchHz, BREATH.pitchPhase);
    let roll = 0;
    if (trauma > 0) {
      const s = trauma * trauma * zs;
      const { hz, seed } = SHAKE;
      // 噪声的 x 每走 1 是半个来回，所以乘 2
      roll = s * SHAKE.roll * tremor(clock * hz[0] * 2 + seed[0]);
      yaw += s * SHAKE.yaw * tremor(clock * hz[1] * 2 + seed[1]);
      pitch += s * SHAKE.pitch * tremor(clock * hz[2] * 2 + seed[2]);
    }

    // 绕转动中心（房子中心离地 PIVOT_Y）摆相机：转动中心永远在视轴上，转多少它在画面上都不动
    const a = az + yaw, e = elev + pitch;
    const ce = Math.cos(e);
    camera.position.set(Math.cos(a) * ce * DIST, PIVOT_Y + Math.sin(e) * DIST, Math.sin(a) * ce * DIST);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, PIVOT_Y, 0);
    // 视平面原点从地面中心换成转动中心：不转的时候画面和以前一模一样
    cy -= Math.cos(elev) * PIVOT_Y;
    if (roll !== 0) {
      // 横滚绕画面中心：相机绕自己的视轴转 roll 后，原来在画面中心的点的视平面坐标转了 −roll，取景框中心跟过去
      camera.rotateZ(roll);
      const c = Math.cos(roll), s = Math.sin(roll);
      const rx = cx * c + cy * s;
      cy = -cx * s + cy * c;
      cx = rx;
    }
    camera.left = cx - hw;
    camera.right = cx + hw;
    camera.top = cy + hh;
    camera.bottom = cy - hh;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  computeFit();
  place();

  // 滚轮缩放由相机自己监听；preventDefault 挡住触控板双指缩放把整页放大
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    rig.zoom(Math.exp(-clamp(px, -200, 200) * 0.0015));
  }, { passive: false });

  const v = new THREE.Vector3();
  const rig: CameraRig = {
    camera,
    get quarter() { return ((quarterU % 4) + 4) % 4; },
    get viewDir() { return viewDir; },
    rotate(dir) {
      quarterU += dir;
      const v0 = seg ? segVel(seg, Math.min(1, seg.t / ROT_TIME)) : 0;
      seg = { p0: az, p1: azimuthOf(quarterU), v0, t: 0 };
      const q = rig.quarter;
      for (const cb of cbs) cb(q);
    },
    zoom(factor) {
      zoomTarget = clamp(zoomTarget * factor, ZOOM_MIN, ZOOM_MAX);
    },
    shake(amount) {
      if (amount > 0) trauma = Math.min(1, trauma + amount);
    },
    punch(target, strength) {
      const s = clamp(strength, 0, 1);
      if (!(s > 0)) return false;
      // 画面上正在播更强的（推进、停留中按峰值算，退回中按此刻的幅度算）：不被弱的打断。
      // 一样强的照常接上：同一个物件又吓到一个人，等于把停留延长
      const level = punch && punch.t < PUNCH.attack + PUNCH.hold ? punch.peak : punchA;
      if (s < level - 1e-6) return false;
      // 从此刻的幅度和焦点接着走，不跳。镜头还没推进去时焦点直接放到目标上（幅度为 0，看不出来）
      const showing = punchA > 0.02;
      punch = {
        from: showing ? { x: punchF.x, z: punchF.z } : { x: target.x, z: target.z },
        to: { x: target.x, z: target.z },
        a0: punchA,
        peak: s,
        glide: showing ? PUNCH.glide : PUNCH.attack,
        t: 0,
      };
      return true;
    },
    intro(seconds) {
      intro = { t: 0, dur: Math.max(0.01, seconds) };
      elev = INTRO_ELEV;
      introZoom = INTRO_ZOOM;
      breathW = 0;
      computeFit();
      place();
    },
    onRotate(cb) { cbs.push(cb); },
    update(dt) {
      clock += dt;
      if (seg) {
        seg.t += dt;
        const u = Math.min(1, seg.t / ROT_TIME);
        az = segPos(seg, u);
        if (u >= 1) {
          az = seg.p1;
          seg = null;
        }
      }
      zoomCur += (zoomTarget - zoomCur) * (1 - Math.exp(-dt * ZOOM_RATE));
      if (Math.abs(zoomTarget - zoomCur) < 1e-4) zoomCur = zoomTarget;
      if (intro) {
        intro.t += dt;
        const k = easeInOutCubic(Math.min(1, intro.t / intro.dur));
        elev = INTRO_ELEV + (ELEV - INTRO_ELEV) * k;
        introZoom = INTRO_ZOOM + (1 - INTRO_ZOOM) * k;
        if (intro.t >= intro.dur) intro = null;
        computeFit();
      }
      trauma = Math.max(0, trauma - dt * SHAKE.decay);
      if (punch) {
        const p = punch;
        p.t += dt;
        const { attack, hold, release } = PUNCH;
        if (p.t < attack) punchA = p.a0 + (p.peak - p.a0) * easeOutCubic(p.t / attack);
        else if (p.t < attack + hold) punchA = p.peak;
        else if (p.t < attack + hold + release) punchA = p.peak * (1 - easeInOutCubic((p.t - attack - hold) / release));
        else {
          punchA = 0;
          punch = null;
        }
        // 换目标用 smoothstep：最快时只有平均速度的 1.5 倍（三次缓动是 3 倍），读起来是平移过去，不是甩过去
        const k = smoothstep(Math.min(1, p.t / p.glide));
        punchF.x = p.from.x + (p.to.x - p.from.x) * k;
        punchF.z = p.from.z + (p.to.z - p.from.z) * k;
      }
      // 镜头在做别的动作（旋转、冲镜、开场）时呼吸让开，做完再慢慢回来
      const busy = seg !== null || punch !== null || intro !== null || reducedMotion?.matches === true;
      breathW = busy ? Math.max(0, breathW - dt / BREATH.fadeOut) : Math.min(1, breathW + dt / BREATH.fadeIn);
      place();
    },
    resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      computeFit();
      place();
    },
    toScreen(p, y = 0) {
      v.set(p.x - HOUSE_W / 2, y, p.z - HOUSE_D / 2).project(camera);
      const w = canvas.clientWidth || width, h = canvas.clientHeight || height;
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    },
  };
  return rig;
}
