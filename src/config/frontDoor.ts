// 前门的时刻（2026-10-30「一夜」，内容分析候选 3「看得见的前门」）：画面（view/frontDoor.ts）和声音（audio/sfx.ts 的 spawnDoor、
// exitDoor）都读这里，不各抄一份——像衣柜的时间轴放在 config/scares.ts 那样。tests/front-door.test.ts 钉着：声音每一声的起点
// 和画面的开合曲线都是照这份排的，改了这里两边一起走。
//
// 进门（秒，从 spawn 事件算起）
// - knocks：两下敲门。门板这时还关着
// - creak：门轴吱呀从 creak[0] 响到 creak[1]；门就在这一段里往屋里推开，吱呀响多久门动多久，先快后慢。
//   访客从门外走到门口（南墙外沿）约 1.2 秒（按进门速度 1.2 米/秒、起步加速度 2.6 米/秒² 算，测试用模拟实测），
//   所以先快的那一段要把门推开到 clearDeg 以上：按 outCubic，0.88 秒就到 70°，比访客早 0.3 秒多
// 离开（秒，从 exit 事件算起）
// - exit.contact：exit 事件（访客跑出前门、到了门外）那一刻起门甩上，contact 秒后撞上门框；远处那声关门的闷响（exitDoor）
//   就落在撞上那一刻，不在事件那一刻，所以画面上门合上和听见关门是同一刻
// - exit.latch：撞上之后多久，有一声很小的锁舌「嗒」
export interface FrontDoorTimeline {
  knocks: readonly number[];
  creak: readonly [number, number];
  /** 推开到多少度（绕西侧合页往屋里开，让出 x ≈ 8.0 那条进门的路） */
  openDeg: number;
  /** 访客走到门口之前，门至少要开到这个角度（度） */
  clearDeg: number;
  exit: { contact: number; latch: number };
}

export const FRONT_DOOR_TIMELINE: FrontDoorTimeline = {
  knocks: [0, 0.24],
  creak: [0.55, 1.55],
  openDeg: 100,
  clearDeg: 70,
  exit: { contact: 0.16, latch: 0.14 },
};
