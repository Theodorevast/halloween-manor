// 鬼魂挡住访客时自己淡下去（第二波 FEEL-5，view/ghost.ts 的 GHOST.occlude 和那几个纯函数）。
// 朝人飘过去时他天然在鬼魂身后（鬼魂离镜头近、他远，过肩只偏 0.32 米，2 米外的人落在鬼魂身宽的投影里）；贴近发毛、现身落下被吓的人、
// 吓跑的那个人，都被鬼魂自己挡住。做法：每帧把鬼魂和每个比它离镜头更远的访客投到屏幕上，算访客的矩形被鬼魂的矩形盖住多少，
// 盖得多就把鬼魂的 u.fade 乘一个小于 1 的数（平时 0.6、现身的实体 0.7、正被手电照出来时 0.75；2026-10-30 路 GH 从 0.35 / 0.5 / 0.6 上调），
// 再平滑（变淡快、回来慢）。
// 这里只测不依赖渲染的部分：投影矩形、重叠比例、平滑、挑哪些访客；着色器里只是多乘一个 uniform 的值
import { describe, expect, it } from 'vitest';
import { CHARACTER } from '../src/config/character';
import { ghostSees } from '../src/engine/ghostRig';
import type { Vec2 } from '../src/sim/types';
import {
  GHOST, approachCover, coverOf, ghostCoverRect, occludeK, overlapOfGhost, rectOf, rectOverlap, visitorCoverRect,
  type CoverNpc, type CoverProject, type Rect,
} from '../src/view/ghost';
import { countDips } from '../src/view/lightfx';

const O = GHOST.occlude;
const R = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });

/**
 * 一台只会朝水平方向看的针孔相机（够测几何）：在 (cx, camY, cz)，朝 (fx, fz)（水平单位向量），竖直视场 60°，1280 × 800。
 * 房屋坐标：x 向东、z 向南、y 向上；朝北（0, −1）时右手边是东（1, 0）
 */
function makeCam(cx: number, cz: number, fx: number, fz: number, camY = 1.9) {
  const W = 1280, H = 800;
  const focal = H / 2 / Math.tan((30 * Math.PI) / 180);
  const right = { x: -fz, z: fx };
  const project: CoverProject = (x, z, y) => {
    const dx = x - cx, dz = z - cz;
    const depth = dx * fx + dz * fz;
    if (depth < 0.05) return { x: NaN, y: NaN };
    return { x: W / 2 + ((dx * right.x + dz * right.z) / depth) * focal, y: H / 2 - ((y - camY) / depth) * focal };
  };
  return { project, right, cam: { x: cx, z: cz } };
}

describe('rectOf：把投影点包成矩形', () => {
  it('取最小最大；有一个点在镜头背后（NaN）就没有矩形', () => {
    expect(rectOf([{ x: 10, y: 50 }, { x: 30, y: 20 }, { x: 20, y: 40 }])).toEqual(R(10, 20, 30, 50));
    expect(rectOf([{ x: 10, y: 50 }, { x: NaN, y: NaN }])).toBeNull();
    expect(rectOf([])).toBeNull();
  });
});

describe('rectOverlap：重叠面积 ÷ 访客矩形的面积（访客被盖住多少）', () => {
  it('完全盖住 = 1，不挨着 = 0，只擦边 = 0', () => {
    const visitor = R(100, 100, 200, 300);
    expect(rectOverlap(R(0, 0, 400, 400), visitor)).toBe(1);
    expect(rectOverlap(visitor, visitor)).toBe(1);
    expect(rectOverlap(R(300, 0, 400, 400), visitor)).toBe(0);
    expect(rectOverlap(R(200, 0, 400, 400), visitor)).toBe(0);
    expect(rectOverlap(R(0, 300, 400, 400), visitor)).toBe(0);
  });
  it('盖住一半 = 0.5；盖住四分之一 = 0.25；鬼魂比访客小时按访客的面积算', () => {
    const visitor = R(100, 100, 200, 300);
    expect(rectOverlap(R(0, 0, 150, 400), visitor)).toBeCloseTo(0.5, 12);
    expect(rectOverlap(R(0, 0, 150, 200), visitor)).toBeCloseTo(0.25, 12);
    // 鬼魂只有 20 × 20，整个落在访客里：400 / 20000
    expect(rectOverlap(R(140, 140, 160, 160), visitor)).toBeCloseTo(400 / 20000, 12);
  });
  it('访客矩形没有面积（退化）= 0，不除以 0', () => {
    expect(rectOverlap(R(0, 0, 100, 100), R(10, 10, 10, 50))).toBe(0);
    expect(rectOverlap(R(0, 0, 100, 100), R(10, 10, 50, 10))).toBe(0);
  });
});

