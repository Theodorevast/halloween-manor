// 第三人称拾取的「按住手势」（src/engine/picking.ts 的 createHoldGesture、createHoldInput）：点一下附身、按住设机关、中途移开作废；
// 输入层再管叠加按键（按住左键再按右键）、丢指针锁定、pointercancel / 失焦。
// 前面几组只测纯逻辑：时间（毫秒）、准星对着谁、事件的 buttons 都由测试传进去，不碰 DOM、不碰镜头；
// 最后一组是 DOM 接线：一个 EventTarget 做的假画布派发 pointerdown / pointermove / pointerup / pointercancel / contextmenu，
// 真的 createPicker 接上真的 three 射线（node 里没有 DOM，也不为这个加 DOM 库），时间和 requestAnimationFrame 由测试控制
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W } from '../src/config/house';
import { TRAP } from '../src/config/visitors';
import { setGhostUi } from '../src/engine/ghostRig';
import { createHoldGesture, createHoldInput, createPicker } from '../src/engine/picking';
import type { CameraRig, GhostRig } from '../src/engine/types';

const HOLD = TRAP.holdToArm * 1000;
const g = () => createHoldGesture(HOLD);

describe('按住手势：点一下', () => {
  it('不到 holdToArm 秒就松手：在松手那一刻附身，不用等满', () => {
    const h = g();
    h.down('bed', 1000);
    expect(h.tick('bed', 1100)).toBeNull();
    expect(h.up('bed', 1150)).toEqual({ type: 'pick', id: 'bed' });
  });

  it('按下的同一帧松手也算点一下', () => {
    const h = g();
    h.down('mirror', 500);
    expect(h.up('mirror', 500)).toEqual({ type: 'pick', id: 'mirror' });
  });

  it('差 1 毫秒按满：还是点一下；正好按满：设机关', () => {
    const a = g();
    a.down('lamp-living', 0);
    expect(a.up('lamp-living', HOLD - 1)).toEqual({ type: 'pick', id: 'lamp-living' });
    const b = g();
    b.down('lamp-living', 0);
    expect(b.up('lamp-living', HOLD)).toEqual({ type: 'arm', id: 'lamp-living' });
  });

  it('松手后手势结束：再松一次什么也没有', () => {
    const h = g();
    h.down('portrait', 0);
    expect(h.up('portrait', 100)).not.toBeNull();
    expect(h.up('portrait', 120)).toBeNull();
    expect(h.holding).toBe(false);
  });
});

describe('按住手势：按住设机关', () => {
  it('按满的那一帧发 arm（不等松手），只发一次，松手不再附身', () => {
    const h = g();
    h.down('bed', 0);
    expect(h.tick('bed', HOLD - 16)).toBeNull();
    expect(h.tick('bed', HOLD + 1)).toEqual({ type: 'arm', id: 'bed' });
    expect(h.tick('bed', HOLD + 17)).toBeNull();
    expect(h.tick('bed', HOLD * 4)).toBeNull();
    expect(h.up('bed', HOLD * 4 + 5)).toBeNull();
  });

  it('两帧之间按满又松手（tick 没来得及发）：松手时补发 arm，不会变成附身', () => {
    const h = g();
    h.down('rocking-chair', 0);
    expect(h.tick('rocking-chair', 400)).toBeNull();
    expect(h.up('rocking-chair', HOLD + 30)).toEqual({ type: 'arm', id: 'rocking-chair' });
  });

  it('按住很久：只设下一次', () => {
    const h = g();
    h.down('door', 0);
    const acts = [200, 520, 700, 1500, 3000].map((t) => h.tick('door', t)).filter(Boolean);
    expect(acts).toEqual([{ type: 'arm', id: 'door' }]);
  });
});

