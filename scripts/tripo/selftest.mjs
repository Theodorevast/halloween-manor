// 流水线自测（不联网、不花钱）：起一个本地假 Tripo 服务，在 scripts/tripo/.selftest/ 里搭一个临时项目，把流水线从头跑几遍，确认：
//   - 重跑不会重复建任务；配置改了、建任务时断线、任务失败都会停下来等人处理；--adopt / --reroll 能接上
//   - key 不出现在任何输出、状态文件、manifest 里；下载结果文件时不带 key；发给 API 的请求都带对了 key
//   - 草稿只做到换装图；--until 生效；导出的 GLB、manifest.json、片段名对得上；结果文件丢了会重新查任务再下
//   node scripts/tripo/selftest.mjs        （VERBOSE=1 打印流水线的全部输出；失败时临时目录留着方便看）
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForGame, inspectGlb } from './glb.mjs';
import { DEFAULT_PATHS, main } from './pipeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOX = join(HERE, '.selftest');
const ROOT = join(BOX, `run-${process.pid}-${Date.now()}`);
// 故意不用 tsk_ 开头：只靠「登记过的 key 一律打码」这一层来挡，测得更严
const KEY = `selftest-${randomBytes(16).toString('hex')}`;

// ---------------------------------------------------------------- 假文件

function fakePng(w, h) {
  const b = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  b.write('IEND', 37, 'latin1'); // CRC 没人校验，留 0
  return b;
}

/** 一个最小的蒙皮 GLB：tris 个三角面、一张 texture 尺寸的 PNG 贴图、Mixamo 骨骼名、anims 里每个名字一段 Hips 位移动画 */
function makeGlb({ anims = [], texture = 2048, tris = 1, moving = false } = {}) {
  const parts = [];
  const views = [];
  const accessors = [];
  let off = 0;
  const push = (buf) => {
    const pad = (4 - (buf.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: off, byteLength: buf.length });
    parts.push(buf, Buffer.alloc(pad));
    off += buf.length + pad;
    return views.length - 1;
  };
  const pos = Buffer.alloc(tris * 36);
  for (let i = 0; i < tris * 3; i++) pos.writeFloatLE((i % 3) * 0.5, i * 12 + 4);
  accessors.push({ bufferView: push(pos), componentType: 5126, count: tris * 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] });
  const img = push(fakePng(texture, texture));
  const times = Buffer.alloc(8);
  times.writeFloatLE(1, 4);
  const tIn = accessors.push({ bufferView: push(times), componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] }) - 1;
  const tr = Buffer.alloc(24);
  tr.writeFloatLE(1, 4);
  tr.writeFloatLE(1, 16);
  tr.writeFloatLE(moving ? 3 : 0, 20);
  const tOut = accessors.push({ bufferView: push(tr), componentType: 5126, count: 2, type: 'VEC3' }) - 1;
  const joints = ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftUpLeg', 'RightUpLeg'].map((n) => `mixamorig:${n}`);
  const nodes = [
    { name: 'Armature', children: [1] },
    ...joints.map((name, i) => (i === 0 ? { name, translation: [0, 1, 0], children: joints.slice(1).map((_, j) => j + 2) } : { name })),
    { name: 'Body', mesh: 0, skin: 0 },
  ];
  const json = {
    asset: { version: '2.0', generator: 'selftest' },
    scene: 0,
    scenes: [{ nodes: [0, nodes.length - 1] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: img, mimeType: 'image/png' }],
    skins: [{ joints: joints.map((_, i) => i + 1) }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: off }],
  };
  if (anims.length) json.animations = anims.map((name) => ({ name, samplers: [{ input: tIn, output: tOut }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] }));
  const bin = Buffer.concat(parts);
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(js.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, js, bh, bin]);
}

// ---------------------------------------------------------------- 假 Tripo 服务

