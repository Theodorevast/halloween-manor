// 入口：把模拟、画面、声音、界面接起来（设计文档 2. 架构）。
// 模拟层只在开场点击之后才开始走；画面从一开始就渲染，开场遮罩后面的房子已经准备好
import './styles.css';
import { createAudio, type AudioSys } from './audio/engine';
import { STRINGS } from './config/strings';
import { installDebug } from './debug';
import { createCameraRig } from './engine/camera';
import { createJuice } from './engine/juice';
import { createPicker } from './engine/picking';
import { createRenderCore, watchFrameTime } from './engine/renderer';
import type { CameraRig, FrameCtx, Module, Quality, RenderCore } from './engine/types';
import type { SimEvent } from './sim/types';
import { createWorld } from './sim/world';
import { createHud } from './ui/hud';
import { createCharactersView } from './view/characters';
import { createFogView } from './view/fog';
import { createHouseView } from './view/house';
import { createOverlays } from './view/overlays';
import { createPropsView } from './view/props';

const stage = document.getElementById('stage')!;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none';
stage.appendChild(canvas);

let core: RenderCore | undefined;
let rig: CameraRig | undefined;
let quality: Quality = 'high';
let qualityPicked = false;
/** boot 全部完成（模型加载完）才算 ready；开场点击可能早于 ready，先记下 wantBegin */
let ready = false;
let wantBegin = false;
let started = false;
const modules: Module[] = [];

// 音频最先建：开场点击时必须在手势里同步 unlock，不能等渲染器和模型加载完。
// 声像：物体在画面上越靠右，声音越偏右（留 20% 余量，不完全偏到一边）
const audio: AudioSys = createAudio((p) => {
  if (!rig) return 0;
  const s = rig.toScreen(p);
  return Math.max(-1, Math.min(1, (s.x / Math.max(1, canvas.clientWidth)) * 2 - 1)) * 0.8;
});
// 浏览器可能挂起音频（Safari 来电、切 App 等）：开场之后的每次点击、按键都顺手恢复
addEventListener('pointerdown', () => { if (wantBegin) void audio.unlock(); });
addEventListener('keydown', () => { if (wantBegin) void audio.unlock(); });
// 标签页隐藏时主循环停了，模拟也停了，环境声却还在响：整个暂停，回来再恢复
document.addEventListener('visibilitychange', () => audio.setSuspended(document.hidden));

const setQuality = (q: Quality) => {
  quality = q;
  core?.setQuality(q);
  for (const m of modules) m.setQuality?.(q);
  hud.setQuality(q);
};

// HUD 最先建：渲染器起不来时也要能显示说明
const hud = createHud(document.getElementById('hud')!, {
  onBegin: () => begin(),
  onRotate: (dir) => rig?.rotate(dir),
  onToggleMute: () => {
    audio.setMuted(!audio.muted);
    return audio.muted;
  },
  onToggleQuality: () => {
    qualityPicked = true; // 玩家自己选过画质，自动降档就别再插手
    setQuality(quality === 'high' ? 'low' : 'high');
    return quality;
  },
});
hud.showStart();
hud.setReady(false);

const world = createWorld({ seed: Date.now() % 2147483647 });
const control = { timeScale: 1 };
const dispatch = (evs: SimEvent[]) => {
  for (const e of evs) for (const m of modules) m.onEvent?.(e, world.state);
};

function begin() {
  if (wantBegin) return;
  wantBegin = true;
  void audio.unlock();
  if (ready) start();
}

function start() {
  started = true;
  rig?.intro(2.5);
}

async function boot() {
  try {
    // ?webgl 强制走 WebGL2：排查「是不是 WebGPU 的问题」时用，冒烟测试也靠它测回退路径
    core = await createRenderCore(canvas, { forceWebGL: new URLSearchParams(location.search).has('webgl') });
  } catch (err) {
    console.error(err);
    hud.showError(STRINGS.noWebGL);
    return;
  }
  const c = core;
  // 图形设备丢失（GPU 进程崩溃、睡眠唤醒、驱动更新、WebGL 上下文太多）：three 默认只打日志、之后 render 直接返回，
  // 画面永久黑掉而模拟和尖叫还在继续。改成停下来、告诉玩家，点一下重新加载
  const onLost = c.renderer.onDeviceLost.bind(c.renderer);
  c.renderer.onDeviceLost = (info) => {
    onLost(info); // 原处理会标记设备已丢失，render 才会停止调用它
    started = false;
    audio.setMuted(true);
    hud.showError(STRINGS.deviceLost);
    addEventListener('pointerdown', () => location.reload(), { once: true });
  };
  const r = (rig = createCameraRig(canvas));
  const fit = () => {
    c.resize(canvas.clientWidth, canvas.clientHeight);
    r.resize(canvas.clientWidth, canvas.clientHeight);
  };
  new ResizeObserver(fit).observe(canvas);
  // 窗口拖到另一块缩放比例不同的屏幕时只有 devicePixelRatio 变、尺寸不变，ResizeObserver 不会触发
  const watchDpr = () => {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { fit(); watchDpr(); }, { once: true });
  };
  watchDpr();
  fit();

  const props = createPropsView(c);
  const overlays = createOverlays(document.getElementById('overlay')!, r);
  const characters = await createCharactersView(c);
  modules.push(createHouseView(c, r), createFogView(c, r), props, characters, createJuice(r, c), audio, overlays, hud);

  const picker = createPicker(canvas, r, () => props.pickTargets());
  picker.onHover((id) => {
    props.setHover(id);
    overlays.setHover(id);
  });
  picker.onPick((id) => { if (started) world.trigger(id); });

  installDebug({ world, dispatch, control, rig: r, core: c });

  // 先把场景里所有材质的渲染管线异步编好，再开始渲染。不预编译的话，管线是第一次画到时同步编译的，
  // 开局头几秒会连着卡好几下（实测单帧最长 0.5–0.7 秒），正好撞上开场镜头下降。
  // 访客的材质要等第一个人进门才出现，所以先放一个临时访客一起编（prewarm 内部各编一次不透明、半透明）。
  // compileAsync 只编主相机那一遍，阴影那几遍（狐狸投到月光和手电的阴影图里）不管，所以再真画一帧：
  // 这时开场遮罩还写着「Lighting the candles…」，多花的这点时间玩家看不见
  const compile = async () => {
    await c.renderer.compileAsync(c.scene, r.camera);
    c.render(r.camera);
  };
  await characters.prewarm(compile).catch((err) => console.warn('预编译着色器失败，改为边画边编', err));

  const frameWatch = watchFrameTime(() => { if (quality === 'high' && !qualityPicked) setQuality('low'); });
  let last = performance.now();
  let time = 0;
  c.renderer.setAnimationLoop(() => {
    const now = performance.now();
    // 切回标签页时 dt 可能很大：限制在 0.1 秒以内，模拟不会一下跳过很多
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    if (started) dispatch(world.step(dt * control.timeScale));
    const ctx: FrameCtx = { dt, time, state: world.state };
    r.update(dt);
    for (const m of modules) m.update?.(ctx);
    if (started) frameWatch(dt);
    c.render(r.camera);
  });

  ready = true;
  hud.setReady(true);
  if (wantBegin) start();
}

// 渲染器建好之后的任何一步抛错（某些浏览器 / 显卡不支持某个节点等），都要告诉玩家，而不是让开场按钮永远停在加载中
boot().catch((err) => {
  console.error(err);
  hud.showError(STRINGS.bootFailed);
});
