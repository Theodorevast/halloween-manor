// 访客登记簿的记录（src/ui/register.ts，2026-10-30「一夜」）：每个访客一行小故事——几点进来、怎么走的
// （逃跑之前最后一个让他恐惧值上涨的事件）；钟点换算；页脚挑哪几句；重名、还在屋里；人太多时 andOthers；
// 天亮自己走的（exit 带 calm）不算吓跑；穿哪套（联名两套的名字只在并进访客轮换时查得到）。
// 前半用手写的事件一步一步摆；最后一组用真的模拟（World）跑几个场景，核对事件的先后和这里的归因对得上
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PROPS, propCenter } from '../src/config/house';
import { NIGHT } from '../src/config/night';
import { STRINGS } from '../src/config/strings';
import { GHOST } from '../src/config/visitors';
import { angleOf } from '../src/lib/angle';
import { idleManifest } from '../src/sim/manifest';
import { GHOST_SOURCE } from '../src/sim/types';
import type { Personality, SimEvent, Vec2, World, WorldState } from '../src/sim/types';
import { createWorld } from '../src/sim/world';
import { REGISTER, clockAt, createRegister, inWords, outfitName } from '../src/ui/register';

const R = STRINGS.register;
const F = R.footer;
/** 晚 9 点以后第 m 分钟（钟点）对应的模拟时间：0 秒是晚 9 点，NIGHT.dawn 秒是早 6 点（九个钟头 = 540 分钟） */
const min = (m: number) => (NIGHT.dawn * m) / 540;

/** 手写的一夜：state 照模拟的样子摆（名字、性格从 state.npcs 里取，物件按 PROPS），事件按顺序喂给登记簿 */
function night(outfits: Record<number, string> = {}) {
  const state: WorldState = {
    time: 0,
    npcs: [],
    objects: PROPS.map((p) => ({ id: p.id, type: p.type, pos: propCenter(p), facing: p.facing, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 })),
    scaredOff: 0,
    hitStop: 0,
    manifest: idleManifest(),
    avoid: [],
  };
  const reg = createRegister((id) => outfits[id]);
  let nextId = 1;
  const emit = (t: number, ...evs: SimEvent[]) => {
    state.time = t;
    for (const e of evs) reg.onEvent(e, state);
  };
  const n = {
    reg,
    state,
    emit,
    /** 进门（spawn），返回编号 */
    come(t: number, name: string, personality: Personality = 'average') {
      const id = nextId++;
      state.npcs.push({ id, name, personality, pos: { x: 8, z: 13 }, heading: 0, lookDir: 0, mode: 'entering', modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [] });
      emit(t, { type: 'spawn', npc: id });
      return id;
    },
    /** 被物件吓到、当场逃跑（startle 涨满 → flee，同一步） */
    scare(t: number, id: number, object: string) {
      emit(t, { type: 'startle', npc: id, object, amount: 40, scream: true }, { type: 'flee', npc: id });
    },
    /** 走出前门：照模拟的样子，先从 state.npcs 里拿掉再发 exit（同一步里移除，事件分发时人已经不在了） */
    out(t: number, id: number, calm = false) {
      const v = state.npcs.find((x) => x.id === id)!;
      state.npcs.splice(state.npcs.indexOf(v), 1);
      if (!calm) state.scaredOff += 1;
      emit(t, { type: 'exit', npc: id, name: v.name, total: state.scaredOff, ...(calm ? { calm: true } : {}) });
    },
    page: (max = 99) => reg.page(state.time, max),
    line: (id: number) => reg.page(state.time, 99).lines.find((l) => l.id === id)!,
    story: (id: number) => n.line(id).story,
  };
  return n;
}

