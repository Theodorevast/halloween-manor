// 恐怖画（2026-10-30 试玩反馈「不够吓人，平面那里可以放真正的恐怖图片」）：素材中台生成的九张维多利亚风格的画。
// - 贴图：public/assets/paintings/ 下九张 webp（最长边 1024，从 assets/generated/vmc/ 的原图母版压出来，来源见 lane-IMG 的报告）。
//   这里统一下载、解码（createImageBitmap，不阻塞主线程），给画像（props/portrait.ts）、镜中人脸（props/mirror.ts）、墙上六幅共用。
//   贴图对象一开始就建好（物件、画框建的时候就能接上），图下载完再换上：三的「异步贴图」——没有图时用 1×1 的默认贴图，
//   换上图只是重建贴图和绑定组，不重编管线。main.ts 在开场之前等它们（loadPaintings，最多 PAINTING_WAIT_MS），第一次出现不卡
// - 墙上六幅（config/house.ts 的 PAINTINGS）：木画框（深色木 + 两道旧金线）+ 凹进去一点的画布，画布有一点光泽；
//   受手电、月光照，不发光。第三人称：和墙一起溶开（walls.ts 的 applyDissolve，nearCut 和墙一样），不会墙溶开了画还悬在半空；
//   鬼魂的冷光、手电的反弹光（bounce.ts）也照得到它们。不投影（贴着墙，影子看不出来，省掉阴影 pass 的几次绘制），受阴影。
//   一开场就在场景里、可见、不标 deferCompile：开场前整栋房子的预编译（main.ts 的 compileInStreams）就编好；六幅的着色器一字不差，只编一条管线（?pipelog 量过，WebGPU、WebGL2 都是）
// - 娃娃屋俯视不建：内墙一直是 0.5 米的矮墙，外墙按镜头降低，都挂不住画；那六张贴图也不下载（PROP_TEXTURES）
import * as THREE from 'three/webgpu';
import { attribute, mix, positionLocal, positionWorld, texture, uniform, uv } from 'three/tsl';
import { CELL, PAINTINGS, ROOMS, WALL_T, type PaintingArt, type PaintingPlacement } from '../config/house';
import { isGhostRig, type CameraRig, type Module, type RenderCore } from '../engine/types';
import { yawFor } from '../lib/angle';
import { C } from './props/kit';
import { GeoBuilder, applyDissolve, ghostDissolve, type V3 } from './walls';

// ───────────────────────── 贴图 ─────────────────────────

/**
 * 九张图的文件（public/assets/paintings/）。来源：assets/generated/vmc/<任务目录>（素材中台 GPT Image 2.5 sunburst，1024×1536 竖幅）。
 * 墙上六幅整张缩到 683×1024；画像两张按画架上画布的比例裁同一块（x 95、y 50、820×1085，缩到 774×1024，逐像素对齐，换脸时不错位）；
 * 镜中人脸按面片的比例裁上面 1365 行（768×1024）。都是 canvas 导出的 webp，质量 0.85。任务目录写在每一行后面
 */
export const PAINTING_FILES = {
  portrait: 'portrait.webp', // img_49854
  portraitPossessed: 'portrait-possessed.webp', // img_49873（用 img_49854 做参考图生成）
  mirrorFace: 'mirror-face.webp', // img_49863
  family: 'family.webp', // img_49855
  moor: 'moor.webp', // img_49857
  girl: 'girl.webp', // img_49858
  house: 'house.webp', // img_49860
  gentleman: 'gentleman.webp', // img_49861
  stillLife: 'still-life.webp', // img_49862
} as const satisfies Record<PaintingArt | 'portrait' | 'portraitPossessed' | 'mirrorFace', string>;
export type PaintingTex = keyof typeof PAINTING_FILES;
/** 物件（画像、镜子）用的三张：娃娃屋只下载这些（墙上那六幅只有第三人称才有） */
export const PROP_TEXTURES: readonly PaintingTex[] = ['portrait', 'portraitPossessed', 'mirrorFace'];

/** main.ts 开场前最多等贴图多久（毫秒）：下载卡住时照样开场，没到的图到了再换上（换上那一下传一次贴图，可能顿一下） */
export const PAINTING_WAIT_MS = 15000;

/** 解码好的图：下载的是 ImageBitmap，下载不到时的备用图是 canvas */
export type PaintingImage = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface PaintingLoaderDeps {
  /** 下载并解码一张图（失败就抛） */
  load(url: string): Promise<PaintingImage>;
  /** 文件名 → 地址 */
  url(file: string): string;
  /** 等多少毫秒（测试换成手动放行的） */
  wait(ms: number): Promise<void>;
  /** 有人要某张贴图、还没开始下载时，自己先下载（开发页面没调 loadAll 也有图）；node 里没有 document，不下载 */
  autoStart?: boolean;
}

