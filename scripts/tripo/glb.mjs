// GLB 检查（纯 JS，不依赖 three）：三角面数、贴图尺寸、压缩扩展、骨骼命名、动画片段名，以及「是不是原地动画」的粗查。
// 结果对照 README「换上吉祥物」里的游戏要求：≤ 约 1.5 万三角面、贴图 ≤ 2048、meshopt 或不压缩（不接 Draco / KTX2）、原地动画。
// 原地动画这里只是粗查；准的要在 dev/characters.html 里跑 __chars.calibrate()（rootMotion 必须是 false）。

export const GAME_LIMITS = { triangles: 15000, texture: 2048 };

/** 读 PNG / JPEG / WebP 的文件头：{ mime, width, height }；不认识返回 null */
export function imageInfo(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) {
        o++;
        continue;
      }
      const m = buf[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
        o += 2;
        continue;
      }
      const len = buf.readUInt16BE(o + 2);
      // SOF0–SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + len;
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const cc = buf.toString('latin1', 12, 16);
    if (cc === 'VP8X') return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (cc === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
    }
    if (cc === 'VP8 ') return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return { mime: 'image/webp', width: null, height: null };
  }
  return null;
}

/** 拆 GLB：{ json, bin } */
export function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件（文件头不是 glTF）');
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`GLB 版本 ${version}，只认 2`);
  const total = Math.min(buf.readUInt32LE(8), buf.length);
  let o = 12;
  let json = null;
  let bin = null;
  while (o + 8 <= total) {
    const len = buf.readUInt32LE(o);
    const type = buf.readUInt32LE(o + 4);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942 && !bin) bin = data;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB 里没有 JSON 块');
  return { json, bin };
}

/** 读一个 FLOAT VEC3 accessor（动画的位移轨道）；别的格式返回 null（不硬猜） */
function readVec3(json, bin, index) {
  const a = json.accessors?.[index];
  if (!a || a.type !== 'VEC3' || a.componentType !== 5126 || a.sparse || a.bufferView == null || !bin) return null;
  const v = json.bufferViews[a.bufferView];
  const stride = v.byteStride || 12;
  const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < a.count; i++) {
    const p = base + i * stride;
    if (p + 12 > bin.length) return null;
    out.push([bin.readFloatLE(p), bin.readFloatLE(p + 4), bin.readFloatLE(p + 8)]);
  }
  return out;
}

const stripPrefix = (n) => String(n ?? '').replace(/^mixamorig\d*[:_]/i, '');
const MIXAMO_CORE = ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'];

