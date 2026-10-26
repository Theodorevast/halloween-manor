// 八音盒：放在床头柜（高 0.55 米，房子任务画）上的小木盒，铜包角，红丝绒内衬，里面一个瓷人偶。
// 被附身：盒子一跳、盖子「啪」地弹开，人偶弹起来，跟着走调的旋律转 4 秒（转速不匀、最后发条松了慢下来），
// 然后人偶沉下去、盖子猛地合上。比真实尺寸放大了一些，不然在俯视镜头里只有几个像素。
import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { C, Parts, bodyMaterial, bump, inQuad, lerp, mesh, outBack, seg, type PropFrame, type PropRig } from './kit';

/** 床头柜面高度（米）：床头柜由房子任务画，这里按约定的 0.55 放 */
export const NIGHTSTAND_H = 0.55;
const W = 0.3, D = 0.2, BASE_H = 0.05, BOX_H = 0.14, WALL = 0.014;
const LID_H = 0.03;
const LID_OPEN = -1.95; // rotation.x：负 = 前沿抬起往后翻

/** 时间线（秒，从 trigger 算起）：旋律 0–4 秒 */
export const MUSIC_BOX_T = {
  lidOpen: 0.16,
  riseFrom: 0.04,
  riseTo: 0.3,
  windDown: 3.3, // 发条松了，开始变慢
  sink: 3.95, // 人偶沉下去
  close: 4.0, // 盖子开始合
  shut: 4.12, // 盖子砸上
  end: 4.25,
};
const T = MUSIC_BOX_T;

