// 衣柜的画面（src/view/props/wardrobe.ts）：门的角度曲线、手指变体、晃的外套、合上那一下的震动、布局、落灰的表，
// 再把物件本身建出来按时间推一遍（不画东西，只查数）
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { CELL, FURNITURE, PROPS, propCenter } from '../src/config/house';
import { SCARES, WARDROBE } from '../src/config/scares';
import { idleManifest } from '../src/sim/manifest';
import type { ScareObjectState, SimEvent, WorldState } from '../src/sim/types';
import { FURNITURE_TOP, WARDROBE_BOX } from '../src/view/furniture';
import { DUST_BURSTS, dustShape } from '../src/view/particles';
import { PLASTER, burstLife } from '../src/view/particles/plaster';
import { BED_TIMELINE, bedDustSpot } from '../src/view/props/bed';
import { PORTRAIT_TIMELINE } from '../src/view/props/portrait';
import {
  WARDROBE_LOOK, WARDROBE_SHUT, coatSwing, createWardrobe, doorDeg, fingerGrip, hasFingers, slamShake, wardrobeDustSpot, wardrobeLayout,
} from '../src/view/props/wardrobe';

const W = WARDROBE;
/** 门撞上门框的那一刻 */
const SHUT = WARDROBE_SHUT;
const FRAME = 1 / 60;
/** [a, b] 按 step 采样（含两端） */
const samples = (a: number, b: number, step = 0.001) => {
  const out: number[] = [];
  for (let k = 0; a + k * step <= b + 1e-9; k++) out.push(a + k * step);
  return out;
};
const maxOf = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), -Infinity);

describe('衣柜：时间轴本身（画面按这个顺序接）', () => {
  it('latch → open → hold → slamAt 首尾相接；手指时段在 hold 里，到 slamAt 为止', () => {
    expect(W.latch[1]).toBe(W.open[0]);
    expect(W.open[1]).toBe(W.hold[0]);
    expect(W.hold[1]).toBe(W.slamAt);
    expect(W.fingers[0]).toBeGreaterThanOrEqual(W.hold[0]);
    expect(W.fingers[1]).toBe(W.slamAt);
    // 惊吓落下的时刻：现在是 slamAt；合并时主会话会改成门撞上的那一刻（WARDROBE_SHUT），两种都在门开始关到撞上之间
    expect(SCARES.wardrobe.hitAt).toBeGreaterThanOrEqual(W.slamAt);
    expect(SCARES.wardrobe.hitAt).toBeLessThanOrEqual(WARDROBE_SHUT);
  });

  it('门撞上门框的那一刻只算一处：WARDROBE_SHUT = slamAt + slamTime', () => {
    expect(WARDROBE_SHUT).toBe(W.slamAt + W.slamTime);
  });
});

