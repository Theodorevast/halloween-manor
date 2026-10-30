// 恐怖画（2026-10-30 试玩反馈「平面那里可以放真正的恐怖图片」）：墙上六幅挂画的位置、贴图文件、贴图加载、画像换脸的时间线、
// 娃娃屋里挂不住的画不建。只查数和规则，不画东西
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CELL, FRONT_DOOR, FURNITURE, PAINTINGS, PROPS, ROOMS, Tile, WALL_H, blocksSight, buildTiles, cellOf, idx, inGrid, propCenter, type PaintingPlacement, type RoomId,
} from '../src/config/house';
import { VISION } from '../src/config/visitors';
import { SCARES } from '../src/config/scares';
import { FURNITURE_TOP } from '../src/view/furniture';
import { GHOST_BODY } from '../src/view/ghost';
import { countDips, dipStarts } from '../src/view/lightfx';
import { OTHER_LOOK, OTHER_SPOTS } from '../src/view/otherShadow';
import {
  FRAME, PAINTING_FILES, PROP_TEXTURES, createPaintingLoader, createPaintings, frameBounds, paintingWall, type PaintingTex,
} from '../src/view/paintings';
import { MIRROR_FACE, MIRROR_FLASH, MIRROR_T, createMirror } from '../src/view/props/mirror';
import { PORTRAIT_CANVAS, PORTRAIT_REVEAL, PORTRAIT_TIMELINE, createPortrait, portraitReveal, portraitRot } from '../src/view/props/portrait';
import { idleManifest } from '../src/sim/manifest';
import type { ScareObjectState, WorldState } from '../src/sim/types';
import type { CameraRig, RenderCore } from '../src/engine/types';

const tiles = buildTiles();
const at = (i: number, j: number) => tiles[idx(i, j)];
/** 墙面上挂画两边至少留多少（米）：不贴着墙角、门框、窗框 */
const MARGIN = 0.15;

describe('挂画：六幅，五个房间都有', () => {
  it('六幅，id 不重复，六张图各用一次', () => {
    expect(PAINTINGS).toHaveLength(6);
    expect(new Set(PAINTINGS.map((p) => p.id)).size).toBe(6);
    expect(PAINTINGS.map((p) => p.art).sort()).toEqual(['family', 'gentleman', 'girl', 'house', 'moor', 'stillLife']);
  });

  it('书房、客厅、走廊、卧室、门厅各至少一幅', () => {
    const rooms = new Set<RoomId>(PAINTINGS.map((p) => p.room));
    for (const r of ['study', 'living', 'hall', 'bedroom', 'foyer'] as RoomId[]) expect(rooms.has(r), r).toBe(true);
  });

  it('画布 2:3（和贴图一样），朝向是正东南西北之一', () => {
    for (const p of PAINTINGS) {
      expect(p.size[0] / p.size[1], p.id).toBeCloseTo(2 / 3, 3);
      expect([0, Math.PI / 2, Math.PI, -Math.PI / 2], p.id).toContain(p.facing);
    }
  });
});

/** 挂画背后那一排墙格（沿墙方向覆盖画框 + MARGIN） */
function wallCellsBehind(p: PaintingPlacement): [number, number][] {
  const w = paintingWall(p);
  const b = frameBounds(p);
  const k0 = Math.floor((b.along0 - MARGIN) / CELL), k1 = Math.floor((b.along1 + MARGIN) / CELL);
  const out: [number, number][] = [];
  for (let k = k0; k <= k1; k++) out.push(w.axis === 'x' ? [w.cell, k] : [k, w.cell]);
  return out;
}

