// 鬼屋布局：模拟（格子、寻路、视线）和画面（墙、地板、家具、物件）的唯一数据来源。
// 坐标：格子 (i, j) 中 i 是列（向东），j 是行（向南）；格子中心的米坐标 = ((i + 0.5) × CELL, (j + 0.5) × CELL)。
// 画面里所有和房屋有关的物体都挂在 houseRoot 下，houseRoot 的局部坐标就是这里的米坐标（y 向上）。
import type { ScareType } from '../sim/types';

export const CELL = 0.5; // 米
export const GRID_W = 32; // 16 米
export const GRID_H = 24; // 12 米
export const HOUSE_W = GRID_W * CELL;
export const HOUSE_D = GRID_H * CELL;

export const WALL_H = 2.4; // 远墙全高
export const WALL_CUT_H = 0.5; // 降低后的墙高
export const WALL_T = 0.2; // 墙的视觉厚度（墙格 0.5 米宽，墙体居中画 0.2 米）

export const Tile = { Floor: 0, Wall: 1, Window: 2, Furniture: 3, Prop: 4, Exit: 5 } as const;
export type Tile = (typeof Tile)[keyof typeof Tile];
/** 能走的格子 */
export const walkable = (t: Tile) => t === Tile.Floor || t === Tile.Exit;
/** 挡视线的格子（家具和物件不挡视线，只挡路） */
export const blocksSight = (t: Tile) => t === Tile.Wall || t === Tile.Window;

export type RoomId = 'study' | 'living' | 'kitchen' | 'hall' | 'bedroom' | 'foyer' | 'bathroom';
/** 格子矩形：列 [x0, x1)，行 [z0, z1) */
export interface Rect { x0: number; z0: number; x1: number; z1: number }

export const ROOMS: Record<RoomId, Rect> = {
  study: { x0: 1, z0: 1, x1: 10, z1: 9 },
  living: { x0: 11, z0: 1, x1: 21, z1: 9 },
  kitchen: { x0: 22, z0: 1, x1: 31, z1: 9 },
  hall: { x0: 1, z0: 10, x1: 31, z1: 14 },
  bedroom: { x0: 1, z0: 15, x1: 10, z1: 23 },
  foyer: { x0: 11, z0: 15, x1: 21, z1: 23 },
  bathroom: { x0: 22, z0: 15, x1: 31, z1: 23 },
};

/** 墙上的门洞（打通成地板），每个 2 格 = 1 米宽 */
export const DOORWAYS: { cells: [number, number][]; rooms: [RoomId, RoomId] }[] = [
  { cells: [[4, 9], [5, 9]], rooms: ['study', 'hall'] },
  { cells: [[15, 9], [16, 9]], rooms: ['living', 'hall'] },
  { cells: [[25, 9], [26, 9]], rooms: ['kitchen', 'hall'] }, // 厨房门，可附身
  { cells: [[4, 14], [5, 14]], rooms: ['bedroom', 'hall'] },
  { cells: [[15, 14], [16, 14]], rooms: ['foyer', 'hall'] },
  { cells: [[25, 14], [26, 14]], rooms: ['bathroom', 'hall'] },
];

/** 前门：访客唯一的出入口（在门厅南墙上） */
export const FRONT_DOOR = {
  cells: [[15, 23], [16, 23]] as [number, number][],
  /** 访客出现 / 消失的位置（门外，米坐标，不在格子里） */
  outside: { x: 8.0, z: 13.2 },
  /** 进门后先走到的位置 */
  inside: { x: 8.0, z: 10.6 },
};

/** 外墙上的窗户格（只有当那面墙是全高的远墙时才看得见） */
export const WINDOWS: [number, number][] = [
  ...[3, 4, 5, 6, 14, 15, 16, 17, 24, 25, 26, 27].map((i) => [i, 0] as [number, number]),
  ...[3, 4, 5, 6, 24, 25, 26, 27].map((i) => [i, 23] as [number, number]),
  ...[3, 4, 5, 6, 17, 18, 19, 20].map((j) => [0, j] as [number, number]),
  ...[3, 4, 5, 6, 17, 18, 19, 20].map((j) => [31, j] as [number, number]),
];