describe('衣柜：门的角度（度）', () => {
  it('没在表演、刚触发的那一刻是关着的', () => {
    expect(doorDeg(-1)).toBe(0);
    expect(doorDeg(0)).toBe(0);
  });

  it('latch：门板轻轻一震（不到 1.5 度），时段结束时回到 0，还没开', () => {
    const latch = samples(W.latch[0], W.latch[1]).map(doorDeg);
    expect(maxOf(latch)).toBeGreaterThan(0.2);
    expect(maxOf(latch)).toBeLessThan(1.5);
    expect(Math.min(...latch)).toBeGreaterThanOrEqual(0);
    expect(doorDeg(W.latch[1] - 0.02)).toBe(0);
    expect(doorDeg(W.latch[1])).toBe(0);
  });

  it('open：从 0 单调开到 openDeg，先快后慢；到头那一帧还在动，是一下子停住的', () => {
    const [a, b] = W.open;
    const open = samples(a, b).map(doorDeg);
    for (let k = 1; k < open.length; k++) expect(open[k]).toBeGreaterThanOrEqual(open[k - 1]);
    expect(doorDeg(a)).toBeCloseTo(0, 9);
    expect(doorDeg(b)).toBe(W.openDeg);
    const mid = doorDeg((a + b) / 2);
    expect(mid).toBeGreaterThan((W.openDeg - mid) * 1.5); // 前一半开得比后一半多得多
    expect(doorDeg(b) - doorDeg(b - FRAME)).toBeGreaterThan(0.05); // 不是慢慢蹭到头
  });

  it('全程（1 毫秒采样）不超过 openDeg，也不往里关过头', () => {
    const all = samples(0, SHUT + 1).map(doorDeg);
    expect(maxOf(all)).toBeLessThanOrEqual(W.openDeg);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0);
  });

  it('hold：停住时一动不动（每一毫秒都正好 openDeg，不回弹、不晃）', () => {
    for (const t of samples(W.hold[0], W.hold[1] - 1e-6)) expect(doorDeg(t)).toBe(W.openDeg);
  });

  it('slamAt：slamTime 秒里猛地合上，越关越快，最后一帧还很快（硬停）', () => {
    const slam = samples(W.slamAt, SHUT).map(doorDeg);
    for (let k = 1; k < slam.length; k++) expect(slam[k]).toBeLessThanOrEqual(slam[k - 1]);
    expect(doorDeg(W.slamAt)).toBe(W.openDeg);
    expect(doorDeg(SHUT - FRAME)).toBeGreaterThan(3);
    const first = W.openDeg - doorDeg(W.slamAt + FRAME);
    const last = doorDeg(SHUT - FRAME) - doorDeg(SHUT);
    expect(last).toBeGreaterThan(first);
  });

  it('合上以后一直是 0（不回弹）', () => {
    for (const t of samples(SHUT, SHUT + 10, 0.01)) expect(doorDeg(t)).toBe(0);
  });
});

describe('衣柜：手指', () => {
  it('变体只看 variant：小于 fingersChance 才有；事件里没有 variant 当 0（sim/types.ts 的约定）', () => {
    expect(hasFingers(0)).toBe(true);
    expect(hasFingers(W.fingersChance - 1e-9)).toBe(true);
    expect(hasFingers(W.fingersChance)).toBe(false);
    expect(hasFingers(0.99)).toBe(false);
    expect(hasFingers(undefined)).toBe(true);
    // 均匀的 variant：正好三分之一左右有手指
    const n = samples(0, 0.999, 0.001).filter((v) => hasFingers(v)).length;
    expect(Math.abs(n / 1000 - W.fingersChance)).toBeLessThan(0.002);
  });

  it('在 fingers 时段里伸出来、扶住门边；合上时缩回去，门撞上之前已经缩完', () => {
    for (let i = 0; i < 4; i++) {
      expect(fingerGrip(W.fingers[0] - 1e-6, i)).toBe(0);
      expect(fingerGrip(W.slamAt - 0.01, i)).toBe(1);
      const rise = samples(W.fingers[0], W.slamAt - 1e-6).map((t) => fingerGrip(t, i));
      for (let k = 1; k < rise.length; k++) expect(rise[k]).toBeGreaterThanOrEqual(rise[k - 1]);
      expect(fingerGrip(SHUT - 2 * FRAME, i)).toBe(0);
      for (const t of samples(SHUT, SHUT + 5, 0.01)) expect(fingerGrip(t, i)).toBe(0);
      for (const t of samples(0, W.fingers[0], 0.01)) expect(fingerGrip(t - 1e-6, i)).toBe(0);
    }
  });

  it('一根接一根伸出来（食指先，小指最后）', () => {
    for (const t of samples(W.fingers[0], W.slamAt, 0.005)) {
      for (let i = 1; i < 4; i++) expect(fingerGrip(t, i)).toBeLessThanOrEqual(fingerGrip(t, i - 1));
    }
  });
});