describe('挂画：挂在实墙上（避开窗、门洞、前门）', () => {
  it('墙面坐标：书房东墙 x = 5.15、走廊北墙 z = 4.85、门厅北墙 z = 7.35（墙格居中、墙厚 0.2）', () => {
    const study = PAINTINGS.find((p) => p.room === 'study')!;
    expect(study.facing).toBe(Math.PI);
    const ws = paintingWall(study);
    expect(ws).toMatchObject({ axis: 'x', cell: 10, nx: -1, nz: 0 });
    expect(ws.plane).toBeCloseTo(5.15, 9);
    const hallN = PAINTINGS.find((p) => p.room === 'hall' && p.facing === Math.PI / 2)!;
    const wh = paintingWall(hallN);
    expect(wh).toMatchObject({ axis: 'z', cell: 9, nx: 0, nz: 1 });
    expect(wh.plane).toBeCloseTo(4.85, 9);
    const foyer = PAINTINGS.find((p) => p.room === 'foyer' && p.facing === Math.PI / 2)!;
    const wf = paintingWall(foyer);
    expect(wf).toMatchObject({ axis: 'z', cell: 14 });
    expect(wf.plane).toBeCloseTo(7.35, 9);
    // 朝北的画挂在房间的南墙上（门厅南墙 z = 11.65）、朝东的挂在西墙上（客厅西墙 x = 5.35）
    const foyerS = PAINTINGS.find((p) => p.room === 'foyer' && p.facing === -Math.PI / 2)!;
    expect(paintingWall(foyerS)).toMatchObject({ axis: 'z', cell: 23, nx: 0, nz: -1 });
    expect(paintingWall(foyerS).plane).toBeCloseTo(11.65, 9);
    const living = PAINTINGS.find((p) => p.room === 'living')!;
    expect(paintingWall(living)).toMatchObject({ axis: 'x', cell: 10, nx: 1, nz: 0 });
    expect(paintingWall(living).plane).toBeCloseTo(5.35, 9);
  });

  it('画框背后（两边各多 0.15 米）全是实墙格：不压窗、不跨门洞和前门', () => {
    for (const p of PAINTINGS) {
      for (const [i, j] of wallCellsBehind(p)) expect(at(i, j), `${p.id} (${i}, ${j})`).toBe(Tile.Wall);
    }
  });

  it('画框在房间这面墙的范围里，离墙角至少 0.15 米', () => {
    for (const p of PAINTINGS) {
      const r = ROOMS[p.room];
      const w = paintingWall(p);
      const b = frameBounds(p);
      const M = (CELL - 0.2) / 2;
      const [lo, hi] = w.axis === 'x' ? [r.z0 * CELL - M, r.z1 * CELL + M] : [r.x0 * CELL - M, r.x1 * CELL + M];
      expect(b.along0, p.id).toBeGreaterThanOrEqual(lo + MARGIN - 1e-9);
      expect(b.along1, p.id).toBeLessThanOrEqual(hi - MARGIN + 1e-9);
    }
  });

  it('高度：画框底边在护墙板腰线（0.9 米）以上，顶边在顶线（离天花板 0.12 米）下面留一点', () => {
    for (const p of PAINTINGS) {
      const b = frameBounds(p);
      expect(b.y0, p.id).toBeGreaterThanOrEqual(0.95);
      expect(b.y1, p.id).toBeLessThanOrEqual(WALL_H - 0.19);
    }
  });
});

/** 第三人称的默认镜头（engine/ghostRig.ts 的 CAM、LOOK：吊臂 2.4 米，俯仰 4° + 构图 4°，过肩 0.32 米）；鬼魂离地 1.4 米 */
const CAMERA = { dist: 2.4, phi: (8 * Math.PI) / 180, pivotY: 1.65, shoulder: 0.32, ghostY: 1.4, ghostHalfW: 0.3, halfFov: (42.7 * Math.PI) / 180 };
const canvasCenter = (p: PaintingPlacement) => {
  const w = paintingWall(p);
  return w.axis === 'x' ? { x: w.plane, z: p.along } : { x: p.along, z: w.plane };
};
/** 从 a 看 b 中间有没有墙（窗也挡视线；终点是墙面，贴着墙的最后一小段不算） */
function clearLine(a: { x: number; z: number }, b: { x: number; z: number }) {
  const n = 200;
  for (let k = 0; k < n; k++) {
    const u = (k / n) * (1 - 0.2 / Math.max(0.2, Math.hypot(b.x - a.x, b.z - a.z)));
    const [i, j] = cellOf(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u);
    if (inGrid(i, j) && blocksSight(at(i, j) as Tile)) return false;
  }
  return true;
}
/** 从 from 朝 dir（方向角）看，这幅画的正面对着他、中间没有墙、离视线中心多少弧度 */
function sighting(p: PaintingPlacement, from: { x: number; z: number }, dir: number) {
  const c = canvasCenter(p), w = paintingWall(p);
  const dx = c.x - from.x, dz = c.z - from.z;
  const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dz, dx) - dir), Math.cos(Math.atan2(dz, dx) - dir)));
  return { off, dist: Math.hypot(dx, dz), faces: -(dx * w.nx + dz * w.nz) > 0, clear: clearLine(from, c), angle: Math.atan2(dz, dx) };
}