describe('钟点：0 秒是 NIGHT.clock.start（晚 9 点），NIGHT.dawn 秒是 NIGHT.clock.end（早 6 点），中间线性', () => {
  test('开局、午夜、天亮；分钟往下取整', () => {
    expect(clockAt(0)).toBe('9:00 pm');
    expect(clockAt(NIGHT.dawn)).toBe('6:00 am');
    expect(clockAt(min(12))).toBe('9:12 pm');
    expect(clockAt(min(12.9))).toBe('9:12 pm');
    expect(clockAt(min(180))).toBe('12:00 am');
    expect(clockAt(min(185))).toBe('12:05 am');
    expect(clockAt(min(240))).toBe('1:00 am');
  });

  test('过了天亮照样往后走（Keep haunting 以后）：7 点、中午 12 点是 pm、过了一整天又回到晚上', () => {
    expect(clockAt(min(600))).toBe('7:00 am');
    expect(clockAt(min(900))).toBe('12:00 pm');
    expect(clockAt(min(1440 + 75))).toBe('10:15 pm');
  });

  test('meridiem = false 时不带 am / pm', () => {
    expect(clockAt(min(18), false)).toBe('9:18');
    expect(clockAt(min(200), false)).toBe('12:20');
  });
});

describe('数字写成英文单词', () => {
  test('one 到 twenty 写单词，句首大写；再多写阿拉伯数字', () => {
    expect(inWords(1)).toBe('one');
    expect(inWords(11, true)).toBe('Eleven');
    expect(inWords(20)).toBe('twenty');
    expect(inWords(21, true)).toBe('21');
    expect(inWords(134)).toBe('134');
  });

  test('英文单词、am / pm 放在 STRINGS.register（numbers、meridiem），register.ts 读它、不自己抄一份', () => {
    expect(R.numbers).toHaveLength(21);
    expect(R.numbers.slice(0, 4)).toEqual(['', 'one', 'two', 'three']);
    expect(R.numbers[20]).toBe('twenty');
    expect(R.meridiem).toEqual({ am: 'am', pm: 'pm' });
    // 改了 strings.ts 里的，登记簿跟着走（证明没有另抄一份）
    const numbers = R.numbers as string[];
    const saved = { three: numbers[3], am: R.meridiem.am, pm: R.meridiem.pm };
    try {
      numbers[3] = 'thrice';
      R.meridiem.am = 'a.m.';
      R.meridiem.pm = 'p.m.';
      expect(inWords(3, true)).toBe('Thrice');
      expect(clockAt(0)).toBe('9:00 p.m.');
      expect(clockAt(NIGHT.dawn)).toBe('6:00 a.m.');
    } finally {
      numbers[3] = saved.three;
      R.meridiem.am = saved.am;
      R.meridiem.pm = saved.pm;
    }
    expect(inWords(3)).toBe('three');
  });
});

