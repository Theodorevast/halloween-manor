// 鬼魂的模型（2026-10-28，设计文档 3.2「以后换模型」）。url 为 null 时用程序化的兜帽人形（view/ghost.ts 的 buildGhostGeometry）；
// 换成用户的新鬼魂模型时只改这里：
// - url：GLB（放在 public/ 下面，写成 `${import.meta.env.BASE_URL}assets/...`）。模型 y 向上、正面朝 +z；
//   大小、位置不用管，加载时按包围盒缩放、摆到和现在的人形一样高（头顶、下摆的高度见 view/ghost.ts 的 GHOST_BODY）
// - animated：带骨骼动画。false 时所有网格合成一个静态的形状（有骨骼的按绑定姿势）
// - clip：animated 时，现身停留那 1.5 秒播的片段名（照样每秒 10 帧）；平时停在这个片段的第一帧
// - headPitch：现身停留时头从哪抬到哪（弧度，正 = 低头，相对模型自己的姿势；不写用 view/ghost.ts 的 GHOST.solid.headPitch）。
//   模型本来就低着头时，要抬到负的才看得出在抬头看人
// 显形、变实、降帧、借光出入、墙上的影子都做在材质和时间上，换了模型照样有。
// 顶点上可以带一个遮蔽属性 _OCCL（0..1，view/ghost.ts 的 GHOST.occlusion），兜帽里、褶子深处跟着暗下去；没有就全当 1。
// 身体的三角形也按它排画的顺序（里面先画、外面后画，view/ghost.ts 的 sortTrianglesInsideOut）：不带 _OCCL 的模型排不了，前后叠着的面可能画反。
//
// 2026-10-29（路 G 第二段）：用户挑的第 4 张概念图 → Tripo 图生模型（不带贴图）→ scripts/blender/ghost_cleanup.py 清理
// （兜帽里的脸推成深洞、去掉地面、≤ 8000 三角面、烘了 _OCCL）→ public/assets/ghost/ghost.glb。重做：scripts/tripo/ghost.mjs。
// 这个模型本来就低着头（头比身子往前探约 12°），默认的 8° → 0° 只是抬回它自己的姿势、看不出抬头：改成 8° → −12°
// （对比截图：dev/ghost.html?manifest&notorch&solid=0.35&cam=6.5,1.75,10&look=8,1.62,10，&headpitch=8,0 是原来的幅度）。
// ?procghost：不加载模型，用原来程序化的人形（对比用）
//
// - eyes（2026-10-30 路 GH，view/ghost.ts 的 GHOST.eyes）：兜帽洞里两点很淡的冷光，只有从正面看得到。写鬼魂的局部坐标（米，
//   模型按包围盒摆好以后：y = 0 在 ghost.y，头顶 0.42、下摆 −1.0，正面 +z），换模型要重量；不写就不画眼睛。
//   这个模型的洞是歪的（左右深浅差约 9 毫米），两点分开写：各自在洞底表面往前约 3 毫米（GLB 坐标 y ≈ 0.834、x ≈ ±0.010 那一圈：
//   遮蔽 0、正前方 ±20° 打出去碰不到兜帽、往后和往外侧都被头挡住；tests/ghost-look.test.ts 拿 GLB 的三角形查）。
//   洞里能放眼睛的地方很窄（离中线 2 厘米以内，再往外从正前方看会被帽檐挡住），所以两眼只隔 3 厘米
const procGhost = typeof location !== 'undefined' && new URLSearchParams(location.search).has('procghost');
const deg = (d: number) => (d * Math.PI) / 180;
export const GHOST_MODEL: {
  url: string | null; animated: boolean; clip: string | null; headPitch?: [number, number];
  eyes?: [number, number, number][];
} = {
  url: procGhost ? null : `${import.meta.env.BASE_URL}assets/ghost/ghost.glb`,
  animated: false,
  clip: null,
  headPitch: [deg(8), deg(-12)],
  eyes: [[0.015, 0.246, 0.0455], [-0.015, 0.246, 0.0545]],
};
