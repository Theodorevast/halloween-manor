// 肖像砸地扬起的灰：画框脸朝下拍在地板上，压出来的空气把灰顺着地面从画框四周喷出去（大部分从最后着地的上沿和两条长边），
// 一路减速、卷起来一点、悬一会儿，再慢慢落下去散掉；画框背上震起一层薄灰往上飘；再崩出几粒碎屑，短短地弹两下。
//
// 做法：一个实例化精灵（前 dust.count 颗是灰，后 chips.count 颗是碎屑），每颗的起点、速度、大小、寿命
// 全由实例编号的哈希算出，轨迹是解析式（指数衰减的喷射 + 缓慢上卷 + 沉降 + 随年龄变大的噪声扰动；碎屑是抛物线弹一次）。
// CPU 每次只写一个「砸地时刻」和画框在地上的位置，不传缓冲、不建材质。
// 灰本身不发光：颜色 = 灰的底色 × 这一点受到的手电 / 台灯光 + 一点月光底色。屋里黑，所以只有被手电照着的那团看得见，
// 这一下正好是访客在看着画的时候（肖像是「被看见才生效」的惊吓）。
// 贴地的面片做软粒子（common.ts，正交、透视相机都对），不出现插进地板 / 墙里的直线。
// 床塌下去那一下也用它（2026-10-28，props/bed.ts）：burst 的最后一个参数换一套形状——落点小一点、灰少一点、喷得慢一点、没有碎屑，
// 中心抬到被子面上。不给参数就是肖像砸地那一套，画面和以前完全一样。
// 衣柜（2026-10-29，props/wardrobe.ts）：形状里多一个 fall（秒）——从柜顶四边翻出去的灰不悬在上面，而是在这几秒里一颗颗慢慢落到
// 门前的地上（见 PLASTER.fall）。不给 fall 时多出来的项全乘 0 / 1，肖像、床的灰和原来一模一样。
import * as THREE from 'three/webgpu';
import {
  exp, float, instanceIndex, length, max, min, mix, mx_noise_float, mx_noise_vec3, pow, smoothstep, sqrt, uniform, uv,
  varying, vec2, vec3,
} from 'three/tsl';
import { FOG } from '../fog';
import { lightAt, type LightUniforms } from './light';
import { centerViewZ, ge, lt, makeSprite, protectMRT, rnd, softFade } from './common';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export const PLASTER = {
  /** 倒在地上的画框（物件局部坐标，米）：和 props/portrait.ts 的画框宽 FW = 0.74、高 FH = 0.94、倒地转轴 FALLEN_Z = 0.25 对应 */
  slab: { halfW: 0.37, z0: 0.25, z1: 1.19 },
  dust: {
    /** 颗数：high / low */
    count: { high: 110, low: 56 },
    /** 从四边喷出去的比例（其余从画框背上震起来） */
    edgeShare: 0.75,
    /** 四边各占多少（上沿 = 最后着地、离转轴最远的那条边，喷得最多）；剩下的是转轴那条边 */
    far: 0.4,
    sides: 0.25,
    /** 贴地喷射：初速（米/秒）、衰减时间常数（秒）。走的距离约 = 初速 × 时间常数 */
    speed: [0.6, 1.7] as const,
    tau: [0.14, 0.26] as const,
    /** 喷射方向在边的法线两侧散开的程度（切向分量 / 法向分量） */
    spread: 0.9,
    /** 向上：初速（米/秒）、时间常数；之后慢慢卷起 rise 米（时间常数 riseTau），settleFrom 秒后以 settle 米/秒落下 */
    up: [0.12, 0.5] as const,
    upTau: 0.3,
    rise: [0.04, 0.16] as const,
    riseTau: 0.7,
    settleFrom: 0.5,
    settle: [0.015, 0.05] as const,
    /** 画框背上震起的灰：往上的初速（米/秒） */
    topUp: [0.18, 0.5] as const,
    /** 噪声扰动的幅度（米）、频率（每米）、随年龄出现的时间常数 */
    turb: 0.1,
    turbFreq: 1.7,
    turbTau: 0.5,
    /** 大小（米）：刚出来 size0，涨到 size1（时间常数 growTau） */
    size0: [0.07, 0.12] as const,
    size1: [0.28, 0.52] as const,
    growTau: 0.5,
    /** 寿命（秒），最后 1 − fadeFrom 的那一段淡出 */
    life: [1.4, 2.0] as const,
    fadeFrom: 0.3,
    /** 不透明度峰值；涨大以后按 (size0 / size)^thin 变稀 */
    alpha: [0.2, 0.36] as const,
    thin: 0.7,
    /** 各颗之间错开出现（秒） */
    stagger: 0.06,
    /** 慢慢转（弧度/秒，±） */
    spin: 0.5,
    /** 软粒子：和后面表面的深度差在这么多米内淡掉 */
    soft: 0.12,
  },
  chips: {
    count: { high: 9, low: 5 },
    /** 水平初速、竖直初速（米/秒），重力（米/秒²） */
    speed: [0.45, 1.25] as const,
    up: [0.9, 1.6] as const,
    gravity: 9.8,
    /** 落地后再弹一下：竖直速度、水平速度各保留多少；之后再滑 slide 米停下 */
    bounceUp: 0.28,
    bounceSide: 0.45,
    slide: 0.03,
    /** 大小（米） */
    size: [0.022, 0.04] as const,
    /** 落地以后留多久（秒）再在 0.8 秒里淡掉 */
    life: [2.6, 3.6] as const,
  },
  /**
   * 往下落的灰（BurstShape.fall 给了才有，衣柜：门撞上以后柜顶积的灰从边上翻下去，慢慢落到门前的地上）。
   * 只有从四边翻出去的灰落（靠转轴那条边除外：衣柜那一边贴着墙），从落点中间震起来的照旧悬一会儿、淡掉。
   * 一颗颗在 stagger 秒里先后翻下去（不是一圈同时离开边沿）；每颗的寿命是 (fall − stagger) 秒的 life[0]..life[1] 倍（随机），
   * 所以全部在 fall 秒内落完。在寿命的 land 倍时落到地面——按这个算出终速，tau 秒里从静止追上终速
   * （先慢后快，像细灰在空气里落，越落越稳），落到地面停住，寿命最后 1 − fadeFrom 那一段淡掉
   */
  fall: { stagger: 0.6, life: [0.45, 1] as const, land: 0.85, tau: 0.45, fadeFrom: 0.7 },
  /** 灰和碎屑的底色（线性）：旧灰泥和画框打底的石膏，灰褐 */
  albedo: new THREE.Color(0.36, 0.32, 0.26),
  chipAlbedo: new THREE.Color(0.42, 0.36, 0.25),
  /** 受到的光 × gain（大约是 Lambert 的 1/π 再压一点：灰是灰褐色，不能被照成一团白） */
  gain: 0.07,
  /** 光锥外的溢光（见 light.ts），和月光底色（× FOG.ambient）的倍数 */
  spill: 0.5,
  ambient: 1.6,
  /** prefers-reduced-motion：喷射速度和扰动乘这个，碎屑只留这个比例 */
  reducedMotion: 0.6,
};