describe('coverOf：重叠比例 → 挡住的程度（smoothstep(from, to)）', () => {
  it('参数照 FEEL-5：from 0.15、to 0.5；k 平时 0.6、现身的实体 0.7、被照出来 0.75（路 GH 从 0.35 / 0.5 / 0.6 上调）；变淡 0.12 秒、回来 0.35 秒', () => {
    expect(O.from).toBe(0.15);
    expect(O.to).toBe(0.5);
    expect(O.alpha).toBe(0.6);
    expect(O.solid).toBe(0.7);
    expect(O.revealed).toBe(0.75);
    expect(O.in).toBe(0.12);
    expect(O.out).toBe(0.35);
  });
  it('from 以下 = 0（只擦到一点不算挡），to 以上 = 1，中间平滑单调', () => {
    expect(coverOf(0)).toBe(0);
    expect(coverOf(O.from)).toBe(0);
    expect(coverOf(O.from - 0.01)).toBe(0);
    expect(coverOf(O.to)).toBe(1);
    expect(coverOf(1)).toBe(1);
    expect(coverOf((O.from + O.to) / 2)).toBeCloseTo(0.5, 12);
    let prev = 0;
    for (let x = O.from; x <= O.to; x += 0.005) {
      const c = coverOf(x);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = c;
    }
  });
});

