// 床的被子（src/view/props/bed.ts）：布局、网格、时间线。不画东西，只查数。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { SCARES } from '../src/config/scares';
import { BED_TIMELINE, bedDustSpot, bedLayout, buildQuiltMesh } from '../src/view/props/bed';

describe('床：被子的布局', () => {
  it('被子在床面里面，床头让出枕头', () => {
    const L = bedLayout();
    expect(L.quilt.x0).toBeGreaterThan(L.bed.x0);
    expect(L.quilt.x1).toBeLessThan(L.bed.x1);
    expect(L.quilt.z0 - L.bed.z0).toBeCloseTo(0.45, 6);
    expect(L.quilt.z1).toBeLessThan(L.bed.z1);
  });

  it('躺着的人在被子范围里，头、躯干、膝盖从床头往床尾排', () => {
    const L = bedLayout();
    expect(L.bodyX).toBeGreaterThan(L.quilt.x0);
    expect(L.bodyX).toBeLessThan(L.quilt.x1);
    expect(L.quilt.z0).toBeLessThan(L.head);
    expect(L.head).toBeLessThan(L.torso);
    expect(L.torso).toBeLessThan(L.knee);
    expect(L.knee).toBeLessThan(L.quilt.z1);
  });

  it('扬灰的位置在躯干那个包正上方的被子面', () => {
    const L = bedLayout();
    expect(bedDustSpot()).toEqual({ x: L.bodyX, y: L.y, z: L.torso });
  });
});

describe('床：时间线', () => {
  it('塌平的时刻就是惊吓落下的时刻（SCARES.bed.hitAt）', () => {
    expect(BED_TIMELINE.collapse).toBe(SCARES.bed.hitAt);
  });

  it('三个鼓包先膝、再躯干、最后头；头升完就开始呼吸，呼吸停了头开始转，转完正好塌平', () => {
    const r = BED_TIMELINE.rise;
    expect(r.knee[0]).toBeLessThan(r.torso[0]);
    expect(r.torso[0]).toBeLessThan(r.head[0]);
    expect(r.knee[1]).toBeLessThan(r.torso[1]);
    expect(r.torso[1]).toBeLessThan(r.head[1]);
    expect(r.head[1]).toBeCloseTo(BED_TIMELINE.breathFrom, 6);
    expect(BED_TIMELINE.breathTo).toBeCloseTo(BED_TIMELINE.turn[0], 6);
    expect(BED_TIMELINE.turn[1]).toBeCloseTo(BED_TIMELINE.collapse, 6);
  });
});

describe('床：被子的网格', () => {
  const L = bedLayout();
  const mesh = buildQuiltMesh(L.quilt, L.y, 8, 6, new THREE.Color(1, 0, 0), new THREE.Color(0, 0, 1));
  const n = mesh.position.length / 3;

  it('顶点数、数值正常', () => {
    expect(mesh.normal.length).toBe(mesh.position.length);
    expect(mesh.color.length).toBe(mesh.position.length);
    expect(mesh.position.every(Number.isFinite)).toBe(true);
    expect(mesh.normal.every(Number.isFinite)).toBe(true);
    expect(Math.max(...mesh.index)).toBeLessThan(n);
  });

  it('每个三角形的绕向和顶点法线同向（正面朝外）', () => {
    const p = mesh.position, nm = mesh.normal;
    let bad = 0;
    for (let t = 0; t < mesh.index.length; t += 3) {
      const [a, b, c] = [mesh.index[t] * 3, mesh.index[t + 1] * 3, mesh.index[t + 2] * 3];
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const s = [nm[a] + nm[b] + nm[c], nm[a + 1] + nm[b + 1] + nm[c + 1], nm[a + 2] + nm[b + 2] + nm[c + 2]];
      if (f[0] * s[0] + f[1] * s[1] + f[2] * s[2] <= 0) bad++;
    }
    expect(bad).toBe(0);
  });

  it('顶面是平的、在 L.y；边缘垂下去的一圈在顶面下面、在范围外一点点', () => {
    const p = mesh.position;
    let top = 0, below = 0;
    for (let i = 0; i < n; i++) {
      const y = p[i * 3 + 1];
      if (Math.abs(y - L.y) < 1e-6) top++;
      else {
        below++;
        expect(y).toBeLessThan(L.y);
      }
    }
    expect(top).toBe(9 * 7); // (8 + 1) × (6 + 1)
    expect(below).toBe(2 * (8 + 6) * 5); // 边缘一圈 28 个点 × 5 排
  });

  it('床头那一条的顶面顶点是床单的颜色，其余是被面的颜色', () => {
    const p = mesh.position, c = mesh.color;
    let linen = 0, fabric = 0;
    for (let i = 0; i < 9 * 7; i++) {
      if (c[i * 3 + 2] === 1) { linen++; expect(p[i * 3 + 2] - L.quilt.z0).toBeLessThan(0.12); }
      else fabric++;
    }
    expect(linen).toBeGreaterThan(0);
    expect(fabric).toBeGreaterThan(linen);
  });
});