const TYPES = {
  '/v3/generation/image-to-image': 'image_to_image',
  '/v3/generation/image-to-model': 'image_to_model',
  '/v3/generation/image-to-multiview': 'generate_multiview_image',
  '/v3/generation/multiview-to-model': 'multiview_to_model',
  '/v3/animations/rig-check': 'animate_prerigcheck',
  '/v3/animations/rig': 'animate_rig',
  '/v3/animations/retarget': 'animate_retarget',
  '/v3/models/convert': 'convert_model',
};
const CREDITS = { image_to_image: 10, image_to_model: 30, generate_multiview_image: 10, multiview_to_model: 30, animate_prerigcheck: 0, animate_rig: 25, animate_retarget: 40, convert_model: 10 };

function startMock() {
  const m = { base: '', seq: 0, creates: [], uploads: 0, apiCalls: 0, badAuth: [], dlWithAuth: [], files: new Map(), tasks: new Map(), failNextCreate: false, nextStatus: null, phantom: null, animNames: ['Idle', 'Walk', 'Run', 'Scared_01'] };
  const makeTask = (path, body) => {
    const id = `task_${String(++m.seq).padStart(4, '0')}`;
    const type = TYPES[path];
    const dl = (name, buf) => {
      m.files.set(name, buf);
      return `${m.base}/dl/${name}?Policy=selftest&Signature=selftest`;
    };
    let output;
    if (type === 'image_to_image') output = { generated_image_url: dl(`${id}.png`, fakePng(2048, 2048)) };
    else if (type === 'generate_multiview_image') output = Object.fromEntries(['front', 'left', 'back', 'right'].map((v) => [`${v}_view_url`, dl(`${id}-${v}.png`, fakePng(1024, 1024))]));
    else if (type === 'animate_prerigcheck') output = { riggable: true, rig_type: 'biped' };
    else if (type === 'animate_retarget') output = { model_url: dl(`${id}.glb`, makeGlb({ anims: m.animNames, tris: 4000 })) };
    else output = { model_url: dl(`${id}.glb`, makeGlb({ tris: 4000 })), rendered_image_url: dl(`${id}-preview.webp`, fakePng(512, 512)) };
    const t = { id, type, body, polls: 0, output, credits: CREDITS[type], forceStatus: m.nextStatus };
    m.nextStatus = null;
    m.tasks.set(id, t);
    return t;
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = Buffer.concat(chunks);
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname.startsWith('/dl/')) {
        if (req.headers.authorization) m.dlWithAuth.push(url.pathname);
        const f = m.files.get(url.pathname.slice(4));
        res.writeHead(f ? 200 : 404, { 'Content-Type': 'application/octet-stream' });
        return res.end(f ?? '');
      }
      m.apiCalls++;
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        m.badAuth.push(url.pathname);
        return send(401, { code: 1000, status: 'error', message: 'Invalid API key' });
      }
      if (req.method === 'POST' && url.pathname === '/v3/files') {
        if (!String(req.headers['content-type']).startsWith('multipart/form-data') || !body.includes('name="file"')) return send(400, { code: 2003, message: 'no file' });
        m.uploads++;
        return send(200, { code: 0, data: { file_token: `file_${++m.seq}` } });
      }
      if (req.method === 'GET' && url.pathname === '/v3/account/balance') return send(200, { code: 0, data: { balance: 1000, frozen: 0 } });
      if (req.method === 'GET' && url.pathname === '/v3/account/usage') {
        return send(200, { code: 0, data: [...m.tasks.values()].map((t) => ({ task_id: t.id, type: t.type, credits_consumed: t.credits, created_at: '2026-10-28T00:00:00Z' })) });
      }
      const tm = /^\/v3\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && tm) {
        const t = m.tasks.get(decodeURIComponent(tm[1]));
        if (!t) return send(404, { code: 404, status: 'error', message: 'task not found' });
        t.polls++;
        const status = t.forceStatus ?? (t.polls === 1 ? 'queued' : t.polls === 2 ? 'running' : 'success');
        const data = { task_id: t.id, type: t.type, status, progress: status === 'success' ? 100 : status === 'running' ? 50 : 0, created_at: '2026-10-28T00:00:00Z' };
        if (status === 'success') Object.assign(data, { output: t.output, credits_consumed: t.credits, completed_at: '2026-10-28T00:01:00Z' });
        if (status === 'failed') Object.assign(data, { error_code: 2018, error_message: 'Model too complex' });
        return send(200, { code: 0, data });
      }
      if (req.method === 'POST' && TYPES[url.pathname]) {
        let json;
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          return send(400, { code: 2002, message: 'bad json' });
        }
        const t = makeTask(url.pathname, json);
        if (m.failNextCreate) {
          // 任务其实建好了，但回 500：模拟「提交时断线」
          m.failNextCreate = false;
          m.phantom = t.id;
          return send(500, { code: 500, status: 'error', message: 'Internal error' });
        }
        m.creates.push({ path: url.pathname, body: json, id: t.id });
        return send(200, { code: 0, data: { task_id: t.id } });
      }
      send(404, { code: 404, message: `no route ${req.method} ${url.pathname}` });
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      m.base = `http://127.0.0.1:${server.address().port}`;
      m.close = () => new Promise((c) => server.close(c));
      r(m);
    }),
  );
}

