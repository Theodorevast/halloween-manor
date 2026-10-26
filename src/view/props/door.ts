// 厨房门：门洞（两格中间，宽 1 米）里的门框 + 门板，合页在西侧。平时门向厨房一侧开到底、贴着墙，
// 不挡门洞的通行观感。被附身：0.12 秒内猛地甩上（越关越快），撞上门框弹两下、门框一震；
// 关 1.5 秒后「咔」地松开一条缝，停住，再用 3 秒慢慢自己打开。墙由房子任务画，这里只画门框和门板。
import * as THREE from 'three/webgpu';
import { C, Parts, bodyMaterial, bump, inOutSine, lerp, mesh, outCubic, seg, wobble, type PropFrame, type PropRig } from './kit';

// 局部坐标：原点在门洞中心的地面，+z 朝走廊（南），-z 是厨房；墙体占 z ∈ [-0.1, 0.1]
const OPEN_W = 0.88; // 门板宽（门框内净宽）
const DOOR_H = 1.98;
const DOOR_T = 0.045;
const JAMB = 0.06; // 门框立柱宽：1 米 = 0.06 + 0.88 + 0.06
const FRAME_D = 0.24; // 门框比墙（0.2）略厚，两面都凸出一点
const HINGE: [number, number] = [-OPEN_W / 2, -0.125]; // 合页轴（x, z）：西侧立柱内沿、厨房一侧的墙面外
/** 平时开着的角度：差一点到 180°，贴墙但不穿墙 */
const OPEN_ANGLE = (172 * Math.PI) / 180;

/** 时间线（秒，从 trigger 算起） */
export const DOOR_T_LINE = {
  slam: 0.12, // 撞上门框
  bounce1: 0.26,
  bounce2: 0.33,
  unlatch: 1.62, // 关满 1.5 秒后松开一条缝
  creepFrom: 2.1, // 停顿后开始慢慢打开
  creepTo: 5.1,
};
const L = DOOR_T_LINE;
const CRACK = 0.07; // 松开的那条缝（弧度）

export function createDoor(): PropRig {
  const model = new THREE.Group();
  model.name = 'kitchen-door';
  const body = bodyMaterial(0.75);

  // 门框：两根立柱 + 门楣，再加两面的线脚
  const frameGroup = new THREE.Group();
  const fp = new Parts();
  const jx = OPEN_W / 2 + JAMB / 2;
  for (const s of [-1, 1]) {
    fp.box(JAMB, DOOR_H + 0.04, FRAME_D, C.woodDark, [s * jx, (DOOR_H + 0.04) / 2, 0]);
    // 线脚（两面各一条，宽一点）
    for (const zs of [-1, 1]) fp.box(0.03, DOOR_H + 0.08, 0.02, C.trim, [s * (OPEN_W / 2 + JAMB + 0.005), (DOOR_H + 0.08) / 2, zs * (FRAME_D / 2 - 0.01)]);
  }
  fp.box(OPEN_W + JAMB * 2 + 0.07, 0.07, FRAME_D + 0.02, C.woodDark, [0, DOOR_H + 0.075, 0]);
  const frameGeo = fp.build();
  const frame = mesh(frameGeo, body, 'door-frame');
  frameGroup.add(frame);
  model.add(frameGroup);

  // 门板：转轴在合页；门板几何在合页坐标里占 x ∈ [0, 0.88]、z ∈ [0, 厚度]（关着时在厨房一侧的墙面里）
  const hinge = new THREE.Group();
  hinge.position.set(HINGE[0], 0, HINGE[1]);
  const pp = new Parts();
  const cx = OPEN_W / 2, cz = DOOR_T / 2;
  pp.box(OPEN_W - 0.01, DOOR_H - 0.01, DOOR_T, C.doorPaint, [cx, DOOR_H / 2, cz]);
  // 四块凸起的门芯板（两面都有）
  for (const zs of [-1, 1]) {
    const z = cz + zs * (DOOR_T / 2 + 0.005);
    for (const [px, py, pw, ph] of [[-0.19, 1.42, 0.3, 0.7], [0.19, 1.42, 0.3, 0.7], [-0.19, 0.48, 0.3, 0.62], [0.19, 0.48, 0.3, 0.62]]) {
      pp.box(pw, ph, 0.012, 0x24302b, [cx + px, py, z]);
    }
    // 门把手（铜）：离合页远的一侧
    pp.cyl(0.028, 0.028, 0.03, 8, C.brass, [OPEN_W - 0.08, 0.98, cz + zs * (DOOR_T / 2 + 0.02)], [Math.PI / 2, 0, 0]);
    pp.box(0.04, 0.12, 0.006, C.brass, [OPEN_W - 0.08, 0.98, cz + zs * (DOOR_T / 2 + 0.003)]);
  }
  // 合页（铁）
  for (const y of [0.25, 1.0, 1.75]) pp.box(0.025, 0.12, DOOR_T + 0.012, C.iron, [0.005, y, cz]);
  const panelGeo = pp.build();
  const panel = mesh(panelGeo, body, 'door-panel');
  hinge.add(panel);
  hinge.rotation.y = OPEN_ANGLE;
  model.add(hinge);

  let t = -1;
  let from = OPEN_ANGLE; // 甩门开始时的角度（万一上一次还没开完）

  return {
    model,
    // 拾取盒：门框 + 开着贴墙的门板（在厨房一侧）
    hit: { size: [1.95, DOOR_H + 0.15, 0.5], center: [-0.43, (DOOR_H + 0.15) / 2, -0.1] },
    shells: [
      { parent: panel, geometry: new THREE.BoxGeometry(OPEN_W, DOOR_H, DOOR_T + 0.02).translate(cx, DOOR_H / 2, cz) },
      { parent: frame, geometry: frameGeo },
    ],
    trigger() {
      from = hinge.rotation.y;
      t = 0;
    },
    reset() {},
    update(f: PropFrame) {
      if (t < 0) return;
      t += f.dt;
      let a: number;
      if (t < L.slam) {
        // 甩上：一开始就有速度（线性项），再越来越快（二次项）撞上去
        const u = seg(t, 0, L.slam);
        a = lerp(from, 0, 0.3 * u + 0.7 * u * u);
      } else if (t < L.unlatch) {
        // 撞上门框弹开两下
        a = 0.17 * bump(seg(t, L.slam, L.bounce1)) + 0.045 * bump(seg(t, L.bounce1, L.bounce2));
      } else if (t < L.creepFrom) {
        // 「咔」：一下子松开一条缝，然后停住不动
        a = CRACK * outCubic(seg(t, L.unlatch, L.unlatch + 0.06));
      } else {
        a = lerp(CRACK, OPEN_ANGLE, inOutSine(seg(t, L.creepFrom, L.creepTo)));
      }
      hinge.rotation.y = a;
      // 撞上那一下门框整体一震
      const shake = 1 - seg(t, L.slam, L.slam + 0.18);
      if (t >= L.slam && shake > 0) {
        frameGroup.position.set(wobble(t * 3, 1) * 0.012 * shake, 0, wobble(t * 3, 2) * 0.008 * shake);
      } else frameGroup.position.set(0, 0, 0);
      if (t >= L.creepTo) {
        t = -1;
        hinge.rotation.y = OPEN_ANGLE;
      }
    },
  };
}