describe('衣柜：外套和震动', () => {
  it('晃的那件外套 hold 之前不动，hold 里晃一下（不超过 WARDROBE_LOOK.coat.amp）', () => {
    for (const t of samples(0, W.hold[0], 0.01)) expect(coatSwing(t)).toBe(0);
    const hold = samples(W.hold[0], W.hold[1]).map((t) => Math.abs(coatSwing(t)));
    expect(maxOf(hold)).toBeGreaterThan(WARDROBE_LOOK.coat.amp * 0.5);
    expect(maxOf(samples(0, SHUT + 3).map((t) => Math.abs(coatSwing(t))))).toBeLessThanOrEqual(WARDROBE_LOOK.coat.amp);
  });

  it('门撞上之前不震；撞上那一下震不超过 2 毫米，很快停下', () => {
    for (const t of samples(0, SHUT - 1e-6, 0.005)) expect(slamShake(t)).toEqual([0, 0]);
    const shake = samples(SHUT, SHUT + 2).map((t) => Math.hypot(...slamShake(t)));
    expect(maxOf(shake)).toBeLessThanOrEqual(0.002);
    expect(maxOf(shake)).toBeGreaterThan(0.0003);
    for (const t of samples(SHUT + WARDROBE_LOOK.shakeTime, SHUT + 2, 0.01)) expect(slamShake(t)).toEqual([0, 0]);
  });
});

describe('衣柜：布局', () => {
  it('物件格就是衣柜正中、朝向一样：物件局部坐标就是衣柜的模型坐标', () => {
    const p = PROPS.find((x) => x.type === 'wardrobe')!;
    const f = FURNITURE.find((x) => x.id === 'bedroom-wardrobe')!;
    const c = propCenter(p);
    expect(c.x).toBeCloseTo(((f.rect.x0 + f.rect.x1) / 2) * CELL, 9);
    expect(c.z).toBeCloseTo(((f.rect.z0 + f.rect.z1) / 2) * CELL, 9);
    expect(p.facing).toBe(f.facing);
  });

  it('门洞在柜体里面；门板背面贴着柜体正面；背板一直伸到墙那边（比格子矩形还靠后）', () => {
    const L = wardrobeLayout();
    expect(L.w).toBeCloseTo(1.5, 9);
    expect(L.xo).toBeGreaterThan(0.5);
    expect(L.xo).toBeLessThan(L.w / 2);
    expect(L.y0).toBeGreaterThan(0.2);
    expect(L.y1).toBeLessThan(FURNITURE_TOP.wardrobe);
    expect(L.zFace).toBeLessThan(L.zf);
    expect(L.zBack).toBeLessThan(-L.zf); // 衣柜背后是墙格，柜体往后伸到墙面
    expect(L.zBack).toBeGreaterThan(L.zb);
  });

  it('落灰从柜顶上起来', () => {
    const L = wardrobeLayout();
    const s = wardrobeDustSpot();
    expect(s.y).toBe(FURNITURE_TOP.wardrobe);
    expect(Math.abs(s.x)).toBeLessThan(0.01);
    expect(s.z).toBeGreaterThan(L.zb);
    expect(s.z).toBeLessThan(L.zf);
  });
});

describe('落下时扬的灰：床、肖像、衣柜一张表（最终审查 P-6）', () => {
  it('三处都在表里', () => {
    expect(Object.keys(DUST_BURSTS).sort()).toEqual(['bed', 'portrait', 'wardrobe']);
  });

  it('肖像、床两行和并表之前一样（原来的 PORTRAIT_IMPACT、画框中心、BED_COLLAPSE、BED_DUST），都不往下落', () => {
    const p = DUST_BURSTS.portrait!, b = DUST_BURSTS.bed!;
    expect(p.at).toBe(PORTRAIT_TIMELINE.impact);
    expect(p.spot()).toEqual({ x: 0, y: 0, z: (PLASTER.slab.z0 + PLASTER.slab.z1) / 2 });
    expect(dustShape(p)).toBeUndefined();
    expect(b.at).toBe(BED_TIMELINE.collapse);
    expect(b.spot()).toEqual(bedDustSpot());
    expect(dustShape(b)).toEqual({ halfW: 0.22, halfL: 0.26, edgeShare: 0.4, count: 0.5, size: 0.75, speed: 0.6, chips: false });
  });

  it('衣柜：门撞上的那一刻（WARDROBE_SHUT）从柜顶起来，落点盖住整个柜顶，WARDROBE.settle 秒里落到地上，不崩碎屑', () => {
    const d = DUST_BURSTS.wardrobe!;
    const L = wardrobeLayout();
    expect(d.at).toBe(WARDROBE_SHUT);
    const s = dustShape(d)!;
    expect(s.fall).toBe(W.settle);
    expect(s.chips).toBe(false);
    // 前沿就是顶檐的外沿（翻下去的灰落在门前，不擦着门板），两边是柜子两侧
    expect(s.halfW).toBeCloseTo(L.w / 2, 9);
    expect(d.spot().z + s.halfL!).toBeCloseTo(L.zf, 9);
  });

  it('每一次扬灰活多久按那一行算：肖像要等碎屑、床不等、衣柜等落灰落完（约 WARDROBE.settle）', () => {
    expect(burstLife()).toBe(PLASTER.chips.life[1]);
    expect(burstLife(dustShape(DUST_BURSTS.bed!))).toBeCloseTo(PLASTER.dust.life[1] + PLASTER.dust.stagger, 9);
    const life = burstLife(dustShape(DUST_BURSTS.wardrobe!));
    expect(life).toBeGreaterThanOrEqual(W.settle);
    expect(life).toBeLessThan(W.settle + 0.2);
    // 落灰在自己寿命结束之前落到地上，落地以后才淡掉
    expect(PLASTER.fall.land).toBeLessThan(1);
    expect(PLASTER.fall.fadeFrom).toBeGreaterThanOrEqual(PLASTER.fall.land - 0.2);
    expect(PLASTER.fall.life[1]).toBe(1);
  });
});