// ---------------------------------------------------------------- 测试

const P = {
  root: ROOT,
  manifest: join(ROOT, 'visitors.json'),
  env: join(ROOT, '.env.local'),
  state: join(ROOT, 'assets-src', 'tripo-state.json'),
  raw: join(ROOT, 'assets-src', 'visitors'),
  out: join(ROOT, 'public', 'assets', 'visitors'),
};
const everything = [];
let mock;
const run = async (...argv) => {
  const lines = [];
  const log = (s) => {
    lines.push(s);
    everything.push(s);
    if (process.env.VERBOSE) console.log(s);
  };
  const code = await main(argv, { paths: P, baseUrl: `${mock.base}/v3`, log, poll: { firstMs: 2, factor: 1, maxMs: 2, timeoutMs: 10_000 } });
  return { code, text: lines.join('\n') };
};
const creates = (from) => mock.creates.slice(from);
const exists = (rel) => existsSync(join(ROOT, rel));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const setManifest = (fn) => {
  const m = readJson(P.manifest);
  fn(m);
  writeFileSync(P.manifest, JSON.stringify(m, null, 2));
};
let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    console.log(`✗ ${name}`);
    throw e;
  }
};

try {
  mock = await startMock();
  mkdirSync(join(ROOT, 'assets-src', 'mascot'), { recursive: true });
  writeFileSync(join(ROOT, 'assets-src', 'mascot', 'mascot.png'), fakePng(1024, 1024));
  // 清单：默认参数取自真的 visitors.json，访客换成三个测试用的（其中一个走四视图）
  const real = readJson(join(HERE, 'visitors.json'));
  real.reference = 'assets-src/mascot/';
  real.defaults.prep.templates = ['t_pose'];
  real.defaults.convert.enabled = false;
  real.variants = [
    { id: 'alpha', status: 'draft', label: 'Alpha', costume: 'a plain grey wool coat' },
    { id: 'beta', status: 'draft', label: 'Beta', costume: 'a short black cape', route: 'multiview' },
    { id: 'gamma', status: 'draft', label: 'Gamma', costume: 'a painted skeleton bodysuit' },
  ];
  writeFileSync(P.manifest, JSON.stringify(real, null, 2));
  writeFileSync(P.env, '# test\nTRIPO_API_KEY=\n');

  await test('真实清单的演练：通过校验，不联网，不写项目里的文件', async () => {
    const lines = [];
    const before = existsSync(DEFAULT_PATHS.state);
    const code = await main(['--dry-run'], { log: (s) => lines.push(s) });
    assert.equal(code, 0, lines.join('\n'));
    assert.equal(existsSync(DEFAULT_PATHS.state), before);
    assert.equal(mock.apiCalls, 0);
  });

  await test('key 是空的：--run 直接拒绝，不发请求', async () => {
    const r = await run('--run', 'all', '--yes');
    assert.equal(r.code, 1);
    assert.match(r.text, /TRIPO_API_KEY 还是空的/);
    assert.equal(mock.apiCalls, 0);
  });

  writeFileSync(P.env, `# test\r\nTRIPO_API_KEY="${KEY}"  # 行尾注释\r\n`);

  await test('演练：打码、不联网、不写状态', async () => {
    const r = await run('--dry-run');
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /Bearer \*\*\*/);
    assert.match(r.text, /有 TRIPO_API_KEY（不显示）/);
    assert.equal(mock.apiCalls, 0);
    assert.ok(!existsSync(P.state));
  });

  await test('--run 不带 --yes：只报计划，不建任务', async () => {
    const r = await run('--run', 'all');
    assert.equal(r.code, 2, r.text);
    assert.equal(mock.creates.length, 0);
    assert.ok(!existsSync(P.state));
  });

  let n0 = mock.creates.length;
  await test('草稿：只做到换装图（共用 T 姿势 1 次 + 换装 3 次 + 四视图 1 次）', async () => {
    const r = await run('--run', 'all', '--yes');
    assert.equal(r.code, 0, r.text);
    const c = creates(n0);
    assert.deepEqual(c.map((x) => x.path.split('/').pop()), ['image-to-image', 'image-to-image', 'image-to-image', 'image-to-multiview', 'image-to-image']);
    assert.equal(mock.uploads, 2); // 参考图 + beta 的换装图
    const prep = c[0];
    assert.equal(prep.body.template, 't_pose');
    assert.match(prep.body.input, /^file_/);
    for (const x of c.filter((y) => y.body.prompt)) {
      assert.equal(x.body.input, prep.id); // 换装都从 T 姿势图出发
      assert.equal(x.body.model, 'chat_image_2.5_sunburst');
    }
    assert.match(c[1].body.prompt, /plain grey wool coat/);
    assert.match(c[3].body.input, /^file_/); // 四视图吃 file_token
    for (const id of ['alpha', 'beta', 'gamma']) assert.ok(exists(`assets-src/visitors/${id}/costume.png`), id);
    assert.ok(exists('assets-src/visitors/beta/view-back.png'));
    assert.match(r.text, /草稿到此为止/);
    assert.ok(!exists('public/assets/visitors/alpha.glb'));
  });

  await test('重跑草稿：一个任务都不新建', async () => {
    n0 = mock.creates.length;
    const up = mock.uploads;
    const r = await run('--run', 'all', '--yes');
    assert.equal(r.code, 0, r.text);
    assert.equal(mock.creates.length, n0);
    assert.equal(mock.uploads, up);
  });

  setManifest((m) => m.variants.forEach((v) => (v.status = 'approved')));

  await test('--until model：只建 alpha 的 3D 模型', async () => {
    n0 = mock.creates.length;
    const r = await run('--run', 'alpha', '--yes', '--until', 'model');
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(creates(n0).map((x) => x.path), ['/v3/generation/image-to-model']);
  });

  await test('批准后：建模 → 绑骨检查 → 绑骨 → 动作 → 导出', async () => {
    n0 = mock.creates.length;
    const r = await run('--run', 'all', '--yes');
    assert.equal(r.code, 0, r.text);
    const c = creates(n0);
    assert.equal(c.length, 11, c.map((x) => x.path).join('\n')); // alpha 3 步 + beta 4 步 + gamma 4 步
    const byPath = (p) => c.filter((x) => x.path === p);
    for (const rig of byPath('/v3/animations/rig')) assert.deepEqual({ ...rig.body, input: 'x' }, { input: 'x', model: 'v1.0-20240301', rig_type: 'biped', spec: 'mixamo', out_format: 'glb' });
    for (const rt of byPath('/v3/animations/retarget')) {
      assert.deepEqual(rt.body.animations, ['preset:biped:idle', 'preset:biped:walk', 'preset:biped:run', 'preset:biped:scared_01']);
      assert.equal(rt.body.animate_in_place, true);
    }
    const mv = byPath('/v3/generation/multiview-to-model')[0];
    assert.equal(mv.body.inputs.length, 1);
    assert.match(mv.body.inputs[0].task_id, /^task_/);
    for (const im of byPath('/v3/generation/image-to-model')) assert.equal(im.body.face_limit, 12000);
    const man = readJson(join(P.out, 'manifest.json'));
    assert.deepEqual(man.visitors.map((v) => v.id), ['alpha', 'beta', 'gamma']);
    for (const v of man.visitors) {
      assert.deepEqual(v.clips, { idle: 'Idle', walk: 'Walk', run: 'Run', scared: 'Scared_01' });
      assert.equal(v.clipMatch, 'name');
      assert.equal(v.url, `assets/visitors/${v.id}.glb`);
      assert.equal(v.game.ok, true, v.game.problems.join('；'));
      assert.equal(v.stats.triangles, 4000);
      assert.ok(exists(`public/assets/visitors/${v.id}.glb`));
    }
    assert.equal(man.visitors[0].source.credits, 10 + 30 + 0 + 25 + 40);
  });

  await test('全部做完后重跑：零新建，只重新导出', async () => {
    n0 = mock.creates.length;
    const r = await run('--run', 'all', '--yes');
    assert.equal(r.code, 0, r.text);
    assert.equal(mock.creates.length, n0);
  });

  await test('改了服装描述：停下来提示 --reroll，不悄悄重做', async () => {
    setManifest((m) => (m.variants[0].costume = 'a long dark green coat'));
    n0 = mock.creates.length;
    const r = await run('--run', 'alpha', '--yes');
    assert.equal(r.code, 1);
    assert.match(r.text, /--reroll alpha costume/);
    assert.equal(mock.creates.length, n0);
  });

  await test('--reroll 后重做 alpha（片段名换成没规律的，按顺序对上并标注）', async () => {
    assert.equal((await run('--reroll', 'alpha', 'costume')).code, 0);
    mock.animNames = ['mixamo.com', 'mixamo.com.001', 'mixamo.com.002', 'mixamo.com.003'];
    n0 = mock.creates.length;
    const r = await run('--run', 'alpha', '--yes');
    assert.equal(r.code, 0, r.text);
    assert.equal(creates(n0).length, 5);
    const a = readJson(join(P.out, 'manifest.json')).visitors.find((v) => v.id === 'alpha');
    assert.equal(a.clipMatch, 'order');
    assert.equal(a.clips.scared, 'mixamo.com.003');
    assert.match(r.text, /按请求顺序对上的/);
    assert.equal(readJson(P.state).history.length, 5); // 旧的 task_id 留在 history 里
    mock.animNames = ['Idle', 'Walk', 'Run', 'Scared_01'];
  });

  await test('建任务时断线：留记号，重跑不重建；--adopt 接上后完成', async () => {
    assert.equal((await run('--reroll', 'gamma', 'animate')).code, 0);
    mock.failNextCreate = true;
    let r = await run('--run', 'gamma', '--yes');
    assert.equal(r.code, 1);
    assert.match(r.text, /任务可能已经在服务器上建好了/);
    assert.ok(readJson(P.state).nodes['gamma:animate'].pending_since);
    n0 = mock.creates.length;
    r = await run('--run', 'gamma', '--yes');
    assert.equal(r.code, 1);
    assert.match(r.text, /--adopt gamma animate/);
    assert.equal(mock.creates.length, n0);
    assert.equal((await run('--usage')).code, 0);
    assert.equal((await run('--adopt', 'gamma', 'animate', mock.phantom)).code, 0);
    r = await run('--run', 'gamma', '--yes');
    assert.equal(r.code, 0, r.text);
    assert.equal(mock.creates.length, n0);
    assert.equal(readJson(P.state).nodes['gamma:animate'].task_id, mock.phantom);
  });

  await test('任务失败：停下来，不自动重试；--reroll 后重做成功', async () => {
    assert.equal((await run('--reroll', 'gamma', 'rig')).code, 0);
    mock.nextStatus = 'failed';
    let r = await run('--run', 'gamma', '--yes');
    assert.equal(r.code, 1);
    assert.match(r.text, /这次不扣费/);
    n0 = mock.creates.length;
    r = await run('--run', 'gamma', '--yes');
    assert.equal(r.code, 1);
    assert.equal(mock.creates.length, n0);
    assert.equal((await run('--reroll', 'gamma', 'rig')).code, 0);
    r = await run('--run', 'gamma', '--yes');
    assert.equal(r.code, 0, r.text);
    assert.equal(creates(n0).length, 2); // rig + animate
  });

  await test('结果文件丢了：重新查任务拿链接再下，不重建', async () => {
    unlinkSync(join(P.raw, 'beta', 'animated.glb'));
    unlinkSync(join(P.out, 'beta.glb'));
    n0 = mock.creates.length;
    const r = await run('--run', 'beta', '--yes');
    assert.equal(r.code, 0, r.text);
    assert.equal(mock.creates.length, n0);
    assert.ok(exists('public/assets/visitors/beta.glb'));
  });

  await test('别的进程拿着锁：拒绝运行', async () => {
    const lock = `${P.state}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: 'test' }));
    const r = await run('--run', 'all', '--yes');
    unlinkSync(lock);
    assert.equal(r.code, 1);
    assert.match(r.text, /另一个流水线进程/);
  });

  await test('--status / --balance / --inspect 正常', async () => {
    assert.equal((await run('--status')).code, 0);
    assert.equal((await run('--balance')).code, 0);
    const r = await run('--inspect', join(P.out, 'alpha.glb'));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /mixamo（mixamorig 前缀）/);
  });

  await test('打开 convert：只补建 convert 一步，导出改用它的 GLB', async () => {
    setManifest((m) => (m.variants[2].overrides = { convert: { enabled: true } }));
    n0 = mock.creates.length;
    const r = await run('--run', 'gamma', '--yes');
    assert.equal(r.code, 0, r.text);
    const c = creates(n0);
    assert.deepEqual(c.map((x) => x.path), ['/v3/models/convert']);
    assert.equal(c[0].body.texture_size, 2048);
    assert.equal(c[0].body.input, readJson(P.state).nodes['gamma:animate'].task_id);
    assert.match(r.text, /来自 convert/);
  });

  await test('游戏要求的检查：贴图过大、带根运动都会报出来', async () => {
    const bad = checkForGame(inspectGlb(makeGlb({ anims: ['Walk'], texture: 4096, tris: 20000, moving: true })));
    assert.equal(bad.ok, false);
    assert.equal(bad.problems.length, 3, bad.problems.join('\n'));
  });

  await test('key 没有泄露；下载不带 key；API 请求都带对了 key；状态里不存签名链接', async () => {
    const all = everything.join('\n');
    assert.ok(!all.includes(KEY), '输出里出现了 key');
    for (const f of [P.state, join(P.out, 'manifest.json')]) {
      const s = readFileSync(f, 'utf8');
      assert.ok(!s.includes(KEY), `${f} 里出现了 key`);
      assert.ok(!s.includes('Signature='), `${f} 里存了签名链接`);
    }
    assert.deepEqual(mock.dlWithAuth, []);
    assert.deepEqual(mock.badAuth, []);
  });

  console.log(`\n全部通过（${passed} 项）。假服务共收到 ${mock.apiCalls} 个 API 请求，新建 ${mock.creates.length} 个假任务，真实 API 一次没碰。`);
  rmSync(ROOT, { recursive: true, force: true });
  if (existsSync(BOX) && !readdirSync(BOX).length) rmSync(BOX, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  console.error(`\n临时目录留着方便看：${ROOT}`);
  process.exitCode = 1;
} finally {
  await mock?.close();
}
