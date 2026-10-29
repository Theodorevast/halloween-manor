// 看得见的前门（2026-10-30「一夜」，内容分析候选 3）：门洞里一扇门，绕西侧合页往屋里开约 100°，让出进门那条路。
// 门板、门框用基础几何体拼成（照厨房门 props/door.ts 的样式），用 props/kit.ts 的 bodyMaterial（和厨房门同一种顶点色材质），投影；
// 不加灯、不发光、不描边。一开场就在场景里（可见、不标 deferCompile），开场的预编译就把它编好了。
//
// 什么时候开、什么时候关（时刻在 config/frontDoor.ts，声音读同一份，tests/front-door.test.ts 钉着）：
// - spawn 事件（有人在门外）：先两下敲门，门还关着；接着门轴吱呀的那一秒里往屋里推开，先快后慢，访客走到门口之前已经开到 70° 以上
// - 附近有进门、逃跑、天亮自己走的人（离门洞 FRONT_DOOR_MOTION.hold 米以内）就一直开着
// - 有人被吓跑：他离门洞 flee.reach 米时被撞开（赶在他前面）；exit 事件（他冲出去、远处那声关门响起）那一刻起甩上，
//   exit.contact 秒后撞上门框，闷响（sfx.ts 的 exitDoor）就落在撞上那一刻；后面还有人要过就先不甩，等最后一个
// - 天亮自己走的人（mode leaving）：他走到离门洞 calm.reach 米时慢慢推开，没有声音
// - 没人了：停 settle 秒，用 close 秒慢慢自己合上，没有声音
// 第三人称：鬼魂和镜头穿过时溶开（照 props.ts 的写法，walls.ts 的 DISSOLVE）。
// 娃娃屋俯视：南墙降低时门板跟着沉到地板下面（读 walls.ts 的 wallFullness）。沉着也还在场景里、还可见：开场的预编译和阴影 pass 都要画到它，
// 南墙第一次升起来才不会卡一下；开合的动作照常走，openness 不受影响
import * as THREE from 'three/webgpu';
import { add, bool, materialEmissive, normalWorld, positionWorld, uniform } from 'three/tsl';
import { FRONT_DOOR_TIMELINE as TL } from '../config/frontDoor';
import { CELL, FRONT_DOOR } from '../config/house';
import type { GhostRig, Module, RenderCore } from '../engine/types';
import type { NpcMode, Vec2 } from '../sim/types';
import { C, Parts, bodyMaterial, clamp01, inOutSine, lerp, mesh, outCubic, seg } from './props/kit';
import { DISSOLVE, Side, dissolveAt, ghostDissolve, v3, wallFullness } from './walls';

export interface FrontDoor extends Module {
  /** 门现在开着多少（0 = 关上，1 = 全开）：收夜检测「最后一个人走了、门关上了」用 */
  readonly openness: number;
}

// ───────────────────────── 动作 ─────────────────────────

/** 画面自己的数（和声音共用的时刻在 config/frontDoor.ts）；米、秒 */
export const FRONT_DOOR_MOTION = {
  /** 离门洞中心这么近的、正在进门 / 逃跑 / 天亮自己走的人，门就一直开着；exit 时他们也要等 */
  hold: 2.6,
  /** 被吓跑的人离门洞中心不到 reach 米时门被撞开，open 秒开到头。reach 要比门扫过的那一片（门洞北边 1.1 米）远，免得门从他身上扫过去 */
  flee: { reach: 2.2, open: 0.22 },
  /** 天亮自己走的人：离门洞中心不到 reach 米时推开，open 秒（慢，缓起缓停） */
  calm: { reach: 2.6, open: 0.9 },
  /** 进门的人已经走到离门洞中心这么近、门还没开到 clearDeg（吱呀的时刻已过，正常不会有）：兜底撞开，不让人穿过关着的门 */
  force: 1.3,
  /** 没人了以后停 settle 秒，再用 close 秒慢慢自己合上（从全开合到 0；半开着合的话按比例缩短，不少于 0.6 秒） */
  settle: 1.0,
  close: 3.0,
};
const M = FRONT_DOOR_MOTION;

type Ease = (u: number) => number;
/** 甩上：一开始就有速度，越关越快（和厨房门被附身甩上同一条） */
const slamEase: Ease = (u) => 0.3 * u + 0.7 * u * u;
const swing = (from: number, to: number, t: number, dur: number, ease: Ease) => lerp(from, to, ease(seg(t, 0, dur)));
const closeDur = (from: number) => Math.max(0.6, (M.close * from) / TL.openDeg);

