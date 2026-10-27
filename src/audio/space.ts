// 第三人称的 3D 声像（2026-10-28 改版）：听者在镜头处，声源按房屋米坐标放进 HRTF 的 PannerNode。
// 俯视（娃娃屋）模式从来不调 setListener：各声音照旧走 StereoPanner（屏幕横坐标的声像），这里的东西一个都不建。
//
// 一个定位声源（Port）的节点
//   直达：in（增益 = HRTF 补偿 × 遮挡衰减）→ 低架 -6.5 dB @ 400 Hz → 遮挡低通 → PannerNode（HRTF，inverse 距离模型）→ 总线
//   HRTF 补偿：Chrome 的 HRTF 比居中的 StereoPanner 在 125–250 Hz 多出约 6 dB、1–4 kHz 基本持平（dev 页面实测，白噪声的
//     倍频程对比），整体听起来发闷、发轰。低架把低频压回去以后，同一个声音在俯视和第三人称下音色一致；
//     剩下的 trim 让两边的响度一致。8 kHz 那个凹口是耳廓的前后线索，不去补
//   混响：wet（增益 = 遮挡衰减 × 距离衰减^wetLaw）→ 遮挡低通 → 混响送入口
//   一次性的声音（物件、门、环境层的嘎吱）各建一个，声音结束时 release；每个访客、鬼魂各有一个常驻的，跟着人走
//   （footsteps.ts、ghost.ts）
//
// 距离：inverse 模型，ref 2.5 米以内是设计音量，之后 ref / (ref + 0.75 × (d − ref))：4 米 -3 dB、8 米 -8.5 dB、
//   12 米 -11.7 dB、房子对角线 20 米 -16 dB。比真实的 1/d 缓（真实的话隔一个房间就听不清了），远近仍然一听就分得出。
//   混响不按这个衰减：直达声每少 1 dB，混响只少 0.5 dB —— 远处的声音更「湿」，这是人耳判断远近的主要线索
// 遮挡（隔墙）：每 0.1 秒从「耳朵」重算一次。耳朵 = 鬼魂的位置（没有鬼魂时是听者）：镜头在鬼魂身后 1–4 米，常常在
//   隔壁房间或者墙里（墙会溶开），从镜头算的话，鬼魂所在房间的声音全会被闷住
//   穿墙：两点连线穿过几道墙（格子地图里连续的墙 / 窗格算一道），每道 -6 dB，低通 1400 / 750 / 450 Hz
//   绕路：从门洞绕过去的最短路比直线多出 e 米：增益 1 / (1 + e / 4)，低通 20000 / (1 + 2.5e)
//     （多绕 1 米 5.7 kHz，3 米 2.4 kHz，6 米 1.2 kHz）
//   两条路取响的那条（增益、截止频率各取大的）。同一个房间里、或者隔着门洞看得见的声源完全不受影响；
//   耳朵在墙里时，起点那道墙不算（墙两边都听得见）
// 听者朝向只取水平方向（头是正的）：镜头俯仰不影响左右，声源的高低交给 y 坐标
import { CELL, GRID_H, GRID_W, blocksSight, buildTiles, idx, type Tile } from '../config/house';

/** 房屋米坐标（x 向东、z 向南、y 为离地高度）。和 three 的世界坐标一样是右手系，可以直接交给 Web Audio */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const SPACE = {
  /** inverse 距离模型：refDistance（米）以内不衰减；rolloffFactor */
  ref: 2.5,
  rolloff: 0.75,
  /** HRTF 的音色补偿：低架滤波（赫兹、dB） */
  shelf: { hz: 400, db: -6.5 },
  /** HRTF 相对 StereoPanner 居中的响度补偿（dB）。dev/audio.html 的两行 calibration 对比量出：同一段粉噪声，
   *  正前方 ref 处的 HRTF（过了低架）和居中的 StereoPanner 差多少就补多少，俯视和第三人称的混音才是同一个响度 */
  trim: 0,
  /** 混响的距离衰减是直达声的几次方（0.5 = dB 数减半） */
  wetLaw: 0.5,
  /** 穿墙：每道墙的增益；1、2、3 道及以上的低通截止（赫兹） */
  wall: { gain: 0.5, cutoff: [1400, 750, 450] as readonly number[] },
  /** 绕路：多绕 metres 米增益减半；截止 = open / (1 + cutoffK × 多绕的米数) */
  around: { metres: 4, cutoffK: 2.5 },
  /** 低通「全开」 */
  open: 20000,
  /** 多久重算一次遮挡（秒）、参数平滑的时间常数（秒） */
  every: 0.1,
  smooth: 0.06,
};

