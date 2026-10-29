// 衣柜（设计文档 4.3、调研 3.3）。这一版是占位：衣柜本身还是 furniture.ts 画的整个家具，这里只有拾取盒和门板前面的幽光外壳，
// 什么都不演。门板拆出来绕合页转、门缝里的黑、里面的外套、被从里面拉上、手指、落灰由衣柜那一路接着做（时间轴在 config/scares.ts 的 WARDROBE），
// 到时候 furniture.ts 的衣柜不再画门。
// 局部坐标（props.ts 摆放：根在 propCenter，转 yawFor(facing)；衣柜朝南，yaw = 0，局部坐标就是房屋坐标的偏移）：
// 物件格是衣柜三格里中间那一格，所以原点正好在衣柜正中；正面在 +z
import * as THREE from 'three/webgpu';
import { CELL, FURNITURE } from '../../config/house';
import { FURNITURE_TOP } from '../furniture';
import type { PropRig } from './kit';

/** 门板的范围（米，局部坐标）：照 furniture.ts 的 wardrobe 画的门（离地 0.44 米到顶檐下面 0.16 米，左右各让出 0.06 米） */
const DOOR = { y0: 0.44, inset: 0.06, top: 0.16, depth: 0.02 };

export function createWardrobe(): PropRig {
  const f = FURNITURE.find((x) => x.id === 'bedroom-wardrobe');
  if (!f) throw new Error('wardrobe: 家具表里没有 bedroom-wardrobe');
  const w = (f.rect.x1 - f.rect.x0) * CELL;
  const zf = ((f.rect.z1 - f.rect.z0) * CELL) / 2;
  const y1 = FURNITURE_TOP.wardrobe - DOOR.top;
  const dw = w - DOOR.inset * 2, dh = y1 - DOOR.y0;

  const model = new THREE.Group();
  model.name = 'wardrobe';
  // 幽光外壳贴着两扇门的正面（悬停、可附身时那层幽光；机关的霜也用它）
  const doors = new THREE.BoxGeometry(dw, dh, DOOR.depth).translate(0, DOOR.y0 + dh / 2, zf - DOOR.depth / 2);

  return {
    model,
    hit: { size: [dw, dh, 0.12], center: [0, DOOR.y0 + dh / 2, zf - 0.06] },
    shells: [{ parent: model, geometry: doors }],
    trigger() {},
    reset() {},
    update() {},
    dispose() {
      doors.dispose();
    },
  };
}