describe('怎么走的：逃跑之前最后一个让他恐惧值上涨的事件', () => {
  test('物件的 startle → ranFrom（物件名小写），钟点是逃跑那一刻；和进门同在 pm 时第二个钟点不再写 pm', () => {
    const n = night();
    const mia = n.come(min(12), 'Mia', 'timid');
    n.scare(min(18), mia, 'wardrobe');
    expect(n.story(mia)).toBe('came in at 9:12 pm; ran from the wardrobe at 9:18');
    // 跨过午夜：am / pm 不一样了就写上
    const theo = n.come(min(170), 'Theo');
    n.scare(min(185), theo, 'lamp-bedroom');
    expect(n.story(theo)).toBe(`${R.cameIn('11:50 pm')}; ${R.ranFrom(STRINGS.propName.lamp, '12:05 am')}`);
  });

  test('机关发作的（trap sprung → trigger → 之后的 startle）→ trap；玩家后来自己附身同一件 → 照常 ranFrom', () => {
    const n = night();
    const a = n.come(min(10), 'Ada');
    const b = n.come(min(20), 'Hugo');
    n.emit(min(30), { type: 'trap', object: 'portrait', phase: 'sprung' }, { type: 'trigger', object: 'portrait', scareType: 'portrait' });
    // 惊吓类要蓄势一会儿才落下：startle 在后面几步
    n.scare(min(32), a, 'portrait');
    expect(n.story(a)).toBe(`${R.cameIn(clockAt(min(10)))}; ${R.trap(STRINGS.propName.portrait, clockAt(min(32), false))}`);
    expect(n.story(a)).toBe('came in at 9:10 pm; the portrait was waiting for them at 9:32');
    // 冷却过后玩家自己附身（前面没有 trap sprung）
    n.emit(min(80), { type: 'trigger', object: 'portrait', scareType: 'portrait' });
    n.scare(min(82), b, 'portrait');
    expect(n.story(b)).toBe(`${R.cameIn(clockAt(min(20)))}; ${R.ranFrom(STRINGS.propName.portrait, clockAt(min(82), false))}`);
  });

  test('同一步里玩家附身一件、另一件的机关发作：各算各的', () => {
    const n = night();
    const a = n.come(min(10), 'Ada');
    const b = n.come(min(12), 'Leo');
    n.emit(
      min(30),
      { type: 'trigger', object: 'mirror', scareType: 'mirror' },
      { type: 'trap', object: 'bed', phase: 'sprung' },
      { type: 'trigger', object: 'bed', scareType: 'bed' },
    );
    n.scare(min(31), a, 'mirror');
    n.scare(min(36), b, 'bed');
    expect(n.story(a)).toContain(R.ranFrom(STRINGS.propName.mirror, clockAt(min(31), false)));
    expect(n.story(b)).toContain(R.trap(STRINGS.propName.bed, clockAt(min(36), false)));
  });

  test('引诱类（heard，听见了也涨恐惧值）也算物件：ran from the music box；机关设的厨房门 → trap', () => {
    const n = night();
    const a = n.come(min(10), 'Nora', 'timid');
    n.emit(min(40), { type: 'trigger', object: 'music-box', scareType: 'musicBox' }, { type: 'heard', npc: a, object: 'music-box' }, { type: 'flee', npc: a });
    expect(n.story(a)).toContain(R.ranFrom(STRINGS.propName.musicBox, clockAt(min(40), false)));
    const b = n.come(min(50), 'Otis', 'timid');
    n.emit(
      min(60),
      { type: 'trap', object: 'kitchen-door', phase: 'sprung' },
      { type: 'trigger', object: 'kitchen-door', scareType: 'door' },
      { type: 'heard', npc: b, object: 'kitchen-door' },
      { type: 'flee', npc: b },
    );
    expect(n.story(b)).toContain(R.trap(STRINGS.propName.door, clockAt(min(60), false)));
  });

  test('现身（manifest drop 的 scared）→ sawYou；同一步 object = GHOST_SOURCE 的 startle 不改它', () => {
    const n = night();
    const a = n.come(min(10), 'Iris');
    n.emit(
      min(44),
      { type: 'manifest', phase: 'drop', pos: { x: 8, z: 9.5 }, scared: [a] },
      { type: 'startle', npc: a, object: GHOST_SOURCE, amount: 30, scream: true },
      { type: 'flee', npc: a },
    );
    expect(n.story(a)).toBe(`${R.cameIn('9:10 pm')}; ${R.sawYou('9:44')}`);
  });

  test('后颈一凉（chill neck + 同一步 GHOST_SOURCE 的 startle）→ coldBreath；慢慢发毛（chill）涨满 → 也是 coldBreath', () => {
    const n = night();
    const a = n.come(min(10), 'Ezra');
    n.emit(min(50), { type: 'chill', npc: a, amount: 18, neck: true }, { type: 'startle', npc: a, object: GHOST_SOURCE, amount: 18, scream: false }, { type: 'flee', npc: a });
    expect(n.story(a)).toBe(`${R.cameIn('9:10 pm')}; ${R.coldBreath('9:50')}`);
    const b = n.come(min(60), 'Lena');
    n.emit(min(70), { type: 'chill', npc: b, amount: 3, neck: false }, { type: 'flee', npc: b });
    expect(n.story(b)).toContain(R.coldBreath(clockAt(min(70), false)));
  });

  test('被别人的尖叫吓到（startle 的 object 为 null）→ scream', () => {
    const n = night();
    const a = n.come(min(10), 'Sam');
    n.emit(min(64), { type: 'startle', npc: a, object: null, amount: 12, scream: false }, { type: 'flee', npc: a });
    expect(n.story(a)).toBe(`${R.cameIn('9:10 pm')}; ${R.scream('10:04')}`);
    // 整句读一遍（集成时改的措辞：原来 "ran when someone screamed, at 10:04" 的逗号读着断）
    expect(n.story(a)).toBe('came in at 9:10 pm; ran at 10:04 when someone screamed');
  });

  test('只看最后一个：先被衣柜吓到、后来听见尖叫才跑 → scream；同一步里先现身、再后颈一凉 → coldBreath', () => {
    const n = night();
    const a = n.come(min(10), 'June');
    n.emit(min(20), { type: 'startle', npc: a, object: 'wardrobe', amount: 30, scream: true });
    n.emit(min(30), { type: 'startle', npc: a, object: null, amount: 12, scream: false }, { type: 'flee', npc: a });
    expect(n.story(a)).toContain(R.scream(clockAt(min(30), false)));
    const b = n.come(min(40), 'Felix');
    n.emit(
      min(50),
      { type: 'manifest', phase: 'drop', pos: { x: 8, z: 9.5 }, scared: [b] },
      { type: 'startle', npc: b, object: GHOST_SOURCE, amount: 30, scream: true },
      { type: 'chill', npc: b, amount: 18, neck: true },
      { type: 'startle', npc: b, object: GHOST_SOURCE, amount: 18, scream: false },
      { type: 'flee', npc: b },
    );
    expect(n.story(b)).toContain(R.coldBreath(clockAt(min(50), false)));
  });

  test('逃跑那一刻就定下来：之后的事件（别人的尖叫之类）不改，exit 也不改钟点', () => {
    const n = night();
    const a = n.come(min(10), 'Maya');
    n.scare(min(20), a, 'mirror');
    n.emit(min(21), { type: 'startle', npc: a, object: null, amount: 12, scream: false });
    n.out(min(26), a);
    expect(n.story(a)).toBe(`${R.cameIn('9:10 pm')}; ${R.ranFrom(STRINGS.propName.mirror, '9:20')}`);
  });
});

