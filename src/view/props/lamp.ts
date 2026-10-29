// 落地灯：圆底座、细杆、八角灯罩，灯罩里一盏暖色 PointLight（不投影）。平时偶尔极轻微地闪一下。
// 被附身：1.2 秒内按一段固定的「不规则」节奏闪几下（声音照着同一张表放噼啪），最后猛亮一下后熄灭；
// 节奏是节奏表（lightfx.ts 的写法：一个字母一档亮度，每秒 10 个字母），亮暗的变化过钨丝的热惯性（lightfx.ts 的 thermal）；
// 任意 1 秒最多暗 3 下（WCAG 2.3.1），tests/flicker.test.ts 守着；原来的表 1.2 秒暗 9 下还会全黑，地址带 ?oldflicker 时还用它（看样对比）。
// broken 期间一直黑着；reset 时闪两下亮回来。灯一直留在场景里只改强度（开关灯会让所有材质重新编译）。
import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, uniform } from 'three/tsl';
import type { Quality } from '../../engine/types';
import { LIGHTFX, letterLevel, thermal } from '../lightfx';
import { PALETTE } from '../palette';
import { C, Parts, approach, bodyMaterial, mesh, seg, type PropFrame, type PropRig } from './kit';

/**
 * 地址带 ?oldflicker 时两处灯闪（这里的台灯、flashlight.ts 的紧张手电）都用旧的，看样时对比新旧；用户定了以后连这个开关和旧的一起删。
 * 载入时读一次（地址在页面生命周期里不会变）；node 里跑测试没有 location
 */
const OLD_FLICKER = typeof location !== 'undefined' && new URLSearchParams(location.search).has('oldflicker');

const H = 1.5; // 灯罩顶的高度
const SHADE_Y = 1.36, SHADE_H = 0.28, SHADE_RT = 0.13, SHADE_RB = 0.23;
const LIGHT_Y = 1.3;
/** 台灯光：强度（坎德拉）和距离，high / low 两档 */
const LIGHT = { high: { intensity: 4.2, distance: 4.8 }, low: { intensity: 3.6, distance: 3.8 } };

/**
 * 旧的闪烁表（2026-10-29 之前用的）：1.2 秒里暗 9 下（任意 1 秒最多 8 下），还会全黑，最亮冲到 1.8——超了 WCAG 2.3.1 的每秒 3 下。
 * 只留给 ?oldflicker 看样对比和测试（tests/flicker.test.ts 量过），正式用的是下面的 LAMP_FLICKER
 */
export const LAMP_FLICKER_OLD: [number, number][] = [
  [0.0, 1.6], [0.05, 0.08], [0.1, 1.15], [0.17, 0.0], [0.26, 0.9], [0.3, 0.12], [0.36, 1.3],
  [0.42, 0.0], [0.55, 0.75], [0.58, 0.0], [0.64, 1.1], [0.69, 0.3], [0.73, 1.0], [0.82, 0.0],
  [0.95, 0.6], [0.98, 0.0], [1.05, 1.8], [1.12, 0.0],
];

/**
 * 被附身时的闪烁节奏表（调研 L1，写法同 lightfx.ts：一个字母一档亮度，每秒 LIGHTFX.rate 个，m = 正常，a = 最暗但不灭，z = 冲高）。
 * 11 个字母 = 1.1 秒，随后熄灭（FLICKER_END 之前那 0.1 秒是黑的）：
 *   e m a m m m m m c a z
 *   0.0 先暗一下（53%）→ 0.2 再暗一下（30%）→ 平静 0.5 秒（像是没事了）→ 0.8 起暗 0.2 秒（42%、30%）→ 1.0 猛亮一下（120%）→ 1.1 熄灭
 * 任意 1 秒最多暗 3 下，连最后熄灭那一下也算：头一下在 0.0、熄灭在 1.1，隔了 1.1 秒，中间只有 0.2、0.8 两下，
 * 任何 1 秒的窗口里最多 3 下，而且有 0.1 秒的余量（换帧率、换采样相位都不会多数出一下）。
 * 平静那一段只用 m：偏离 1 的小抖动会抬高「高点」，后面再暗一点点就被数成一下。改这一串之前先跑 tests/flicker.test.ts
 */
export const LAMP_PATTERN = 'emammmmmcaz';

/** 节奏表 → [开始秒, 亮度][]：每个字母 1 / LIGHTFX.rate 秒，连着同一档的并成一段（声音按这张表放噼啪，段少一点省事）；字母放完接熄灭（亮度 0） */
function tableOf(pattern: string): [number, number][] {
  const tab: [number, number][] = [];
  for (let i = 0; i < pattern.length; i++) {
    const v = letterLevel(pattern[i]);
    if (!tab.length || tab[tab.length - 1][1] !== v) tab.push([i / LIGHTFX.rate, v]);
  }
  tab.push([pattern.length / LIGHTFX.rate, 0]);
  return tab;
}

