// 换模型（view/ghost.ts 的 createGhostClip）：带动画的鬼魂现身停留时播的片段（评审 I2）。
// 以前用 LoopOnce + clampWhenFinished + mixer.setTime：片段比停留短时，播到头 three 把 action 暂停，setTime 只清时间不清暂停，
// 之后每一帧都在第 0 秒求值——当场弹回第一帧，以后每次现身都不再动。这里用真的 three 动画系统（不渲染）按鬼魂每帧的调用走一遍
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { MANIFEST } from '../src/config/visitors';
import { GHOST, createGhostClip } from '../src/view/ghost';

/** 一个 0.5 秒的「抬头」片段（比 1.5 秒的停留短）：head.position.x 从 0 走到 1 */
function makeRig(duration = 0.5) {
  const root = new THREE.Group();
  const head = new THREE.Object3D();
  head.name = 'head';
  root.add(head);
  const clip = new THREE.AnimationClip('lift', duration, [
    new THREE.VectorKeyframeTrack('head.position', [0, duration], [0, 0, 0, 1, 0, 0]),
  ]);
  return { head, clip, pose: createGhostClip(root, clip) };
}

/** 鬼魂每帧的调用：停留中按 1 / stepRate 秒取整的时间摆，没在停留时摆第 0 秒（ghost.ts 的 update） */
function playHold(r: ReturnType<typeof makeRig>, out: number[] = []) {
  const rate = GHOST.manifest.stepRate;
  for (let t = 0; t <= MANIFEST.hold + 1e-9; t += 1 / 60) {
    r.pose.pose(Math.floor(t * rate) / rate);
    out.push(r.head.position.x);
  }
  return out;
}

describe('现身时播的片段', () => {
  it('建好时停在第一帧', () => {
    const r = makeRig();
    expect(r.head.position.x).toBe(0);
  });

  it('片段比停留短：播到头停在最后一帧，不弹回第一帧', () => {
    const r = makeRig();
    const xs = playHold(r);
    // 一路只往前走（降帧：一格一格地走，不往回跳）
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-9);
    expect(xs[xs.length - 1]).toBeCloseTo(1);
    // 停留里超过片段长度的那一段一直停在最后一帧（调试页兜底时停留能到 2.5 秒）
    for (const t of [0.5, 0.8, 1.4, 2.5]) {
      r.pose.pose(t);
      expect(r.head.position.x).toBeCloseTo(1);
    }
  });

  it('每次现身都从第一帧重新播，播得动（以前播完一次以后一直停在第一帧）', () => {
    const r = makeRig();
    playHold(r);
    r.pose.pose(0); // 收了：回到第一帧
    expect(r.head.position.x).toBeCloseTo(0);
    for (let n = 0; n < 3; n++) {
      r.pose.pose(0.1);
      expect(r.head.position.x).toBeCloseTo(0.2);
      r.pose.pose(0.3);
      expect(r.head.position.x).toBeCloseTo(0.6);
      const xs = playHold(r);
      expect(xs[xs.length - 1]).toBeCloseTo(1);
      r.pose.pose(0);
      expect(r.head.position.x).toBeCloseTo(0);
    }
  });

  it('片段比停留长：停留结束时还在中间，也不会被夹住', () => {
    const r = makeRig(3);
    r.pose.pose(1.4);
    expect(r.head.position.x).toBeCloseTo(1.4 / 3);
    expect(r.pose.time).toBeCloseTo(1.4);
  });
});
