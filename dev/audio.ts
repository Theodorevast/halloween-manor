// 声音沙盒：每个声音一个按钮（实时，走真正的 createAudio）；「Render all offline」把每个声音用 OfflineAudioContext
// 走完整条总线（限幅器、软削波、混响）渲染出来，量峰值、RMS、时长，结果 console.log 并写到 window.__audioReport。
// Playwright：
//   node scripts/shot.mjs http://127.0.0.1:5735/dev/audio.html shots/audio.png --wait 1000 \
//     --eval "window.renderAll()" --eval-wait 8000 --eval "JSON.stringify(window.__audioReport)"
//   window.__audio.bench() → 第一次 / 再次 unlock 的同步耗时（毫秒）
//   window.renderAll(seed?) → Promise<Row[]>；window.renderOne(name, seed?) 只渲染一个（seed 默认 12345，换种子看随机部分的离散）；window.__audio = { sys, state, fire(name) }
// 指标口径：
//   peak    整段（含混响尾巴）的采样峰值，dBFS
//   rms     「声音窗」里的 RMS（两个声道合起来）：画面上这件事发生的那段时间（台灯 0–1.2、肖像 0–1.3……），不含混响尾巴
//   rmsMax  400 毫秒滑动窗的最大 RMS（最响的那一下有多响）
//   dur     从起点到最后一个超过 -60 dBFS 的采样（含混响尾巴）
import { FRONT_DOOR, HOUSE_W, PROPS, propCenter } from '../src/config/house';
import { createAmbience, dreadTarget } from '../src/audio/ambience';
import { createAudio, createBus, createRouter, type MixBus, type Router } from '../src/audio/engine';
import { braam, rng } from '../src/audio/sfx';
import type { NpcState, Personality, ScareType, SimEvent, Vec2, WorldState } from '../src/sim/types';

const SR = 48000;
/** 每个声音从 0.05 秒开始（前面留一点空，看得出起音） */
const T0 = 0.05;
const pan = (p: Vec2) => Math.max(-1, Math.min(1, (p.x / HOUSE_W) * 2 - 1)) * 0.8;

// ── 假的模拟状态：全部物件 + 三个访客（三种性格） ─────────────────────────────
const npc = (id: number, name: string, personality: Personality, pos: Vec2): NpcState => ({
  id, name, personality, pos, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [],
});
const state: WorldState = {
  time: 0,
  npcs: [npc(1, 'Mia', 'timid', { x: 3.5, z: 2.5 }), npc(2, 'Theo', 'average', { x: 8, z: 6 }), npc(3, 'Nora', 'brave', { x: 12.5, z: 9 })],
  objects: PROPS.map((p) => ({ id: p.id, type: p.type, pos: propCenter(p), facing: p.facing, cooldown: 0, active: 0, broken: 0, seenBy: [] })),
  scaredOff: 0,
  hitStop: 0,
};
const objId = (type: ScareType) => state.objects.find((o) => o.type === type)!.id;
const trig = (type: ScareType): SimEvent => ({ type: 'trigger', object: objId(type), scareType: type });
const reset = (type: ScareType): SimEvent => ({ type: 'reset', object: objId(type) });
const startle = (id: number, scream: boolean, object: string | null = 'portrait', amount = 32): SimEvent => ({ type: 'startle', npc: id, object, amount, scream });

// ── 声音清单（按钮和离线测量共用） ─────────────────────────────────────────
type Group = 'ambience' | 'scare' | 'lure' | 'voice' | 'other' | 'stress' | 'calib';
interface Case {
  name: string;
  group: Group;
  /** 渲染总长（秒） */
  seconds: number;
  /** RMS 窗（相对起点，秒） */
  win: [number, number];
  /** 设计时长（画面上这件事持续多久，秒）；只用于报告 */
  nominal: number;
  /** 实时按钮发的事件（没有就不出按钮） */
  events?: SimEvent[];
  /** 离线渲染：在 t 时刻放这个声音 */
  render(bus: MixBus, router: Router, t: number): void;
}
const viaRouter = (events: SimEvent[]) => (_bus: MixBus, router: Router, t: number) => router.play(events, state, t);
const ambience = (d: number) => (bus: MixBus, _r: Router, t: number) => {
  const a = createAmbience(bus);
  a.start(t, 0.5);
  a.setDread(d, t);
};

