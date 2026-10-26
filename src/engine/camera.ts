// 正交斜俯视相机：90° 旋转（缓入缓出、可连按）、滚轮缩放、屏幕震动、开场下降镜头。
// 画面始终按「整栋房子 + 边距」取景（横屏按高度、竖屏按宽度），缩放在这个基准上乘
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
/** 相机离房子中心的距离：正交相机只影响裁剪面，够远就行 */
const DIST = 40;

const azimuthOf = (quarterUnwrapped: number) => Math.PI / 4 + (quarterUnwrapped * Math.PI) / 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

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

interface Shake { strength: number; duration: number; t: number; px: number; py: number }

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
  const shakes: Shake[] = [];
  let clock = 0;
  let width = Math.max(1, canvas.clientWidth);
  let height = Math.max(1, canvas.clientHeight);
  const cbs: ((q: number) => void)[] = [];
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
    const ce = Math.cos(elev);
    camera.position.set(viewDir.x * ce * DIST, Math.sin(elev) * DIST, viewDir.z * ce * DIST);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);

    // 震动：在视平面里平移取景框（单位：米）。每次震动用平滑的正弦叠加，按剩余时长的平方衰减
    let ox = 0, oy = 0;
    for (const s of shakes) {
      const k = s.strength * (1 - s.t / s.duration) ** 2;
      ox += k * (0.65 * Math.sin(clock * 83 + s.px) + 0.35 * Math.sin(clock * 131 + s.py * 1.7));
      oy += k * (0.65 * Math.sin(clock * 97 + s.py) + 0.35 * Math.sin(clock * 151 + s.px * 1.3));
    }

    const z = zoomCur * introZoom;
    const hw = fit.hw / z, hh = fit.hh / z;
    camera.left = fit.cx + ox - hw;
    camera.right = fit.cx + ox + hw;
    camera.top = fit.cy + oy + hh;
    camera.bottom = fit.cy + oy - hh;
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
    shake(strength, duration) {
      if (strength <= 0 || duration <= 0) return;
      shakes.push({ strength, duration, t: 0, px: Math.random() * 100, py: Math.random() * 100 });
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
      for (let i = shakes.length - 1; i >= 0; i--) {
        shakes[i].t += dt;
        if (shakes[i].t >= shakes[i].duration) shakes.splice(i, 1);
      }
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