describe('按住手势：中途作废', () => {
  it('按住期间准星移到另一个物件上：作废，按满了也不设，松手也不附身', () => {
    const h = g();
    h.down('bed', 0);
    expect(h.tick('music-box', 200)).toBeNull();
    expect(h.holding).toBe(false);
    expect(h.tick('bed', HOLD + 100)).toBeNull(); // 又移回来也不算：已经作废
    expect(h.up('bed', HOLD + 120)).toBeNull();
  });

  it('准星移开（没对着任何物件）：作废', () => {
    const h = g();
    h.down('bed', 0);
    expect(h.tick(null, 100)).toBeNull();
    expect(h.tick('bed', HOLD + 100)).toBeNull();
    expect(h.up('bed', HOLD + 120)).toBeNull();
  });

  it('两帧之间移开又松手（tick 没看到）：松手时对着的不是原来那个，不附身也不设机关', () => {
    const h = g();
    h.down('bed', 0);
    expect(h.up('music-box', 100)).toBeNull();
    const k = g();
    k.down('bed', 0);
    expect(k.up(null, HOLD + 100)).toBeNull();
  });

  it('没对着物件就按下：什么都不发', () => {
    const h = g();
    h.down(null, 0);
    expect(h.holding).toBe(false);
    expect(h.tick(null, HOLD + 100)).toBeNull();
    expect(h.tick('bed', HOLD + 200)).toBeNull(); // 按下之后才对准的不算
    expect(h.up('bed', HOLD + 300)).toBeNull();
  });

  it('cancel（丢了指针锁定、窗口失焦）：作废', () => {
    const h = g();
    h.down('bed', 0);
    h.cancel();
    expect(h.tick('bed', HOLD + 100)).toBeNull();
    expect(h.up('bed', HOLD + 120)).toBeNull();
  });
});

describe('按住手势：连着来', () => {
  it('点一下之后马上按住另一个：各算各的', () => {
    const h = g();
    h.down('bed', 0);
    expect(h.up('bed', 120)).toEqual({ type: 'pick', id: 'bed' });
    h.down('mirror', 200);
    expect(h.tick('mirror', 200 + HOLD)).toEqual({ type: 'arm', id: 'mirror' });
    expect(h.up('mirror', 200 + HOLD + 50)).toBeNull();
  });

  it('作废之后重新按：从头计时', () => {
    const h = g();
    h.down('bed', 0);
    h.tick(null, 100);
    h.down('bed', 1000);
    expect(h.tick('bed', 1000 + HOLD - 1)).toBeNull();
    expect(h.tick('bed', 1000 + HOLD)).toEqual({ type: 'arm', id: 'bed' });
  });

  it('按住的时长取自 TRAP.holdToArm', () => {
    expect(HOLD).toBe(TRAP.holdToArm * 1000);
    expect(HOLD).toBeGreaterThan(0);
  });
});

// ── 输入层：叠加按键、丢锁定、pointercancel / 失焦 ──────────────────────────────
// 事件序列取自真 Chrome（指针锁定下实测，.logs/p-chord-probe.mjs）：叠加按键时，pointerdown 只在第一个键按下时发，
// pointerup 只在最后一个键松开时发，中途按下 / 松开某个键发的是 pointermove（button 是变的那个键，buttons 是之后的状态）：
//   左按 → 右按 → 左松 → 右松：down(0, 1) · move(2, 3) · move(0, 2) · up(2, 0)
//   左按 → 右按 → 右松 → 左松：down(0, 1) · move(2, 3) · move(2, 1) · up(0, 0)
//   右按 → 左按 → 左松 → 右松：down(2, 2) · move(0, 3) · move(0, 2) · up(2, 0)
// buttons 的位：1 = 左键，2 = 右键。输入层 down 只收 button，buttons 只收 buttons，松手由左键位判断，不看 button

/** 一套假输入：时间、准星、按下去之后触发的回调都由测试控制 */
function rig(aim: string | null = 'bed') {
  let now = 0;
  let aimed = aim;
  const picks: string[] = [];
  const arms: string[] = [];
  const input = createHoldInput({ holdMs: HOLD, aimed: () => aimed, now: () => now, onPick: (id) => picks.push(id), onArm: (id) => arms.push(id) });
  input.setLocked(true);
  return {
    input, picks, arms,
    at(ms: number) { now = ms; },
    aim(id: string | null) { aimed = id; },
    /** 这一帧：准星对着谁就把谁传给 frame（拾取器每帧自己算好传进来） */
    frame(ms: number) { now = ms; input.frame(aimed); },
  };
}