describe('挂画：第一眼看得见（2026-10-30 试玩 S2：一夜里基本碰不到）', () => {
  it('开场第一帧：镜头正对前门，门厅南墙有一幅，在画面里、中间没有墙、鬼魂挡不住', () => {
    // 开场的位置在 ghostRig.ts 的 START（没有导出），从源码读：谁改了开场站位，这里要跟着看一眼
    const src = new TextDecoder().decode(fs.readFileSync(new URL('../src/engine/ghostRig.ts', import.meta.url)));
    const m = /const START = \{ x: ([\d.]+), z: ([\d.]+), heading: Math\.PI \/ 2 \}/.exec(src);
    expect(m).not.toBeNull();
    const ghost = { x: Number(m![1]), z: Number(m![2]) }, heading = Math.PI / 2;
    const back = CAMERA.dist * Math.cos(CAMERA.phi);
    const cam = {
      x: ghost.x - Math.cos(heading) * back - Math.sin(heading) * CAMERA.shoulder,
      z: ghost.z - Math.sin(heading) * back + Math.cos(heading) * CAMERA.shoulder,
    };
    const toGhost = Math.atan2(ghost.z - cam.z, ghost.x - cam.x);
    const seen = PAINTINGS.filter((p) => {
      const s = sighting(p, cam, heading);
      const half = Math.atan2(p.size[0] / 2 + 0.075, s.dist);
      const fromGhost = Math.abs(Math.atan2(Math.sin(s.angle - toGhost), Math.cos(s.angle - toGhost)));
      return s.faces && s.clear && s.off + half < CAMERA.halfFov && fromGhost > Math.atan2(CAMERA.ghostHalfW, CAMERA.dist) + half;
    });
    expect(seen.map((p) => p.room)).toContain('foyer');
  });

  it('第一个访客进门：走到门里朝北，手电正对着门厅北墙的一幅（在视野半角里、够得着）', () => {
    const lit = PAINTINGS.filter((p) => {
      const s = sighting(p, FRONT_DOOR.inside, -Math.PI / 2);
      return s.faces && s.clear && s.off < VISION.halfAngle && s.dist < VISION.range;
    });
    expect(lit.map((p) => p.room)).toContain('foyer');
  });

  it('隔着走廊：从门厅门洞出来，正对面的走廊北墙有一幅（往前 45° 以内、3 米以内）', () => {
    const across = PAINTINGS.filter((p) => {
      const s = sighting(p, { x: 8, z: 7.25 }, -Math.PI / 2);
      return p.room === 'hall' && s.faces && s.clear && s.off < Math.PI / 4 && s.dist < 3;
    });
    expect(across.length).toBeGreaterThan(0);
  });

  it('鬼魂正好站在画前：头顶那条线以上还露着至少 38% 的画（画上的脸都在上半幅），离墙 0.8 到 2 米都是', () => {
    const camY = CAMERA.pivotY + CAMERA.dist * Math.sin(CAMERA.phi), back = CAMERA.dist * Math.cos(CAMERA.phi);
    const head = CAMERA.ghostY + GHOST_BODY.top;
    for (const p of PAINTINGS) {
      const top = p.y + p.size[1] / 2;
      for (const d of [0.8, 1.25, 2]) {
        const line = camY + ((head - camY) * (back + d)) / back;
        expect((top - line) / p.size[1], `${p.id} 离墙 ${d} 米`).toBeGreaterThanOrEqual(0.38);
      }
    }
  });
});