export function inspectGlb(buf) {
  const { json, bin } = parseGlb(buf);
  const acc = json.accessors ?? [];
  const nodes = json.nodes ?? [];
  const exts = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);

  const parent = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const ancestors = (i) => {
    const out = [];
    for (let p = parent.get(i); p != null && out.length < 256; p = parent.get(p)) out.push(p);
    return out;
  };
  // 父链上的缩放（只取 x 分量，忽略旋转）：用来把不同层级的位移换到同一个尺度上比较
  const chainScale = (i) => ancestors(i).reduce((s, p) => s * Math.abs(nodes[p].scale?.[0] ?? 1), 1);

  // 三角面：按场景里实际挂着的次数算
  const uses = new Map();
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !parent.has(i));
  const seen = new Set();
  const visit = (i) => {
    if (seen.has(i) || !nodes[i]) return;
    seen.add(i);
    if (nodes[i].mesh != null) uses.set(nodes[i].mesh, (uses.get(nodes[i].mesh) ?? 0) + 1);
    (nodes[i].children ?? []).forEach(visit);
  };
  roots.forEach(visit);
  let triangles = 0;
  let primitives = 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  (json.meshes ?? []).forEach((m, mi) => {
    const k = uses.get(mi) ?? 0;
    for (const p of m.primitives ?? []) {
      primitives++;
      const mode = p.mode ?? 4;
      const count = (p.indices != null ? acc[p.indices]?.count : acc[p.attributes?.POSITION]?.count) ?? 0;
      const tris = mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
      triangles += tris * k;
      const pos = acc[p.attributes?.POSITION];
      if (pos?.min && pos?.max) for (let j = 0; j < 3; j++) (lo[j] = Math.min(lo[j], pos.min[j])), (hi[j] = Math.max(hi[j], pos.max[j]));
    }
  });

  // 贴图
  const images = (json.images ?? []).map((im, i) => {
    let bytes = null;
    if (im.bufferView != null && bin) {
      const v = json.bufferViews[im.bufferView];
      bytes = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    } else if (typeof im.uri === 'string' && im.uri.startsWith('data:')) bytes = Buffer.from(im.uri.split(',')[1] ?? '', 'base64');
    const info = bytes ? imageInfo(bytes) : null;
    return { index: i, name: im.name ?? null, mime: im.mimeType ?? info?.mime ?? null, width: info?.width ?? null, height: info?.height ?? null, bytes: bytes?.length ?? null, external: !bytes && !!im.uri };
  });
  const maxTexture = images.reduce((m, im) => Math.max(m, im.width ?? 0, im.height ?? 0), 0);

  // 骨骼
  const skins = (json.skins ?? []).map((s) => s.joints ?? []);
  const jointIdx = [...new Set(skins.flat())];
  const jointNames = jointIdx.map((j) => nodes[j]?.name ?? `node_${j}`);
  const prefixed = jointNames.filter((n) => /^mixamorig\d*[:_]/i.test(n)).length;
  const core = MIXAMO_CORE.filter((b) => jointNames.some((n) => stripPrefix(n) === b)).length;
  const boneNaming = !jointNames.length
    ? '无骨骼'
    : prefixed >= jointNames.length / 2
      ? 'mixamo（mixamorig 前缀）'
      : core >= 8
        ? 'mixamo 风格（无前缀）'
        : '其他';
  const hips =
    jointIdx.find((j) => stripPrefix(nodes[j]?.name) === 'Hips') ??
    jointIdx.find((j) => /hip|pelvis/i.test(nodes[j]?.name ?? '')) ??
    skins[0]?.[0] ??
    null;

  // 动画：片段名按 three.js GLTFLoader 的规则（没名字的叫 animation_<序号>），这样写进 manifest 的名字和游戏里拿到的一致
  const animations = (json.animations ?? []).map((a, ai) => {
    const name = a.name || `animation_${ai}`;
    let duration = 0;
    for (const s of a.samplers ?? []) {
      const inp = acc[s.input];
      if (inp?.max?.[0] != null) duration = Math.max(duration, inp.max[0]);
    }
    // 粗查原地：看 Hips 及其祖先节点上的位移轨道。原地循环的首尾帧回到同一处（跑步时胯部前后晃得再大也一样），
    // 带根运动的片段首尾帧水平方向差出一大截。net = 首尾帧的水平距离，sway = 水平晃动范围，都除以胯高
    let net = null;
    let sway = null;
    let ref = null;
    if (hips != null) {
      const hipsChain = new Set([hips, ...ancestors(hips)]);
      const restY = Math.abs(nodes[hips].translation?.[1] ?? 0) * chainScale(hips);
      let animY = 0;
      for (const ch of a.channels ?? []) {
        const n = ch.target?.node;
        if (ch.target?.path !== 'translation' || !hipsChain.has(n)) continue;
        const out = readVec3(json, bin, a.samplers?.[ch.sampler]?.output);
        if (!out?.length) continue;
        const s = chainScale(n);
        const first = out[0];
        const last = out[out.length - 1];
        const xs = out.map((p) => p[0]);
        const zs = out.map((p) => p[2]);
        net = Math.max(net ?? 0, Math.hypot(last[0] - first[0], last[2] - first[2]) * s);
        sway = Math.max(sway ?? 0, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * s);
        if (n === hips) animY = Math.max(animY, ...out.map((p) => Math.abs(p[1]) * s));
      }
      ref = restY > 1e-6 ? restY : animY > 1e-6 ? animY : null;
    }
    const ratio = (x) => (x == null ? null : ref ? Number((x / ref).toFixed(3)) : x === 0 ? 0 : null);
    const netRatio = ratio(net);
    return {
      name,
      duration: Number(duration.toFixed(3)),
      channels: (a.channels ?? []).length,
      netRatio,
      swayRatio: ratio(sway),
      inPlace: netRatio == null ? null : netRatio < 0.25,
    };
  });

  return {
    bytes: buf.length,
    generator: json.asset?.generator ?? null,
    extensions: [...exts],
    meshopt: exts.has('EXT_meshopt_compression'),
    quantized: exts.has('KHR_mesh_quantization'),
    draco: exts.has('KHR_draco_mesh_compression'),
    ktx2: exts.has('KHR_texture_basisu'),
    triangles,
    primitives,
    meshes: (json.meshes ?? []).length,
    materials: (json.materials ?? []).length,
    rawExtent: Number.isFinite(lo[0]) ? hi.map((h, j) => Number((h - lo[j]).toFixed(4))) : null,
    images,
    maxTexture,
    joints: jointNames.length,
    jointSample: jointNames.slice(0, 6),
    boneNaming,
    hips: hips != null ? nodes[hips]?.name ?? `node_${hips}` : null,
    animations,
  };
}