describe('输入层：叠加按键（按住左键再按右键）', () => {
  it('左按 → 右按 → 左松 → 右松：只附身一次，不设机关（以前会在 0.5 秒后误设机关、丢掉点一下）', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.frame(60);
    r.at(100); r.input.buttons(3); // 按下右键：pointermove，左键还按着
    expect(r.picks).toEqual([]);
    r.frame(150);
    r.at(200); r.input.buttons(2); // 松开左键：pointermove，buttons 只剩右键
    expect(r.picks).toEqual(['bed']);
    r.frame(250);
    r.at(300); r.input.buttons(0); // 松开右键：pointerup
    // 手势早就结束了：再过很久也不会设机关
    r.frame(600);
    r.frame(1200);
    expect(r.picks).toEqual(['bed']);
    expect(r.arms).toEqual([]);
    expect(r.input.holding).toBe(false);
  });

  it('左键按住满 0.5 秒（帧里已经设下）→ 再按右键 → 松左键：恰好设一次机关，不附身', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.frame(300);
    r.frame(HOLD + 20); // 按满：这一帧设下
    expect(r.arms).toEqual(['bed']);
    r.at(700); r.input.buttons(3); // 按下右键
    r.at(800); r.input.buttons(2); // 松开左键
    r.at(900); r.input.buttons(0); // 松开右键
    r.frame(1500);
    expect(r.arms).toEqual(['bed']);
    expect(r.picks).toEqual([]);
  });

  it('左键按住满 0.5 秒但帧还没来得及设下 → 再按右键 → 松左键：松开那一刻补设，仍是恰好一次，不附身', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.frame(300);
    r.at(HOLD + 100); r.input.buttons(3); // 按满之后、下一帧之前按下右键
    r.at(HOLD + 200); r.input.buttons(2); // 松开左键
    expect(r.arms).toEqual(['bed']);
    r.at(HOLD + 300); r.input.buttons(0);
    r.frame(2000);
    expect(r.arms).toEqual(['bed']);
    expect(r.picks).toEqual([]);
  });

  it('左按 → 右按 → 右松 → 左松（右键先松）：右键的按下、松开不影响左键的手势，最后松左键才结束', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.buttons(3); // 按下右键
    r.at(150); r.input.buttons(1); // 松开右键，左键还按着
    expect(r.input.holding).toBe(true);
    expect(r.picks).toEqual([]);
    r.at(200); r.input.buttons(0); // 松开左键：pointerup
    expect(r.picks).toEqual(['bed']);
    expect(r.arms).toEqual([]);
  });

  it('左键按住时右键按下、松开，再接着按到 0.5 秒：照样设机关（右键没有打断它）', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.buttons(3);
    r.at(200); r.input.buttons(1);
    r.frame(HOLD + 10);
    expect(r.arms).toEqual(['bed']);
    r.at(HOLD + 100); r.input.buttons(0);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual(['bed']);
  });

  it('按住左键时鼠标一直在动（pointermove，buttons = 1）：手势不会被打断，照样按满设机关', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    for (let t = 16; t < HOLD; t += 16) { r.at(t); r.input.buttons(1); r.frame(t); }
    expect(r.input.holding).toBe(true);
    expect(r.arms).toEqual([]);
    r.frame(HOLD + 5);
    expect(r.arms).toEqual(['bed']);
  });

  it('没按着左键时的 pointermove（buttons = 0 或只有右键）什么也不做', () => {
    const r = rig();
    for (let t = 0; t < 400; t += 16) { r.at(t); r.input.buttons(0); r.input.buttons(2); r.frame(t); }
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
    expect(r.input.holding).toBe(false);
  });

  it('叠加按键的同时准星移到了别的物件上：松开左键时作废，不附身也不设机关', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.buttons(3);
    r.aim('music-box');
    r.at(200); r.input.buttons(2);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });
});