// 下面几条是纯曲线：t 是这一下动作开始以后的秒数，from 是动作开始时门的角度（度）。控制器用的就是它们，测试直接量
/** 进门推开：t 从 spawn 事件算起；敲门时关着，吱呀那一秒里先快后慢开到头 */
export const spawnOpenDeg = (t: number, from = 0) => lerp(from, TL.openDeg, outCubic(seg(t, TL.creak[0], TL.creak[1])));
/** 被吓跑的人撞开 */
export const bangOpenDeg = (t: number, from = 0) => swing(from, TL.openDeg, t, M.flee.open, outCubic);
/** 天亮自己走的人推开 */
export const calmOpenDeg = (t: number, from = 0) => swing(from, TL.openDeg, t, M.calm.open, inOutSine);
/** 没人了，慢慢自己合上（缓起缓停，没有声音，所以不能「砰」一下） */
export const slowCloseDeg = (t: number, from: number) => swing(from, 0, t, closeDur(from), inOutSine);
/** exit：从事件那一刻起甩上，contact 秒后撞上门框 */
export const slamDeg = (t: number, from: number) => swing(from, 0, t, TL.exit.contact, slamEase);

/** 控制器要的访客信息（NpcState 的子集） */
export interface DoorNpc {
  id: number;
  mode: NpcMode;
  pos: Vec2;
}

export interface DoorMotion {
  /** 门现在开了多少度 */
  readonly deg: number;
  /** 0 = 关上，1 = 全开 */
  readonly openness: number;
  /** spawn 事件：门外有人敲门 */
  spawn(): void;
  /** exit 事件：id 是走出前门的人，npcs 是此刻 state.npcs（可能还留着他） */
  exit(id: number, npcs: readonly DoorNpc[]): void;
  /** 每帧：dt 是真实时间（hit-stop 里也照常走），npcs 是此刻 state.npcs */
  update(dt: number, npcs: readonly DoorNpc[]): void;
}

interface Move {
  kind: 'open' | 'close' | 'slam';
  from: number;
  to: number;
  t0: number;
  dur: number;
  ease: Ease;
}

/** 前门的开合状态机（纯 TypeScript，不碰 three.js）：角度只由事件和访客的位置、模式推出来 */
export function createDoorMotion(): DoorMotion {
  let now = 0;
  let deg = 0;
  let m: Move | null = null;
  /** 排好、还没到点的进门推开：敲门这几百毫秒里门还关着，吱呀一起就推开 */
  let pending: { at: number } | null = null;
  /** 进门那一下排到的最后时刻（吱呀结束）：在这之前不用「兜底撞开」 */
  let scriptEnd = -Infinity;
  /** 门开着、不动、没人需要它，已经过了多久 */
  let idle = 0;

  const begin = (kind: Move['kind'], to: number, dur: number, ease: Ease) => {
    m = { kind, from: deg, to, t0: now, dur, ease };
  };
  const needsDoor = (mode: NpcMode) => mode === 'entering' || mode === 'fleeing' || mode === 'leaving';
  const distOf = (n: DoorNpc) => Math.hypot(n.pos.x - DOORWAY.x, n.pos.z - DOORWAY.z);

  return {
    get deg() {
      return deg;
    },
    get openness() {
      return clamp01(deg / TL.openDeg);
    },
    spawn() {
      // 慢慢合着的停住，敲完门再接着推开；甩上的让它合完（吱呀起来之前早合完了）
      if (m && m.kind === 'close') m = null;
      pending = { at: now + TL.creak[0] };
      scriptEnd = now + TL.creak[1];
      idle = 0;
    },
    exit(id, npcs) {
      // 又有人在敲门了、或者门本来就关着：不用甩
      if (pending !== null || deg < 1) return;
      // 后面还有人要过：先不甩，等最后一个（远处那声关门的闷响照样响，是声音那边的事）
      for (const n of npcs) {
        if (n.id !== id && needsDoor(n.mode) && distOf(n) <= M.hold) return;
      }
      begin('slam', 0, TL.exit.contact, slamEase);
      idle = 0;
    },
    update(dt, npcs) {
      now += dt;
      // 排好的进门推开到点了：从当前角度开到头，在吱呀这一段里走完
      if (pending !== null && now >= pending.at) {
        m = { kind: 'open', from: deg, to: TL.openDeg, t0: pending.at, dur: TL.creak[1] - TL.creak[0], ease: outCubic };
        pending = null;
      }
      // 推进动作
      if (m) {
        const end = m.t0 + m.dur;
        deg = now >= end ? m.to : lerp(m.from, m.to, m.ease(seg(now, m.t0, end)));
        if (now >= end) m = null;
      }
      // 看周围的人：谁要用门、谁在跑向门
      let held = false;
      let bang = false;
      let calm = false;
      let force = false;
      for (const n of npcs) {
        if (!needsDoor(n.mode)) continue;
        const d = distOf(n);
        if (d <= M.hold) held = true;
        if (n.mode === 'fleeing' && d <= M.flee.reach) bang = true;
        else if (n.mode === 'leaving' && d <= M.calm.reach) calm = true;
        else if (n.mode === 'entering' && d <= M.force) force = true;
      }
      const opening = m !== null && m.to > 0;
      if (pending === null && !opening) {
        if (bang && deg < TL.openDeg - 0.5) begin('open', TL.openDeg, M.flee.open, outCubic);
        else if (calm && deg < TL.openDeg - 0.5) begin('open', TL.openDeg, M.calm.open, inOutSine);
        else if (force && now >= scriptEnd && deg < TL.clearDeg) begin('open', TL.openDeg, M.flee.open, outCubic);
      }
      // 没人了：停 settle 秒，慢慢合上
      if (held || m !== null || pending !== null || deg < 0.01) idle = 0;
      else {
        idle += dt;
        if (idle >= M.settle) {
          begin('close', 0, closeDur(deg), inOutSine);
          idle = 0;
        }
      }
    },
  };
}