// ───────────────────────── 物件本身 ─────────────────────────

const objState = (): ScareObjectState => ({ id: 'wardrobe', type: 'wardrobe', pos: { x: 4.25, z: 7.75 }, facing: Math.PI / 2, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 });
const worldState = (obj: ScareObjectState): WorldState => ({ time: 0, npcs: [], objects: [obj], scaredOff: 0, hitStop: 0, manifest: idleManifest(), avoid: [] });
const trig = (variant?: number): Extract<SimEvent, { type: 'trigger' }> => ({ type: 'trigger', object: 'wardrobe', scareType: 'wardrobe', variant });

/** 建一个衣柜、触发一次，返回「推到第几秒」和要看的几样东西 */
function rigAt(variant?: number) {
  const rig = createWardrobe();
  const obj = objState();
  const state = worldState(obj);
  const find = (name: string) => {
    const o = rig.model.getObjectByName(name);
    if (!o) throw new Error(`衣柜里没有 ${name}`);
    return o;
  };
  const hinge = find('wardrobe-hinge');
  const fingers = find('wardrobe-fingers');
  let now = 0;
  rig.update({ dt: FRAME, time: 0, obj, state });
  rig.trigger(state, trig(variant));
  return {
    rig, hinge, fingers,
    /** 用 1/120 秒的步长推到 trigger 以后第 s 秒 */
    to(s: number) {
      while (now < s - 1e-9) {
        const dt = Math.min(1 / 120, s - now);
        now += dt;
        rig.update({ dt, time: now, obj, state });
      }
    },
  };
}