describe('挂画：前面没有挡着的东西', () => {
  it('画前面紧挨着的那一排格子是地板（不是家具、物件）', () => {
    for (const p of PAINTINGS) {
      const w = paintingWall(p);
      for (const [i, j] of wallCellsBehind(p)) {
        const fi = i + w.nx, fj = j + w.nz;
        const t = at(fi, fj);
        // 两边多出来的 MARGIN 那一格可能正好是门洞前的地板，也算地板
        expect(t === Tile.Floor || t === Tile.Exit, `${p.id} 前面 (${fi}, ${fj}) = ${t}`).toBe(true);
      }
    }
  });

  it('画前 1 米内没有比画框底边还高的家具，没有可附身的物件', () => {
    for (const p of PAINTINGS) {
      const w = paintingWall(p);
      const b = frameBounds(p);
      // 画前 1 米的那一块（房屋米坐标，水平面）
      const n0 = w.plane, n1 = w.plane + (w.axis === 'x' ? w.nx : w.nz) * 1.0;
      const zone = w.axis === 'x'
        ? { x0: Math.min(n0, n1), x1: Math.max(n0, n1), z0: b.along0, z1: b.along1 }
        : { x0: b.along0, x1: b.along1, z0: Math.min(n0, n1), z1: Math.max(n0, n1) };
      const hits = (x0: number, z0: number, x1: number, z1: number) => x0 < zone.x1 && x1 > zone.x0 && z0 < zone.z1 && z1 > zone.z0;
      for (const f of FURNITURE) {
        if (!hits(f.rect.x0 * CELL, f.rect.z0 * CELL, f.rect.x1 * CELL, f.rect.z1 * CELL)) continue;
        expect(FURNITURE_TOP[f.kind], `${p.id} 前面有 ${f.id}`).toBeLessThan(b.y0 - 0.05);
      }
      for (const q of PROPS) {
        const c = propCenter(q);
        expect(hits(c.x - 0.5, c.z - 0.5, c.x + 0.5, c.z + 0.5), `${p.id} 前面有物件 ${q.id}`).toBe(false);
      }
    }
  });

  it('不挂在墙上多一个影子的那几面墙的影子落点上（view/otherShadow.ts 的 OTHER_SPOTS）：同一面墙上沿墙至少隔 1.2 米', () => {
    for (const p of PAINTINGS) {
      const w = paintingWall(p);
      const b = frameBounds(p);
      for (const s of OTHER_SPOTS) {
        // 影子落在站位背后的墙面上：墙面 = 站位往法线反方向退 fromWall
        const wx = s.x - s.nx * OTHER_LOOK.fromWall, wz = s.z - s.nz * OTHER_LOOK.fromWall;
        const sameWall = w.axis === 'x' ? s.nx === w.nx && Math.abs(wx - w.plane) < 0.05 : s.nz === w.nz && Math.abs(wz - w.plane) < 0.05;
        if (!sameWall) continue;
        const along = w.axis === 'x' ? wz : wx;
        const gap = Math.max(b.along0 - along, along - b.along1);
        expect(gap, `${p.id} 和影子 ${s.id}`).toBeGreaterThanOrEqual(1.2);
      }
    }
  });
});

describe('挂画：娃娃屋俯视', () => {
  it('createPaintings：第三人称建六幅（开场就在场景里、不延后编译、不投影、受阴影），娃娃屋一幅都不建', () => {
    const ghostCore = { houseRoot: new THREE.Group(), scene: new THREE.Scene() } as unknown as RenderCore;
    const ghostRig = { ghost: { x: 0, y: 1.4, z: 0 } } as unknown as CameraRig;
    const view = createPaintings(ghostCore, ghostRig);
    const meshes: THREE.Mesh[] = [];
    ghostCore.houseRoot.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes).toHaveLength(6);
    for (const m of meshes) {
      expect(m.visible).toBe(true);
      expect(m.userData.deferCompile).toBeFalsy();
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(true);
    }
    view.dispose?.();
    expect(ghostCore.houseRoot.children).toHaveLength(0);

    const dollCore = { houseRoot: new THREE.Group(), scene: new THREE.Scene() } as unknown as RenderCore;
    const dollRig = { viewDir: { x: 1, z: 1 } } as unknown as CameraRig;
    const doll = createPaintings(dollCore, dollRig);
    let n = 0;
    dollCore.houseRoot.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
    expect(n).toBe(0);
    doll.dispose?.();
  });

  it('画框的几何：背面贴着墙面，画布凹在画框里（画框比画布高出一截），正面朝房间', () => {
    expect(FRAME.canvasZ).toBeGreaterThan(0);
    expect(FRAME.depth).toBeGreaterThan(FRAME.canvasZ + 0.01);
    expect(FRAME.width).toBeGreaterThan(0.04);
  });
});