export type FurnitureKind =
  | 'bookshelf' | 'desk' | 'sofa' | 'fireplace' | 'counter' | 'table'
  | 'bed' | 'nightstand' | 'wardrobe' | 'coatRack' | 'bathtub' | 'sink' | 'rug' | 'runner';

export interface Furniture {
  id: string;
  kind: FurnitureKind;
  rect: Rect;
  /** 正面朝向（方向角，见 lib/angle.ts） */
  facing: number;
  /** false = 只画不挡路（地毯） */
  blocks: boolean;
}

const N = -Math.PI / 2, S = Math.PI / 2, E = 0, W = Math.PI;

export const FURNITURE: Furniture[] = [
  { id: 'study-shelf', kind: 'bookshelf', rect: { x0: 1, z0: 1, x1: 4, z1: 2 }, facing: S, blocks: true },
  { id: 'study-desk', kind: 'desk', rect: { x0: 7, z0: 5, x1: 9, z1: 7 }, facing: W, blocks: true },
  { id: 'living-fireplace', kind: 'fireplace', rect: { x0: 15, z0: 1, x1: 17, z1: 2 }, facing: S, blocks: true },
  { id: 'living-sofa', kind: 'sofa', rect: { x0: 14, z0: 4, x1: 18, z1: 5 }, facing: N, blocks: true },
  { id: 'kitchen-counter', kind: 'counter', rect: { x0: 22, z0: 1, x1: 31, z1: 2 }, facing: S, blocks: true },
  { id: 'kitchen-table', kind: 'table', rect: { x0: 25, z0: 4, x1: 28, z1: 6 }, facing: S, blocks: true },
  { id: 'hall-runner', kind: 'runner', rect: { x0: 3, z0: 11, x1: 29, z1: 13 }, facing: E, blocks: false },
  { id: 'bedroom-bed', kind: 'bed', rect: { x0: 1, z0: 18, x1: 4, z1: 22 }, facing: E, blocks: true },
  // 床头柜在床头（西墙）北侧，八音盒放在上面（面高 0.55 米）
  { id: 'bedroom-nightstand', kind: 'nightstand', rect: { x0: 1, z0: 17, x1: 2, z1: 18 }, facing: E, blocks: true },
  { id: 'bedroom-wardrobe', kind: 'wardrobe', rect: { x0: 7, z0: 15, x1: 10, z1: 16 }, facing: S, blocks: true },
  { id: 'foyer-rug', kind: 'rug', rect: { x0: 14, z0: 18, x1: 18, z1: 22 }, facing: N, blocks: false },
  { id: 'foyer-coatrack', kind: 'coatRack', rect: { x0: 19, z0: 16, x1: 20, z1: 17 }, facing: W, blocks: true },
  { id: 'bath-tub', kind: 'bathtub', rect: { x0: 27, z0: 20, x1: 31, z1: 23 }, facing: N, blocks: true },
  { id: 'bath-sink', kind: 'sink', rect: { x0: 22, z0: 15, x1: 24, z1: 16 }, facing: S, blocks: true },
];

export interface PropPlacement {
  id: string;
  type: ScareType;
  /** 物件所在格（门：门洞两格中的西边那格） */
  cell: [number, number];
  /** 正面朝向（方向角） */
  facing: number;
  room: RoomId;
}

/**
 * 可附身的物件。除了门（门洞里，能走），物件所在格都会标成 Tile.Prop（挡路不挡视线）。
 * 摆放原则：
 * - 每个引诱物件旁边配一个惊吓物件，被引过去查看的人正好看见它（先引诱、再惊吓）：
 *   卧室八音盒 + 床边落地灯（西墙床头），厨房门 + 摇椅（门里正对门洞，从走廊往里看就在眼前）
 * - 有正面的物件（肖像、镜子）朝南或朝东：默认镜头在东南方向看得见正面；背靠墙、面朝房间，屋里的人都在它正面
 * - 落地镜不跟引诱物件配对：它是最重的惊吓，配上引诱就成了每 20 秒一次的「刷恐惧」，太容易（见 tests/balance.test.ts）
 * - 床（2026-10-28）：被子下面有人。床本身已经挡路（Tile.Furniture），床面中间那一格改标成 Tile.Prop，不改变能不能走；
 *   这一格压在床上、四周也都是床，所以和别的物件不一样：不在家具外面，旁边也没有可走的格子
 */