describe('天亮自己走的（exit 带 calm）', () => {
  test('写 leftAtDawn（出门那一刻），不写 ranFrom 之类；不算吓跑：cameRan 的 ran 不数他，neverRan 数他', () => {
    const n = night();
    const ada = n.come(min(4), 'Ada', 'brave');
    const leo = n.come(min(300), 'Leo');
    const mia = n.come(min(20), 'Mia', 'timid');
    n.scare(min(60), mia, 'bed');
    n.out(min(63), mia);
    n.out(NIGHT.dawn + min(4), ada, true);
    n.out(NIGHT.dawn + min(10), leo, true);
    // 不评价恐惧（原来写 "unafraid"：被吓过一下、只是没跑的人也这么写，不准），只写天色
    expect(n.story(ada)).toBe('came in at 9:04 pm; walked out at 6:04 am, as the sky paled');
    expect(n.story(leo)).toBe(`${R.cameIn('2:00 am')}; ${R.leftAtDawn('6:10')}`);
    const p = n.page();
    expect(p.footer[0]).toBe(F.cameRan('Three', 'One'));
    expect(p.footer).toContain(F.neverRan('Two'));
  });

  test('天亮往外走的路上被吓到（leaving → fleeing，exit 不带 calm）：照常算吓跑、写吓到他的东西', () => {
    const n = night();
    const a = n.come(min(100), 'Otis');
    n.scare(NIGHT.dawn + min(3), a, 'lamp-living');
    n.out(NIGHT.dawn + min(6), a);
    expect(n.story(a)).toContain(R.ranFrom(STRINGS.propName.lamp, clockAt(NIGHT.dawn + min(3), false)));
    expect(n.page().footer[0]).toBe(F.cameRan('One', 'One'));
    expect(n.page().footer).not.toContain(F.neverRan('One'));
  });
});

