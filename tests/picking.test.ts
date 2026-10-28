// 第三人称拾取的「按住手势」（src/engine/picking.ts 的 createHoldGesture、createHoldInput）：点一下附身、按住设机关、中途移开作废；
// 输入层再管叠加按键（按住左键再按右键）、丢指针锁定、pointercancel / 失焦。
// 只测纯逻辑：时间（毫秒）、准星对着谁、事件的 buttons 都由测试传进去，不碰 DOM、不碰镜头
import { describe, expect, it } from 'vitest';
import { TRAP } from '../src/config/visitors';
import { createHoldGesture, createHoldInput } from '../src/engine/picking';

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
