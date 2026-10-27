// Tripo API（文档站 developers.tripo3d.ai）的价目表和预设动作表：只用来在本地估算积分、校验清单，不联网。
//
// 价格出处：https://developers.tripo3d.ai/en/pricing（2026-10-27 读取，1 积分 = 0.01 美元）；
//   P2 的价格出自 https://developers.tripo3d.ai/en/docs/changelog.md（2026-08 条目），P1 的价格页面上是前端切换的标签页，没读到 → 未核实。
// 预设动作出处：animations-retarget.md（Tripo API网站/docs/research/2026-10-22/tripo-docs/）。
// 价格会变：真实扣费以任务结果里的 credits_consumed 为准，流水线会把它记进状态文件。

export const PRICING_SOURCE = 'developers.tripo3d.ai/en/pricing（2026-10-27 读取）';
export const USD_PER_CREDIT = 0.01;

/** 图像生成（text-to-image / image-to-image），按尺寸档：≤1K / 2K / 4K。缺的档 = 该模型不支持 */
const IMAGE_BASE = {
  seedream_v5: { '1k': 5, '2k': 5, '4k': 5 },
  seedream_v4: { '1k': 5, '2k': 5, '4k': 5 },
  banana: { '1k': 5 },
  banana2: { '1k': 10, '2k': 10, '4k': 15 },
  banana_pro: { '1k': 15, '2k': 15, '4k': 20 },
  chat_image_1: { '1k': 5 },
  'chat_image_1.5': { '1k': 10 },
  chat_image_2: { '1k': 10, '2k': 10, '4k': 15 },
  'chat_image_2.5_flare': { '1k': 10, '2k': 10, '4k': 15 },
  'chat_image_2.5_sunburst': { '1k': 10, '2k': 10, '4k': 15 },
};
/** chat_image 的 quality 加价档；low / medium 按基础价 */
const IMAGE_QUALITY = {
  chat_image_2: { high: { '1k': 20, '2k': 25, '4k': 40 } },
  'chat_image_2.5': {
    high: { '1k': 20, '2k': 25, '4k': 40 },
    xhigh: { '1k': 25, '2k': 30, '4k': 45 },
    max: { '1k': 30, '2k': 50, '4k': 50 },
  },
};

/** 只有这些模型收 quality（image-to-image 文档：传给别的模型会报错） */
export const QUALITY_MODELS = ['chat_image_2', 'chat_image_2.5_flare', 'chat_image_2.5_sunburst'];
/** 只有这些模型认 background（传给别的模型会被忽略） */
export const BACKGROUND_MODELS = ['chat_image_2.5_flare', 'chat_image_2.5_sunburst'];
export const IMAGE_MODELS = Object.keys(IMAGE_BASE);
export const IMAGE_TEMPLATES = ['t_pose', 'character_completion', '3d_enhance', 'variants', 'figure'];

/** size → 价格档。不传时文档默认 2048x2048；size=auto 按 2K 计（价目表原话） */
export function sizeTier(size) {
  if (size == null || /^auto$/i.test(size)) return '2k';
  const kw = /^([124])k$/i.exec(String(size));
  if (kw) return `${kw[1]}k`;
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size));
  if (!m) return null;
  const long = Math.max(Number(m[1]), Number(m[2]));
  return long <= 1024 ? '1k' : long <= 2048 ? '2k' : '4k';
}

/** image-to-image 一次的积分。返回 { credits, note }；credits 为 null 表示价目表里查不到 */
export function imageCredits(body) {
  const model = body.model ?? 'seedream_v5'; // image-to-image 的默认模型
  const tier = sizeTier(body.size);
  const table = IMAGE_BASE[model];
  if (!table || !tier) return { credits: null, note: `价目表里没有 ${model} / ${body.size ?? '默认尺寸'}（未核实）` };
  const q = body.quality;
  if (q && !['low', 'medium'].includes(q)) {
    const family = model.startsWith('chat_image_2.5') ? 'chat_image_2.5' : model;
    const price = IMAGE_QUALITY[family]?.[q]?.[tier];
    if (price == null) return { credits: null, note: `价目表里没有 ${model} quality=${q}（未核实）` };
    return { credits: price, note: `${model} ${tier.toUpperCase()} quality=${q}` };
  }
  const price = table[tier];
  if (price == null) return { credits: null, note: `${model} 不支持 ${tier.toUpperCase()}` };
  return { credits: price, note: `${model} ${tier.toUpperCase()}${q ? ` quality=${q}` : ''}` };
}