const CASES: Case[] = [
  { name: 'calibration -20 dBFS sine', group: 'calib', seconds: 1, win: [0.2, 0.9], nominal: 1, render: (bus, _r, t) => {
    const o = new OscillatorNode(bus.ac, { frequency: 1000 });
    o.connect(new GainNode(bus.ac, { gain: 0.1 * Math.SQRT2 })).connect(bus.sfx);
    o.start(t);
    o.stop(t + 0.9);
  } },
  { name: 'ambience fear 0', group: 'ambience', seconds: 14, win: [3, 13.9], nominal: 0, render: ambience(0) },
  { name: 'ambience avg fear 70', group: 'ambience', seconds: 14, win: [3, 13.9], nominal: 0, render: ambience(dreadTarget(70, 0)) },
  { name: 'ambience dread max', group: 'ambience', seconds: 14, win: [3, 13.9], nominal: 0, render: ambience(1) },
  { name: 'ambient creak', group: 'ambience', seconds: 4, win: [0, 1], nominal: 1, render: (bus, _r, t) => createAmbience(bus).creak(t, 0, false) },
  { name: 'ambient settle', group: 'ambience', seconds: 4, win: [0, 0.5], nominal: 0.5, render: (bus, _r, t) => createAmbience(bus).creak(t, 0, true) },
  { name: 'trigger lamp', group: 'scare', seconds: 2, win: [0, 1.2], nominal: 1.12, events: [trig('lamp')], render: viaRouter([trig('lamp')]) },
  { name: 'trigger rockingChair', group: 'scare', seconds: 7.5, win: [0, 5.6], nominal: 5.6, events: [trig('rockingChair')], render: viaRouter([trig('rockingChair')]) },
  { name: 'trigger portrait', group: 'scare', seconds: 4, win: [0, 1.3], nominal: 1.3, events: [trig('portrait')], render: viaRouter([trig('portrait')]) },
  { name: 'trigger mirror', group: 'scare', seconds: 4, win: [0, 1.0], nominal: 1.0, events: [trig('mirror')], render: viaRouter([trig('mirror')]) },
  { name: 'flee (braam + scream)', group: 'scare', seconds: 4.5, win: [0.15, 1.65], nominal: 1.65, events: [startle(2, true), { type: 'flee', npc: 2 }], render: viaRouter([startle(2, true), { type: 'flee', npc: 2 }]) },
  { name: 'braam alone', group: 'scare', seconds: 4, win: [0, 1.5], nominal: 1.5, render: (bus, _r, t) => void braam(bus, t, 0) },
  { name: 'trigger musicBox', group: 'lure', seconds: 6.5, win: [0, 4.12], nominal: 4.25, events: [trig('musicBox')], render: viaRouter([trig('musicBox')]) },
  { name: 'trigger door', group: 'lure', seconds: 7.5, win: [0, 0.6], nominal: 5.1, events: [trig('door')], render: viaRouter([trig('door')]) },
  { name: 'reset lamp', group: 'other', seconds: 3, win: [0, 1.2], nominal: 0.65, events: [reset('lamp')], render: viaRouter([reset('lamp')]) },
  { name: 'reset portrait', group: 'other', seconds: 4, win: [0, 1.1], nominal: 1.05, events: [reset('portrait')], render: viaRouter([reset('portrait')]) },
  { name: 'scream timid', group: 'voice', seconds: 1.6, win: [0.07, 0.97], nominal: 0.9, events: [startle(1, true)], render: viaRouter([startle(1, true)]) },
  { name: 'scream average', group: 'voice', seconds: 1.6, win: [0.07, 0.87], nominal: 0.8, events: [startle(2, true)], render: viaRouter([startle(2, true)]) },
  { name: 'scream brave', group: 'voice', seconds: 1.6, win: [0.07, 0.72], nominal: 0.65, events: [startle(3, true)], render: viaRouter([startle(3, true)]) },
  { name: 'gasp (heard a scream)', group: 'voice', seconds: 1, win: [0.03, 0.24], nominal: 0.21, events: [startle(2, false, null, 5)], render: viaRouter([startle(2, false, null, 5)]) },
  { name: 'gasp (startled, no scream)', group: 'voice', seconds: 1, win: [0.03, 0.27], nominal: 0.24, events: [startle(3, false, 'lamp-living', 10)], render: viaRouter([startle(3, false, 'lamp-living', 10)]) },
  { name: 'exit', group: 'other', seconds: 3.5, win: [0, 0.4], nominal: 0.4, events: [{ type: 'exit', npc: 9, name: 'Leo', total: 1 }], render: viaRouter([{ type: 'exit', npc: 9, name: 'Leo', total: 1 }]) },
  { name: 'spawn', group: 'other', seconds: 4, win: [0, 1.6], nominal: 1.6, events: [{ type: 'spawn', npc: 1 }], render: viaRouter([{ type: 'spawn', npc: 1 }]) },
  {
    name: 'stress: mirror + 3 screams + flee + door + dread max',
    group: 'stress',
    seconds: 5,
    win: [0, 2],
    nominal: 2,
    render: (bus, router, t) => {
      ambience(1)(bus, router, t);
      router.play([trig('mirror'), trig('door'), trig('lamp'), startle(1, true), startle(2, true), startle(3, true), { type: 'flee', npc: 1 }], state, t);
    },
  },
];