describe('重名、还在屋里', () => {
  test('两个 Mia：各一行、各写各的（按访客编号记，不按名字：exit 也按编号对）', () => {
    const n = night();
    const first = n.come(min(10), 'Mia', 'timid');
    n.scare(min(30), first, 'wardrobe');
    n.out(min(33), first);
    const second = n.come(min(40), 'Mia', 'brave');
    n.emit(min(80), { type: 'chill', npc: second, amount: 20, neck: true }, { type: 'startle', npc: second, object: GHOST_SOURCE, amount: 20, scream: false }, { type: 'flee', npc: second });
    const lines = n.page().lines;
    expect(lines.map((l) => [l.name, l.tag])).toEqual([
      ['Mia', STRINGS.personalityTag.timid],
      ['Mia', STRINGS.personalityTag.brave],
    ]);
    expect(lines[0].story).toContain(R.ranFrom(STRINGS.propName.wardrobe, clockAt(min(30), false)));
    expect(lines[1].story).toContain(R.coldBreath(clockAt(min(80), false)));
  });

  test('还在屋里的写 stillInside；逃跑了还没出门的照样写怎么走的', () => {
    const n = night();
    const a = n.come(min(10), 'Nora');
    const b = n.come(min(20), 'Hugo');
    n.scare(min(40), b, 'rocking-chair');
    expect(n.story(a)).toBe(`${R.cameIn('9:10 pm')}; ${R.stillInside}`);
    expect(n.story(b)).toBe(`${R.cameIn('9:20 pm')}; ${R.ranFrom(STRINGS.propName.rockingChair, '9:40')}`);
  });

  test('一行按进门的先后排；没见过 spawn 的人（登记簿建得晚）：照样记下，不写几点进来', () => {
    const n = night();
    // 模拟里已经有这个人，登记簿没收到他的 spawn
    n.state.npcs.push({ id: 40, name: 'Priya', personality: 'average', pos: { x: 8, z: 9 }, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [] });
    const a = n.come(min(30), 'Ollie');
    n.emit(min(50), { type: 'startle', npc: 40, object: 'portrait', amount: 40, scream: true }, { type: 'flee', npc: 40 });
    n.out(min(55), 40);
    expect(n.page().lines.map((l) => l.id)).toEqual([a, 40]);
    expect(n.story(40)).toBe(R.ranFrom(STRINGS.propName.portrait, '9:50 pm'));
  });
});