describe('approachCover：指数逼近（变淡快、回来慢）', () => {
  it('往上走（挡住了，鬼魂要淡）用 in 秒的时间常数，往下走（让开了，鬼魂要回来）用 out 秒；一个时间常数走到 63%', () => {
    // 1 秒切成 600 小步，免得步长误差
    let up = 0;
    for (let k = 0; k < Math.round(O.in * 600); k++) up = approachCover(up, 1, 1 / 600);
    expect(up).toBeCloseTo(1 - Math.exp(-1), 2);
    let down = 1;
    for (let k = 0; k < Math.round(O.out * 600); k++) down = approachCover(down, 0, 1 / 600);
    expect(down).toBeCloseTo(Math.exp(-1), 2);
    // 变淡比回来快
    expect(O.in).toBeLessThan(O.out);
  });
  it('只往目标走、不过冲；dt = 0 不动；很大的 dt 也不会冲过头', () => {
    expect(approachCover(0.3, 1, 0)).toBe(0.3);
    expect(approachCover(0.3, 1, 100)).toBeLessThanOrEqual(1);
    expect(approachCover(0.3, 1, 100)).toBeCloseTo(1, 9);
    expect(approachCover(0.7, 0, 100)).toBeGreaterThanOrEqual(0);
    let c = 0;
    for (let k = 0; k < 600; k++) {
      const next = approachCover(c, 0.6, 1 / 60);
      expect(next).toBeGreaterThanOrEqual(c);
      expect(next).toBeLessThanOrEqual(0.6 + 1e-12);
      c = next;
    }
  });
  it('挡住的人走开（重叠从 0.6 一下掉到 0）：鬼魂的不透明度乘数平滑地回来，一路单调，只算一下暗…亮（任意 1 秒最多暗 3 下）', () => {
    // 乘数 = 1 − (1 − k) × cover。先挡住 1 秒（淡到位），再让开 1.5 秒，60 Hz
    const k = O.alpha;
    let cover = 0;
    const mul: number[] = [];
    for (let i = 0; i < 60; i++) { cover = approachCover(cover, coverOf(0.6), 1 / 60); mul.push(1 - (1 - k) * cover); }
    for (let i = 0; i < 90; i++) { cover = approachCover(cover, coverOf(0), 1 / 60); mul.push(1 - (1 - k) * cover); }
    expect(countDips(mul, 60)).toBeLessThanOrEqual(1);
    // 让开以后单调回到 1
    for (let i = 61; i < mul.length; i++) expect(mul[i]).toBeGreaterThanOrEqual(mul[i - 1] - 1e-12);
    expect(mul[mul.length - 1]).toBeGreaterThan(0.95);
  });
  it('访客在鬼魂的边上来回（重叠在门槛两边，每秒 2 次：一个人一秒里横着挪两趟鬼魂的边已经很夸张了）：每秒最多暗 2 下，不超过 3', () => {
    const mul: number[] = [];
    let cover = 0;
    for (let i = 0; i < 240; i++) {
      const overlap = Math.sin((i / 60) * Math.PI * 2 * 2) > 0 ? 0.6 : 0; // 方波：一会儿挡住、一会儿让开
      cover = approachCover(cover, coverOf(overlap), 1 / 60);
      mul.push(1 - (1 - O.alpha) * cover);
    }
    for (let s = 0; s + 60 <= mul.length; s += 15) expect(countDips(mul.slice(s, s + 60), 60), `第 ${s / 60} 秒`).toBeLessThanOrEqual(3);
  });
  it('访客的距离和鬼魂的距离几乎一样（「比鬼魂更远」逐帧在门槛上跳，重叠一帧有一帧没有）：平滑把它抹平，乘数一点都不闪（一下都数不出来）', () => {
    const mul: number[] = [];
    let cover = 0;
    for (let i = 0; i < 180; i++) {
      cover = approachCover(cover, coverOf(i % 2 ? 0.6 : 0), 1 / 60);
      mul.push(1 - (1 - O.alpha) * cover);
    }
    // 抹平以后停在一个中间值上轻轻起伏：按它的最高点归一（countDips 假定从 1 起步）再数，一下都数不出来
    const settled = mul.slice(60);
    const top = Math.max(...settled);
    expect(countDips(settled.map((v) => v / top), 60)).toBe(0);
    // 起伏本身也小（相邻两帧差不到 0.1）
    for (let i = 61; i < mul.length; i++) expect(Math.abs(mul[i] - mul[i - 1])).toBeLessThan(0.1);
  });
});

describe('occludeK：挡住时鬼魂留下多少', () => {
  // 2026-10-30 用户试玩（路 GH）：「太透明」，平时 0.35 → 0.6；实体、被照着照比例上调：淡掉的那一截（1 − k）都乘 0.4 / 0.65，
  // 实体 0.5 → 0.7、被照着 0.6 → 0.75（还是平时 < 实体 < 被照着）
  it('平时 0.6；现身的实体 0.7；正被手电照着 0.75（照出来的显形要看得见）；又是实体又被照着取大的', () => {
    expect(occludeK(false, false)).toBe(0.6);
    expect(occludeK(true, false)).toBe(0.7);
    expect(occludeK(false, true)).toBe(0.75);
    expect(occludeK(true, true)).toBe(0.75);
  });
  it('照比例：实体、被照着淡掉的那一截和平时淡掉的那一截同一个比例缩（原来 0.35 / 0.5 / 0.6）', () => {
    const k = (1 - O.alpha) / (1 - 0.35);
    expect(1 - O.solid).toBeCloseTo((1 - 0.5) * k, 1);
    expect(1 - O.revealed).toBeCloseTo((1 - 0.6) * k, 1);
  });
});