// tsconfig 的 types 里没有 node 的类型（见 tests/overlays.test.ts）：用变量当模块名取 node:fs
const fsId = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsId)) as { readFileSync(path: URL): Uint8Array; existsSync(path: URL): boolean };
const fileOf = (id: PaintingTex) => new URL(`../public/assets/paintings/${PAINTING_FILES[id]}`, import.meta.url);

/** WebP 的宽高（RIFF 头：VP8 / VP8L / VP8X 三种） */
function webpSize(buf: Uint8Array): [number, number] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ascii = (a: number, b: number) => String.fromCharCode(...buf.subarray(a, b));
  expect(ascii(0, 4)).toBe('RIFF');
  expect(ascii(8, 12)).toBe('WEBP');
  const chunk = ascii(12, 16);
  if (chunk === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
  if (chunk === 'VP8L') {
    const b = dv.getUint32(21, true);
    return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1];
  }
  const u24 = (o: number) => dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
  if (chunk === 'VP8X') return [u24(24) + 1, u24(27) + 1];
  throw new Error(`不认识的 WebP 块 ${chunk}`);
}
const sizeOf = (id: PaintingTex) => webpSize(fs.readFileSync(fileOf(id)));

describe('贴图文件（public/assets/paintings/，素材中台原图压的 webp）', () => {
  it('九张都在，最长边 1024', () => {
    for (const id of Object.keys(PAINTING_FILES) as PaintingTex[]) {
      expect(fs.existsSync(fileOf(id)), id).toBe(true);
      expect(Math.max(...sizeOf(id)), id).toBe(1024);
    }
    expect(Object.keys(PAINTING_FILES)).toHaveLength(9);
  });

  it('画像平时和被附身的两张一样大（逐像素对齐，换脸时不错位），比例和画架上的画布一样', () => {
    expect(sizeOf('portraitPossessed')).toEqual(sizeOf('portrait'));
    const [w, h] = sizeOf('portrait');
    expect(w / h).toBeCloseTo(PORTRAIT_CANVAS[0] / PORTRAIT_CANVAS[1], 2);
  });

  it('墙上六幅的贴图比例和画布一样（2:3），镜中人脸的比例和镜子里那块面片一样', () => {
    for (const p of PAINTINGS) {
      const [w, h] = sizeOf(p.art);
      expect(w / h, p.id).toBeCloseTo(p.size[0] / p.size[1], 2);
    }
    const [w, h] = sizeOf('mirrorFace');
    expect(w / h).toBeCloseTo(MIRROR_FACE[0] / MIRROR_FACE[1], 2);
  });
});

/** 假的图片（node 里没有 ImageBitmap） */
const fakeImage = (tag: string) => ({ width: 4, height: 6, tag }) as unknown as ImageBitmap;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('贴图加载（createPaintingLoader）', () => {
  it('贴图一开始就有（物件建的时候还没下载完）：sRGB、不翻转、有 mipmap；下载完换上图、needsUpdate', async () => {
    const loader = createPaintingLoader({ load: async (url) => fakeImage(url), url: (f) => `/x/${f}`, wait: () => new Promise(() => {}) });
    const t = loader.texture('moor');
    expect(t).toBeInstanceOf(THREE.Texture);
    expect(t.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t.flipY).toBe(false);
    expect(t.generateMipmaps).toBe(true);
    expect(loader.texture('moor')).toBe(t); // 同一张只建一次
    const v0 = t.version;
    const r = await loader.loadAll();
    expect(r.failed).toEqual([]);
    expect(r.late).toEqual([]);
    expect(r.ready.sort()).toEqual((Object.keys(PAINTING_FILES) as PaintingTex[]).sort());
    expect((t.image as { tag: string }).tag).toBe('/x/moor.webp');
    expect(t.version).toBeGreaterThan(v0);
  });

  it('下载失败不卡住开场：照样 resolve，记在 failed 里，有备用图的换上备用图（画像、镜中人脸用原来程序画的）', async () => {
    const loader = createPaintingLoader({
      load: async (url) => { if (url.includes('portrait.webp') || url.includes('girl')) throw new Error('404'); return fakeImage(url); },
      url: (f) => f,
      wait: () => new Promise(() => {}),
    });
    const backup = fakeImage('backup');
    const p = loader.texture('portrait', () => backup);
    const g = loader.texture('girl');
    const r = await loader.loadAll();
    expect(r.failed.sort()).toEqual(['girl', 'portrait']);
    expect(p.image).toBe(backup);
    expect(p.version).toBeGreaterThan(0);
    // 没有备用图的：保持没有图（three 用 1×1 的默认贴图），不抛错
    expect(g.image).toBeFalsy();
  });

  it('下载卡住：等到上限就先 resolve（late），之后下载完了照样换上', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let timeUp: (() => void) | null = null;
    const loader = createPaintingLoader({
      load: async (url) => { if (url.includes('house')) await gate; return fakeImage(url); },
      url: (f) => f,
      wait: () => new Promise<void>((r) => { timeUp = r; }),
    });
    const h = loader.texture('house');
    const pending = loader.loadAll({ timeoutMs: 1000 });
    await tick();
    timeUp!();
    const r = await pending;
    expect(r.late).toEqual(['house']);
    expect(h.image).toBeFalsy();
    release!();
    await tick(); await tick();
    expect((h.image as { tag: string }).tag).toBe('house.webp');
  });

  it('loadAll 调两次只下载一遍', async () => {
    let n = 0;
    const loader = createPaintingLoader({ load: async (url) => { n++; return fakeImage(url); }, url: (f) => f, wait: () => new Promise(() => {}) });
    await Promise.all([loader.loadAll(), loader.loadAll()]);
    expect(n).toBe(Object.keys(PAINTING_FILES).length);
  });
});