/** 一次扬尘的形状；每一项不给就是肖像砸地的那一套（PLASTER.slab、PLASTER.dust、碎屑照常） */
export interface BurstShape {
  /** 灰从哪一圈起来：落点（矩形）的半宽、半长（米） */
  halfW?: number;
  halfL?: number;
  /** 从四边喷出去的比例（其余从落点中间震起来） */
  edgeShare?: number;
  /** 灰的颗数、大小、喷射快慢，各乘这个比例 */
  count?: number;
  size?: number;
  speed?: number;
  /** false = 不崩碎屑 */
  chips?: boolean;
  /**
   * 往下落（秒）：四边翻出去的灰在这么多秒里一颗颗慢慢落到地上（见 PLASTER.fall；衣柜用 WARDROBE.settle）。
   * 不给（肖像、床）就不落，和原来完全一样
   */
  fall?: number;
}

/**
 * 这一次扬尘最长的一颗能活多久（秒，从 burst 的 t0 算起）：过了就可以把整个物体藏起来、不再拷软粒子的深度。
 * 按这一次的形状算（没有碎屑就不等碎屑的 3.6 秒；落灰按 fall 算），不是全局的最长寿命
 */
export function burstLife(shape: BurstShape = {}): number {
  const D = PLASTER.dust;
  // 不落的灰最长 life[1] + stagger；落灰（先后错开、寿命按 fall − fall.stagger 算）全在 fall 秒内落完
  const dust = Math.max(D.life[1] + D.stagger, shape.fall ?? 0);
  return (shape.chips ?? true) ? Math.max(dust, PLASTER.chips.life[1]) : dust;
}