describe('输入层：右键不开始、不打断手势', () => {
  it('右键按下（button 2）不开始手势：按多久都不设机关、不附身', () => {
    const r = rig();
    r.at(0); r.input.down(2);
    expect(r.input.holding).toBe(false);
    r.frame(HOLD + 100);
    r.at(HOLD + 200); r.input.buttons(0);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });

  it('中键、侧键按下也不开始', () => {
    for (const b of [1, 3, 4]) {
      const r = rig();
      r.input.down(b);
      expect(r.input.holding).toBe(false);
    }
  });

  it('先按右键、再按左键（左键那一下没有 pointerdown，只有 pointermove）：不附身也不设机关', () => {
    const r = rig();
    r.at(0); r.input.down(2); // pointerdown(button 2)
    r.at(100); r.input.buttons(3); // 按下左键：pointermove
    r.frame(HOLD + 50);
    r.at(HOLD + 100); r.input.buttons(2); // 松开左键
    r.at(HOLD + 200); r.input.buttons(0); // 松开右键
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });

  it('已经在按左键时又收到右键的 pointerdown（有的浏览器会发）：不重开、不打断，左键的计时照旧', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(300); r.input.down(2);
    expect(r.input.holding).toBe(true);
    r.frame(HOLD + 5); // 从 0 起算的 0.5 秒：不是从右键按下算起
    expect(r.arms).toEqual(['bed']);
  });
});

describe('输入层：丢指针锁定、pointercancel、失焦', () => {
  // 下面几条故意不动准星、中间不放帧：准星移开本来就会作废，这里要测的是「丢了锁定」自己就作废
  it('按住时丢了指针锁定（Esc、切走窗口）：手势马上作废，之后松手既不附身也不设机关', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.setLocked(false);
    expect(r.input.holding).toBe(false);
    r.at(200); r.input.buttons(0); // 松手事件（有时还收得到），准星还对着床
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });

  it('丢了锁定又很快重新锁上（中间没有帧）：还没松的左键再松开，也什么都不发', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.setLocked(false);
    r.at(150); r.input.setLocked(true);
    r.at(200); r.input.buttons(0);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });

  it('丢了锁定又重新锁上之后，过了 0.5 秒的帧也不会设机关（按下发生在丢锁定之前）', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.setLocked(false);
    r.at(150); r.input.setLocked(true);
    r.frame(HOLD + 100);
    r.frame(HOLD * 3);
    expect(r.arms).toEqual([]);
    expect(r.picks).toEqual([]);
  });

  it('叠加按键时丢了指针锁定：松开左键也什么都不发', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.buttons(3);
    r.at(150); r.input.setLocked(false);
    r.at(200); r.input.buttons(2);
    r.at(300); r.input.buttons(0);
    r.frame(HOLD + 400);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });

  it('没锁定时按下不开始手势（那一下是「点一下继续」）', () => {
    const r = rig();
    r.input.setLocked(false);
    r.at(0); r.input.down(0);
    expect(r.input.holding).toBe(false);
    r.frame(HOLD + 50);
    r.at(HOLD + 100); r.input.buttons(0);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });

  it('pointercancel / 窗口失焦（cancel）：作废，之后松手、按满都不发', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.cancel();
    r.frame(HOLD + 100);
    r.at(HOLD + 200); r.input.buttons(0);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
    expect(r.input.holding).toBe(false);
  });

  it('作废之后重新按：从头计时，照常点一下 / 设机关', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.at(100); r.input.cancel();
    r.at(1000); r.input.down(0);
    r.at(1100); r.input.buttons(0);
    expect(r.picks).toEqual(['bed']);
    r.at(2000); r.input.down(0);
    r.frame(2000 + HOLD);
    expect(r.arms).toEqual(['bed']);
  });
});

describe('输入层：普通的点一下和按住', () => {
  it('点一下：松手那一刻附身，一次', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.frame(60);
    r.at(120); r.input.buttons(0);
    r.frame(700);
    expect(r.picks).toEqual(['bed']);
    expect(r.arms).toEqual([]);
  });

  it('按住满 0.5 秒：按满的那一帧设机关（不等松手），松手不再附身', () => {
    const r = rig();
    r.at(0); r.input.down(0);
    r.frame(HOLD - 16);
    expect(r.arms).toEqual([]);
    r.frame(HOLD + 1);
    expect(r.arms).toEqual(['bed']);
    r.at(HOLD * 3); r.input.buttons(0);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual(['bed']);
  });

  it('没对着物件就按下：什么都不发', () => {
    const r = rig(null);
    r.at(0); r.input.down(0);
    expect(r.input.holding).toBe(false);
    r.frame(HOLD + 50);
    r.at(HOLD + 100); r.input.buttons(0);
    expect(r.picks).toEqual([]);
    expect(r.arms).toEqual([]);
  });
});

