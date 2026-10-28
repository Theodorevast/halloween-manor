// 落地灯：圆底座、细杆、八角灯罩，灯罩里一盏暖色 PointLight（不投影）。平时偶尔极轻微地闪一下。
// 被附身：1.2 秒内按一段固定的「不规则」节奏乱闪（声音照着同一张表放噼啪），最后猛亮一下后熄灭；
// broken 期间一直黑着；reset 时闪两下亮回来。灯一直留在场景里只改强度（开关灯会让所有材质重新编译）。
import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, uniform } from 'three/tsl';
import type { Quality } from '../../engine/types';
import { PALETTE } from '../palette';
import { C, Parts, approach, bodyMaterial, mesh, seg, type PropFrame, type PropRig } from './kit';

const H = 1.5; // 灯罩顶的高度
const SHADE_Y = 1.36, SHADE_H = 0.28, SHADE_RT = 0.13, SHADE_RB = 0.23;
const LIGHT_Y = 1.3;
/** 台灯光：强度（坎德拉）和距离，high / low 两档 */
const LIGHT = { high: { intensity: 4.2, distance: 4.8 }, low: { intensity: 3.6, distance: 3.8 } };

/**
 * 被附身时的闪烁表：[开始时间（秒）, 亮度]，每一段持续到下一段开始。
 * 亮度 > 1 是电压冲高的一下（泛光会把它放大）。最后 1.2 秒熄灭。声音任务可以按「亮度从低跳到 ≥ 0.6 的时刻」放噼啪。
 */
export const LAMP_FLICKER: [number, number][] = [
  [0.0, 1.6], [0.05, 0.08], [0.1, 1.15], [0.17, 0.0], [0.26, 0.9], [0.3, 0.12], [0.36, 1.3],
  [0.42, 0.0], [0.55, 0.75], [0.58, 0.0], [0.64, 1.1], [0.69, 0.3], [0.73, 1.0], [0.82, 0.0],
  [0.95, 0.6], [0.98, 0.0], [1.05, 1.8], [1.12, 0.0],
];
const FLICKER_END = 1.2;
/** reset：闪两下再稳稳亮回 */
export const LAMP_RELIGHT: [number, number][] = [
  [0.0, 0.0], [0.08, 1.1], [0.14, 0.0], [0.3, 0.9], [0.36, 0.05], [0.5, 1.0],
];

const sample = (tab: [number, number][], t: number) => {
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
  light.userData.lightfx = { glow }; // 现身时跟着附近的灯一起暗，灯罩、灯泡的自发光（glow）也一起（lightfx.ts 收集）
  model.add(light);

  let q: Quality = 'high';
  let t = -1; // 被附身的表演
  let r = -1; // 复原
  let off = false;
  // 平时的轻微闪：每隔几秒随机来一下，0.1–0.3 秒，亮度掉到 0.8–0.95
  let rnd = seed * 9301 + 49297;
  const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  let nextBlip = 2 + rand() * 6;
  let blip = -1, blipLen = 0.2, blipDepth = 0.1;
  let level = 1;

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
    },
    reset() {
      r = 0;
      t = -1;
    },
    update(f: PropFrame) {
      const { dt, obj } = f;
      // 兜底：错过事件时按 state 对齐
      if (t < 0 && r < 0) {
        if (!off && obj.broken > 0) off = true;
        else if (off && obj.broken <= 0) r = 0;
      }

      let target = 1;
      if (t >= 0) {
        t += dt;
        target = t < FLICKER_END ? sample(LAMP_FLICKER, t) : 0;
        if (t >= FLICKER_END) { t = -1; off = true; }
        level = target; // 闪烁要硬切，不做平滑
      } else if (r >= 0) {
        r += dt;
        target = sample(LAMP_RELIGHT, r);
        // 最后一段从 0.5 秒起 0.15 秒内爬到满亮（灯丝预热）
        if (r >= 0.5) target = Math.min(1, 0.6 + seg(r, 0.5, 0.65) * 0.4);
        level = target;
        if (r >= 0.65) { r = -1; off = false; }
      } else if (off) {
        level = approach(level, 0, 30, dt);
      } else {
        // 平时
        nextBlip -= dt;
        if (nextBlip <= 0) {
          blip = 0;
          blipLen = 0.1 + rand() * 0.2;
          blipDepth = 0.05 + rand() * 0.15;
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