/** 一个定位声源的入口。in 是直达声，wet 是混响送出；一次性声音用完 release，常驻的（访客、鬼魂）每帧 move */
export interface Port {
  readonly in: AudioNode;
  readonly wet: AudioNode;
  /** 挪到新位置。at = 安排在哪个时刻（离线测量用）；不给就是立刻 */
  move(x: number, y: number, z: number, at?: number): void;
  release(): void;
}

/** 一个声音落在哪：数字 = 立体声声像 -1..1（俯视模式，或不定位的声音）；Vec3 = 3D 位置；Port = 跟着人走的声道 */
export type Place = number | Vec3 | Port;

export const isPort = (p: Place): p is Port => typeof p === 'object' && 'release' in p;

export interface Space {
  /** setListener 调过至少一次：之后新起的声音都按 3D 定位 */
  readonly active: boolean;
  /** 听者（镜头）现在的位置 */
  readonly listener: Readonly<Vec3>;
  setListener(pos: Vec3, forward: Vec3): void;
  /** 遮挡从哪里算（鬼魂的位置）；null = 从听者算 */
  setEar(p: { x: number; z: number } | null): void;
  /** 建一个定位声源，直达声接到 dest（sfx / voice / amb 总线），混响接到总混响 */
  port(at: Vec3, dest: AudioNode): Port;
  /** 每帧调；每 SPACE.every 秒重算一次遮挡和混响量 */
  update(now: number): void;
  /** 立刻重算（离线测量：没有「每帧」） */
  refresh(now: number): void;
  /** 到听者的距离（米） */
  distance(x: number, y: number, z: number): number;
  /** 某点此刻的遮挡：[增益, 低通截止]（调试和 dev 页面用） */
  occlusion(x: number, z: number): [number, number];
}

// ── 格子地图上的遮挡 ──────────────────────────────────────────────────────────

const tiles = buildTiles();
const opaque = new Uint8Array(tiles.length);
for (let k = 0; k < tiles.length; k++) opaque[k] = blocksSight(tiles[k] as Tile) ? 1 : 0;
/** 格子外（屋外）不算墙 */
const wallAt = (i: number, j: number) => i >= 0 && j >= 0 && i < GRID_W && j < GRID_H && opaque[idx(i, j)] === 1;
const clampI = (i: number) => (i < 0 ? 0 : i >= GRID_W ? GRID_W - 1 : i);
const clampJ = (j: number) => (j < 0 ? 0 : j >= GRID_H ? GRID_H - 1 : j);

/** 两点连线穿过几道墙（逐格 DDA；连续的墙格算一道；起点、终点所在的那道不算） */
export function wallsBetween(ax: number, az: number, bx: number, bz: number): number {
  let i = Math.floor(ax / CELL);
  let j = Math.floor(az / CELL);
  const i1 = Math.floor(bx / CELL);
  const j1 = Math.floor(bz / CELL);
  const dx = bx - ax;
  const dz = bz - az;
  const si = Math.sign(dx);
  const sj = Math.sign(dz);
  const tdx = si ? CELL / Math.abs(dx) : Infinity;
  const tdz = sj ? CELL / Math.abs(dz) : Infinity;
  let tx = si > 0 ? ((i + 1) * CELL - ax) / dx : si < 0 ? (i * CELL - ax) / dx : Infinity;
  let tz = sj > 0 ? ((j + 1) * CELL - az) / dz : sj < 0 ? (j * CELL - az) / dz : Infinity;
  let skipping = wallAt(i, j);
  let inRun = false;
  let runs = 0;
  // 4 连通的 DDA 从起点格走到终点格正好 |Δi| + |Δj| 步
  for (let n = Math.abs(i1 - i) + Math.abs(j1 - j); n > 0; n--) {
    if (tx < tz) {
      i += si;
      tx += tdx;
    } else {
      j += sj;
      tz += tdz;
    }
    const w = wallAt(i, j);
    if (skipping) {
      skipping = w;
      continue;
    }
    if (w && !inRun) runs++;
    inRun = w;
  }
  // 终点就在墙里：这道墙是它自己待的地方，不算隔着
  if (inRun && wallAt(i1, j1)) runs--;
  return Math.max(0, runs);
}