export interface PaintingLoadResult {
  /** 下载、解码好了的 */
  ready: PaintingTex[];
  /** 下载失败的（有备用图的已经换上备用图） */
  failed: PaintingTex[];
  /** 等到上限还没下载完的（之后到了照样换上） */
  late: PaintingTex[];
}

export interface PaintingLoader {
  /**
   * 某张图的贴图（每张只建一个）：sRGB、不翻转（ImageBitmap 和 canvas 一样，第 0 行是图的上沿——uv 要用左上角为原点的，
   * 两个后端、两种来源都一样，不靠 flipY）、有 mipmap、各向异性 8。fallback：下载失败时换上的备用图（只调一次）
   */
  texture(id: PaintingTex, fallback?: () => PaintingImage): THREE.Texture;
  /** 下载 ids（默认全部九张）。只下载一遍，再调返回同一个 Promise。不会 reject：失败的记在 failed 里；超过 timeoutMs 先 resolve */
  loadAll(opts?: { ids?: readonly PaintingTex[]; timeoutMs?: number }): Promise<PaintingLoadResult>;
}

interface Slot {
  tex: THREE.Texture;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  fallback?: () => PaintingImage;
  promise?: Promise<void>;
}

export function createPaintingLoader(deps: PaintingLoaderDeps): PaintingLoader {
  const slots = new Map<PaintingTex, Slot>();
  const slot = (id: PaintingTex) => {
    let s = slots.get(id);
    if (!s) {
      const tex = new THREE.Texture();
      tex.name = `painting:${id}`;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      s = { tex, state: 'idle' };
      slots.set(id, s);
    }
    return s;
  };
  const apply = (s: Slot, img: PaintingImage) => {
    s.tex.image = img;
    s.tex.needsUpdate = true;
  };
  const fetchOne = (id: PaintingTex): Promise<void> => {
    const s = slot(id);
    if (s.promise) return s.promise;
    s.state = 'loading';
    s.promise = deps.load(deps.url(PAINTING_FILES[id])).then(
      (img) => {
        s.state = 'ready';
        apply(s, img);
      },
      (err: unknown) => {
        s.state = 'failed';
        console.warn(`[paintings] ${PAINTING_FILES[id]} 加载失败${s.fallback ? '，改用程序画的备用图' : ''}`, err);
        if (s.fallback) apply(s, s.fallback());
      },
    );
    return s.promise;
  };
  let all: Promise<PaintingLoadResult> | null = null;
  return {
    texture(id, fallback) {
      const s = slot(id);
      if (fallback && !s.fallback) {
        s.fallback = fallback;
        if (s.state === 'failed') apply(s, fallback());
      }
      if (s.state === 'idle' && deps.autoStart) void fetchOne(id);
      return s.tex;
    },
    loadAll({ ids = Object.keys(PAINTING_FILES) as PaintingTex[], timeoutMs = PAINTING_WAIT_MS } = {}) {
      if (all) return all;
      const done = Promise.all(ids.map(fetchOne));
      const states = (st: Slot['state']) => ids.filter((id) => slot(id).state === st);
      all = Promise.race([done, deps.wait(timeoutMs)]).then(() => ({ ready: states('ready'), failed: states('failed'), late: states('loading') }));
      return all;
    },
  };
}