// ── DOM 接线：假画布派发指针事件，真的 createPicker ────────────────────────────────────────
// 上面的 createHoldInput 只测了判定；剩下的是几行 addEventListener：事件的哪个字段交给谁、什么时候摘监听、每帧的循环。
// 这里用一个 EventTarget 做的假画布把它们跑一遍（时间用 clock、帧用 queued，都由测试控制）

/** 假画布（也当 window 用）：EventTarget + 够用的一点点画布接口；记着还挂着多少监听，dispose 之后应该是 0 */
class FakeTarget extends EventTarget {
  style: Record<string, string> = {};
  private readonly live = new Map<string, Set<unknown>>();
  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    if (cb) (this.live.get(type) ?? this.live.set(type, new Set()).get(type)!).add(cb);
    super.addEventListener(type, cb, opts);
  }
  override removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
    if (cb) this.live.get(type)?.delete(cb);
    super.removeEventListener(type, cb, opts);
  }
  get listeners() {
    let n = 0;
    for (const set of this.live.values()) n += set.size;
    return n;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

/** 一个指针事件里拾取器会读的字段 */
interface Ptr {
  button?: number;
  buttons?: number;
  pointerType?: string;
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  /** 不给就是「此刻」（真的事件创建时的时间戳） */
  timeStamp?: number;
}

describe('DOM 接线：假画布派发指针事件，真的 createPicker', () => {
  let clock = 0;
  let queued: (() => void)[] = [];
  let win: FakeTarget;
  const live: { dispose(): void }[] = [];

  /** 跑一帧：把此刻排着的回调都跑一遍（回调里新排的留给下一帧）。回调抛了异常会从这里抛出来 */
  const runFrame = () => {
    const q = queued;
    queued = [];
    for (const cb of q) cb();
  };
  /** Node 的 Event 没有这些字段，timeStamp 还是只读的访问器：用 defineProperty 盖在实例上 */
  const ptr = (type: string, init: Ptr = {}) => {
    const e = new Event(type, { cancelable: true });
    const v = { button: 0, buttons: 0, pointerType: 'mouse', pointerId: 1, clientX: 400, clientY: 300, timeStamp: clock, ...init };
    for (const [k, value] of Object.entries(v)) Object.defineProperty(e, k, { value });
    return e;
  };

  beforeEach(() => {
    clock = 1000;
    queued = [];
    win = new FakeTarget();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => queued.push(cb));
    vi.stubGlobal('addEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.addEventListener(t, cb));
    vi.stubGlobal('removeEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.removeEventListener(t, cb));
  });
  afterEach(() => {
    for (const p of live.splice(0)) p.dispose();
    setGhostUi({ locked: false, aim: null });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 镜头在 (0, 1.5, 0) 朝 -z 看，床（一个 1 米的方块）在正前方 3 米：画面正中（400, 300）正对着它 */
  function scene() {
    const canvas = new FakeTarget();
    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    bed.userData.propId = 'bed';
    bed.position.set(0, 1.5, -3);
    bed.updateMatrixWorld(true);
    /** 镜头转向 (x, y, z)，位置不变 */
    const look = (x: number, y: number, z: number) => {
      camera.position.set(0, 1.5, 0);
      camera.lookAt(x, y, z);
      camera.updateMatrixWorld(true);
    };
    look(0, 1.5, -3);
    const fire = (type: string, init?: Ptr) => canvas.dispatchEvent(ptr(type, init));
    return { canvas, camera, bed, look, fire };
  }

  describe('第三人称（准星）拾取器', () => {
    /**
     * 鬼魂站在床的位置上：距离 0，一定够得着，也没有墙隔着（视线检查两端各留 0.2 米不查），不用管房子的布局；
     * 指针锁定上了（真的由 ghostRig 通过 setGhostUi 发布）
     */
    function ghostEnv() {
      const s = scene();
      const rig = { camera: s.camera, ghost: { x: HOUSE_W / 2, y: 0, z: HOUSE_D / 2 - 3, heading: 0, speed: 0, inWall: false } } as unknown as GhostRig;
      const picker = createPicker(s.canvas as unknown as HTMLCanvasElement, rig, () => [s.bed]);
      live.push(picker);
      const picks: string[] = [];
      const arms: string[] = [];
      const hovers: (string | null)[] = [];
      picker.onPick((id) => picks.push(id));
      picker.onArm((id) => arms.push(id));
      picker.onHover((id) => hovers.push(id));
      setGhostUi({ locked: true });
      return {
        ...s, picker, picks, arms, hovers,
        down: (init?: Ptr) => s.fire('pointerdown', { button: 0, buttons: 1, ...init }),
        move: (init?: Ptr) => s.fire('pointermove', init),
        up: (init?: Ptr) => s.fire('pointerup', { button: 0, buttons: 0, ...init }),
        cancel: () => s.fire('pointercancel'),
        contextmenu: () => s.fire('contextmenu', { button: 2, buttons: 2 }),
      };
    }

    it('点一下：按下不附身，松手那一刻附身（一次），不设机关', () => {
      const e = ghostEnv();
      runFrame();
      expect(e.hovers).toEqual(['bed']); // 准星对着床：悬停
      e.down();
      expect(e.picks).toEqual([]);
      clock = 1120;
      e.up();
      expect(e.picks).toEqual(['bed']);
      expect(e.arms).toEqual([]);
      clock = 1700;
      runFrame();
      expect(e.picks).toEqual(['bed']);
      expect(e.arms).toEqual([]);
    });

    it('按住满 0.5 秒：按满的那一帧设机关（不等松手），松手不再附身', () => {
      const e = ghostEnv();
      e.down();
      clock = 1000 + TRAP.holdToArm * 1000 - 16;
      runFrame();
      expect(e.arms).toEqual([]);
      clock = 1000 + TRAP.holdToArm * 1000;
      runFrame();
      expect(e.arms).toEqual(['bed']);
      clock = 1900;
      e.up();
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual(['bed']);
    });

    it('按住期间准星移开：手势作废，按满了也不设，松手也不附身；悬停跟着准星走', () => {
      const e = ghostEnv();
      e.down();
      clock = 1200;
      e.look(20, 1.5, -3); // 转开了
      runFrame();
      clock = 1800;
      e.look(0, 1.5, -3); // 又转回来：已经作废
      runFrame();
      e.up();
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual([]);
      expect(e.hovers).toEqual(['bed', null, 'bed']);
    });

    it('右键：按下、contextmenu、松开，不附身也不设机关，按多久都一样', () => {
      const e = ghostEnv();
      e.canvas.dispatchEvent(ptr('pointerdown', { button: 2, buttons: 2 }));
      e.contextmenu();
      clock = 1800;
      runFrame();
      e.canvas.dispatchEvent(ptr('pointerup', { button: 2, buttons: 0 }));
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual([]);
    });

    it('叠加按键：按住左键再按右键（pointermove，buttons 3）、右键弹 contextmenu、先松左键（pointermove，buttons 2）：松左键那一刻附身，之后松右键（pointerup，button 2）不再发', () => {
      const e = ghostEnv();
      e.down();
      clock = 1100;
      e.move({ button: 2, buttons: 3 });
      e.contextmenu();
      expect(e.picks).toEqual([]);
      clock = 1200;
      e.move({ button: 0, buttons: 2 });
      expect(e.picks).toEqual(['bed']);
      clock = 1300;
      e.canvas.dispatchEvent(ptr('pointerup', { button: 2, buttons: 0 }));
      clock = 2000;
      runFrame();
      expect(e.picks).toEqual(['bed']);
      expect(e.arms).toEqual([]);
    });

    it('按住左键时鼠标一直在动（pointermove，buttons 1）：手势不被打断，照样按满设机关', () => {
      const e = ghostEnv();
      e.down();
      for (let t = 1016; t < 1500; t += 16) {
        clock = t;
        e.move({ buttons: 1 });
        runFrame();
      }
      expect(e.arms).toEqual([]);
      clock = 1500;
      runFrame();
      expect(e.arms).toEqual(['bed']);
    });

    it('没锁定指针时按下：不开始手势（那一下是「点一下继续」），也没有悬停', () => {
      const e = ghostEnv();
      setGhostUi({ locked: false });
      runFrame();
      e.down();
      clock = 1120;
      e.up();
      clock = 1800;
      runFrame();
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual([]);
      expect(e.hovers).toEqual([]);
    });

    it('按住时丢了指针锁定：作废，之后松手既不附身也不设机关', () => {
      const e = ghostEnv();
      e.down();
      clock = 1100;
      setGhostUi({ locked: false });
      clock = 1200;
      e.up();
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual([]);
    });

    it('pointercancel：作废，按满也不设', () => {
      const e = ghostEnv();
      e.down();
      clock = 1100;
      e.cancel();
      clock = 1800;
      runFrame();
      e.up();
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual([]);
    });

    it('窗口失焦（window 的 blur）：作废，按满也不设', () => {
      const e = ghostEnv();
      e.down();
      clock = 1100;
      win.dispatchEvent(new Event('blur'));
      clock = 1800;
      runFrame();
      e.up();
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual([]);
    });

    // P-2：每帧的循环要先排下一帧、再发回调。订阅者（悬停、附身、设机关的回调）抛了异常，循环不能就此停掉
    it('悬停的订阅者抛了异常：下一帧已经排好，循环不会就此停掉，之后按满照样设机关（以前这里排不上下一帧，悬停和按住设机关从此全没了）', () => {
      const e = ghostEnv();
      let boom = true;
      e.picker.onHover((id) => {
        if (boom && id === 'bed') throw new Error('hover boom');
      });
      expect(() => runFrame()).toThrow('hover boom'); // 第一帧：准星对着床，悬停回调抛了
      expect(queued).toHaveLength(1); // 下一帧已经排好
      boom = false;
      e.down();
      clock = 1000 + TRAP.holdToArm * 1000;
      runFrame();
      expect(e.arms).toEqual(['bed']);
    });

    it('设机关的订阅者抛了异常：下一帧也已经排好，之后悬停照样跟着准星走', () => {
      const e = ghostEnv();
      e.picker.onArm(() => {
        throw new Error('arm boom');
      });
      runFrame();
      e.down();
      clock = 1000 + TRAP.holdToArm * 1000;
      expect(() => runFrame()).toThrow('arm boom');
      expect(queued).toHaveLength(1);
      e.look(20, 1.5, -3); // 转开
      runFrame();
      expect(e.hovers).toEqual(['bed', null]);
    });

    it('dispose：画布上的监听和 window 上的 blur 都摘掉，排着的那一帧跑完不再续排，之后的事件不再有反应', () => {
      const e = ghostEnv();
      expect(e.canvas.listeners).toBeGreaterThan(0);
      expect(win.listeners).toBeGreaterThan(0);
      e.down();
      e.picker.dispose();
      expect(e.canvas.listeners).toBe(0);
      expect(win.listeners).toBe(0);
      runFrame();
      expect(queued).toEqual([]);
      clock = 1100;
      e.up();
      expect(e.picks).toEqual([]);
      expect(e.arms).toEqual([]);
    });
  });

  describe('俯视（娃娃屋）拾取器', () => {
    /** rig 里没有 ghost，所以走的是俯视那一套 */
    function topEnv() {
      const s = scene();
      const picker = createPicker(s.canvas as unknown as HTMLCanvasElement, { camera: s.camera } as unknown as CameraRig, () => [s.bed]);
      live.push(picker);
      const picks: string[] = [];
      const hovers: (string | null)[] = [];
      picker.onPick((id) => picks.push(id));
      picker.onHover((id) => hovers.push(id));
      return {
        ...s, picker, picks, hovers,
        down: (init?: Ptr) => s.fire('pointerdown', { buttons: 1, ...init }),
        move: (init?: Ptr) => s.fire('pointermove', init),
        up: (init?: Ptr) => s.fire('pointerup', init),
        cancel: () => s.fire('pointercancel'),
        leave: () => s.fire('pointerleave'),
      };
    }

    it('点一下（同一点、120 毫秒内）：松手那一刻附身，附身的是点下去的那个物件', () => {
      const e = topEnv();
      e.down();
      expect(e.picks).toEqual([]);
      clock = 1120;
      e.up();
      expect(e.picks).toEqual(['bed']);
    });

    it('点在空处：什么也不附身', () => {
      const e = topEnv();
      e.down({ clientX: 40, clientY: 40 });
      clock = 1100;
      e.up({ clientX: 40, clientY: 40 });
      expect(e.picks).toEqual([]);
    });

    it('按住满 400 毫秒再松手不算点击；拖了 6 像素以上也不算；4 像素还算', () => {
      const e = topEnv();
      e.down();
      clock = 1400;
      e.up();
      expect(e.picks).toEqual([]);
      clock = 2000;
      e.down();
      clock = 2100;
      e.up({ clientX: 407 });
      expect(e.picks).toEqual([]);
      clock = 3000;
      e.down();
      clock = 3100;
      e.up({ clientX: 404 });
      expect(e.picks).toEqual(['bed']);
    });

    it('鼠标右键（button 2）不开始点击；别的 pointerId 的松手也不算', () => {
      const e = topEnv();
      e.down({ button: 2, buttons: 2 });
      clock = 1100;
      e.up({ button: 2 });
      expect(e.picks).toEqual([]);
      e.down({ pointerId: 7 });
      clock = 1200;
      e.up({ pointerId: 8 });
      expect(e.picks).toEqual([]);
    });

    it('pointercancel：作废，之后的松手不再算点击', () => {
      const e = topEnv();
      e.down();
      clock = 1100;
      e.cancel();
      e.up();
      expect(e.picks).toEqual([]);
    });

    it('悬停：鼠标移到物件上 → onHover(id)、光标变手；移开 → onHover(null)、光标复原；鼠标离开画布 → 清掉', () => {
      const e = topEnv();
      e.move();
      expect(e.hovers).toEqual(['bed']);
      expect(e.canvas.style.cursor).toBe('pointer');
      e.move({ clientX: 40, clientY: 40 });
      expect(e.hovers).toEqual(['bed', null]);
      expect(e.canvas.style.cursor).toBe('');
      e.move();
      e.leave();
      expect(e.hovers).toEqual(['bed', null, 'bed', null]);
    });

    it('鼠标不动、镜头动了：每帧比一下镜头，光标下的物件变了悬停就跟着变；镜头没动不重新检测', () => {
      const e = topEnv();
      e.move();
      expect(e.hovers).toEqual(['bed']);
      e.look(20, 1.5, -3); // 镜头转开，鼠标没动
      runFrame();
      expect(e.hovers).toEqual(['bed', null]);
      runFrame();
      expect(e.hovers).toEqual(['bed', null]);
      e.look(0, 1.5, -3);
      runFrame();
      expect(e.hovers).toEqual(['bed', null, 'bed']);
    });

    // P-2：看镜头的循环也一样，先排下一帧再发回调；以前回调一抛，循环停了，watching 还卡成 true，之后 pointermove 再也起不了这个循环
    it('悬停的订阅者抛了异常：看镜头的循环不会停，镜头再动悬停照样跟着变（以前 watching 卡成 true，再也起不来）', () => {
      const e = topEnv();
      let boom = false;
      e.picker.onHover((id) => {
        if (boom && id === null) throw new Error('hover boom');
      });
      e.move(); // 悬停到床上，开始每帧看镜头
      expect(e.hovers).toEqual(['bed']);
      boom = true;
      e.look(20, 1.5, -3); // 镜头转开，光标下没有物件了：回调抛
      expect(() => runFrame()).toThrow('hover boom');
      expect(queued).toHaveLength(1);
      boom = false;
      e.look(0, 1.5, -3);
      runFrame();
      expect(e.hovers).toEqual(['bed', null, 'bed']);
    });

    it('dispose：所有监听都摘掉，光标和 touch-action 复原，排着的那一帧跑完不再续排，之后的事件不再有反应', () => {
      const e = topEnv();
      e.move();
      expect(e.canvas.style.touchAction).toBe('none');
      expect(e.canvas.listeners).toBeGreaterThan(0);
      e.picker.dispose();
      expect(e.canvas.listeners).toBe(0);
      expect(e.canvas.style.cursor).toBe('');
      expect(e.canvas.style.touchAction).toBeUndefined();
      runFrame();
      expect(queued).toEqual([]);
      e.down();
      clock = 1100;
      e.up();
      expect(e.picks).toEqual([]);
    });
  });
});