describe('贴图加载：娃娃屋', () => {
  it('只下载物件用的三张（画像两张、镜中人脸）', async () => {
    const urls: string[] = [];
    const loader = createPaintingLoader({ load: async (url) => { urls.push(url); return fakeImage(url); }, url: (f) => f, wait: () => new Promise(() => {}) });
    const r = await loader.loadAll({ ids: PROP_TEXTURES });
    expect(urls.sort()).toEqual(['mirror-face.webp', 'portrait-possessed.webp', 'portrait.webp']);
    expect(r.ready).toHaveLength(3);
  });
});

describe('镜子（mirror.ts）：脸留到 1.8 秒，别的时间线、亮度、冷光不动', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const objState = (): ScareObjectState => ({
    id: 'mirror', type: 'mirror', pos: { x: 11.25, z: 8.75 }, facing: 0, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0,
  });
  it('扑上来的时刻、亮度表照旧（声音 sfx.ts 的 mirror()、config/scares.ts 的 hitAt 都对着它）', () => {
    expect(MIRROR_T.hit).toBe(SCARES.mirror.hitAt);
    expect(MIRROR_FLASH.slice(0, 8)).toEqual([[0, 0], [0.38, 0.65], [0.43, 0], [0.47, 0.4], [0.5, 0], [0.6, 1.3], [0.7, 1.12], [0.8, 1]]);
    expect(Math.max(...MIRROR_FLASH.map((e) => e[1]))).toBe(1.3);
  });

  it('脸贴在玻璃上留到 1.8 秒才化开，化完才开始散雾；别的时刻不动', () => {
    expect(MIRROR_T.dissolveFrom).toBeCloseTo(1.8, 9);
    expect(MIRROR_T.dissolveTo - MIRROR_T.dissolveFrom).toBeCloseTo(0.45, 9); // 化开本身的快慢照旧
    expect(MIRROR_T.dissolveTo).toBeLessThanOrEqual(MIRROR_T.clearFrom);
    expect({ fogTo: MIRROR_T.fogTo, handFrom: MIRROR_T.handFrom, handTo: MIRROR_T.handTo, hit: MIRROR_T.hit, clearFrom: MIRROR_T.clearFrom, clearTo: MIRROR_T.clearTo })
      .toEqual({ fogTo: 0.42, handFrom: 0.15, handTo: 0.36, hit: 0.6, clearFrom: 2.4, clearTo: 5.4 });
  });

  it('物件：冷光最亮还是 3.38（1.3 × 2.6），留着的时候稳稳亮着，任意 1 秒内暗不超过 3 下，演完脸藏起来、灯灭；脸的网格还是 deferCompile', () => {
    // 手印的遮罩是 Canvas 画的（node 里没有 document）：给一张什么也不画的假画布，这里只查灯和网格
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
    const rig = createMirror();
    const obj = objState();
    const state: WorldState = { time: 0, npcs: [], objects: [obj], scaredOff: 0, hitStop: 0, manifest: idleManifest(), avoid: [] };
    const face = rig.model.getObjectByName('mirror-face')!;
    expect(face.userData.deferCompile).toBe(true);
    let light: THREE.PointLight | null = null;
    rig.model.traverse((o) => { if ((o as THREE.PointLight).isPointLight) light = o as THREE.PointLight; });
    const flash = light as unknown as THREE.PointLight;
    rig.update({ dt: 1 / 60, time: 0, obj, state });
    expect(face.visible).toBe(false);
    rig.trigger(state, { type: 'trigger', object: 'mirror', scareType: 'mirror' });
    const HZ = 60;
    const series: number[] = [];
    const faceSeen: boolean[] = [];
    for (let k = 0; k < HZ * 6; k++) {
      rig.update({ dt: 1 / HZ, time: k / HZ, obj, state });
      series.push(flash.intensity);
      faceSeen.push(face.visible);
    }
    const at_ = (t: number) => Math.round(t * HZ) - 1;
    expect(Math.max(...series)).toBeCloseTo(1.3 * 2.6, 6);
    // 第二个参数是采样率：不给的话默认按 10 Hz 算，「1 秒」的窗口只有 1/6 秒，这条就白测了。
    // 从第一次亮起来开始数：dipStarts 的起始高点是 1（灯平时亮着的约定），这盏灯平时是 0，从 0 开头会多数一下 t = 0 的「暗」
    const first = series.findIndex((v) => v > 0);
    const lit = series.slice(first);
    expect(countDips(lit, HZ)).toBeLessThanOrEqual(3);
    // 暗下去的只有原来那三下（两次闪现、扑上来以后退一点），脸留长没有多出一下
    const dips = dipStarts(lit, HZ).map((d) => d + (first + 1) / HZ);
    expect(dips).toHaveLength(3);
    [0.43, 0.5, 0.7].forEach((d, i) => expect(dips[i]).toBeCloseTo(d, 1));
    // 留着的这一段（亮度退到 1.0 以后、化开之前）一点不闪
    const hold = series.slice(at_(0.85), at_(MIRROR_T.dissolveFrom - 0.02));
    expect(Math.max(...hold) - Math.min(...hold)).toBeLessThan(1e-9);
    expect(hold[0]).toBeCloseTo(2.6, 9);
    expect(faceSeen[at_(0.9)] && faceSeen[at_(1.4)] && faceSeen[at_(1.75)]).toBe(true);
    expect(faceSeen[at_(MIRROR_T.dissolveTo + 0.05)]).toBe(false);
    expect(flash.intensity).toBe(0);
    expect(face.visible).toBe(false);
  });
});