const freeBase = new Uint8Array(tiles.length);
for (let k = 0; k < tiles.length; k++) freeBase[k] = opaque[k] ? 0 : 1;

/**
 * 从起点格出发、只走非墙格（8 方向，斜着走不切墙角）的最短路长度场（单位：格）。起点格本身是墙也照样出发。
 * 正反两遍扫描反复做，直到不再变短（这栋房子 4–6 遍就收敛，约 0.1 毫秒）
 */
function pathField(field: Float32Array, free: Uint8Array, i0: number, j0: number) {
  const W = GRID_W;
  const H = GRID_H;
  const D = Math.SQRT2;
  free.set(freeBase);
  const s = idx(i0, j0);
  free[s] = 1;
  field.fill(Infinity);
  field[s] = 0;
  for (let pass = 0; pass < 24; pass++) {
    let changed = false;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!free[k]) continue;
        let v = field[k];
        if (i > 0 && free[k - 1]) v = Math.min(v, field[k - 1] + 1);
        if (j > 0 && free[k - W]) {
          v = Math.min(v, field[k - W] + 1);
          if (i > 0 && free[k - 1] && free[k - W - 1]) v = Math.min(v, field[k - W - 1] + D);
          if (i < W - 1 && free[k + 1] && free[k - W + 1]) v = Math.min(v, field[k - W + 1] + D);
        }
        if (v < field[k]) {
          field[k] = v;
          changed = true;
        }
      }
    }
    for (let j = H - 1; j >= 0; j--) {
      for (let i = W - 1; i >= 0; i--) {
        const k = j * W + i;
        if (!free[k]) continue;
        let v = field[k];
        if (i < W - 1 && free[k + 1]) v = Math.min(v, field[k + 1] + 1);
        if (j < H - 1 && free[k + W]) {
          v = Math.min(v, field[k + W] + 1);
          if (i < W - 1 && free[k + 1] && free[k + W + 1]) v = Math.min(v, field[k + W + 1] + D);
          if (i > 0 && free[k - 1] && free[k + W - 1]) v = Math.min(v, field[k + W - 1] + D);
        }
        if (v < field[k]) {
          field[k] = v;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/** 遮挡计算器：耳朵挪到新格子时重建最短路场 */
export function createOcclusion() {
  const field = new Float32Array(GRID_W * GRID_H);
  const free = new Uint8Array(GRID_W * GRID_H);
  let ex = NaN;
  let ez = NaN;
  let cell = -1;
  /** 声源所在格的最短路（米）；声源在墙格里时取它旁边最近的非墙格 */
  const pathTo = (sx: number, sz: number) => {
    const i = clampI(Math.floor(sx / CELL));
    const j = clampJ(Math.floor(sz / CELL));
    let best = field[idx(i, j)];
    if (!Number.isFinite(best)) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= GRID_W || nj >= GRID_H) continue;
          best = Math.min(best, field[idx(ni, nj)] + Math.hypot(di, dj));
        }
      }
    }
    return best * CELL;
  };
  return {
    setEar(x: number, z: number) {
      ex = x;
      ez = z;
      const c = idx(clampI(Math.floor(x / CELL)), clampJ(Math.floor(z / CELL)));
      if (c === cell) return;
      cell = c;
      pathField(field, free, c % GRID_W, Math.floor(c / GRID_W));
    },
    /** [增益, 低通截止] */
    at(sx: number, sz: number): [number, number] {
      if (!Number.isFinite(ex)) return [1, SPACE.open];
      const n = wallsBetween(ex, ez, sx, sz);
      if (n === 0) return [1, SPACE.open];
      const wg = SPACE.wall.gain ** n;
      const wc = SPACE.wall.cutoff[Math.min(n, SPACE.wall.cutoff.length) - 1];
      // 多绕的路：8 方向的格子路比真实路线平均长 4% 左右，再留一格的量化余量
      const e = Math.max(0, pathTo(sx, sz) * 0.96 - Math.hypot(sx - ex, sz - ez) - CELL);
      const ag = Number.isFinite(e) ? 1 / (1 + e / SPACE.around.metres) : 0;
      const ac = Number.isFinite(e) ? SPACE.open / (1 + SPACE.around.cutoffK * e) : 0;
      return [Math.max(wg, ag), Math.max(wc, ac)];
    },
  };
}