export const PROPS: PropPlacement[] = [
  { id: 'portrait', type: 'portrait', cell: [7, 1], facing: S, room: 'study' },
  { id: 'rocking-chair', type: 'rockingChair', cell: [26, 7], facing: S, room: 'kitchen' },
  { id: 'lamp-living', type: 'lamp', cell: [19, 2], facing: S, room: 'living' },
  { id: 'kitchen-door', type: 'door', cell: [25, 9], facing: S, room: 'kitchen' },
  { id: 'music-box', type: 'musicBox', cell: [1, 17], facing: E, room: 'bedroom' },
  { id: 'lamp-bedroom', type: 'lamp', cell: [1, 16], facing: E, room: 'bedroom' },
  { id: 'mirror', type: 'mirror', cell: [22, 17], facing: E, room: 'bathroom' },
  { id: 'bed', type: 'bed', cell: [2, 20], facing: E, room: 'bedroom' },
];

export const cellCenter = (i: number, j: number) => ({ x: (i + 0.5) * CELL, z: (j + 0.5) * CELL });
export const cellOf = (x: number, z: number): [number, number] => [Math.floor(x / CELL), Math.floor(z / CELL)];
export const inGrid = (i: number, j: number) => i >= 0 && j >= 0 && i < GRID_W && j < GRID_H;
export const idx = (i: number, j: number) => j * GRID_W + i;

/** 物件的米坐标中心（门在两格中间） */
export const propCenter = (p: PropPlacement) => {
  const c = cellCenter(p.cell[0], p.cell[1]);
  return p.type === 'door' ? { x: c.x + CELL / 2, z: c.z } : c;
};

/** 生成格子地图（长度 GRID_W × GRID_H，按 idx(i, j) 取值） */
export function buildTiles(): Uint8Array {
  const t = new Uint8Array(GRID_W * GRID_H).fill(Tile.Wall);
  const fill = (r: Rect, v: Tile) => {
    for (let j = r.z0; j < r.z1; j++) for (let i = r.x0; i < r.x1; i++) t[idx(i, j)] = v;
  };
  for (const r of Object.values(ROOMS)) fill(r, Tile.Floor);
  for (const d of DOORWAYS) for (const [i, j] of d.cells) t[idx(i, j)] = Tile.Floor;
  for (const [i, j] of FRONT_DOOR.cells) t[idx(i, j)] = Tile.Exit;
  for (const [i, j] of WINDOWS) t[idx(i, j)] = Tile.Window;
  for (const f of FURNITURE) if (f.blocks) fill(f.rect, Tile.Furniture);
  for (const p of PROPS) if (p.type !== 'door') t[idx(p.cell[0], p.cell[1])] = Tile.Prop;
  return t;
}

/** 调试用：把地图画成字符 */
export function tilesToAscii(t: Uint8Array): string {
  const ch = ['.', '#', '=', 'o', 'P', 'E'];
  const rows: string[] = [];
  for (let j = 0; j < GRID_H; j++) {
    let s = '';
    for (let i = 0; i < GRID_W; i++) s += ch[t[idx(i, j)]];
    rows.push(s);
  }
  return rows.join('\n');
}

/** 某个格子属于哪个房间（墙和门洞返回 null） */
export function roomAt(i: number, j: number): RoomId | null {
  for (const [id, r] of Object.entries(ROOMS) as [RoomId, Rect][]) {
    if (i >= r.x0 && i < r.x1 && j >= r.z0 && j < r.z1) return id;
  }
  return null;
}