describe('投影矩形（针孔相机，鬼魂在镜头前 2.4 米、过肩偏 0.32 米）', () => {
  // 镜头在 (10, 10)，朝北；鬼魂在它北边 2.4 米；右手边是东
  const cam = makeCam(10, 10, 0, -1);
  const ghost = { x: 10, z: 7.6 };

  it('鬼魂矩形：竖直 0.55–2.05 米，水平左右各 0.32 米（镜头的右方向）', () => {
    const r = ghostCoverRect(cam.project, ghost, cam.right)!;
    const focal = 800 / 2 / Math.tan((30 * Math.PI) / 180);
    expect(r.x0).toBeCloseTo(640 - (0.32 / 2.4) * focal, 6);
    expect(r.x1).toBeCloseTo(640 + (0.32 / 2.4) * focal, 6);
    expect(r.y0).toBeCloseTo(400 - ((2.05 - 1.9) / 2.4) * focal, 6); // 头顶在上（y 小）
    expect(r.y1).toBeCloseTo(400 - ((0.55 - 1.9) / 2.4) * focal, 6);
  });
  it('访客矩形：脚到 CHARACTER.targetHeight + 0.15 米，水平左右各 0.25 米', () => {
    const r = visitorCoverRect(cam.project, { x: 10, z: 6 }, cam.right)!;
    const focal = 800 / 2 / Math.tan((30 * Math.PI) / 180);
    expect(r.x1 - r.x0).toBeCloseTo((0.5 / 4) * focal, 6);
    expect(r.y0).toBeCloseTo(400 - ((CHARACTER.targetHeight + 0.15 - 1.9) / 4) * focal, 6);
    expect(r.y1).toBeCloseTo(400 - ((0 - 1.9) / 4) * focal, 6);
  });
  it('在镜头背后：没有矩形', () => {
    expect(ghostCoverRect(cam.project, { x: 10, z: 12 }, cam.right)).toBeNull();
    expect(visitorCoverRect(cam.project, { x: 10, z: 12 }, cam.right)).toBeNull();
  });
});

