// 正交斜俯视相机（娃娃屋视角：触屏设备、?dollhouse）：90° 旋转（缓入缓出、可连按）、滚轮缩放、开场下降镜头，
// 再加吓跑时摄影师式地一抖（创伤值震动，只转不移）。
// 画面按「整栋房子 + 边距」取景（横屏按高度），缩放在这个基准上乘。
// 竖屏（宽度是瓶颈，2026-10-30 eye S-6、newbie S3：房子只占屏幕三成高、访客十来个像素）：横向不按整栋房子，按 9 个物件取景
// （最外面那个物件离屏幕边还留 CONTENT_PAD 米）。斜着看房子是一个横躺的菱形，两头的尖角（墙角、床尾、厨房台面那一截）裁掉一点，
// 房子撑满屏幕宽度，人大约大四分之一；四个方位转一圈物件都还在画面里。横屏、桌面本来就按高度取景，不变
// 正交相机平移只是整张画平着滑，看不出纵深；只有小角度的转动能让前后的东西互相错开，所以震动只用旋转。
// 2026-10-28 做减法：去掉了没人操作时的镜头「呼吸」和惊吓落下时的冲镜推近
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W, PROPS, WALL_H, propCenter } from '../config/house';
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
/** 竖屏横向按物件取景：离画面中线最远的那个物件中心外面再留这么多米（床那么大的物件也露出一大半，点得到） */
const CONTENT_PAD = 0.6;
/**
 * 9 个物件的中心在视平面上离中线最远多少米（45°、135° 两种朝向取大的；另外两个是镜像）。
 * 视平面横轴 = (dz, 0, −dx)，和高度、仰角无关，算一次就行
 */
const PROPS_HALF_WIDTH = (() => {
  let m = 0;
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4]) {
    const dx = Math.cos(a), dz = Math.sin(a);
    for (const p of PROPS) {
      const c = propCenter(p);
      m = Math.max(m, Math.abs((c.x - HOUSE_W / 2) * dz - (c.z - HOUSE_D / 2) * dx));
    }
  }
  return m;
})();
/** 相机离转动中心的距离：正交相机只影响裁剪面，够远就行 */
const DIST = 40;
/** 震动绕着转的点：房子中心、离地这么高（米），大致是物件、人的中部，地板和墙头朝相反方向错开 */
const PIVOT_Y = 0.8;
/**
 * 震动：Squirrel Eiserloh「Juicing Your Cameras With Math」的创伤值模型。事件往创伤值（0..1）里加（juice.ts，只有吓跑），
 * 创伤值每秒线性减 1；画面转角 = 最大角 × 创伤值² × 平滑噪声（不用随机数，不会一帧一跳）。
 * 平方让尾巴自然收掉。只转不移：横滚为主，方位、仰角各带一点，读起来是摄影师被吓得手一缩，不是地震。
 * 幅度按缩放倍数反比缩小（推近时画面放大，同样的角度在屏幕上走得更远）
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

export function createCameraRig(canvas: HTMLCanvasElement): CameraRig {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, DIST * 2.5);
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
  let clock = 0;
  let width = Math.max(1, canvas.clientWidth);
  let height = Math.max(1, canvas.clientHeight);
  const cbs: ((q: number) => void)[] = [];
  // viewDir 只跟着旋转走，不含震动：月光方向、降墙都按它算，不该跟着晃
  const viewDir = { x: Math.cos(az), z: Math.sin(az) };

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
    // 横向：整栋房子和「物件 + CONTENT_PAD」取小的（竖屏才用得上：横屏按高度取景，这个数会被下面换掉）
    let hw = Math.min(xMax * (1 + MARGIN), PROPS_HALF_WIDTH + CONTENT_PAD);
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
    const hw = fit.hw / z, hh = fit.hh / z;
    let cx = fit.cx, cy = fit.cy;

    // 震动：取景算完之后再叠上去，只改相机朝向，不改取景框的大小
    let yaw = 0, pitch = 0, roll = 0;
    if (trauma > 0) {
      const s = (trauma * trauma) / zoomCur;
      const { hz, seed } = SHAKE;
      // 噪声的 x 每走 1 是半个来回，所以乘 2
      roll = s * SHAKE.roll * tremor(clock * hz[0] * 2 + seed[0]);
      yaw = s * SHAKE.yaw * tremor(clock * hz[1] * 2 + seed[1]);
      pitch = s * SHAKE.pitch * tremor(clock * hz[2] * 2 + seed[2]);
    }

    // 绕转动中心（房子中心离地 PIVOT_Y）摆相机：转动中心永远在视轴上，转多少它在画面上都不动
    const a = az + yaw, e = elev + pitch;
    const ce = Math.cos(e);
    camera.position.set(Math.cos(a) * ce * DIST, PIVOT_Y + Math.sin(e) * DIST, Math.sin(a) * ce * DIST);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, PIVOT_Y, 0);
    // 视平面原点从地面中心换成转动中心：不抖的时候画面和地面中心为原点时一模一样
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
    intro(seconds) {
      intro = { t: 0, dur: Math.max(0.01, seconds) };
      elev = INTRO_ELEV;
      introZoom = INTRO_ZOOM;
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