/**
 * 被附身时的闪烁表：[开始时间（秒）, 亮度]，每一段持续到下一段开始（由节奏表 LAMP_PATTERN 推出来，形状和以前一样）。
 * 亮度 > 1 是电压冲高的一下（泛光会把它放大）。最后一项是熄灭（亮度 0），之后到 FLICKER_END 一直是黑的。
 * 声音（audio/sfx.ts 的 lamp）按这张表放：亮度从低跳到 ≥ 0.6 的时刻放噼啪，最后一项的时刻放熄灭那一下，最亮的一项的时刻让基音涌一下
 */
export const LAMP_FLICKER: [number, number][] = OLD_FLICKER ? LAMP_FLICKER_OLD : tableOf(LAMP_PATTERN);
/** 被附身的表演放多少秒：到点就算熄灭、进入 broken（比表里最后一项晚一点） */
export const FLICKER_END = 1.2;
/** reset：闪两下再稳稳亮回（从黑着起步暗两下，连开头从全黑起步算成的那一下也只有 3 下；tests/flicker.test.ts 查过，不用改） */
export const LAMP_RELIGHT: [number, number][] = [
  [0.0, 0.0], [0.08, 1.1], [0.14, 0.0], [0.3, 0.9], [0.36, 0.05], [0.5, 1.0],
];
/** 附身、复原以后，平时的轻闪至少隔这么多秒（从复原亮回、回到平时那一刻起算）再来，见 createLamp 里的 quietBlips */
export const BLIP_QUIET = 1.3;
/**
 * 平时轻闪的深度范围（亮度掉多少）。上限要小于 lightfx 的 countDips 门槛 0.1：原来 0.05–0.2，深的那几下数得出来，
 * 刚好落在附身前 0.13–0.2 秒时加上附身自己的 3 下就是 4 下。现在一下都数不出来，看起来是更轻的一闪（2026-10-29）
 */
export const BLIP_DEPTH = [0.035, 0.095] as const;

/** 查表：t 秒时所在那一段的亮度（每一段持续到下一段开始；t 比第一项还早就取第一项） */
export const sampleTable = (tab: [number, number][], t: number) => {
  let v = tab[0][1];
  for (const [at, x] of tab) if (t >= at) v = x;
  return v;
};

