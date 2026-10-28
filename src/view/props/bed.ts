// 床：被子下面有人（设计文档 4.1）。这一版是占位：一块静态的、细分 40×60 的被子，什么都不演；
// 鼓包、呼吸、塌平、凹陷的动画由物件那一路（P1）接着做，到时候 furniture.ts 里的床不再画被子。
// 位置按家具表里的 bedroom-bed 算：床面就是它的格子矩形；被子盖在床面上，浮在家具里现在那块被子上方 QUILT.lift 米
// （两块不重叠、不闪，P1 把家具里的被子删掉以后正好接上）。
// 局部坐标（props.ts 摆放：根在 propCenter，转 yawFor(facing)，模型正面朝 +z）：床头在 -z（靠西墙），床尾在 +z；
// 床宽方向是 x。物件格是床面当中的一格，不在床的正中心（床的矩形比一格大），所以下面的范围都是从家具表换算出来的。
import * as THREE from 'three/webgpu';
import { CELL, FURNITURE, PROPS, propCenter } from '../../config/house';
import { yawFor } from '../../lib/angle';
import { FURNITURE_TOP } from '../furniture';
import { C, bodyMaterial, mesh, type PropRig } from './kit';

/** 被子的范围和高度（米）：数字照 furniture.ts 的 bed 现在画的被子 */
const QUILT = {
  /** 离床面（FURNITURE_TOP.bed）多高 */
  lift: 0.06,
  /** 床头留给枕头的一截（从格子矩形的床头边算起；furniture.ts 里被子从床头板往前 0.6 米，床头板靠墙多伸出 0.15 米） */
  pillow: 0.45,
  /** 床尾、两侧各缩进多少 */
  foot: 0.06,
  side: 0.04,
  /** 细分：沿床宽（x）40 段，沿床长（z）60 段，顶点位移做鼓包时够细 */
  segs: [40, 60] as [number, number],
};
/** 拾取盒的高度范围：盖住被子和以后鼓起来的部分 */
const HIT_Y: [number, number] = [0.35, 0.85];

/** 房屋米坐标 → 物件局部坐标（物件根在 propCenter，绕 y 转 yaw）；取到微米，免得 cos(π/2) 留下 1e-17 的尾巴 */
const toLocal = (x: number, z: number, c: { x: number; z: number }, yaw: number): [number, number] => {
  const dx = x - c.x, dz = z - c.z;
  const snap = (v: number) => Math.round(v * 1e6) / 1e6;
  return [snap(dx * Math.cos(yaw) - dz * Math.sin(yaw)), snap(dx * Math.sin(yaw) + dz * Math.cos(yaw))];
};

export function createBed(): PropRig {
  const placement = PROPS.find((p) => p.type === 'bed');
  const bed = FURNITURE.find((f) => f.id === 'bedroom-bed');
  if (!placement || !bed) throw new Error('bed: PROPS 里没有 bed，或者家具表里没有 bedroom-bed');

  // 床面（格子矩形）在局部坐标里的包围盒
  const c = propCenter(placement), yaw = yawFor(placement.facing);
  const { x0, z0, x1, z1 } = bed.rect;
  const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([i, j]) => toLocal(i * CELL, j * CELL, c, yaw));
  const bx0 = Math.min(...corners.map((p) => p[0])), bx1 = Math.max(...corners.map((p) => p[0]));
  const bz0 = Math.min(...corners.map((p) => p[1])), bz1 = Math.max(...corners.map((p) => p[1]));

  // 被子：床宽方向两侧各缩 side，床头让出枕头，床尾缩 foot
  const qx0 = bx0 + QUILT.side, qx1 = bx1 - QUILT.side;
  const qz0 = bz0 + QUILT.pillow, qz1 = bz1 - QUILT.foot;
  const y = FURNITURE_TOP.bed + QUILT.lift;
  const geo = new THREE.PlaneGeometry(qx1 - qx0, qz1 - qz0, QUILT.segs[0], QUILT.segs[1])
    .rotateX(-Math.PI / 2)
    .translate((qx0 + qx1) / 2, y, (qz0 + qz1) / 2);
  // bodyMaterial 用顶点色：整块是一种布的颜色
  const col = new THREE.Color(C.fabric);
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([col.r, col.g, col.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const model = new THREE.Group();
  model.name = 'bed';
  const quilt = mesh(geo, bodyMaterial(0.9), 'bed-quilt');
  model.add(quilt);

  return {
    model,
    // 拾取盒盖住整个床面
    hit: { size: [bx1 - bx0, HIT_Y[1] - HIT_Y[0], bz1 - bz0], center: [(bx0 + bx1) / 2, (HIT_Y[0] + HIT_Y[1]) / 2, (bz0 + bz1) / 2] },
    shells: [{ parent: quilt, geometry: geo }],
    trigger() {},
    reset() {},
    update() {},
  };
}
