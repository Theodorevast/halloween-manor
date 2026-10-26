// 房子的开发页：用 harness 看结构和氛围。
// 网址参数：
//   ?ambient=0.25   半球光强度（默认 1.2 看结构；0.25 看氛围）
//   ?props          在 PROPS 的格子上画小柱子，确认物件格没被家具、墙占住
//   ?top            正上方俯视（配合 ?grid 核对家具是否在 rect 里）
//   ?grid           画出格子线（灰）和家具 rect（黄）、物件格（绿）
//   ?q=2            开局先转几次镜头
//   ?low            画质 low（月光不投影）
//   ?spot           在客厅放一盏投影的聚光灯照向走廊（模拟手电），检查 layer 1 的全高墙能不能挡光
//   ?spotnolayer    同上，但阴影相机不开 layer 1（对照：光会从矮墙上方漏过去）
//   ?spot=x,z,tx,tz 自定聚光灯位置（高 0.8）和照向的地面点，比如贴着矮墙顶面扫过去看有没有锯齿
//   ?shadowside=front  只投影墙的材质改用 shadowSide = FrontSide（对照用）
//   ?zoom=1.5
//   ?focus=8,6      把镜头平移到房屋坐标 (x, z)（配合 zoom 看局部）
//   ?mag=4          再放大（直接改正交相机的 zoom，超出 rig 的 1.6 上限，只用来看细节）
// Playwright：window.__house.stats() 返回 draw call 数；.setQuality('low')；.rotate(1)
import * as THREE from 'three/webgpu';
import { CELL, FURNITURE, GRID_H, GRID_W, PROPS, propCenter } from '../src/config/house';
import type { Quality } from '../src/engine/types';
import { createHouseView } from '../src/view/house';
import { createHarness } from './harness';

const q = new URLSearchParams(location.search);
const h = await createHarness({ ambient: Number(q.get('ambient') ?? 1.2) });
const house = createHouseView(h.core, h.rig);
h.add(house);
if (q.has('low')) house.setQuality?.('low');
for (let i = 0; i < Number(q.get('q') ?? 0); i++) h.rig.rotate(1);
if (q.has('zoom')) h.rig.zoom(Number(q.get('zoom')));
if (q.has('mag')) {
  h.rig.camera.zoom = Number(q.get('mag'));
  h.rig.camera.updateProjectionMatrix();
}
if (q.has('focus')) {
  // 正交相机平移：相机位置和看的点一起挪，harness 只在 rotate 时重摆相机
  const [fx, fz] = (q.get('focus') ?? '8,6').split(',').map(Number);
  h.rig.camera.position.add(new THREE.Vector3(fx - 8, 0, fz - 6));
}

if (q.has('props')) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x66ff99, emissive: 0x115522 });
  for (const p of PROPS) {
    const c = propCenter(p);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.2, 10), mat);
    m.position.set(c.x, 0.6, c.z);
    h.core.houseRoot.add(m);
  }
}

if (q.has('grid')) {
  const y = 2.6;
  const pts: number[] = [];
  for (let i = 0; i <= GRID_W; i++) pts.push(i * CELL, y, 0, i * CELL, y, GRID_H * CELL);
  for (let j = 0; j <= GRID_H; j++) pts.push(0, y, j * CELL, GRID_W * CELL, y, j * CELL);
  const lines = (arr: number[], color: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicNodeMaterial({ color }));
  };
  h.core.houseRoot.add(lines(pts, 0x404850));
  const rect = (x0: number, z0: number, x1: number, z1: number, yy: number) => [
    x0, yy, z0, x1, yy, z0, x1, yy, z0, x1, yy, z1, x1, yy, z1, x0, yy, z1, x0, yy, z1, x0, yy, z0,
  ];
  const fr: number[] = [];
  for (const f of FURNITURE) fr.push(...rect(f.rect.x0 * CELL, f.rect.z0 * CELL, f.rect.x1 * CELL, f.rect.z1 * CELL, y + 0.01));
  h.core.houseRoot.add(lines(fr, 0xffd040));
  const pr: number[] = [];
  for (const p of PROPS) {
    const [i, j] = p.cell;
    const w = p.type === 'door' ? 2 : 1;
    pr.push(...rect(i * CELL, j * CELL, (i + w) * CELL, (j + 1) * CELL, y + 0.02));
  }
  h.core.houseRoot.add(lines(pr, 0x40ff80));
}

if (q.has('top')) {
  // 正上方俯视：harness 的相机只在 rotate 时摆位置，这里摆一次就不会被改回去
  h.rig.camera.position.set(0, 30, 0.0001);
  h.rig.camera.up.set(0, 0, -1);
  h.rig.camera.lookAt(0, 0, 0);
}

if (q.has('spot') || q.has('spotnolayer')) {
  // 模拟手电：客厅里离南墙 1.5 米、高 0.8 米，斜着照向南墙（实墙段，不对着门洞）和墙后的走廊
  const spot = new THREE.SpotLight(0xffd9a8, 30, 9, Math.PI / 6, 0.6, 2);
  const custom = (q.get('spot') ?? '').split(',').map(Number);
  const [sx, sz, tx, tz] = custom.length === 4 ? custom : [9.6, 3.0, 9.6, 7.0];
  spot.position.set(sx, 0.8, sz);
  spot.target.position.set(tx, 0, tz);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0006;
  spot.shadow.normalBias = 0.02;
  if (q.has('spot')) spot.shadow.camera.layers.enable(1);
  h.core.houseRoot.add(spot, spot.target);
}

if (q.get('shadowside') === 'front') {
  const m = h.core.scene.getObjectByName('walls-shadow-only') as THREE.Mesh | undefined;
  if (m) (m.material as THREE.Material).shadowSide = THREE.FrontSide;
}

h.start();

const info = h.core.renderer.info;
(window as unknown as { __house: unknown }).__house = {
  stats: () => ({
    backend: h.core.backend,
    drawCalls: info.render.drawCalls,
    frameCalls: info.render.frameCalls,
    triangles: info.render.triangles,
  }),
  setQuality: (v: Quality) => house.setQuality?.(v),
  rotate: (d: 1 | -1) => h.rig.rotate(d),
  /** 场景里每个会画的网格：名字、layer、是否投影 */
  meshes: () => {
    const out: string[] = [];
    h.core.scene.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) out.push(`${o.name || o.type} L${o.layers.mask} ${o.castShadow ? 'cast' : ''}`);
    });
    return out;
  },
  /** 去掉只投影的墙（对照用） */
  dropShadowWalls: () => {
    const m = h.core.scene.getObjectByName('walls-shadow-only');
    if (m) m.visible = false;
  },
};
console.log('backend', h.core.backend);