describe('画像换脸（portrait.ts）', () => {
  const T = PORTRAIT_TIMELINE;
  it('时间线：眼睛甩过去那一刻（snap）开始化开，访客受惊（hitAt，0.94 秒不变）时正好换完，单调、连续', () => {
    expect(SCARES.portrait.hitAt).toBe(0.94);
    expect(portraitRot(0)).toBe(0);
    expect(portraitRot(T.snap)).toBe(0);
    expect(T.snap + PORTRAIT_REVEAL.time).toBeCloseTo(SCARES.portrait.hitAt, 9);
    expect(portraitRot(SCARES.portrait.hitAt)).toBeCloseTo(1, 9);
    expect(portraitRot(SCARES.portrait.hitAt + 0.01)).toBe(1);
    let prev = 0;
    for (let t = 0; t <= 1.2; t += 1 / 240) {
      const r = portraitRot(t);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(r - prev).toBeLessThan(0.05); // 1/240 秒里不跳
      prev = r;
    }
  });

  it('换完以后脸至少留 1.5 秒才扑倒；扑倒、砸地、回弹之间的间隔照旧（声音、灰、印子都跟着这一份）', () => {
    expect(T.fall - SCARES.portrait.hitAt).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(T.fall - T.trembleFrom).toBeCloseTo(0.22, 9);
    expect(T.impact - T.fall).toBeCloseTo(0.34, 9);
    expect(T.bounce1 - T.impact).toBeCloseTo(0.16, 9);
    expect(T.bounce2 - T.bounce1).toBeCloseTo(0.1, 9);
    expect(T.end - T.bounce2).toBeCloseTo(0.1, 9);
  });

  it('脸在访客受惊之前就换完了：眼睛甩过去后很快开始，下巴（离脸中心 0.145）在 hitAt 之前 0.2 秒以上到位', () => {
    const F = PORTRAIT_REVEAL.face;
    // 噪声最不利（n = 1，前沿最靠后）
    expect(portraitReveal(F[0], F[1], portraitRot(T.snap + 0.15), 0)).toBeGreaterThan(0);
    expect(portraitReveal(F[0], F[1] + 0.145, portraitRot(SCARES.portrait.hitAt - 0.2), 1)).toBe(1);
    // 换得不能太早：hitAt 之前 0.5 秒时下巴还没到（受惊要对着换脸，不是换完很久才叫）
    expect(portraitReveal(F[0], F[1] + 0.145, portraitRot(SCARES.portrait.hitAt - 0.5), 1)).toBeLessThan(1);
  });

  it('从脸开始化开：脸先换完、四角最后；进度 0 时哪儿都没换，进度 1 时全换完（噪声取哪头都一样）', () => {
    const F = PORTRAIT_REVEAL.face;
    for (const n of [0, 0.5, 1]) {
      expect(portraitReveal(F[0], F[1], 0, n)).toBe(0);
      expect(portraitReveal(0, 0, 0, n)).toBe(0);
      expect(portraitReveal(0, 0, 1, n)).toBe(1);
      expect(portraitReveal(1, 1, 1, n)).toBe(1);
      expect(portraitReveal(F[0], F[1], 0.35, n)).toBe(1);
      expect(portraitReveal(0, 1, 0.35, n)).toBe(0);
      expect(portraitReveal(1, 1, 0.35, n)).toBe(0);
    }
  });

  const objState = (over: Partial<ScareObjectState> = {}): ScareObjectState => ({
    id: 'portrait', type: 'portrait', pos: { x: 3.75, z: 0.75 }, facing: Math.PI / 2, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0, ...over,
  });
  const world = (obj: ScareObjectState): WorldState => ({ time: 0, npcs: [], objects: [obj], scaredOff: 0, hitStop: 0, manifest: idleManifest(), avoid: [] });

  it('物件：触发后按时间线换脸；扑倒、趴着时保持；复原时还脸朝下就换回来，扶回画架时已经是平常的女士像', () => {
    const rig = createPortrait();
    const canvas = rig.model.getObjectByName('portrait-canvas')!;
    const rot = canvas.userData.rot as { value: number };
    const pivot = canvas.parent!;
    const obj = objState();
    const state = world(obj);
    let now = 0;
    const to = (s: number) => {
      while (now < s - 1e-9) {
        const dt = Math.min(1 / 120, s - now);
        now += dt;
        rig.update({ dt, time: now, obj, state });
      }
    };
    rig.update({ dt: 1 / 60, time: 0, obj, state });
    expect(rot.value).toBe(0);
    // 模拟那边附身时设上 active、broken（sim/scares.ts 的 triggerObject），这里一直留着，复原前再清掉
    obj.active = 1.8;
    obj.broken = 10;
    rig.trigger(state, { type: 'trigger', object: 'portrait', scareType: 'portrait' });
    now = 0;
    to(T.snap + 0.2);
    expect(rot.value).toBeCloseTo(portraitRot(T.snap + 0.2), 6);
    expect(rot.value).toBeGreaterThan(0);
    expect(rot.value).toBeLessThan(1);
    // 模拟的 active（1.8 秒）先到头，画还立着、脸还在：不能被「错过事件」的兜底提前放倒
    to(1.8);
    obj.active = 0;
    to(T.trembleFrom - 0.01);
    expect(rot.value).toBe(1);
    expect(pivot.rotation.x).toBeCloseTo(-0.1, 9);
    expect(pivot.position.y).toBeCloseTo(0.755, 9);
    to(T.impact + 0.02);
    expect(pivot.rotation.x).toBeGreaterThan(1.2);
    to(T.end + 0.5);
    expect(rot.value).toBe(1);
    to(T.end + 3);
    expect(rot.value).toBe(1);
    // 复原：头 0.32 秒还趴着（脸朝下），这时换回来
    obj.broken = 0;
    rig.reset();
    const r0 = now;
    to(r0 + 0.05);
    expect(rot.value).toBe(0);
    // 那时画还是脸朝下的（转轴转过 π/2 附近）
    expect(pivot.rotation.x).toBeGreaterThan(1.3);
  });
});
