// 角度约定（全项目统一）：房屋平面上 x 向东、z 向南、y 向上；
// 方向角 a（弧度）对应的单位向量是 (cos a, sin a)，即 a = 0 朝东，π/2 朝南，π 朝西，-π/2 朝北

export const dirOf = (a: number) => ({ x: Math.cos(a), z: Math.sin(a) });
export const angleOf = (dx: number, dz: number) => Math.atan2(dz, dx);

/** 把角度规整到 (-π, π] */
export const wrapAngle = (a: number) => {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t <= 0 ? t + Math.PI * 2 : t) - Math.PI;
};

/** 两个角度之差的绝对值（0..π） */
export const angleDiff = (a: number, b: number) => Math.abs(wrapAngle(a - b));

/** three.js 物体的 rotation.y：模型正面朝 +z 时，让它面向方向角 a */
export const yawFor = (a: number) => Math.PI / 2 - a;
