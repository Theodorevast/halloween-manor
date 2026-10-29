// 一夜（2026-10-30，用户定：整套一夜、8 分钟、中段「墙上多一个影子」）。一局有个开头、中段和收尾，但不加目标、不计分、没有失败：
// - 开头：前门真的推开，第一个人独自进来，过一会儿才有第二个敲门（openingGaps）
// - 中段：偶尔某个访客的手电扫过一面墙，墙上多一个不是你的影子（OTHER_SHADOW）
// - 收尾：length 秒（模拟时间）以后播报 "No one else is coming tonight."，门廊灯慢慢熄，不再有人敲门（World.close）；
//   最后几位被吓走（不吓也行，没有时限）、前门关上以后：静一会儿 → 光从屋里收回前门（开场显影反着放）→ 翻开访客登记簿。
//   Keep haunting：门廊灯亮回来、光重新铺开、照常有人来（World.reopen）；Another night：重新载入
// 钟点：一夜按 clock 的晚 9 点到凌晨 3 点换算（登记簿上写 "came in at 9:12 pm"）

export const NIGHT = {
  /** 一夜多长（秒，模拟时间：?debug 的 step、setTimeScale 能快进）。用户 2026-10-30 定 8 分钟 */
  length: 8 * 60,
  /** 开局几个访客之间隔多久进门（秒，第一个在 SPAWN.first）：第一个人独自进来 */
  openingGaps: [25, 25],
  /** 收夜时门廊灯在多少秒里慢慢熄到多暗（0..1，不全灭也行）；Keep haunting 时同样的时间亮回来 */
  porchFade: { seconds: 15, level: 0 },
  /** 最后一个人走了、前门关上以后：先静多久，再用多久把光收回前门，再翻开登记簿（秒） */
  closing: { silence: 2, reveal: 3.5 },
  /** 钟点换算：一夜从几点到几点（24 小时制，跨午夜） */
  clock: { start: 21, end: 3 },
};

/**
 * 墙上多一个影子（The Other One）：一晚最多 max 次，after 秒以后（或者吓跑 afterScared 个以后，哪个先到）才可能出现。
 * 只在没有手电照着的时候出现在某面墙上，被某个访客的手电照到约 litFor 秒以后、下一次没被照着时消失；有访客走近 near 米就提前撤。
 * 访客没反应，播报不提
 */
export const OTHER_SHADOW = {
  max: 2,
  after: 4 * 60,
  afterScared: 6,
  litFor: 1,
  near: 1.2,
};