// ── 离线测量 ─────────────────────────────────────────────────────────────
interface Row {
  name: string;
  group: Group;
  nominal: number;
  dur: number;
  peak: number;
  rms: number;
  rmsMax: number;
  /** 峰值出现的时刻（秒，相对起点） */
  peakAt: number;
  /** 重击时刻：10 毫秒包络的局部最大值，不低于峰值 15 dB、比前 80 毫秒的最小值高 6 dB 以上（相隔至少 60 毫秒）。环境层不算 */
  hits: number[];
  ok: boolean;
  notes: string;
}
const dB = (x: number) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -Infinity);

function measure(buf: AudioBuffer, c: Case): Row {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const n = L.length;
  let peak = 0;
  let peakI = 0;
  let last = 0;
  const floor = 10 ** (-60 / 20);
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) {
      peak = a;
      peakI = i;
    }
    if (a > floor) last = i;
  }
  // 重击检测（10 毫秒包络）
  const B = Math.floor(0.01 * SR);
  const env: number[] = [];
  for (let s = 0; s + B <= n; s += B) {
    let a = 0;
    for (let i = s; i < s + B; i++) a += (L[i] * L[i] + R[i] * R[i]) / 2;
    env.push(10 * Math.log10(a / B + 1e-12));
  }
  const top = Math.max(...env);
  const hits: number[] = [];
  for (let k = 8; c.group !== 'ambience' && k < env.length - 3; k++) {
    const at = k * 0.01 + 0.005 - T0;
    const localMax = env.slice(k - 3, k + 4).every((v) => v <= env[k]);
    const rise = env[k] - Math.min(...env.slice(k - 8, k));
    if (localMax && env[k] > top - 15 && rise > 6 && (!hits.length || at - hits[hits.length - 1] > 0.06)) hits.push(Math.round(at * 100) / 100);
  }
  const i0 = Math.floor((T0 + c.win[0]) * SR);
  const i1 = Math.min(n, Math.floor((T0 + c.win[1]) * SR));
  let ss = 0;
  for (let i = i0; i < i1; i++) ss += (L[i] * L[i] + R[i] * R[i]) / 2;
  const rms = Math.sqrt(ss / Math.max(1, i1 - i0));
  // 400 毫秒滑动窗，步长 50 毫秒
  const W = Math.floor(0.4 * SR);
  const hop = Math.floor(0.05 * SR);
  let rmsMax = 0;
  for (let s = 0; s + W <= n; s += hop) {
    let a = 0;
    for (let i = s; i < s + W; i++) a += (L[i] * L[i] + R[i] * R[i]) / 2;
    rmsMax = Math.max(rmsMax, Math.sqrt(a / W));
  }
  const row: Row = {
    name: c.name, group: c.group, nominal: c.nominal,
    dur: Math.round((last / SR - T0) * 100) / 100,
    peak: dB(peak), rms: dB(rms), rmsMax: dB(rmsMax), peakAt: Math.round((peakI / SR - T0) * 100) / 100, hits, ok: true, notes: '',
  };
  const fail = (why: string) => {
    row.ok = false;
    row.notes += (row.notes ? '; ' : '') + why;
  };
  if (c.group !== 'calib' && row.peak > -1) fail('peak > -1 dBFS');
  if (c.group === 'ambience' && row.rms > -30) fail('ambience rms > -30');
  if (c.group === 'scare' && (row.rms < -20 || row.rms > -10)) fail('scare rms outside -20..-10');
  if (c.nominal > 0 && c.group !== 'stress' && c.group !== 'calib' && row.dur < c.nominal - 0.02) fail(`shorter than ${c.nominal}s`);
  return row;
}