// ───────────────────────── 门板 ─────────────────────────

/** 门洞中心（房屋米坐标）：前门两格的中点，南墙的中线上 */
const DOORWAY = {
  x: FRONT_DOOR.cells.reduce((s, [i]) => s + (i + 0.5) * CELL, 0) / FRONT_DOOR.cells.length,
  z: (FRONT_DOOR.cells[0][1] + 0.5) * CELL,
};

// 局部坐标（和厨房门一样）：原点在门洞中心的地面，+z 朝屋外（南），-z 是屋里（门厅）；墙体占 z ∈ [-0.1, 0.1]
const OPEN_W = 0.88; // 门板宽（门框内净宽）
const DOOR_H = 1.98;
const DOOR_T = 0.05;
const JAMB = 0.06; // 门框立柱宽：1 米 = 0.06 + 0.88 + 0.06
const FRAME_D = 0.24; // 门框比墙（0.2）略厚，两面都凸出一点
/** 合页轴（x, z）：西侧立柱内沿、门厅一侧的墙面外。门板绕它转，正角度往屋里（-z）开 */
const HINGE: [number, number] = [-OPEN_W / 2, -0.125];
const RAD = Math.PI / 180;
/** 南墙降到底时门板沉多深（米）：比门框顶（2.09）深，整个沉到地板下面 */
const SINK = 2.4;
const smooth = (t: number) => t * t * (3 - 2 * t);

const LEAF = C.wood;
const PANEL = C.woodDark;

/** 门框：两根立柱 + 门楣，再加两面的线脚（比门洞多出不到 3 厘米，藏在墙里） */
function buildFrame(): THREE.BufferGeometry {
  const fp = new Parts();
  const jx = OPEN_W / 2 + JAMB / 2;
  for (const s of [-1, 1]) {
    fp.box(JAMB, DOOR_H + 0.04, FRAME_D, C.woodDark, [s * jx, (DOOR_H + 0.04) / 2, 0]);
    for (const zs of [-1, 1]) fp.box(0.03, DOOR_H + 0.08, 0.02, C.trim, [s * (OPEN_W / 2 + JAMB + 0.005), (DOOR_H + 0.08) / 2, zs * (FRAME_D / 2 - 0.01)]);
  }
  // 门楣顶到 2.09 米，在 walls.ts 的前门门楣（下沿 2.1 米）下面
  fp.box(OPEN_W + JAMB * 2 + 0.05, 0.07, FRAME_D + 0.02, C.woodDark, [0, DOOR_H + 0.075, 0]);
  return fp.build();
}