/** 网页里用的那一份：fetch（低优先级，让开场按钮要等的第一套访客造型先下）+ createImageBitmap（在后台线程解码） */
const shared = createPaintingLoader({
  url: (file) => `${import.meta.env.BASE_URL}assets/paintings/${file}`,
  async load(url) {
    const res = await fetch(url, { priority: 'low' } as RequestInit);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const blob = await res.blob();
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  autoStart: typeof document !== 'undefined',
});
/** 某张图的贴图（全页共用；见 PaintingLoader.texture） */
export const paintingTexture = shared.texture;
/** 下载贴图（main.ts 在 boot 一开始调，开场前等它；见 PaintingLoader.loadAll） */
export const loadPaintings = shared.loadAll;

// ───────────────────────── 挂在哪 ─────────────────────────

/** 墙格靠屋里那一条：墙体在墙格里居中，墙面 = 房间格子的边往墙里 M */
const M = (CELL - WALL_T) / 2;

export interface PaintingWall {
  /** 'x'：东西两面墙（墙面是 x = plane，画沿 z 排）；'z'：南北两面墙 */
  axis: 'x' | 'z';
  /** 墙面的米坐标 */
  plane: number;
  /** 墙格所在的列（axis 'x'）或行（axis 'z'） */
  cell: number;
  /** 墙面法线（指向房间里）= 画的正面朝向 */
  nx: number;
  nz: number;
}

/** 画挂在 room 的哪面墙上：朝西的画挂在东墙上，依此类推 */
export function paintingWall(p: PaintingPlacement): PaintingWall {
  const r = ROOMS[p.room];
  const dx = Math.round(Math.cos(p.facing)), dz = Math.round(Math.sin(p.facing));
  if (dx < 0) return { axis: 'x', plane: r.x1 * CELL + M, cell: r.x1, nx: -1, nz: 0 };
  if (dx > 0) return { axis: 'x', plane: r.x0 * CELL - M, cell: r.x0 - 1, nx: 1, nz: 0 };
  if (dz > 0) return { axis: 'z', plane: r.z0 * CELL - M, cell: r.z0 - 1, nx: 0, nz: 1 };
  return { axis: 'z', plane: r.z1 * CELL + M, cell: r.z1, nx: 0, nz: -1 };
}

/**
 * 画框的尺寸（米）：width 画布边到画框外沿；depth 画框最高处离墙面；canvasZ 画布离墙面（凹在画框里）。
 * PROFILE 是画框的断面（d：从画布边往外多远，z：离墙面多高），从里往外：压住画布边的金色斜边、深色木的凹槽、顶面、
 * 一道细金线、外斜面、贴到墙上的外侧面。每一段绕画布一圈、四角斜接
 */
export const FRAME = { width: 0.075, depth: 0.045, canvasZ: 0.02 };
type Finish = 'gilt' | 'wood' | 'woodDark';
const PROFILE: { d: number; z: number; finish: Finish }[] = [
  { d: -0.006, z: 0.021, finish: 'gilt' }, // 压住画布边 6 毫米，看不见画布的边
  { d: 0.007, z: 0.03, finish: 'woodDark' },
  { d: 0.03, z: 0.04, finish: 'wood' },
  { d: 0.048, z: FRAME.depth, finish: 'gilt' },
  { d: 0.054, z: FRAME.depth, finish: 'woodDark' },
  { d: FRAME.width, z: 0.03, finish: 'woodDark' },
  { d: FRAME.width, z: 0, finish: 'woodDark' }, // 最后一个点的 finish 不用
];
/** 表面：颜色、粗糙度、金属度。旧金线发暗；木框上过清漆；画布有一点光泽（油画的上光油） */
const FINISH: Record<Finish | 'canvas', { color: number; rough: number; metal: number }> = {
  gilt: { color: 0x8f7240, rough: 0.38, metal: 0.65 },
  wood: { color: C.wood, rough: 0.5, metal: 0 },
  woodDark: { color: C.woodDark, rough: 0.55, metal: 0 },
  // 0.45 时手电从下面照上来，画布下半截是一片白色的反光（截图里像起了雾，看不清画）；0.62 还有一层白，0.72 只剩柔和的光泽
  canvas: { color: 0xffffff, rough: 0.72, metal: 0 },
};

/** 画框外沿的范围：沿墙 along0..along1、离地 y0..y1（米） */
export function frameBounds(p: PaintingPlacement) {
  const [w, h] = p.size;
  const f = FRAME.width;
  return { along0: p.along - w / 2 - f, along1: p.along + w / 2 + f, y0: p.y - h / 2 - f, y1: p.y + h / 2 + f };
}

// ───────────────────────── 画框和画布 ─────────────────────────

/** 一幅画的几何（局部坐标：原点在墙面上、画布中心的高度；+z 朝房间里，+x 是站在画前看的右手边，y 向上） */
function buildPainting(p: PaintingPlacement): THREE.BufferGeometry {
  const b = new GeoBuilder({ surf: 2, uv: 2, artMask: 1 });
  const hw = p.size[0] / 2, hh = p.size[1] / 2;
  const use = (f: Finish | 'canvas') => {
    const s = FINISH[f];
    b.color(s.color).set('surf', s.rough, s.metal).set('artMask', f === 'canvas' ? 1 : 0).set('uv', 0, 0);
  };
  // 画布：uv 左上角为原点（贴图不翻转，见 PaintingLoader.texture）
  use('canvas');
  const z = FRAME.canvasZ;
  b.quad([-hw, -hh, z], [hw, -hh, z], [hw, hh, z], [-hw, hh, z], [0, 0, 1], { uv: [[0, 1], [1, 1], [1, 0], [0, 0]] });
  // 画框：断面的每一段绕一圈，四条边是四个梯形（四角斜接）
  for (let k = 0; k < PROFILE.length - 1; k++) {
    const a = PROFILE[k], c = PROFILE[k + 1];
    use(a.finish);
    const dd = c.d - a.d, dz = c.z - a.z, len = Math.hypot(dd, dz);
    const out = -dz / len, up = dd / len; // 这一段的法线：沿「往外」的分量、沿 z 的分量
    const X0 = hw + a.d, Y0 = hh + a.d, X1 = hw + c.d, Y1 = hh + c.d;
    const q = (p0: V3, p1: V3, p2: V3, p3: V3, n: V3) => b.quad(p0, p1, p2, p3, n);
    q([-X0, Y0, a.z], [X0, Y0, a.z], [X1, Y1, c.z], [-X1, Y1, c.z], [0, out, up]); // 上
    q([-X0, -Y0, a.z], [X0, -Y0, a.z], [X1, -Y1, c.z], [-X1, -Y1, c.z], [0, -out, up]); // 下
    q([X0, -Y0, a.z], [X0, Y0, a.z], [X1, Y1, c.z], [X1, -Y1, c.z], [out, 0, up]); // 右
    q([-X0, -Y0, a.z], [-X0, Y0, a.z], [-X1, Y1, c.z], [-X1, -Y1, c.z], [-out, 0, up]); // 左
  }
  return b.build();
}

/**
 * 墙上的六幅（PAINTINGS）。只有第三人称（GhostRig）才建，和墙一起溶开（?noghostfx 时不溶，和墙一样）；
 * 娃娃屋俯视什么也不建（见文件头）。接线（modules.push）在 main.ts
 */
export function createPaintings(core: RenderCore, rig: CameraRig): Module {
  if (!isGhostRig(rig)) return {};
  const noFx = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noghostfx');
  // 溶解按房屋坐标算：世界坐标减 houseRoot 的偏移（houseRoot 只平移不旋转；写法照 props.ts、frontDoor.ts）
  const houseOffset = uniform(new THREE.Vector3());
  const dissolve = !noFx;
  /**
   * 画框和画布一个材质（每幅一个：贴图、墙面法线不同；着色器一样，共用一条管线）。顶点色是画框的木、金，artMask = 1 的是画布（取贴图）。
   * 第三人称和墙一样溶开（applyDissolve：鬼魂周围、视线上挖洞，洞边结霜，nearCut 和墙一样；加上鬼魂的冷光、手电的反弹光）。
   * 溶解按「投到墙面上的那一点」、墙面的法线算（P − n × 离墙多远）：画上的洞和背后墙上的洞是同一个，洞边的霜、冷光也接得上，
   * 墙溶开了画不会剩一截悬在半空；反弹光的房间范围（墙面正好在边上，按一半算）也和墙一样，画不会比背后的墙多亮一倍。
   * 代价：画框侧面、斜面的反弹光、鬼魂冷光按墙面的朝向算（几厘米宽的面，看不出）；手电、月光照旧按自己的法线
   */
  const material = (tex: THREE.Texture, wallN: THREE.Vector3) => {
    const m = new THREE.MeshStandardNodeMaterial();
    const surf = attribute('surf', 'vec2');
    const albedo = mix(attribute('color', 'vec3'), texture(tex, uv()).rgb, attribute('artMask', 'float'));
    m.roughnessNode = surf.x;
    m.metalnessNode = surf.y;
    if (dissolve) {
      const n = uniform(wallN);
      // 局部 z 就是离墙面多远（几何的原点在墙面上）
      applyDissolve(m, ghostDissolve, positionWorld.sub(houseOffset).sub(n.mul(positionLocal.z)), n, albedo, { nearCut: true });
    } else m.colorNode = albedo;
    return m;
  };
  const items = PAINTINGS.map((p) => {
    const tex = paintingTexture(p.art);
    const w = paintingWall(p);
    const mesh = new THREE.Mesh(buildPainting(p), material(tex, new THREE.Vector3(w.nx, 0, w.nz)));
    mesh.name = `painting:${p.id}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.position.set(w.axis === 'x' ? w.plane : p.along, p.y, w.axis === 'x' ? p.along : w.plane);
    mesh.rotation.y = yawFor(p.facing);
    core.houseRoot.add(mesh);
    return { mesh, tex };
  });
  return {
    update() {
      houseOffset.value.copy(core.houseRoot.position);
    },
    dispose() {
      for (const it of items) {
        it.mesh.removeFromParent();
        it.mesh.geometry.dispose();
        (it.mesh.material as THREE.Material).dispose();
        it.tex.dispose();
      }
    },
  };
}