export function createLamp(seed: number): PropRig {
  const model = new THREE.Group();
  model.name = 'lamp';

  const sp = new Parts();
  sp.cyl(0.13, 0.16, 0.035, 8, C.woodDark, [0, 0.0175, 0]);
  sp.cyl(0.05, 0.08, 0.05, 8, C.brass, [0, 0.06, 0]);
  sp.cyl(0.016, 0.016, SHADE_Y - 0.06, 6, C.brass, [0, (SHADE_Y + 0.06) / 2 - 0.02, 0]);
  sp.cyl(0.03, 0.03, 0.05, 6, C.brass, [0, 0.7, 0]); // 杆中间的一节
  // 灯罩的支架
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    sp.rod([0, LIGHT_Y - 0.02, 0], [Math.cos(a) * SHADE_RT * 0.95, SHADE_Y + SHADE_H / 2 - 0.01, Math.sin(a) * SHADE_RT * 0.95], 0.004, C.brass, 3);
  }
  const standGeo = sp.build();
  const stand = mesh(standGeo, bodyMaterial(0.6, 0.3), 'lamp-stand');
  model.add(stand);

  // 灯罩：两面都画（从上面能看到里面），亮着时由内往外透光 → 自发光
  const glow = uniform(1);
  const shadeMat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9, metalness: 0, flatShading: true });
  shadeMat.colorNode = color(C.ivory);
  // 灯泡在灯罩下半截：下沿透光最亮，往上渐暗，灯罩才有体积感
  const up = positionLocal.y.div(SHADE_H).add(0.5);
  shadeMat.emissiveNode = color(PALETTE.lamp).mul(glow).mul(mix(0.85, 0.3, up));
  const shadeGeo = new THREE.CylinderGeometry(SHADE_RT, SHADE_RB, SHADE_H, 8, 1, true);
  const shade = mesh(shadeGeo, shadeMat, 'lamp-shade');
  shade.position.y = SHADE_Y;
  shade.castShadow = false; // 灯罩挡手电没意义，而且它自己在发光
  model.add(shade);

  // 灯泡：纯自发光的小球（亮的时候泛光最明显的一点）
  const bulbMat = new THREE.MeshBasicNodeMaterial();
  bulbMat.colorNode = color(PALETTE.lamp).mul(glow.mul(2.4).add(0.04));
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), bulbMat);
  bulb.position.y = LIGHT_Y;
  model.add(bulb);

  const light = new THREE.PointLight(PALETTE.lamp, LIGHT.high.intensity, LIGHT.high.distance, 2);
  light.position.y = LIGHT_Y;
  light.castShadow = false;
  // 现身时跟着附近的灯一起暗，灯罩、灯泡的自发光（glow）也一起（lightfx.ts 收集）；自己在闪（附身、复原）时标 busy，
  // lightfx 这段时间不再叠加压暗：两套闪叠起来会超过每秒 3 下。带着 busy 这个字段，现身的蓄力、收也整段不碰它
  // （lightfx 的 skipOwned，见 ghost.ts 的 manifestLights）：只跟着落下、停留暗
  const fxTag = { glow, busy: false };
  light.userData.lightfx = fxTag;
  model.add(light);

  let q: Quality = 'high';
  let t = -1; // 被附身的表演
  let r = -1; // 复原
  let off = false;
  // 平时的轻微闪：每隔几秒随机来一下，0.1–0.3 秒，亮度最多掉 BLIP_DEPTH（峰谷差不到 0.1，countDips 数不成一下）
  let rnd = seed * 9301 + 49297;
  const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  let nextBlip = 2 + rand() * 6;
  let blip = -1, blipLen = 0.2, blipDepth = 0.1;
  let level = 1;
  /**
   * 附身、复原一开始：正在进行的轻闪作废，下一次轻闪至少隔 BLIP_QUIET 秒（只在平时那一段里倒数，也就是复原亮回以后）。
   * 不然附身那一刻轻闪快来了（或者正闪到一半），它会留到复原亮回的那一刻接着闪：复原自己暗 2 下，紧接着一下轻闪，
   * 附近再有现身落下就是任意 1 秒 4 下（2026-10-29 最终审查 I1 / 路 F Minor 3）。1.3 秒：离复原的第二下（0.36 秒）超过 1 秒还有余量。
   * 附身之前 0.13–0.2 秒刚闪完的一下原来也会凑成 4 下（约万分之七的附身时刻）：2026-10-29 用户说「要考虑用户体验」，
   * 防光敏优先，轻闪本来就是「极轻微」，所以把它压到数不出来（BLIP_DEPTH），这种情况也就没有了
   */
  const quietBlips = () => {
    blip = -1;
    nextBlip = Math.max(nextBlip, BLIP_QUIET);
  };

  return {
    model,
    hit: { size: [0.55, H + 0.06, 0.55], center: [0, (H + 0.06) / 2, 0] },
    shells: [
      { parent: stand, geometry: standGeo },
      { parent: shade, geometry: shadeGeo },
    ],
    trigger() {
      t = 0;
      r = -1;
      quietBlips();
    },
    reset() {
      r = 0;
      t = -1;
      quietBlips();
    },
    update(f: PropFrame) {
      const { dt, obj } = f;
      // 兜底：错过事件时按 state 对齐（兜底开始的复原和 reset 一样，先把轻闪压住）
      if (t < 0 && r < 0) {
        if (!off && obj.broken > 0) off = true;
        else if (off && obj.broken <= 0) {
          r = 0;
          quietBlips();
        }
      }

      fxTag.busy = t >= 0 || r >= 0;
      let target = 1;
      if (t >= 0) {
        t += dt;
        target = t < FLICKER_END ? sampleTable(LAMP_FLICKER, t) : 0;
        if (t >= FLICKER_END) { t = -1; off = true; }
        // 钨丝的热惯性：变暗快、变亮慢一点，不一帧硬切（?oldflicker 时还是旧的硬切）
        level = OLD_FLICKER ? target : thermal(level, target, dt);
      } else if (r >= 0) {
        r += dt;
        target = sampleTable(LAMP_RELIGHT, r);
        // 最后一段从 0.5 秒起 0.15 秒内爬到满亮（灯丝预热）
        if (r >= 0.5) target = Math.min(1, 0.6 + seg(r, 0.5, 0.65) * 0.4);
        level = OLD_FLICKER ? target : thermal(level, target, dt);
        if (r >= 0.65) { r = -1; off = false; }
      } else if (off) {
        level = approach(level, 0, 30, dt);
      } else {
        // 平时
        nextBlip -= dt;
        if (nextBlip <= 0) {
          blip = 0;
          blipLen = 0.1 + rand() * 0.2;
          blipDepth = BLIP_DEPTH[0] + rand() * (BLIP_DEPTH[1] - BLIP_DEPTH[0]);
          nextBlip = 3 + rand() * 7;
        }
        let v = 1;
        if (blip >= 0) {
          blip += dt;
          const u = blip / blipLen;
          v = 1 - blipDepth * (0.6 + 0.4 * Math.sin(u * 40)) * Math.sin(Math.PI * Math.min(1, u));
          if (u >= 1) blip = -1;
        }
        level = approach(level, v, 25, dt);
      }

      glow.value = level;
      light.intensity = LIGHT[q].intensity * level;
    },
    setQuality(nq) {
      q = nq;
      light.distance = LIGHT[q].distance;
    },
    dispose() {
      light.dispose();
    },
  };
}