/** 门板：转轴在合页；几何在合页坐标里占 x ∈ [0, 0.88]、z ∈ [0, 厚度] */
function buildLeaf(): THREE.BufferGeometry {
  const pp = new Parts();
  const cx = OPEN_W / 2;
  const cz = DOOR_T / 2;
  pp.box(OPEN_W - 0.01, DOOR_H - 0.01, DOOR_T, LEAF, [cx, DOOR_H / 2, cz]);
  for (const zs of [-1, 1]) {
    const z = cz + zs * (DOOR_T / 2 + 0.005);
    // 六块凸起的门芯板（两列三行，两面都有）
    for (const px of [-0.19, 0.19]) for (const [py, ph] of [[0.42, 0.56], [1.05, 0.5], [1.62, 0.5]]) pp.box(0.3, ph, 0.012, PANEL, [cx + px, py, z]);
    // 门把手（铜）：离合页远的一侧
    pp.cyl(0.028, 0.028, 0.03, 8, C.brass, [OPEN_W - 0.08, 0.98, cz + zs * (DOOR_T / 2 + 0.02)], [Math.PI / 2, 0, 0]);
    pp.box(0.04, 0.12, 0.006, C.brass, [OPEN_W - 0.08, 0.98, cz + zs * (DOOR_T / 2 + 0.003)]);
  }
  // 门环（屋外那一面，两下敲门敲的就是它）：底板 + 吊环 + 门环落下去敲的那颗钉
  pp.box(0.09, 0.1, 0.01, C.brass, [cx, 1.5, DOOR_T + 0.014]);
  pp.add(new THREE.TorusGeometry(0.045, 0.008, 6, 12), C.brass, [cx, 1.43, DOOR_T + 0.03]);
  pp.cyl(0.012, 0.012, 0.03, 6, C.brass, [cx, 1.34, DOOR_T + 0.015], [Math.PI / 2, 0, 0]);
  // 合页（铁）
  for (const y of [0.25, 1.0, 1.75]) pp.box(0.025, 0.12, DOOR_T + 0.012, C.iron, [0.005, y, cz]);
  return pp.build();
}

/**
 * rig 不为空是第三人称：门板在鬼魂周围和「镜头 → 鬼魂」视线上溶开（?noghostfx 时不溶，和 props.ts 一样）；
 * 为空是娃娃屋俯视：不溶，南墙降低时门板沉到地板下面。接线（modules.push）在 main.ts，不在这里
 */
export function createFrontDoor(core: RenderCore, rig: GhostRig | null): FrontDoor {
  const noFx = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noghostfx');
  const dissolve = rig !== null && !noFx;

  const material = bodyMaterial(0.75);
  // 溶解按房屋坐标算：门会动，用片元的世界坐标减去 houseRoot 的偏移（houseRoot 只平移不旋转）。写法照 props.ts 的 dissolveMaterial
  const houseOffset = uniform(new THREE.Vector3());
  if (dissolve) {
    const d = dissolveAt(ghostDissolve, positionWorld.sub(houseOffset), normalWorld, DISSOLVE.furniture);
    material.maskNode = d.keep;
    // 影子照旧：溶开的只是「看穿」
    material.maskShadowNode = bool(true);
    // 洞口一圈冷光、附近一点霜光
    const edge = v3(DISSOLVE.rimGlow).mul(d.rim).add(v3(DISSOLVE.frostGlow).mul(d.frost));
    material.emissiveNode = add((material.emissiveNode as THREE.Node<'vec3'> | null) ?? materialEmissive, edge);
  }

  const frameGeo = buildFrame();
  const leafGeo = buildLeaf();
  const root = new THREE.Group();
  root.name = 'front-door';
  root.position.set(DOORWAY.x, 0, DOORWAY.z);
  root.add(mesh(frameGeo, material, 'front-door-frame'));
  const hinge = new THREE.Group();
  hinge.name = 'front-door-hinge';
  hinge.position.set(HINGE[0], 0, HINGE[1]);
  hinge.add(mesh(leafGeo, material, 'front-door-leaf'));
  root.add(hinge);
  core.houseRoot.add(root);

  const motion = createDoorMotion();

  return {
    get openness() {
      return motion.openness;
    },
    onEvent(e, state) {
      if (e.type === 'spawn') motion.spawn();
      else if (e.type === 'exit') motion.exit(e.npc, state.npcs);
    },
    update(ctx) {
      houseOffset.value.copy(core.houseRoot.position);
      motion.update(ctx.dt, ctx.state.npcs);
      hinge.rotation.y = motion.deg * RAD;
      // 南墙降低多少，门板就沉下去多少（和墙高用同一条缓动）；第三人称墙一直全高，一直是 0
      root.position.y = SINK * (smooth(wallFullness[Side.S] ?? 1) - 1);
    },
    dispose() {
      core.houseRoot.remove(root);
      frameGeo.dispose();
      leafGeo.dispose();
      material.dispose();
    },
  };
}