/** 带种子的随机数：同一份代码每次测出来一样 */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function renderCase(c: Case, seed = 12345): Promise<Row> {
  const prev = rng.next;
  rng.next = seeded(seed);
  try {
    const ac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(c.seconds * SR), sampleRate: SR });
    const bus = createBus(ac);
    c.render(bus, createRouter(bus, pan), T0);
    return measure(await ac.startRendering(), c);
  } finally {
    rng.next = prev;
  }
}

const w = window as unknown as {
  renderAll(seed?: number): Promise<Row[]>;
  renderOne(name: string, seed?: number): Promise<Row | null>;
  __audioReport?: Row[];
  __audio?: unknown;
};

function show(rows: Row[]) {
  const el = document.getElementById('report')!;
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-inf');
  el.innerHTML =
    '<table><tr><th>sound</th><th>group</th><th>nominal s</th><th>dur s</th><th>peak dBFS</th><th>rms dBFS</th><th>rmsMax400</th><th></th></tr>' +
    rows
      .map((r) => `<tr><td>${r.name}</td><td>${r.group}</td><td>${r.nominal || ''}</td><td>${r.dur}</td><td>${f(r.peak)}</td><td>${f(r.rms)}</td><td>${f(r.rmsMax)}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'ok' : r.notes}</td></tr>`)
      .join('') +
    '</table>';
}

w.renderAll = async (seed?: number) => {
  const rows: Row[] = [];
  for (const c of CASES) rows.push(await renderCase(c, seed));
  w.__audioReport = rows;
  console.log('audio report\n' + rows.map((r) => `${r.name.padEnd(52)} dur ${String(r.dur).padStart(5)}  peak ${r.peak} @${r.peakAt}  rms ${r.rms}  rmsMax ${r.rmsMax}  ${r.ok ? 'ok' : r.notes}${r.hits.length ? '\n    hits ' + r.hits.join(' ') : ''}`).join('\n'));
  show(rows);
  return rows;
};
w.renderOne = async (name, seed) => {
  const c = CASES.find((x) => x.name === name);
  return c ? renderCase(c, seed) : null;
};

// ── 实时按钮 ──────────────────────────────────────────────────────────────
const sys = createAudio(pan);
const fire = async (name: string) => {
  await sys.unlock();
  const c = CASES.find((x) => x.name === name);
  if (!c?.events) return;
  // flee 的那个人要已经在逃跑；其他人复位
  for (const v of state.npcs) v.mode = 'wander';
  for (const e of c.events) {
    if (e.type === 'flee') state.npcs.find((v) => v.id === e.npc)!.mode = 'fleeing';
    sys.onEvent?.(e, state);
  }
};
/** 第一次 unlock（建 AudioContext、总线、混响冲激响应、环境层）在点击里同步花多久；第二次（已在运行）花多久 */
const bench = () => {
  const s = createAudio(pan);
  const a = performance.now();
  void s.unlock();
  const b = performance.now();
  void s.unlock();
  const c = performance.now();
  s.dispose?.();
  return { firstMs: Math.round((b - a) * 10) / 10, againMs: Math.round((c - b) * 100) / 100 };
};
w.__audio = { sys, state, fire, bench };

const box = document.getElementById('buttons')!;
for (const g of ['scare', 'lure', 'voice', 'other'] as Group[]) {
  const sec = document.createElement('div');
  sec.innerHTML = `<h2>${g}</h2>`;
  for (const c of CASES.filter((x) => x.group === g && x.events)) {
    const b = document.createElement('button');
    b.textContent = c.name;
    b.onclick = () => void fire(c.name);
    sec.appendChild(b);
  }
  box.appendChild(sec);
}
const amb = document.createElement('button');
amb.textContent = 'start ambience';
amb.onclick = () => void sys.unlock();
box.prepend(amb);

const fear = document.getElementById('fear') as HTMLInputElement;
const fearv = document.getElementById('fearv')!;
fear.oninput = () => {
  fearv.textContent = fear.value;
  for (const v of state.npcs) v.fear = Number(fear.value);
};
(document.getElementById('mute') as HTMLInputElement).onchange = (e) => sys.setMuted((e.target as HTMLInputElement).checked);
document.getElementById('render')!.onclick = () => void w.renderAll();

// 主循环：和 main.ts 一样每帧调 update（没解锁时什么都不做）
const status = document.getElementById('status')!;
let last = performance.now();
let time = 0;
const loop = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  sys.update?.({ dt, time, state });
  status.textContent = `front door pan ${pan(FRONT_DOOR.outside).toFixed(2)}`;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