describe('overlapOfGhost：挑谁、取最大的那个重叠', () => {
  const cam = makeCam(10, 10, 0, -1);
  const ghost = { x: 10, y: 1.4, z: 7.6 };
  const npc = (x: number, z: number, mode = 'wander'): CoverNpc => ({ pos: { x, z } as Vec2, mode });
  const overlap = (npcs: CoverNpc[], g = ghost) => overlapOfGhost({ project: cam.project, cam: cam.cam, right: cam.right, ghost: g, npcs });

  it('访客正在鬼魂正后方 2 米（离镜头 4.4 米）：整个被盖住 = 1', () => {
    expect(overlap([npc(10, 5.6)])).toBeCloseTo(1, 9);
  });
  it('横着错开：0.2 米还是 1（整个落在鬼魂的矩形里），0.5 米盖住一半多，1.2 米以外 = 0', () => {
    expect(overlap([npc(10.2, 5.6)])).toBeCloseTo(1, 9);
    const half = overlap([npc(10.5, 5.6)]);
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.8);
    expect(overlap([npc(11.2, 5.6)])).toBe(0);
    expect(overlap([npc(8.8, 5.6)])).toBe(0);
  });
  it('比鬼魂离镜头更近的人（他在鬼魂前面，鬼魂挡不到他）不算，哪怕投影重叠', () => {
    expect(overlap([npc(10, 9.0)])).toBe(0);
  });
  it('离镜头超过 8 米的人不算（7.9 米算：正后方时鬼魂的矩形远大于他的，盖满）', () => {
    expect(overlap([npc(10, 2.1)])).toBeGreaterThan(0.9); // 7.9 米
    expect(overlap([npc(10, 1.9)])).toBe(0); // 8.1 米
  });
  it('已经走了（gone）的人不算；吓跑的人（fleeing）照样算：吓跑那一下正是要看清他的时候（f11a）', () => {
    expect(overlap([npc(10, 5.6, 'gone')])).toBe(0);
    expect(overlap([npc(10, 5.6, 'fleeing')])).toBeCloseTo(1, 9);
    expect(overlap([npc(10, 5.6, 'startled')])).toBeCloseTo(1, 9);
    expect(overlap([npc(10, 5.6, 'leaving')])).toBeCloseTo(1, 9);
  });
  it('几个人取重叠最大的；没有人 = 0；在镜头背后的人跳过、不报错', () => {
    expect(overlap([])).toBe(0);
    expect(overlap([npc(11.2, 5.6), npc(10, 5.6), npc(10.5, 5.6)])).toBeCloseTo(1, 9);
    expect(overlap([npc(10, 14), npc(10, 5.6)])).toBeCloseTo(1, 9);
  });
  it('每帧最多看离镜头最近的 GHOST.occlude.people 个：多出来的最远的不看', () => {
    // 3 个在 8 米以内、不挡的近人（离镜头 5 米上下，落在鬼魂的两侧）+ 一个正后方 7.5 米的（排第 4，被顶掉了）
    const near = [npc(13, 6), npc(7, 6), npc(14, 6.5)];
    expect(O.people).toBe(3);
    expect(overlap([...near, npc(10, 2.5)])).toBe(0);
    // 换成只有 2 个近人：第三个名额轮到它
    expect(overlap([...near.slice(0, 2), npc(10, 2.5)])).toBeGreaterThan(0.9);
  });
  it('访客再矮一点（被鬼魂的下摆以下的部分挡不到）也按面积算：脚在鬼魂矩形下面时盖不满', () => {
    // 访客就在镜头旁边偏后（离镜头比鬼魂远一点点）：脚的位置投影更靠下，鬼魂矩形（0.55 米起）盖不到脚
    const r = overlap([npc(10, 7.0)]);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

// ───────────────────────── 只算看得见的人（修复第 2 轮，审查 I1） ─────────────────────────
// 用真的房子（config/house.ts）和游戏里用的 ghostSees（engine/ghostRig.ts，按看得见的墙体算，名牌、眼睛显不显示也用它）：
// 走廊（hall）在 z 5–7 米，它北边的墙在 z 4.5–5、南边的墙在 z 7–7.5，门洞在 x 7.5–8.5（通客厅 / 门厅）。
// 镜头在门厅里朝北（隔着走廊南墙，那面墙按视线胶囊溶开了），鬼魂在走廊里，访客在走廊里、或隔着北墙在客厅里

describe('overlapOfGhost：只算看得见的人（隔着墙的人不让鬼魂淡）', () => {
  const npc = (x: number, z: number, mode = 'wander'): CoverNpc => ({ pos: { x, z } as Vec2, mode });
  /** 镜头在 (cx, 8.4) 朝北；鬼魂在它北边 2.4 米的走廊里 (cx, 6) */
  const scene = (cx: number) => {
    const cam = makeCam(cx, 8.4, 0, -1);
    const ghost = { x: cx, y: 1.4, z: 6 };
    return (npcs: CoverNpc[], sees?: (a: { x: number; z: number }, b: Vec2) => boolean) =>
      overlapOfGhost({ project: cam.project, cam: cam.cam, right: cam.right, ghost, npcs, sees });
  };

  it('前提：不判视线时，客厅里正对着鬼魂的人（隔着走廊北墙）盖满 = 1；判了视线就不算 = 0（墙是实心的：x = 9 不在门洞里）', () => {
    const overlap = scene(9);
    expect(overlap([npc(9, 3)])).toBeCloseTo(1, 9);
    expect(ghostSees({ x: 9, z: 6 }, { x: 9, z: 3 })).toBe(false);
    expect(overlap([npc(9, 3)], ghostSees)).toBe(0);
  });

  it('同一个房间（走廊里）的人算，哪怕镜头在走廊南墙外：镜头 → 鬼魂那一段上的墙已经溶开，不查；如果查镜头 → 访客就会误判成看不见', () => {
    const overlap = scene(9);
    // 走廊里鬼魂身后 0.7 米：正对着，被盖住八成多
    expect(overlap([npc(9, 5.3)], ghostSees)).toBeGreaterThan(0.8);
    expect(overlap([npc(9, 5.3)], ghostSees)).toBeCloseTo(overlap([npc(9, 5.3)]), 9);
    // 对照：从镜头那一点看，中间隔着南墙，看不见（所以视线不能从镜头起查）
    expect(ghostSees({ x: 9, z: 8.4 }, { x: 9, z: 5.3 })).toBe(false);
    expect(ghostSees({ x: 9, z: 6 }, { x: 9, z: 5.3 })).toBe(true);
  });

  it('门洞：正对着门洞的人看得见、算；斜着穿过门洞的算；错开门洞、被北墙挡住的不算（鬼魂在门洞边上，人在墙那一段后面）', () => {
    const overlap = scene(8);
    expect(overlap([npc(8, 3)], ghostSees)).toBeCloseTo(1, 9); // 正对着门洞
    expect(overlap([npc(8.3, 3.2)], ghostSees)).toBeCloseTo(1, 9); // 斜着穿过门洞
    // 鬼魂靠在门洞的东沿（8.3），人在它东北、视线擦过 8.5 以东的那段墙
    const edge = scene(8.3);
    const o = edge([npc(8.9, 3)]);
    expect(o).toBeGreaterThan(0.5); // 不判视线时盖住大半
    expect(ghostSees({ x: 8.3, z: 6 }, { x: 8.9, z: 3 })).toBe(false);
    expect(edge([npc(8.9, 3)], ghostSees)).toBe(0);
  });

  it('几个人：被墙挡住的那个盖得再多也不算，取看得见的里最大的', () => {
    const overlap = scene(9);
    // 客厅里正对着的（隔墙，盖满）+ 走廊里偏一点的（看得见，盖住一部分）
    const hidden = npc(9, 3), seen = npc(9.4, 5.3);
    const oSeen = overlap([seen]);
    expect(oSeen).toBeGreaterThan(0);
    expect(oSeen).toBeLessThan(1);
    expect(overlap([hidden, seen], ghostSees)).toBeCloseTo(oSeen, 9);
    expect(overlap([hidden, seen])).toBeCloseTo(1, 9); // 不判视线时被隔墙的那个顶上去
  });

  it('只在会抬高当前最大值时才查视线：不重叠的人不查、已经有更大的了也不再查（视线检查比矩形重叠贵）', () => {
    const overlap = scene(9);
    let calls = 0;
    const spy = () => { calls++; return true; };
    // 不重叠的人（走廊里偏东 4 米）：一次都不查
    expect(overlap([npc(13, 6.4)], spy)).toBe(0);
    expect(calls).toBe(0);
    // 近的盖满（9, 4）、远的也盖满（9, 2.5）：近的查一次，远的不会比它大，不查
    calls = 0;
    expect(overlap([npc(9, 4), npc(9, 2.5)], spy)).toBeCloseTo(1, 9);
    expect(calls).toBe(1);
    // 近的盖住八成（9, 5.3）、远的盖满：两个都要查（远的抬高了最大值）
    calls = 0;
    expect(overlap([npc(9, 5.3), npc(9, 3)], spy)).toBeCloseTo(1, 9);
    expect(calls).toBe(2);
  });

  it('看不见的人不占「最多 people 个」以外的额外名额：还是离镜头最近的 3 个里挑；全都看不见 = 0', () => {
    const overlap = scene(9);
    expect(overlap([npc(9, 3), npc(9.1, 2.6), npc(8.9, 2.2)], () => false)).toBe(0);
    expect(overlap([npc(9, 3), npc(9.1, 2.6), npc(8.9, 2.2)], () => true)).toBeCloseTo(1, 9);
  });
});