/** 对照游戏要求：problems 是必须处理的，notes 是提醒 */
export function checkForGame(info) {
  const problems = [];
  const notes = [];
  if (info.triangles > GAME_LIMITS.triangles) problems.push(`三角面 ${info.triangles} > ${GAME_LIMITS.triangles}`);
  if (info.maxTexture > GAME_LIMITS.texture) problems.push(`贴图最大 ${info.maxTexture}px > ${GAME_LIMITS.texture}（可以在 visitors.json 里打开 convert 步骤，texture_size=2048）`);
  if (info.images.some((im) => im.width == null && !im.external)) notes.push('有贴图读不出尺寸（可能是 KTX2 或少见格式）');
  if (info.draco) problems.push('用了 Draco 压缩（游戏没接 Draco 解码）');
  if (info.ktx2) problems.push('用了 KTX2 / Basis 贴图（游戏没接）');
  if (!info.joints) problems.push('没有骨骼（没绑上？）');
  else if (!info.boneNaming.startsWith('mixamo')) notes.push(`骨骼命名不像 Mixamo（${info.jointSample.join('、')}…），以后从 Mixamo 补动作可能对不上`);
  if (!info.animations.length) problems.push('没有动画片段');
  const moving = info.animations.filter((a) => a.inPlace === false).map((a) => `${a.name}（首尾帧水平差出胯高的 ${a.netRatio} 倍）`);
  if (moving.length) problems.push(`这些片段看起来带位移，不是原地动画：${moving.join('、')}`);
  const unknown = info.animations.filter((a) => a.inPlace == null).map((a) => a.name);
  if (unknown.length) notes.push(`没法粗查是否原地：${unknown.join('、')}（以 dev/characters.html 的 calibrate() 为准）`);
  return { ok: problems.length === 0, problems, notes };
}

/** 给人看的多行摘要 */
export function formatInspection(info, check = checkForGame(info)) {
  const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;
  const lines = [
    `  文件 ${mb(info.bytes)}${info.generator ? ` · 导出器 ${info.generator}` : ''}`,
    `  三角面 ${info.triangles}（${info.meshes} 个网格 / ${info.primitives} 个图元 / ${info.materials} 个材质）· 压缩：${info.draco ? 'Draco' : info.meshopt ? 'meshopt' : '无'}${info.quantized ? ' + 量化' : ''}`,
    `  贴图 ${info.images.length} 张：${info.images.map((im) => `${im.width ?? '?'}×${im.height ?? '?'} ${im.mime ?? ''}`.trim()).join('，') || '无'}`,
    `  骨骼 ${info.joints} 根 · 命名：${info.boneNaming}${info.hips ? ` · 根骨 ${info.hips}` : ''}`,
    `  动画 ${info.animations.length} 段：${info.animations.map((a) => `${a.name} ${a.duration}s${a.inPlace === false ? '（带位移）' : ''}`).join('，') || '无'}`,
  ];
  if (info.rawExtent) lines.push(`  网格原始尺寸（未算节点缩放）${info.rawExtent.join(' × ')}；游戏会归一到 1.1 米高`);
  lines.push(check.ok ? '  ✓ 符合游戏要求' : `  ✗ ${check.problems.join('\n  ✗ ')}`);
  for (const n of check.notes) lines.push(`  · ${n}`);
  return lines.join('\n');
}