// ── 听者和定位声源 ───────────────────────────────────────────────────────────

interface Live {
  x: number;
  y: number;
  z: number;
  pre: GainNode;
  shelf: BiquadFilterNode;
  lp: BiquadFilterNode;
  pan: PannerNode;
  wg: GainNode;
  wlp: BiquadFilterNode;
  /** 上次写进参数的值（变化很小时不再写，免得参数的时间线越攒越长） */
  g: number;
  c: number;
  w: number;
}

const finite3 = (v: Vec3 | null | undefined): v is Vec3 => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** inverse 距离模型的增益（和 PannerNode 里的同一个公式） */
export const distanceGain = (d: number) => SPACE.ref / (SPACE.ref + SPACE.rolloff * (Math.max(d, SPACE.ref) - SPACE.ref));

export function createSpace(ac: BaseAudioContext, reverb: AudioNode): Space {
  let active = false;
  const lis: Vec3 = { x: 8, y: 1.6, z: 6 };
  let fwd = { x: 0, z: -1 };
  let ear: { x: number; z: number } | null = null;
  const occ = createOcclusion();
  const live = new Set<Live>();
  let nextAt = 0;
  const trim = 10 ** (SPACE.trim / 20);
  const open = Math.min(SPACE.open, ac.sampleRate * 0.45);

  const setEarNow = () => occ.setEar(ear ? ear.x : lis.x, ear ? ear.z : lis.z);

  const apply = (L: Live, now: number, immediate: boolean) => {
    const [g, c0] = occ.at(L.x, L.z);
    const c = Math.min(open, c0);
    const w = g * distanceGain(Math.hypot(L.x - lis.x, L.y - lis.y, L.z - lis.z)) ** SPACE.wetLaw;
    if (immediate) {
      L.pre.gain.value = trim * g;
      L.lp.frequency.value = c;
      L.wg.gain.value = w;
      L.wlp.frequency.value = c;
    } else {
      const k = SPACE.smooth;
      if (Math.abs(g - L.g) > 0.02 * Math.max(g, L.g)) L.pre.gain.setTargetAtTime(trim * g, now, k);
      if (Math.abs(c - L.c) > 0.03 * Math.max(c, L.c)) {
        L.lp.frequency.setTargetAtTime(c, now, k);
        L.wlp.frequency.setTargetAtTime(c, now, k);
      }
      if (Math.abs(w - L.w) > 0.02 * Math.max(w, L.w)) L.wg.gain.setTargetAtTime(w, now, k);
    }
    L.g = g;
    L.c = c;
    L.w = w;
  };

  const writeListener = () => {
    const l = ac.listener;
    if (l.positionX) {
      l.positionX.value = lis.x;
      l.positionY.value = lis.y;
      l.positionZ.value = lis.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = 0;
      l.forwardZ.value = fwd.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      // Firefox 的 AudioListener 没有 AudioParam，只有旧接口
      l.setPosition(lis.x, lis.y, lis.z);
      l.setOrientation(fwd.x, 0, fwd.z, 0, 1, 0);
    }
  };

  const space: Space = {
    get active() {
      return active;
    },
    get listener() {
      return lis;
    },

    setListener(pos, forward) {
      if (!finite3(pos) || !finite3(forward)) return;
      lis.x = pos.x;
      lis.y = pos.y;
      lis.z = pos.z;
      const h = Math.hypot(forward.x, forward.z);
      // 正对着上下看时水平方向没有定义：沿用上一帧的
      if (h > 1e-4) fwd = { x: forward.x / h, z: forward.z / h };
      writeListener();
      if (!active) {
        active = true;
        setEarNow();
        // Chrome 的 HRTF 数据库在第一个 HRTF PannerNode 建出来时才开始异步加载，加载完之前（实时 AudioContext 里）
        // HRTF 声像一律输出静音：现在就建一个不接任何东西的，让它先加载，免得开局第一声脚步、第一声「呼」被吞掉
        new PannerNode(ac, { panningModel: 'HRTF' });
      }
    },

    setEar(p) {
      ear = p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: p.x, z: p.z } : null;
    },

    port(at, dest) {
      const p = finite3(at) ? at : { x: lis.x, y: lis.y, z: lis.z };
      const pre = new GainNode(ac, { gain: trim });
      const shelf = new BiquadFilterNode(ac, { type: 'lowshelf', frequency: SPACE.shelf.hz, gain: SPACE.shelf.db });
      // 低通的 Q 在 Web Audio 里是分贝：-3 dB = 巴特沃斯，截止处没有共振峰
      const lp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: open, Q: -3 });
      const pan = new PannerNode(ac, {
        panningModel: 'HRTF',
        distanceModel: 'inverse',
        refDistance: SPACE.ref,
        rolloffFactor: SPACE.rolloff,
        maxDistance: 10000,
        positionX: p.x,
        positionY: p.y,
        positionZ: p.z,
      });
      pre.connect(shelf).connect(lp).connect(pan).connect(dest);
      const wg = new GainNode(ac, { gain: 1 });
      const wlp = new BiquadFilterNode(ac, { type: 'lowpass', frequency: open, Q: -3 });
      wg.connect(wlp).connect(reverb);
      const L: Live = { x: p.x, y: p.y, z: p.z, pre, shelf, lp, pan, wg, wlp, g: 1, c: open, w: 1 };
      apply(L, ac.currentTime, true);
      live.add(L);
      let released = false;
      return {
        in: pre,
        wet: wg,
        move(x, y, z, t) {
          if (released || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
          const jump = Math.hypot(x - L.x, z - L.z) > 1.5;
          L.x = x;
          L.y = y;
          L.z = z;
          if (t !== undefined) {
            pan.positionX.setValueAtTime(x, t);
            pan.positionY.setValueAtTime(y, t);
            pan.positionZ.setValueAtTime(z, t);
          } else if (pan.positionX) {
            pan.positionX.value = x;
            pan.positionY.value = y;
            pan.positionZ.value = z;
          } else pan.setPosition(x, y, z);
          // 一下子挪很远（声道换给了下一个访客）：遮挡立刻按新位置算，不平滑
          if (jump) apply(L, ac.currentTime, true);
        },
        release() {
          if (released) return;
          released = true;
          live.delete(L);
          for (const n of [pre, shelf, lp, pan, wg, wlp]) n.disconnect();
        },
      };
    },

    update(now) {
      if (!active || now < nextAt) return;
      nextAt = now + SPACE.every;
      space.refresh(now);
    },

    refresh(now) {
      setEarNow();
      for (const L of live) apply(L, now, false);
    },

    distance(x, y, z) {
      return Math.hypot(x - lis.x, y - lis.y, z - lis.z);
    },

    occlusion(x, z) {
      setEarNow();
      return occ.at(x, z);
    },
  };
  return space;
}