describe('页脚：两三句，挑最有意思的', () => {
  /** n 个人进门（每隔 4 分钟一个），返回编号 */
  const crowd = (n: ReturnType<typeof night>, k: number) => Array.from({ length: k }, (_, i) => n.come(min(4 * i + 2), `V${i + 1}`));

  test('cameRan：came 数所有进来的（含还在屋里的），ran 只数吓跑的；英文单词、句首大写；超过 twenty 写阿拉伯数字', () => {
    const n = night();
    const ids = crowd(n, 14);
    ids.slice(0, 11).forEach((id, i) => n.scare(min(100 + i), id, i % 2 ? 'bed' : 'portrait'));
    expect(n.page().footer[0]).toBe('Fourteen came in. Eleven ran.');
    const m = night();
    const many = crowd(m, 23);
    many.slice(0, 21).forEach((id, i) => m.scare(min(200 + i), id, ['bed', 'portrait', 'mirror'][i % 3]));
    expect(m.page().footer[0]).toBe('23 came in. 21 ran.');
  });

  test('没人吓跑时不写 cameRan', () => {
    const n = night();
    crowd(n, 3);
    expect(n.page().footer.some((s) => s.includes('came in'))).toBe(false);
    expect(n.page().footer).toContain(F.noneSaw);
  });

  test('noneSaw / someSaw：被现身吓到过的人数（不管最后是被什么吓跑的，一个人只数一次）', () => {
    const n = night();
    const [a, b, c] = crowd(n, 3);
    n.emit(min(30), { type: 'manifest', phase: 'drop', pos: { x: 8, z: 9.5 }, scared: [a, b] });
    n.emit(min(60), { type: 'manifest', phase: 'drop', pos: { x: 8, z: 9.5 }, scared: [a] });
    n.scare(min(70), a, 'wardrobe');
    n.scare(min(72), c, 'bed');
    expect(n.page().footer).toContain(F.someSaw('Two'));
    expect(n.page().footer).not.toContain(F.noneSaw);
  });

  test('mostWork：一件物件吓跑的人最多——至少两个、至少占吓跑的一半、比别的物件都多；机关发作的也算那件', () => {
    const n = night();
    const ids = crowd(n, 6);
    n.emit(min(40), { type: 'trap', object: 'wardrobe', phase: 'sprung' }, { type: 'trigger', object: 'wardrobe', scareType: 'wardrobe' });
    n.scare(min(41), ids[0], 'wardrobe');
    n.scare(min(60), ids[1], 'wardrobe');
    n.scare(min(70), ids[2], 'bed');
    n.emit(min(80), { type: 'startle', npc: ids[3], object: null, amount: 12, scream: false }, { type: 'flee', npc: ids[3] });
    expect(n.page().footer).toContain(F.mostWork(STRINGS.propName.wardrobe));
    // 再多一个被床吓跑的：衣柜 2、床 2 并列，不写
    n.scare(min(90), ids[4], 'bed');
    expect(n.page().footer.some((s) => s.includes('did most of the work'))).toBe(false);
  });

  test('mostWork 不到吓跑的一半不写（"most of the work" 要说实话）', () => {
    const n = night();
    const ids = crowd(n, 7);
    n.scare(min(40), ids[0], 'wardrobe');
    n.scare(min(41), ids[1], 'wardrobe');
    n.scare(min(42), ids[2], 'bed');
    n.scare(min(43), ids[3], 'mirror');
    n.scare(min(44), ids[4], 'portrait');
    expect(n.page().footer.some((s) => s.includes('did most of the work'))).toBe(false);
  });

  test('stayedLongest：走了的人里待得最久的，写到他走的那一刻（吓跑的是逃跑那一刻）；最久的还在屋里就不写', () => {
    const n = night();
    const [a, b, c] = crowd(n, 3); // 9:02、9:06、9:10 进门
    n.scare(min(40), a, 'bed');
    n.scare(min(100), b, 'wardrobe');
    // c 还在屋里、算到此刻比 b 待得还久：不写
    n.state.time = min(200);
    expect(n.page().footer).toEqual([F.cameRan('Three', 'Two'), F.noneSaw]);
    n.scare(min(205), c, 'mirror');
    expect(n.page().footer).toEqual([F.cameRan('Three', 'Three'), F.stayedLongest('V3', '12:25 am'), F.noneSaw]);
  });

  test('stayedLongest：天亮自己走的人待到出门那一刻', () => {
    const n = night();
    const [a, b] = crowd(n, 2);
    n.scare(min(40), a, 'bed');
    n.out(NIGHT.dawn + min(5), b, true);
    expect(n.page().footer).toEqual([F.cameRan('Two', 'One'), F.neverRan('One'), F.stayedLongest('V2', '6:05 am')]);
  });

  test('neverRan：有人天亮自己走了（数字照样写成英文单词）', () => {
    const n = night();
    const [a, b] = crowd(n, 2);
    n.out(NIGHT.dawn + min(2), a, true);
    n.out(NIGHT.dawn + min(5), b, true);
    // 没人吓跑：不写 cameRan，三句都留给挑的（V1 进门早、出门也早，待得最久）
    expect(n.page().footer).toEqual([F.neverRan('Two'), F.stayedLongest('V1', '6:02 am'), F.noneSaw]);
  });

  test('挑的顺序：mostWork → someSaw → neverRan → stayedLongest → noneSaw；连 cameRan 最多三句', () => {
    const n = night();
    const ids = crowd(n, 6);
    n.emit(min(30), { type: 'manifest', phase: 'drop', pos: { x: 8, z: 9.5 }, scared: [ids[0]] });
    ids.slice(0, 4).forEach((id, i) => n.scare(min(40 + i), id, i < 3 ? 'wardrobe' : 'bed'));
    n.out(NIGHT.dawn + min(1), ids[4], true);
    n.out(NIGHT.dawn + min(2), ids[5], true);
    const p = n.page();
    expect(p.footer).toEqual([F.cameRan('Six', 'Four'), F.mostWork(STRINGS.propName.wardrobe), F.someSaw('One')]);
    expect(p.postscript).toBe('');
  });

  test('oneMore（墙上多一个影子出现过）：单独放在最后（postscript），这时前面只挑一句', () => {
    const n = night();
    const ids = crowd(n, 4);
    n.emit(min(30), { type: 'manifest', phase: 'drop', pos: { x: 8, z: 9.5 }, scared: [ids[0]] });
    ids.slice(0, 3).forEach((id, i) => n.scare(min(40 + i), id, i < 2 ? 'wardrobe' : 'bed'));
    n.reg.noteOtherOne();
    const p = n.page();
    expect(p.footer).toEqual([F.cameRan('Four', 'Three'), F.mostWork(STRINGS.propName.wardrobe)]);
    expect(p.postscript).toBe(F.oneMore);
  });

  test('没人来过：页脚是空的', () => {
    const n = night();
    expect(n.page()).toMatchObject({ lines: [], others: '', footer: [] });
  });
});

