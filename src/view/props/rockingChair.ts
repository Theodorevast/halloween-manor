// 摇椅：两条弧形摇腿、坐垫、纺锤背。被附身时没人碰它却猛地往后一仰、摇起来，
// 3 秒内越摇越快、越摇越大，然后慢慢停下。摇动是绕摇腿圆心转动 + 沿地面滚动（摇腿不打滑）。
import * as THREE from 'three/webgpu';
import { C, Parts, bodyMaterial, mesh, seg, type PropFrame, type PropRig } from './kit';

/** 摇腿圆弧的半径（圆心在地面上方 R 处）和弧长对应的角度 */
const R = 1.1;
const ARC = 0.86;

/**
 * 摇动参数（秒、赫兹、弧度）。频率在 0–3 秒内线性从 f0 升到 f1，振幅从 a0 升到 a1；
 * 3 秒后进入衰减：频率在 decay 秒内降到 fEnd，振幅按 e^(-k·t) 衰减，最后补一段缓动归零。
 */
export const ROCK = { spin: 3, f0: 1.0, f1: 2.4, a0: 0.13, a1: 0.21, decay: 2.6, fEnd: 0.9, k: 1.25 };
const TOTAL = ROCK.spin + ROCK.decay + 0.6;

export function createRockingChair(): PropRig {
  const model = new THREE.Group();
  model.name = 'rocking-chair';
  // rock：转轴在摇腿圆心；chair 往下挪 R，让摇腿落在地面上
  const rock = new THREE.Group();
  rock.position.y = R;
  const chair = new THREE.Group();
  chair.position.y = -R;
  rock.add(chair);
  model.add(rock);

  const p = new Parts();
  const wx = 0.23; // 摇腿离中线的距离
  for (const s of [-1, 1]) {
    // 摇腿：一段圆环，先把弧的中点转到正下方，再从 xy 平面转进 yz 平面，抬高 R
    p.add(new THREE.TorusGeometry(R, 0.022, 4, 12, ARC), C.woodDark, [s * wx, R, 0], [0, -Math.PI / 2, -Math.PI / 2 - ARC / 2]);
    // 前腿（到扶手）、后腿（往上接靠背立柱）
    const y = (z: number) => R - Math.sqrt(R * R - z * z) + 0.01; // 摇腿上表面的高度
    p.rod([s * wx, y(0.2), 0.2], [s * (wx + 0.01), 0.64, 0.23], 0.018, C.wood);
    p.rod([s * wx, y(-0.21), -0.21], [s * (wx - 0.01), 1.12, -0.35], 0.02, C.wood);
    // 扶手
    p.rod([s * (wx + 0.02), 0.65, 0.27], [s * (wx - 0.005), 0.67, -0.28], 0.022, C.wood);
    // 腿之间的横档
    p.rod([s * wx, 0.2, 0.19], [s * wx, 0.2, -0.2], 0.01, C.woodDark);
  }
  // 座面 + 坐垫
  p.box(0.5, 0.045, 0.46, C.wood, [0, 0.4, 0]);
  p.box(0.44, 0.05, 0.4, C.fabric, [0, 0.445, 0.01]);
  // 靠背：上横梁 + 纺锤
  p.rod([-0.23, 1.06, -0.335], [0.23, 1.06, -0.335], 0.025, C.wood);
  p.rod([-0.22, 0.6, -0.27], [0.22, 0.6, -0.27], 0.014, C.woodDark);
  for (let i = 0; i < 5; i++) {
    const x = -0.14 + i * 0.07;
    p.rod([x, 0.43, -0.22], [x, 1.05, -0.33], 0.009, C.woodDark, 4);
  }
  // 靠背上搭的一块旧毯子，让剪影更好认
  p.box(0.36, 0.3, 0.02, C.fabric, [0.02, 0.92, -0.32], [-0.18, 0, 0.04]);
  const geo = p.build();
  const body = bodyMaterial(0.8);
  const chairMesh = mesh(geo, body, 'rocking-chair');
  chair.add(chairMesh);

  let t = -1;
  let phase = 0;
  let decayFrom = 0; // 进入衰减时的振幅

  const pose = (theta: number) => {
    rock.rotation.x = theta;
    rock.position.z = R * theta; // 滚动：圆心跟着走 R·θ
  };

  return {
    model,
    hit: { size: [0.62, 1.2, 1.05], center: [0, 0.6, 0] },
    shells: [{ parent: chairMesh, geometry: geo }],
    trigger() {
      t = 0;
      phase = 0;
    },
    reset() {},
    update(f: PropFrame) {
      if (t < 0) return;
      t += f.dt;
      let theta = 0;
      if (t < ROCK.spin) {
        const u = t / ROCK.spin;
        const freq = ROCK.f0 + (ROCK.f1 - ROCK.f0) * u;
        phase += Math.PI * 2 * freq * f.dt;
        const amp = ROCK.a0 + (ROCK.a1 - ROCK.a0) * u;
        // 负号：第一下往后仰（像被谁猛地推了一把），起步就有速度，没有慢慢启动
        theta = -amp * Math.sin(phase);
        decayFrom = amp;
      } else {
        const td = t - ROCK.spin;
        const freq = ROCK.f1 + (ROCK.fEnd - ROCK.f1) * Math.min(1, td / ROCK.decay);
        phase += Math.PI * 2 * freq * f.dt;
        // 指数衰减，最后 0.6 秒再乘一个淡出，保证正好停在 0
        const amp = decayFrom * Math.exp(-ROCK.k * td) * (1 - seg(td, ROCK.decay, ROCK.decay + 0.6));
        theta = -amp * Math.sin(phase);
      }
      pose(theta);
      if (t >= TOTAL) {
        t = -1;
        pose(0);
      }
    },
  };
}
