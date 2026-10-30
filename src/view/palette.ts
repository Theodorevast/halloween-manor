// 全项目共用的颜色（设计文档 3. 画面）。房子、物件、角色、后处理都从这里取，保证一套调色板
export const PALETTE = {
  /** 背景（屋外的夜） */
  night: 0x050608,
  /** 月光：窗外的方向光 + 很弱的半球光 */
  moon: 0x3b4a6b,
  moonSky: 0x8090b0,
  moonGround: 0x201810,
  /** 手电：外圈 / 亮芯 */
  torchHalo: 0xffd9a8,
  torchCore: 0xfff1dc,
  /** 台灯 */
  lamp: 0xffb35c,
  /** 可附身物件的幽光 */
  possess: 0x7dffa8,
  /**
   * 吓跑瞬间的暗角脉冲：近黑的冷色，混进四角只是把画面边缘往暗里收一点（2026-10-30 第二波 VX：原来是暗红 0x5a0a0a，
   * 整屏泛红像动作游戏的「你受伤了」，newbie S2、eye S-2）
   */
  dread: 0x080b11,
  /** 室内材质：深色木头、旧墙纸、地砖 */
  woodDark: 0x2a1c14,
  wood: 0x4a3222,
  wallpaper: 0x3a3338,
  wallTrim: 0x221a1c,
  tile: 0x5a5e60,
  fabric: 0x4a2430,
  brass: 0x8a6a3a,
} as const;