describe('衣柜：物件', () => {
  it('转的是 −x（西边）那一扇，合页在它外侧；按时间轴开门、停住、合上，演完关着', () => {
    const r = rigAt(0.9);
    const L = wardrobeLayout();
    expect(r.hinge.position.x).toBeCloseTo(-L.xo, 9);
    expect(r.hinge.position.z).toBeCloseTo(L.zFace, 9);
    for (const s of [0.1, 0.8, 1.6, 1.9, 2.25, 2.3]) {
      r.to(s);
      expect(r.hinge.rotation.y).toBeCloseTo(-THREE.MathUtils.degToRad(doorDeg(s)), 6);
      if (s === 1.9) {
        // 停住的时候：门绕西边的合页往外开，门缝那条边往前（+z）走出去二十几厘米、往西（−x）偏：门往西南转
        const edge = new THREE.Vector3(L.xo - 0.01, 1, 0).applyEuler(r.hinge.rotation);
        expect(edge.z).toBeGreaterThan(0.2);
        expect(edge.x).toBeLessThan(L.xo - 0.01 - 0.05);
      }
    }
    r.to(SHUT + 3);
    expect(r.hinge.rotation.y).toBe(0);
    expect(r.rig.model.position.length()).toBe(0);
    r.rig.dispose?.();
  });

  it('默认的娃娃屋机位（东南，方位角 45°）看得进门缝：开着的门在画面上不挡着门缝；晃的外套就挂在门缝后面', () => {
    const r = rigAt(0.9);
    r.to(1.9);
    const L = wardrobeLayout();
    r.rig.model.updateMatrixWorld(true);
    // 镜头在东南（dev/harness.ts、engine/camera.ts 的方位角 π/4）：画面横轴是 (sin 45°, 0, −cos 45°)
    const az = Math.PI / 4;
    const sx = (v: THREE.Vector3) => v.x * Math.sin(az) - v.z * Math.cos(az);
    const hingeP = r.hinge.localToWorld(new THREE.Vector3(0, 1, 0));
    const freeP = r.hinge.localToWorld(new THREE.Vector3(L.xo - WARDROBE_BOX.gap / 2, 1, 0));
    const stillEdge = new THREE.Vector3(WARDROBE_BOX.gap / 2, 1, L.zFace); // 一直关着那扇门的门边
    // 开着的门在画面上占 [合页, 门缝那条边]，整个在不动那扇门门边的左边，中间露出来二十几厘米宽的缝
    expect(sx(stillEdge) - Math.max(sx(hingeP), sx(freeP))).toBeGreaterThan(0.15);
    const coatPivot = r.rig.model.getObjectByName('wardrobe-coat')!.parent!;
    expect(coatPivot.position.x).toBeLessThan(0);
    expect(coatPivot.position.x).toBeGreaterThan(-0.2);
  });

  it('扶住的时候只露出手指：门后那一截手（掌骨）离门缝那条边往里不超过 3 厘米、往柜子里不超过 4.5 厘米（审查 Minor-3：门外不显出一截黑桩）', () => {
    const r = rigAt(0.1);
    r.to(2.1); // 四根都扶住了（最晚的小指 2.07 秒）
    const L = wardrobeLayout();
    const xe = L.xo - WARDROBE_BOX.gap / 2; // 门缝那条边（合页坐标）
    const pos = (r.fingers as THREE.Mesh).geometry.attributes.position;
    let minX = Infinity, minZ = Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getZ(i) >= 0) continue; // 门板里面那个平面以前的（绕过门边、趴在门面上的手指）不算
      minX = Math.min(minX, pos.getX(i));
      minZ = Math.min(minZ, pos.getZ(i));
    }
    expect(minX).toBeGreaterThan(xe - 0.03);
    expect(minZ).toBeGreaterThan(-0.045);
  });

  it('手指只在 variant 小于 fingersChance 的那一次出现，只在 fingers 时段里，合上以后不见', () => {
    const yes = rigAt(0.1);
    expect(yes.fingers.visible).toBe(false);
    yes.to(W.fingers[0] - 0.05);
    expect(yes.fingers.visible).toBe(false);
    yes.to(1.9);
    expect(yes.fingers.visible).toBe(true);
    yes.to(SHUT);
    expect(yes.fingers.visible).toBe(false);
    yes.to(SHUT + 3);
    expect(yes.fingers.visible).toBe(false);

    const no = rigAt(0.5);
    for (const s of [1.75, 1.9, 2.1, 2.25]) {
      no.to(s);
      expect(no.fingers.visible).toBe(false);
    }
    // 事件里没有 variant：当 0，有手指
    const none = rigAt(undefined);
    none.to(1.9);
    expect(none.fingers.visible).toBe(true);
  });

  it('手指平时不进开场那次阻塞的预编译（deferCompile）', () => {
    const r = rigAt(0.1);
    expect(r.fingers.userData.deferCompile).toBe(true);
  });

  it('合上那一下整只柜子（物件这部分）震不超过 2 毫米，演完回到原位', () => {
    const r = rigAt(0.9);
    let worst = 0;
    for (const s of samples(SHUT - 0.05, SHUT + 0.5, 1 / 120)) {
      r.to(s);
      worst = Math.max(worst, r.rig.model.position.length());
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(0.002);
    r.to(SHUT + 3);
    expect(r.rig.model.position.length()).toBe(0);
  });
});
