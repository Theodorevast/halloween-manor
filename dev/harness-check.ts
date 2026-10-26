// 沙盒自检：在假访客位置放两个方块、在物件位置放小柱子，确认相机、坐标和假状态都对
import * as THREE from 'three/webgpu';
import { createHarness } from './harness';

const h = await createHarness({ ambient: 1.2 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 12), new THREE.MeshStandardMaterial({ color: 0x334455 }));
floor.rotation.x = -Math.PI / 2;
floor.position.set(8, 0, 6);
h.core.houseRoot.add(floor);
const npcs = h.state.npcs.map(() => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.5), new THREE.MeshStandardMaterial({ color: 0xffaa33 }));
  h.core.houseRoot.add(m);
  return m;
});
for (const o of h.state.objects) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.8), new THREE.MeshStandardMaterial({ color: 0x66ff99 }));
  m.position.set(o.pos.x, 0.4, o.pos.z);
  h.core.houseRoot.add(m);
}
h.add({
  update({ state }) {
    state.npcs.forEach((n, i) => npcs[i].position.set(n.pos.x, 0.55, n.pos.z));
  },
});
h.start();
console.log('backend', h.core.backend);
