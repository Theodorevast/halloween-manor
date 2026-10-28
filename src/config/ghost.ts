// 鬼魂的模型（2026-10-28，设计文档 3.2「以后换模型」）。url 为 null 时用程序化的兜帽人形（view/ghost.ts 的 buildGhostGeometry）；
// 换成用户的新鬼魂模型时只改这里：
// - url：GLB（放在 public/ 下面，写成 `${import.meta.env.BASE_URL}assets/...`）。模型 y 向上、正面朝 +z；
//   大小、位置不用管，加载时按包围盒缩放、摆到和现在的人形一样高（头顶、下摆的高度见 view/ghost.ts 的 GHOST_BODY）
// - animated：带骨骼动画。false 时所有网格合成一个静态的形状（有骨骼的按绑定姿势）
// - clip：animated 时，现身停留那 1.5 秒播的片段名（照样每秒 10 帧）；平时停在这个片段的第一帧
// 显形、变实、降帧、借光出入、墙上的影子都做在材质和时间上，换了模型照样有
export const GHOST_MODEL: { url: string | null; animated: boolean; clip: string | null } = { url: null, animated: false, clip: null };