export interface Plaster {
  object: THREE.Sprite;
  /**
   * 在 t0（ctx.time 的时间轴）砸地。center：画框中心（房屋坐标）；axisW / axisL：画框宽、长方向（长方向从转轴指向画框上沿）。
   * shape：换一套形状（床、衣柜用）。返回这一次最长的一颗能活多久（秒，burstLife）
   */
  burst(t0: number, center: THREE.Vector3, axisW: THREE.Vector3, axisL: THREE.Vector3, shape?: BurstShape): number;
  setQuality(q: 'high' | 'low'): void;
  setReduced(on: boolean): void;
  dispose(): void;
}

export function createPlaster(light: LightUniforms, time: THREE.UniformNode<'float', number>): Plaster {
  const D = PLASTER.dust, C = PLASTER.chips;
  const N = D.count.high, NC = C.count.high;
  const uT0 = uniform(-1000);
  const uSeed = uniform(0);
  const uCenter = uniform(new THREE.Vector3());
  const uAxisW = uniform(new THREE.Vector3(1, 0, 0));
  const uAxisL = uniform(new THREE.Vector3(0, 0, 1));
  const uDustN = uniform(N);
  const uChipN = uniform(NC);
  /** prefers-reduced-motion 时 < 1：喷得慢一点、扰动小一点 */
  const calm = uniform(1);
  const hw0 = PLASTER.slab.halfW, hl0 = (PLASTER.slab.z1 - PLASTER.slab.z0) / 2;
  /** 落点的半宽、半长；从四边喷出的比例；大小比例（每次 burst 写，默认就是肖像那一套） */
  const uHw = uniform(hw0);
  const uHl = uniform(hl0);
  const uEdge = uniform(D.edgeShare);
  const uSize = uniform(1);
  /** 往下落：这一次落多久（秒，0 = 不落）；落点离地多高（米，不落时 0） */
  const uFall = uniform(0);
  const uDrop = uniform(0);
  const FL = PLASTER.fall;

  const r = (k: number) => rnd(k, uSeed);
  const lerp = (a: number, b: number, t: F) => float(a).add(t.mul(b - a));
  const rng = (v: readonly [number, number], k: number) => lerp(v[0], v[1], r(k));
  const ease = (t: F, tau: number | F) => float(1).sub(exp(t.negate().div(tau)));

  const idx = float(instanceIndex);
  const chip = ge(idx, N); // 1 = 碎屑，0 = 灰（全部用 0 / 1 混合，不用 select，见 common.ts 的 ge / lt）
  const dust = float(1).sub(chip);
  const activeF = mix(lt(idx, uDustN), lt(idx.sub(N), uChipN), chip);

  // —— 起点在画框的哪条边、往哪个方向喷（画框局部：x 沿宽、z 沿长，原点在画框中心）——
  const u1 = r(1), u2 = r(2);
  const inFar = lt(u1, D.far), inR0 = lt(u1, D.far + D.sides), inL0 = lt(u1, D.far + D.sides * 2);
  const fFar = inFar, fR = inR0.sub(inFar), fL = inL0.sub(inR0), fNear = float(1).sub(inL0);
  const along = mix(uHl.negate(), uHl, sqrt(u2)); // 长边上偏向上沿（上沿最后着地，压出来的气最多）
  const across = mix(uHw.negate(), uHw, u2);
  const ex = across.mul(fFar.add(fNear)).add(fR.sub(fL).mul(uHw));
  const ez = along.mul(fR.add(fL)).add(fFar.sub(fNear).mul(uHl));
  const nx = fR.sub(fL), nz = fFar.sub(fNear);
  // 切向散开
  const sp = r(3).sub(0.5).mul(D.spread * 2);
  const dxRaw = nx.add(nz.negate().mul(sp)), dzRaw = nz.add(nx.mul(sp));
  const dl = sqrt(dxRaw.mul(dxRaw).add(dzRaw.mul(dzRaw)));
  const dirX = dxRaw.div(dl), dirZ = dzRaw.div(dl);

  // —— 灰 ——
  const fe = lt(r(4), uEdge); // 1 = 从四边喷出，0 = 从画框背上震起
  // 1 = 这一颗往下落（给了 fall：四边翻出去的，靠转轴那条边除外），0 = 原来那一套。不给 fall 时全是 0：
  // 下面乘 keep 的项乘的是 1、减 fallF 那一项减的是 0、mix(…, fallF) 取的是原值，算出来和原来一样
  const fallF = lt(float(0), uFall).mul(fe).mul(float(1).sub(fNear));
  const keep = float(1).sub(fallF);
  const delay = r(5).mul(mix(float(D.stagger), float(FL.stagger), fallF)).mul(dust);
  const age = time.sub(uT0).sub(delay);
  const ageC = max(age, 0);
  const vScale = calm;
  const tau = rng(D.tau, 7);
  const h = mix(r(6).mul(0.05), rng(D.speed, 6).mul(vScale).mul(tau).mul(ease(ageC, tau)), fe);
  const topX = mix(uHw.negate(), uHw, r(8)), topZ = mix(uHl.negate(), uHl, r(9));
  const lx0 = mix(topX, ex, fe), lz0 = mix(topZ, ez, fe);
  const y0 = mix(float(0.06), lerp(0.015, 0.05, r(10)), fe);
  const vy = mix(rng(D.topUp, 11), rng(D.up, 11), fe).mul(vScale);
  const settle = rng(D.settle, 12).mul(max(ageC.sub(D.settleFrom), 0));
  // 寿命（落灰：(fall − stagger) 秒的 life[0]..life[1] 倍，加上错开的那一点也在 fall 秒内）
  const lifeD = mix(rng(D.life, 20), max(uFall.sub(FL.stagger), 0.5).mul(lerp(FL.life[0], FL.life[1], r(20))), fallF);
  // 往下落：寿命的 land 倍时落到地面（从起点往下 uDrop + y0）。终速 = 落差 / (land × 寿命 − tau)，tau 秒里从静止追上，
  // 走过的距离 = 终速 × (t − tau × (1 − e^(−t/tau)))
  const vFall = uDrop.add(y0).div(max(lifeD.mul(FL.land).sub(FL.tau), 0.25));
  const fallBy = vFall.mul(ageC.sub(ease(ageC, FL.tau).mul(FL.tau)));
  const yDust = max(
    y0.add(vy.mul(D.upTau).mul(ease(ageC, D.upTau))).add(rng(D.rise, 13).mul(ease(ageC, D.riseTau)).mul(keep))
      .sub(settle.mul(keep)).sub(fallBy.mul(fallF)),
    // 下限：原来贴着落点（不钻进地板 / 被子 / 柜顶）；落灰落到地面为止（落点下面 uDrop 米）
    mix(float(0.025), float(0.02).sub(uDrop), fallF),
  );
  const n0 = vec3(lx0.mul(D.turbFreq), r(14).mul(40), lz0.mul(D.turbFreq));
  const turb = mx_noise_vec3(n0.add(vec3(ageC.mul(0.35), ageC.mul(0.6), ageC.mul(-0.3)))).mul(calm.mul(D.turb)).mul(ease(ageC, D.turbTau));
  const dustLocal = vec3(lx0.add(dirX.mul(h)), yDust, lz0.add(dirZ.mul(h)));

  // —— 碎屑：从上沿、两条长边靠上的那一段崩出去，抛物线落地、再弹一小下，最后滑一点停住 ——
  const g = C.gravity;
  const cvh = rng(C.speed, 15).mul(vScale), cvy = rng(C.up, 16).mul(sqrt(calm));
  const t1 = cvy.mul(2 / g);
  const vy2 = cvy.mul(C.bounceUp), vh2 = cvh.mul(C.bounceSide);
  const t2 = vy2.mul(2 / g);
  const ta = min(ageC, t1); // 第一跳里的时间
  const tb = min(max(ageC.sub(t1), 0), t2); // 第二跳里的时间
  const tc = max(ageC.sub(t1).sub(t2), 0); // 落定以后
  const chipH = cvh.mul(ta).add(vh2.mul(tb)).add(smoothstep(0, 0.15, tc).mul(C.slide));
  const hop1 = cvy.mul(ta).sub(ta.mul(ta).mul(g / 2)), hop2 = vy2.mul(tb).sub(tb.mul(tb).mul(g / 2));
  const chipY = max(hop1.mul(lt(ageC, t1)).add(hop2.mul(ge(ageC, t1))), 0);
  const chipSize = rng(C.size, 17);
  const cEdgeZ = mix(along.mul(0.5).add(uHl.mul(0.5)), uHl, fFar);
  const chipLocal = vec3(ex.add(dirX.mul(chipH)), chipY.add(chipSize.mul(0.5)), cEdgeZ.add(dirZ.mul(chipH)));

  // —— 画框局部 → 房屋坐标 ——
  const local = mix(dustLocal, chipLocal, chip);
  const p: V3 = uCenter.add(uAxisW.mul(local.x)).add(vec3(0, local.y, 0)).add(uAxisL.mul(local.z)).add(turb.mul(dust));

  // —— 大小、不透明度、寿命 ——
  const s0 = rng(D.size0, 18).mul(uSize), s1 = rng(D.size1, 19).mul(uSize);
  const dustSize = s0.add(s1.sub(s0).mul(ease(ageC, D.growTau)));
  const lifeC = rng(C.life, 20);
  const life = mix(lifeD, lifeC, chip);
  const fadeFrom = mix(float(D.fadeFrom), float(FL.fadeFrom), fallF);
  const fadeD = smoothstep(0, 0.05, age).mul(float(1).sub(smoothstep(lifeD.mul(fadeFrom), lifeD, age)));
  const alphaD = rng(D.alpha, 21).mul(fadeD).mul(pow(s0.div(dustSize), D.thin));
  const alphaC = float(1).sub(smoothstep(lifeC.sub(0.8), lifeC, age));
  const aliveF = activeF.mul(ge(age, 0)).mul(lt(age, life));
  const size = mix(dustSize, chipSize, chip).mul(aliveF);

  // —— 光：底色 × (月光底色 + 手电 / 台灯) ——
  const L = lightAt(light, p, { spill: PLASTER.spill, points: true });
  const amb = FOG.ambient.clone().multiplyScalar(PLASTER.ambient);
  const lit = L.mul(PLASTER.gain).add(vec3(amb.r, amb.g, amb.b));
  const albedo = mix(
    vec3(PLASTER.albedo.r, PLASTER.albedo.g, PLASTER.albedo.b).mul(lerp(0.85, 1.1, r(22))),
    vec3(PLASTER.chipAlbedo.r, PLASTER.chipAlbedo.g, PLASTER.chipAlbedo.b).mul(lerp(0.6, 1.1, r(22))),
    chip,
  );
  const vCol = varying(albedo.mul(lit), 'vPlasterCol');
  const vAlpha = varying(mix(alphaD, alphaC, chip), 'vPlasterA');
  const vHard = varying(chip, 'vPlasterHard');
  const vSeed = varying(r(23), 'vPlasterSeed');
  const vz = centerViewZ(p);

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, fog: false,
  });
  mat.positionNode = p;
  mat.scaleNode = vec2(size, size);
  mat.rotationNode = r(24).mul(Math.PI * 2).add(r(25).sub(0.5).mul(D.spin * 2).mul(ageC));
  // 片元：灰是一团高斯软斑，浓淡被噪声搅得不均匀（很多团叠在一起才像一片烟尘，单独一团看不出边）；碎屑是边缘利落的小点
  const q = uv().sub(0.5).mul(2);
  const d = length(q);
  const wob = mx_noise_float(vec3(q.mul(1.8).add(vSeed.mul(37)), vSeed.mul(11))).mul(0.5).add(0.5);
  const dustEdge = exp(d.mul(d).mul(-3.2)).mul(wob.mul(0.7).add(0.45)).mul(float(1).sub(smoothstep(0.8, 1.0, d)));
  const chipEdge = float(1).sub(smoothstep(0.55, 0.9, d));
  const shape = mix(dustEdge, chipEdge, vHard);
  mat.colorNode = vCol;
  mat.opacityNode = vAlpha.mul(shape).mul(softFade(vz, mix(float(D.soft), float(0.015), vHard)));
  mat.alphaTest = 0.003;
  protectMRT(mat);

  const object = makeSprite(mat, N + NC, 'portrait-plaster-dust', 2.5);
  let seed = 0;
  let quality: 'high' | 'low' = 'high';
  let reduced = false;
  /** 这一次扬尘的形状（颗数、喷射快慢的比例；碎屑要不要），burst 时写 */
  let burstShape: Required<Pick<BurstShape, 'count' | 'speed' | 'chips'>> = { count: 1, speed: 1, chips: true };
  const applyCounts = () => {
    uDustN.value = Math.max(1, Math.round(D.count[quality] * burstShape.count));
    uChipN.value = burstShape.chips ? Math.max(1, Math.round(C.count[quality] * (reduced ? PLASTER.reducedMotion : 1))) : 0;
    calm.value = (reduced ? PLASTER.reducedMotion : 1) * burstShape.speed;
  };

  return {
    object,
    burst(t0, center, axisW, axisL, opts = {}) {
      uHw.value = opts.halfW ?? hw0;
      uHl.value = opts.halfL ?? hl0;
      uEdge.value = opts.edgeShare ?? D.edgeShare;
      uSize.value = opts.size ?? 1;
      uFall.value = opts.fall ?? 0;
      // center 是房屋坐标，y 就是离地高度
      uDrop.value = opts.fall ? center.y : 0;
      burstShape = { count: opts.count ?? 1, speed: opts.speed ?? 1, chips: opts.chips ?? true };
      applyCounts();
      uT0.value = t0;
      seed = (seed + 7919) % 1_000_000; // 每次换一套随机数：每次砸下去的样子都不一样
      uSeed.value = seed;
      uCenter.value.copy(center);
      uAxisW.value.copy(axisW);
      uAxisL.value.copy(axisL);
      return burstLife(opts);
    },
    setQuality(q) { quality = q; applyCounts(); },
    setReduced(on) { reduced = on; applyCounts(); },
    dispose() { mat.dispose(); },
  };
}
