// 第三人称拾取的「按住手势」（src/engine/picking.ts 的 createHoldGesture）：点一下附身、按住设机关、中途移开作废。
// 只测状态机：时间（毫秒）由测试传进去，不碰 DOM、不碰镜头
import { describe, expect, it } from 'vitest';
import { TRAP } from '../src/config/visitors';
import { createHoldGesture } from '../src/engine/picking';

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
