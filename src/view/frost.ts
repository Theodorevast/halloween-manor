// 地上的霜（2026-10-28，调研 S1）：现身时从鬼魂脚下往外长（grow，大号）；另有一个机关提示用的小号（small：物件脚下一小圈薄霜），
// 现在没人调它——机关提示用的是 props.ts 里物件表面的那层霜（地上一圈霜看不出是哪个物件），留着它是看样时的另一个选项。
// 每块霜是一块贴地的方片（高过地毯一点），片元里按到中心的距离和噪声画：从中心往外长，长到的那条边是细碎的冰花，越往外越薄；
// 停一会儿以后从外往里化掉。受光照（有灯照着才看得清，阴影里是暗的）、不发光，只带墙上的霜那一点点自发光（walls.ts 的
// DISSOLVE.frostGlow，没灯的时候隐约看得出）；颜色用 DISSOLVE.frostAlbedo，和鬼魂穿墙时墙上结的霜是同一种。
// 几块霜共用一个材质：每块的参数是逐物体的 uniform（onObjectUpdate 从 mesh.userData 读），没在用的藏起来（不画）。
// 材质第一次出现时现编会卡一下：网格标 userData.deferCompile，开场按钮可用之后由 main.ts 预编译
import * as THREE from 'three/webgpu';
import { clamp, float, length, max, mix, mx_noise_float, positionLocal, positionWorld, pow, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { MANIFEST } from '../config/visitors';
import type { FrameCtx, Module, RenderCore } from '../engine/types';
import type { Vec2 } from '../sim/types';
import { DISSOLVE, v3 } from './walls';

type F = THREE.Node<'float'>;

export const FROST = {
  /** 离地高度（米）：地毯、走廊长毯的面在 0.016 米，高过它 */
  y: 0.02,
  /**
   * 大号（现身）：几块轮流用（上一块还在化，下一次就来了）；长满以后停多久再化（秒）、化多久、最浓多少。
   * 停多久就是现身的停留 MANIFEST.hold（直接引用，不另写一个数）：霜在鬼魂收回之前不化，改停留时长霜跟着走
   */
  big: { count: 2, hold: MANIFEST.hold, melt: 4, alpha: 0.46 },
  /** 小号（机关提示的另一个选项，现在没人用）：半径（米）、长出来、化掉各几秒、最浓多少（薄） */
  small: { count: 4, radius: 0.42, grow: 0.5, melt: 1.5, alpha: 0.26 },
  /**
   * 边：噪声每个半径几个起伏（按半径算，大小两号的边一样碎）、扰动幅度（占半径的比例）；冰花每米几颗；
   * 长到的那条边往里多宽是碎的冰花（占半径的比例）
   */
  noise: 2.9,
  ragged: 0.2,
  crystal: 34,
  feather: 0.3,
  /** 里面也不是一整片：每米 patch 个起伏的薄厚，薄处只剩 patchMin（像一层不匀的白霜，不是一块白毯子） */
  patch: 5.5,
  patchMin: 0.45,
  /** 越往外越薄：从这个半径比例开始，到边上只剩 edgeThin */
  thinFrom: 0.4,
  edgeThin: 0.5,
  /** 霜厚的地方 roughness 降到这个（略提光泽，手电扫过时有一点反光；不发光） */
  roughness: 0.42,
  /** 自发光：DISSOLVE.frostGlow 的几倍 */
  glow: 1,
  /** 画在地板之后、地面薄雾（1.5）之前 */
  renderOrder: 1.2,
};

/** 一块霜的参数（逐物体 uniform 的值） */
interface Patch {
  mesh: THREE.Mesh;
  /** x, z（房屋坐标）、半径（米）、随机种子 */
  a: THREE.Vector4;
  /** 开始长的时刻、长多久、开始化的时刻、化多久（秒，frost 自己的钟） */
  b: THREE.Vector4;
  /** 最浓多少 */
  c: THREE.Vector4;
  /** 小号：哪个物件的；大号为 null */
  id: string | null;
  /** 等下一次 update 再定开始的时刻（事件在两帧之间到）；melt：等下一次 update 再开始化 */
  pendingStart: boolean;
  pendingMelt: boolean;
  active: boolean;
}

/** 方片比半径大这么多（噪声把边往外推） */
const EXTENT = 1 + FROST.ragged + 0.08;

export interface Frost extends Module {
  /** pos 处从 0 长到 radius 米（seconds 秒），停 FROST.big.hold 秒，再化 FROST.big.melt 秒 */
  grow(pos: Vec2, radius: number, seconds: number): void;
  /** 机关提示（现在没人调，见文件开头）：on = true 时在 pos 长一小圈薄霜（同一个 id 再调不重来），false 时化掉 */
  small(id: string, pos: Vec2, on: boolean): void;
  update(ctx: FrameCtx): void;
  dispose(): void;
}

export function createFrost(core: RenderCore): Frost {
  const time = uniform(0);
  const uA = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => (object?.userData.frost as Patch | undefined)?.a);
  const uB = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => (object?.userData.frost as Patch | undefined)?.b);
  const uC = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => (object?.userData.frost as Patch | undefined)?.c);

  const mat = new THREE.MeshStandardNodeMaterial({
    transparent: true, depthWrite: false, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  {
    // 到中心的距离（半径的比例）：方片的局部坐标 −1..1 对应 EXTENT 倍半径
    const d = length(positionLocal.xz).mul(EXTENT);
    // 噪声在世界坐标里取（每块霜的边都不一样，同一块不随时间变）
    const P = positionWorld;
    const seed = uA.w;
    const q = vec2(P.x, P.z).mul(float(FROST.noise).div(max(uA.z, 0.05))).add(vec2(seed.mul(17.3), seed.mul(-9.1)));
    const n = mx_noise_float(vec3(q.x, q.y, seed)).mul(0.65).add(mx_noise_float(vec3(q.x.mul(2.7), q.y.mul(2.7), seed.add(3.1))).mul(0.35));
    const e = d.add(n.mul(FROST.ragged));
    // 长、化：长的时候先快后慢；化的时候从外往里收，同时整体变薄
    const g = clamp(time.sub(uB.x).div(max(uB.y, 0.001)), 0, 1);
    const grown = float(1).sub(pow(float(1).sub(g), 2));
    const m = clamp(time.sub(uB.z).div(max(uB.w, 0.001)), 0, 1);
    const front = grown.mul(float(1).sub(m));
    const inside = float(1).sub(smoothstep(front.sub(0.06), front, e));
    // 长到的那条边往里 feather 宽是碎的冰花，再往里是连成片的霜
    const crystal = smoothstep(0.15, 0.7, mx_noise_float(vec3(P.x, P.z, seed).mul(FROST.crystal)).mul(0.5).add(0.5));
    const rim = smoothstep(front.sub(FROST.feather), front, e);
    const lumpy = mix(float(FROST.patchMin), float(1), smoothstep(-0.35, 0.45, mx_noise_float(vec3(P.x, P.z, seed.add(7.7)).mul(FROST.patch))));
    const broken = mix(lumpy, crystal, rim);
    const thin = mix(float(1), float(FROST.edgeThin), smoothstep(FROST.thinFrom, 1, d));
    // 刚开始长、快化完的时候 front 很小：噪声在中心挖出的几小块不能先冒出来、最后剩下（整块一起淡到 0，不会一下子没了）
    const tiny = smoothstep(0, 0.18, front);
    const cover = inside.mul(broken).mul(thin).mul(tiny).mul(float(1).sub(m.mul(0.6))) as F;
    mat.colorNode = v3(DISSOLVE.frostAlbedo).mul(crystal.mul(0.25).add(0.75));
    mat.roughnessNode = mix(float(0.85), float(FROST.roughness), inside);
    mat.emissiveNode = v3(DISSOLVE.frostGlow).mul(FROST.glow).mul(cover);
    mat.opacityNode = cover.mul(uC.x);
  }

  const root = new THREE.Group();
  root.name = 'frost';
  core.houseRoot.add(root);
  const geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

  const make = (k: number): Patch => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = `frost-${k}`;
    mesh.renderOrder = FROST.renderOrder;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // 位置、大小每次都变，包围球不准；平时藏着，不费事
    mesh.visible = false;
    // 不进开场那次阻塞的预编译：main.ts 在开场按钮可用之后再编（那几帧里它是完全透明的）
    mesh.userData.deferCompile = true;
    const p: Patch = {
      mesh, a: new THREE.Vector4(0, 0, 1, 0), b: new THREE.Vector4(-1e6, 1, -1e6, 1), c: new THREE.Vector4(0, 0, 0, 0),
      id: null, pendingStart: false, pendingMelt: false, active: false,
    };
    mesh.userData.frost = p;
    root.add(mesh);
    return p;
  };
  const big = Array.from({ length: FROST.big.count }, (_, k) => make(k));
  const small = Array.from({ length: FROST.small.count }, (_, k) => make(FROST.big.count + k));
  let nextBig = 0;
  let now = 0;

  const place = (p: Patch, pos: Vec2, radius: number) => {
    p.a.set(pos.x, pos.z, radius, Math.random() * 100);
    p.mesh.position.set(pos.x, FROST.y, pos.z);
    p.mesh.scale.set(radius * EXTENT, 1, radius * EXTENT);
    p.active = true;
    p.mesh.visible = true;
  };

  return {
    grow(pos, radius, seconds) {
      const p = big[nextBig];
      nextBig = (nextBig + 1) % big.length;
      place(p, pos, radius);
      // 开始时刻等下一次 update 再定；先把「开始化」推到很远，免得这一帧按旧值画
      p.b.set(now, Math.max(0.05, seconds), 1e9, FROST.big.melt);
      p.c.x = FROST.big.alpha;
      p.pendingStart = true;
      p.pendingMelt = false;
    },
    small(id, pos, on) {
      const S = FROST.small;
      let p = small.find((s) => s.id === id && s.active);
      if (on) {
        if (p && !p.pendingMelt && p.b.z >= 1e8) return; // 已经亮着
        p ??= small.find((s) => !s.active) ?? small.reduce((a, s) => (s.b.z < a.b.z ? s : a));
        p.id = id;
        place(p, pos, S.radius);
        p.b.set(now, S.grow, 1e9, S.melt);
        p.c.x = S.alpha;
        p.pendingStart = true;
        p.pendingMelt = false;
      } else if (p) {
        p.pendingMelt = true;
      }
    },
    update(ctx: FrameCtx) {
      now = ctx.time;
      time.value = now;
      for (const p of [...big, ...small]) {
        if (!p.active) continue;
        if (p.pendingStart) {
          const hold = p.id === null ? FROST.big.hold : Infinity;
          p.b.x = now;
          p.b.z = Number.isFinite(hold) ? now + p.b.y + hold : 1e9;
          p.pendingStart = false;
        }
        if (p.pendingMelt) {
          // 还没长满就关：从现在的样子开始化
          p.b.z = Math.min(p.b.z, now);
          p.pendingMelt = false;
        }
        if (now >= p.b.z + p.b.w) {
          p.active = false;
          p.mesh.visible = false;
          p.id = null;
        }
      }
    },
    dispose() {
      core.houseRoot.remove(root);
      geometry.dispose();
      mat.dispose();
    },
  };
}
