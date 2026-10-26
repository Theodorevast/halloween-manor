// 备用小人：吉祥物 GLB 加载失败时顶上，游戏照常运行。
// 胶囊身体 + 球形头 + 两个点状眼睛，围巾颜色按性格换（远远看去也分得清谁是谁）。
// 尺寸随手取（约 1.1 个单位高），由 characters.ts 和 GLB 走同一套归一化；正面朝 +z。
import * as THREE from 'three/webgpu';
import type { Personality } from '../sim/types';
import { PALETTE } from './palette';

// 调色板里没有「访客衣服」这一类颜色：先放在这里，都压得比较灰，和屋里的暗色调站在一起
const SCARF: Record<Personality, number> = { timid: 0xc9a24a, average: 0x4f8a80, brave: 0xb0462e };
const COAT = 0x857462; // 偏暖的燕麦色外套：在冷蓝的月光和墙纸前面跳得出来
const SKIN = 0xd8c4a4;

export function createFallbackCharacter(personality: Personality): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fallback-visitor';
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.32, 3, 10), mat(COAT));
  body.position.y = 0.22 + 0.16; // 胶囊总高 0.76，底部贴地
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.23, 1), mat(SKIN));
  head.position.y = 0.86;
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.055, 6, 14), mat(SCARF[personality]));
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 0.66;
  // 围巾垂下来的一截，挂在身前偏右，看得出正面
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.04), scarf.material);
  tail.position.set(0.09, 0.53, 0.2);
  tail.rotation.z = 0.12;
  const eyeMat = new THREE.MeshBasicMaterial({ color: PALETTE.night });
  const eyeGeo = new THREE.SphereGeometry(0.03, 8, 6);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(0.075 * s, 0.9, 0.205);
    g.add(eye);
  }
  g.add(body, head, scarf, tail);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  return g;
}