/** image-to-model / multiview-to-model 一次的积分 */
export function model3dCredits(body) {
  const model = body.model ?? 'v3.1-20260211';
  // pbr 默认 true，且 pbr=true 会强制 texture=true；两个都显式 false 才是无纹理
  const textured = !(body.texture === false && body.pbr === false);
  const tq = body.texture_quality ?? 'standard';
  if (model.startsWith('P2-')) {
    if (!textured) return { credits: 100, note: 'P2 无纹理（changelog 2026-08）' };
    const p = { fast: 110, standard: 110, detailed: 120, extreme: 130 }[tq];
    return { credits: p ?? null, note: `P2 ${tq} 纹理（changelog 2026-08）` };
  }
  if (model.startsWith('P1-')) return { credits: null, note: 'P1 价格在价目页的前端标签页里，没读到（未核实）' };
  // H 系列：无纹理 20 / 标准纹理 30，加项叠加
  let c = textured ? 30 : 20;
  const parts = [textured ? '标准纹理 30' : '无纹理 20'];
  if (textured && tq === 'detailed') { c += 10; parts.push('HD 纹理 +10'); }
  if (textured && tq === 'extreme') { c += 20; parts.push('8K 纹理 +20'); }
  if (body.geometry_quality === 'detailed') { c += 20; parts.push('HD 几何 +20'); }
  if (body.quad) { c += 5; parts.push('四边面 +5'); }
  if (body.smart_low_poly) { c += 10; parts.push('Smart Low-poly +10'); }
  if (body.generate_parts) { c += 20; parts.push('分件 +20'); }
  return { credits: c, note: `H 系列 ${model}：${parts.join('，')}` };
}

export const RIG_CHECK_CREDITS = 0;
export const RIG_CREDITS = 25;
export const RETARGET_CREDITS_PER_CLIP = 10;
export const IMAGE_TO_MULTIVIEW_CREDITS = 10;

/** 格式转换：下面任何一个参数取了非默认值就按「高级」10 积分，否则「基础」5 积分（价目表原话） */
const CONVERT_ADVANCED_DEFAULTS = {
  quad: false, face_limit: undefined, flatten_bottom: false, flatten_bottom_threshold: 0.01,
  texture_size: 4096, texture_format: 'JPEG', pivot_to_center_bottom: false, scale_factor: 1,
};
export function convertCredits(body) {
  const adv = Object.entries(CONVERT_ADVANCED_DEFAULTS).filter(([k, d]) => body[k] !== undefined && body[k] !== d).map(([k]) => k);
  return adv.length ? { credits: 10, note: `高级转换（${adv.join('、')} 非默认）` } : { credits: 5, note: '基础转换' };
}

/** 绑骨 v1.0-20240301 能用的人形预设（90+ 个，文档原表） */
export const V1_BIPED_PRESETS = [
  'afraid', 'agree', 'angry_01', 'angry_02', 'angry_03', 'basketball_shot', 'bow', 'box_01', 'box_02', 'box_03',
  'cast_a_spell', 'cheer', 'chop', 'clap', 'climb', 'complain_01', 'complain_02', 'cross_body_crunch', 'crossover_dribble',
  'cry', 'dance_01', 'dance_02', 'dance_03', 'dance_04', 'dance_05', 'dance_06', 'defeat_02', 'defeat_03', 'depressed',
  'dig', 'dive', 'dribble', 'fall', 'fire', 'flee_01', 'flee_02', 'flip', 'fold_arms', 'football_catch', 'football_pass',
  'football_save', 'freaky', 'frightened', 'front_kick_01', 'front_kick_02', 'frustrated_01', 'frustrated_02', 'golf',
  'greet_01', 'greet_02', 'greet_03', 'greet_04', 'heart_pose', 'hit_to_body_01', 'hit_to_body_02', 'hit_to_head',
  'hit_to_side', 'hit_to_stomach', 'hug', 'hurt', 'idle', 'jump', 'jump_down', 'jump_rope_01', 'jump_rope_02',
  'laugh_01', 'laugh_02', 'lift_heavy', 'look_around', 'make_a_call_01', 'make_a_call_02', 'pitch_baseball',
  'play_mobile_game', 'play_video_game', 'press-up', 'run', 'run_upstairs', 'scared_01', 'scared_02', 'scratch',
  'shoot', 'shovel', 'sing_01', 'sing_02', 'sing_03', 'sing_04', 'sit', 'slash', 'sob', 'standing_relax', 'surf',
  'swagger', 'swim', 'turn', 'victory_celebration', 'volleyball', 'wait', 'walk', 'warm_up', 'wave_goodbye_01',
  'wave_goodbye_02',
].map((s) => `preset:biped:${s}`);

/** 绑骨 v2.5 / v3.0 的人形预设（只有 11 个，没有害怕 / 张望类，所以这里用 v1.0） */
export const V25_BIPED_PRESETS = ['idle', 'walk', 'run', 'dive', 'climb', 'jump', 'slash', 'shoot', 'hurt', 'fall', 'turn'].map((s) => `preset:${s}`);

export const RIG_MODELS = ['v1.0-20240301', 'v2.5-20260210', 'v3.0-20260909'];
/** 一次 retarget 最多几个动作（多了直接报错） */
export const MAX_CLIPS_PER_RETARGET = 5;
