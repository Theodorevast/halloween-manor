// 一夜（2026-10-30，用户定：整套一夜、中段「墙上多一个影子」；夜长先定 8 分钟，用户随后又要「5 分钟内能玩完的完整游戏」，
// 所以收夜在 3 分 20 秒、天亮在 4 分 30 秒：天亮时还没被吓走的人自己出门，5 分钟以内翻到登记簿）。一局有个开头、中段和收尾，但不加目标、不计分、没有失败：
// - 开头：前门真的推开，第一个人独自进来，过一会儿才有第二个敲门（openingGaps）
// - 中段：偶尔某个访客的手电扫过一面墙，墙上多一个不是你的影子（OTHER_SHADOW）
// - 收尾：length 秒（模拟时间）以后播报 "No one else is coming tonight."，门廊灯慢慢熄，不再有人敲门（World.close）；
//   最后几位被吓走（或者到 dawn 天亮自己出门：exit 带 calm）、前门关上以后：静一会儿 → 光从屋里收回前门（开场显影反着放）→ 翻开访客登记簿。
//   Keep haunting：门廊灯亮回来、光重新铺开、照常有人来（World.reopen）；Another night：重新载入
// 钟点：模拟时间 0 是 clock.start（晚 9 点），dawn 是 clock.end（早 6 点），中间线性换算（登记簿上写 "came in at 9:12 pm"），
// 过了天亮照样往后走（Keep haunting 以后）

export const NIGHT = {
  /** 多久以后收夜（秒，模拟时间：?debug 的 step、setTimeScale 能快进）：不再有人来、门廊灯慢慢熄 */
  length: 200,
  /**
   * 多久以后天亮（秒）：屋里还没被吓走的人自己出门（World.dawn，exit 带 calm，登记簿写「天亮前自己走了」），
   * 收夜不用等玩家把最后几位都吓走，5 分钟左右就能翻到登记簿。播报一行 STRINGS.ticker.dawn
   */
  dawn: 270,
  /** 开局几个访客之间隔多久进门（秒，第一个在 SPAWN.first）：第一个人独自进来 */
  openingGaps: [20, 20],
  /** 收夜时门廊灯在多少秒里慢慢熄到多暗（0..1，不全灭也行）；Keep haunting 时同样的时间亮回来 */
  porchFade: { seconds: 15, level: 0 },
  /** 最后一个人走了、前门关上以后：先静多久，再用多久把光收回前门，再翻开登记簿（秒） */
  closing: { silence: 2, reveal: 3.5 },
  /** 钟点换算：模拟时间 0 → start 点，dawn → end 点（24 小时制，跨午夜） */
  clock: { start: 21, end: 6 },
};

/**
 * 墙上多一个影子（The Other One）：一晚最多 max 次，after 秒以后（或者吓跑 afterScared 个以后，哪个先到）才可能出现。
 * 只在没有手电照着的时候出现在某面墙上，被某个访客的手电照到约 litFor 秒以后、下一次没被照着时消失；有访客走近 near 米就提前撤。
 * 一次出现最长 maxShown 秒（真实时间，从第一次被照到算起）：到了就在接下来约 1.2 秒（otherShadow.ts 的 OTHER_LOOK.fade）里
 * 慢慢化掉，不管有没有被照着——访客一直照着它时原来会一直在（实测一次 16 秒，访客盯着却没反应，显得怪），墙上的影子在光里化掉才是对的样子。
 * 访客没反应，播报不提
 */
export const OTHER_SHADOW = {
  max: 2,
  after: 100,
  afterScared: 3,
  litFor: 1,
  near: 1.2,
  maxShown: 5,
};