export function createMusicBox(): PropRig {
  const model = new THREE.Group();
  model.name = 'music-box';
  const box = new THREE.Group(); // 整个盒子（附身那一下会跳）
  box.position.y = NIGHTSTAND_H;
  model.add(box);
  const body = bodyMaterial(0.6, 0.15);

  // 盒身：实心底座（上表面是丝绒）+ 四面薄壁 + 铜包角
  const bp = new Parts();
  bp.box(W, BASE_H, D, C.woodDark, [0, BASE_H / 2, 0]);
  bp.box(W - WALL * 2, 0.004, D - WALL * 2, C.velvet, [0, BASE_H + 0.002, 0]);
  const wh = BOX_H - BASE_H;
  bp.box(W, wh, WALL, C.wood, [0, BASE_H + wh / 2, D / 2 - WALL / 2]);
  bp.box(W, wh, WALL, C.wood, [0, BASE_H + wh / 2, -D / 2 + WALL / 2]);
  bp.box(WALL, wh, D - WALL * 2, C.wood, [W / 2 - WALL / 2, BASE_H + wh / 2, 0]);
  bp.box(WALL, wh, D - WALL * 2, C.wood, [-W / 2 + WALL / 2, BASE_H + wh / 2, 0]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bp.box(0.022, BOX_H + 0.004, 0.022, C.brass, [sx * (W / 2 - 0.008), BOX_H / 2, sz * (D / 2 - 0.008)]);
  bp.box(0.05, 0.03, 0.008, C.brass, [0, BOX_H - 0.02, D / 2 + 0.003]); // 锁扣
  for (const sx of [-1, 1]) bp.box(0.008, 0.008, 0.008, C.brass, [sx * 0.008, 0.08, D / 2 + 0.004]); // 侧面发条钥匙露出来的一点
  bp.cyl(0.01, 0.01, 0.03, 6, C.brass, [W / 2 + 0.015, 0.07, 0], [0, 0, Math.PI / 2]);
  bp.box(0.006, 0.04, 0.025, C.brass, [W / 2 + 0.032, 0.07, 0]);
  // 托人偶的弹簧杆：固定在盒底，人偶弹起来后正好站在它顶上（合着盖子时被人偶的裙子包住，看不见）
  bp.cyl(0.005, 0.005, 0.046, 4, C.brass, [0, BASE_H + 0.023, 0]);
  const boxGeo = bp.build();
  const boxMesh = mesh(boxGeo, body, 'music-box-body');
  box.add(boxMesh);

  // 盖子：转轴在后沿顶上
  const lid = new THREE.Group();
  lid.position.set(0, BOX_H, -D / 2);
  const lp = new Parts();
  lp.box(W + 0.008, LID_H, D + 0.008, C.wood, [0, LID_H / 2, D / 2]);
  lp.box(W - 0.06, 0.004, D - 0.06, C.brass, [0, LID_H + 0.002, D / 2]); // 盖面铜饰
  lp.box(W - 0.09, 0.005, D - 0.09, C.woodDark, [0, LID_H + 0.004, D / 2]);
  lp.box(W - 0.03, 0.004, D - 0.03, C.velvet, [0, -0.002, D / 2]); // 盖子里面的丝绒
  const lidGeo = lp.build();
  const lidMesh = mesh(lidGeo, body, 'music-box-lid');
  lid.add(lidMesh);
  box.add(lid);

  // 人偶：转盘 + 芭蕾舞裙 + 身体 + 头 + 举过头的手臂；瓷白，转的时候微微发亮（黑屋里看得见）
  const dancer = new THREE.Group();
  const dp = new Parts();
  dp.cyl(0.035, 0.035, 0.006, 10, C.brass, [0, 0.003, 0]);
  dp.cyl(0.004, 0.004, 0.02, 4, C.brass, [0, 0.016, 0]);
  dp.cyl(0.004, 0.034, 0.03, 8, C.ivory, [0, 0.04, 0]); // 裙子
  dp.cyl(0.009, 0.011, 0.034, 6, C.ivory, [0, 0.07, 0]);
  dp.add(new THREE.SphereGeometry(0.013, 8, 6), C.ivory, [0, 0.098, 0]);
  dp.add(new THREE.SphereGeometry(0.009, 6, 4), 0x2a1a14, [0, 0.106, -0.004]); // 发髻
  dp.rod([-0.018, 0.08, 0], [-0.006, 0.122, 0], 0.003, C.ivory, 3);
  dp.rod([0.018, 0.08, 0], [0.006, 0.122, 0], 0.003, C.ivory, 3);
  dp.rod([0.03, 0.05, 0.005], [0.006, 0.026, 0], 0.003, C.ivory, 3); // 抬起的一条腿
  const dancerGeo = dp.build();
  const shine = uniform(0);
  const dancerMat = bodyMaterial(0.35, 0.05);
  dancerMat.emissiveNode = color(0xc8bca0).mul(shine).mul(0.5);
  const dancerMesh = mesh(dancerGeo, dancerMat, 'music-box-dancer');
  dancerMesh.castShadow = false; // 太小，省一次阴影绘制
  dancer.add(dancerMesh);
  const DOWN = BOX_H - 0.132; // 收起时：头顶刚好在盖子下面，转盘和裙摆藏进实心盒底
  const UP = 0.1; // 弹起来以后：转盘离丝绒底 5 厘米，上半身露出盒沿
  dancer.position.y = DOWN;
  box.add(dancer);

  let t = -1;
  let spin = 0;

  return {
    model,
    // 拾取盒比盒子大很多：盒子太小不好点，点床头柜也算点到八音盒
    hit: { size: [0.55, NIGHTSTAND_H + 0.3, 0.55], center: [0, (NIGHTSTAND_H + 0.3) / 2, 0] },
    shells: [
      { parent: boxMesh, geometry: new THREE.BoxGeometry(W, BOX_H, D).translate(0, BOX_H / 2, 0) },
      { parent: lidMesh, geometry: new THREE.BoxGeometry(W + 0.008, LID_H, D + 0.008).translate(0, LID_H / 2, D / 2) },
    ],
    trigger() {
      t = 0;
    },
    reset() {},
    update(f: PropFrame) {
      if (t < 0) return;
      t += f.dt;
      // 盖子：0.16 秒弹开（带过冲），4.0 秒起越合越快砸上，再弹一下
      let lidA = 0;
      if (t < T.close) lidA = LID_OPEN * outBack(seg(t, 0, T.lidOpen), 2.2);
      else if (t < T.shut) lidA = lerp(LID_OPEN, 0, inQuad(seg(t, T.close, T.shut)));
      else lidA = -0.14 * bump(seg(t, T.shut, T.end));
      lid.rotation.x = lidA;

      // 盒子：打开那一下和合上那一下各跳一次
      box.position.y = NIGHTSTAND_H + 0.012 * bump(seg(t, 0, 0.1)) + 0.008 * bump(seg(t, T.shut, T.shut + 0.08));

      // 人偶：弹起 → 转 → 沉下
      const up = t < T.sink ? outBack(seg(t, T.riseFrom, T.riseTo), 2.5) : 1 - inQuad(seg(t, T.sink, T.shut));
      dancer.position.y = lerp(DOWN, UP, up);
      // 转速：约 0.7 圈/秒，忽快忽慢（像走调的发条），3.3 秒起松下来
      const wind = t < T.windDown ? 1 : Math.max(0.15, 1 - (t - T.windDown) / 0.8);
      const speed = 4.4 * wind * (1 + 0.28 * Math.sin(t * 7.3) + 0.12 * Math.sin(t * 17.9));
      if (t < T.shut) spin += speed * f.dt;
      dancer.rotation.y = spin;
      // 人偶跟着节奏微微晃
      dancer.rotation.z = 0.05 * Math.sin(t * 5.1) * up;
      shine.value = up * (0.7 + 0.3 * Math.sin(t * 9));

      if (t >= T.end) {
        t = -1;
        lid.rotation.x = 0;
        dancer.position.y = DOWN;
        box.position.y = NIGHTSTAND_H;
        shine.value = 0;
      }
    },
  };
}