describe('人太多时只写前面一些行，剩下的 andOthers', () => {
  test('十五个人、只写前 REGISTER.maxLines 个（按进门的先后），剩下的一句带过', () => {
    expect(REGISTER.maxLines).toBe(12);
    const n = night();
    const ids = Array.from({ length: 15 }, (_, i) => n.come(min(3 * i + 1), `V${i + 1}`));
    const p = n.reg.page(n.state.time);
    expect(p.lines.map((l) => l.id)).toEqual(ids.slice(0, 12));
    expect(p.others).toBe(R.andOthers('three'));
    expect(p.others).toBe('and three others');
    // 页脚照样数所有人
    ids.forEach((id, i) => n.scare(min(100 + i), id, 'bed'));
    expect(n.reg.page(n.state.time).footer[0]).toBe('Fifteen came in. Fifteen ran.');
  });

  test('只多出一个时整页都写（不写 "and one others"）', () => {
    const n = night();
    const ids = Array.from({ length: 13 }, (_, i) => n.come(min(3 * i + 1), `V${i + 1}`));
    const p = n.reg.page(n.state.time);
    expect(p.lines.map((l) => l.id)).toEqual(ids);
    expect(p.others).toBe('');
  });
});

describe('穿哪套', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('公开的四套、占位狐狸：STRINGS.register.outfit；性格标注 average 不写；outfitOf 给不出就不写这一项', () => {
    const n = night({ 1: 'witch', 2: 'lantern-explorer', 3: 'fox' });
    n.come(min(2), 'Mia', 'timid');
    n.come(min(4), 'Theo', 'average');
    n.come(min(6), 'Iris', 'brave');
    n.come(min(8), 'Hugo', 'brave');
    expect(n.page().lines.map(({ name, tag, outfit }) => [name, tag, outfit])).toEqual([
      ['Mia', 'scaredy-cat', 'the witch'],
      ['Theo', '', 'the explorer'],
      ['Iris', 'skeptic', 'the fox'],
      ['Hugo', 'skeptic', ''],
    ]);
    for (const id of ['vampire', 'lantern-explorer', 'witch', 'skeleton', 'fox']) expect(outfitName(id)).toBe(R.outfit[id]);
    expect(outfitName(undefined)).toBe('');
    expect(outfitName('jotaro')).toBe('Jotaro'); // 2026-10-30 起默认并进联名（node 里没有 location 也一样）
  });

  test('outfitOf 一开始给不出（角色还没建好）、后来给得出：翻开时再问一次', () => {
    const outfits: Record<number, string> = {};
    const n = night(outfits);
    const a = n.come(min(2), 'Mia');
    expect(n.line(a).outfit).toBe('');
    outfits[a] = 'skeleton';
    expect(n.line(a).outfit).toBe('the skeleton');
  });

  test('联名两套：用 COLLAB_SPECS 自己的 label，并进访客轮换时查得到（2026-10-30 起默认并进）', async () => {
    vi.resetModules();
    vi.stubGlobal('location', { search: '' });
    const c = await import('../src/config/character');
    const r = await import('../src/ui/register');
    const labels = c.COLLAB_SPECS.map((s) => s.label);
    expect(labels.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(['jotaro', 'dio'].map((id) => r.outfitName(id))).toEqual(labels);
    // 公开的四套没有 label（名字在 STRINGS.register.outfit 里）
    expect(c.VISITOR_SPECS.filter((s) => !c.COLLAB_SPECS.includes(s)).map((s) => s.label)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('COLLAB=0 构建（__COLLAB__ 为 false）、或者地址带 ?nocollab：查不到联名的名字', async () => {
    vi.resetModules();
    vi.stubGlobal('location', { search: '?nocollab' });
    const r0 = await import('../src/ui/register');
    expect(r0.outfitName('jotaro')).toBe('');
    vi.resetModules();
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('__COLLAB__', false);
    const r = await import('../src/ui/register');
    expect(r.outfitName('jotaro')).toBe('');
    expect(r.outfitName('dio')).toBe('');
  });
});

describe('真的模拟跑一遍：事件的先后和这里的归因对得上', () => {
  const DT = 1 / 60;
  /** 一步一步推进 World，事件全部喂给登记簿（each：每步之前），直到 pred 为真或超时 */
  function drive(w: World, reg: ReturnType<typeof createRegister>, seconds: number, pred: () => boolean, each?: () => void) {
    for (let k = 0; k < Math.round(seconds / DT); k++) {
      each?.();
      for (const e of w.step(DT)) reg.onEvent(e, w.state);
      if (pred()) return true;
    }
    return false;
  }
  const bearingTo = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);
  const prop = (id: string) => propCenter(PROPS.find((p) => p.id === id)!);
  const storyOf = (reg: ReturnType<typeof createRegister>, w: World, id: number) => reg.page(w.state.time, 99).lines.find((l) => l.id === id)!.story;

  test('肖像吓破胆 → ran from the portrait（逃跑那一刻的钟点）', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const reg = createRegister();
    const STUDY = { x: 2.75, z: 3.75 };
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: bearingTo(STUDY, prop('portrait')) });
    n.fear = 80;
    let fledAt = -1;
    drive(w, reg, 0.1, () => false);
    expect(w.trigger('portrait')).toBe(true);
    expect(drive(w, reg, 3, () => n.mode === 'fleeing', () => { n.lookDir = bearingTo(n.pos, prop('portrait')); })).toBe(true);
    fledAt = w.state.time;
    expect(storyOf(reg, w, n.id)).toContain(R.ranFrom(STRINGS.propName.portrait, clockAt(fledAt, false)));
  });

  test('设在肖像上的机关：手电扫到时发作 → the portrait was waiting for them', () => {
    const w = createWorld({ seed: 114, autoSpawn: false });
    const reg = createRegister();
    const STUDY = { x: 2.75, z: 3.75 };
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: bearingTo(STUDY, prop('portrait')) - 0.8 });
    n.fear = 80;
    expect(w.arm('portrait')).toBe(true);
    expect(drive(w, reg, 5, () => n.mode === 'fleeing')).toBe(true);
    expect(storyOf(reg, w, n.id)).toContain(R.trap(STRINGS.propName.portrait, clockAt(w.state.time, false)));
  });

  test('现身落下、当场吓破胆 → saw you in the dark, and ran（同一步的 GHOST_SOURCE startle 不改）', () => {
    const w = createWorld({ seed: 107, autoSpawn: false });
    const reg = createRegister();
    const spot = { x: 10.25, z: 3.25 };
    const start = { x: 8.25, z: 1.25 };
    const a = w.spawn({ pos: start, personality: 'average', lookDir: bearingTo(start, spot) });
    a.fear = 85;
    w.setGhost(spot);
    expect(w.manifest()).toBe(true);
    expect(drive(w, reg, 5, () => a.mode === 'fleeing')).toBe(true);
    expect(storyOf(reg, w, a.id)).toContain(R.sawYou(clockAt(w.state.time, false)));
    expect(reg.page(w.state.time).footer).toContain(F.someSaw('One'));
  });

  test('鬼魂贴着后颈 → felt a cold breath, and ran', () => {
    const w = createWorld({ seed: 33, autoSpawn: false });
    const reg = createRegister();
    const FOYER = { x: 8, z: 9.5 };
    const a = w.spawn({ pos: FOYER, personality: 'average', lookDir: 0 });
    a.fear = 92;
    const behind = () => ({ x: a.pos.x - Math.cos(a.heading) * 0.3, z: a.pos.z - Math.sin(a.heading) * 0.3 });
    expect(drive(w, reg, GHOST.neckDwell + 2, () => a.mode === 'fleeing', () => w.setGhost(behind()))).toBe(true);
    expect(storyOf(reg, w, a.id)).toContain(R.coldBreath(clockAt(w.state.time, false)));
  });
});
