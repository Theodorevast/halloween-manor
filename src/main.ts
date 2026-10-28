// 入口：把模拟、画面、声音、界面接起来（设计文档 2. 架构）。
// 模拟层只在开场点击之后才开始走；画面从一开始就渲染，开场遮罩后面的房子已经准备好
import './styles.css';
import { createAudio, type AudioSys } from './audio/engine';
import { STRINGS } from './config/strings';
import { installDebug } from './debug';
import { createCameraRig } from './engine/camera';
import { createGhostRig } from './engine/ghostRig';
import { createCinematic, type Cinematic } from './engine/cinematic';
import { createJuice } from './engine/juice';
import { createPicker } from './engine/picking';
import { createRenderCore, watchFrameTime } from './engine/renderer';
import { isGhostRig, type CameraRig, type FrameCtx, type Module, type Quality, type RenderCore } from './engine/types';
import type { Object3D } from 'three/webgpu';
import type { SimEvent } from './sim/types';
import { createWorld } from './sim/world';
import { createHud } from './ui/hud';
import { createCharactersView } from './view/characters';
import { createGhostView } from './view/ghost';
import { createFogView } from './view/fog';
import { createHouseView } from './view/house';
import { createOverlays } from './view/overlays';
import { createParticlesView } from './view/particles';
import { createPropsView } from './view/props';

const stage = document.getElementById('stage')!;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none';
stage.appendChild(canvas);

let core: RenderCore | undefined;
let rig: CameraRig | undefined;
let cinematic: Cinematic | undefined;
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
  // 指针锁定也必须在这次点击的调用栈里
  if (rig && isGhostRig(rig)) rig.lockPointer();
  if (ready) start();
}

function start() {
  started = true;
  cinematic?.intro(2.5);
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
  // 有鼠标和键盘的设备用第三人称操控鬼魂；触屏设备（没有精确指针）继续用娃娃屋俯视。?dollhouse 强制俯视
  const ghostMode = matchMedia('(pointer: fine)').matches && !new URLSearchParams(location.search).has('dollhouse');
  const r = (rig = ghostMode ? createGhostRig(canvas) : createCameraRig(canvas));
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

  // 第三人称：物件在鬼魂周围溶开（和墙、家具一样；?noghostfx 时都不溶）
  const props = createPropsView(c, { dissolve: isGhostRig(r) && !new URLSearchParams(location.search).has('noghostfx') });
  const overlays = createOverlays(document.getElementById('overlay')!, r);
  const characters = await createCharactersView(c);
  const cine = (cinematic = createCinematic(r, c));
  modules.push(
    createHouseView(c, r), createFogView(c, r), props, characters, createParticlesView(c),
    ...(isGhostRig(r) ? [createGhostView(c, r)] : []),
    createJuice(r, c), cine, audio, overlays, hud,
  );

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
  // compileAsync 只编镜头视锥里的物体（r186 的 _projectObject 做了视锥剔除）：别的房间里的那些，ready 之后在后台编（见文件末尾）
  const compile = async () => {
    await c.renderer.compileAsync(c.scene, r.camera);
    c.render(r.camera);
  };
  // 不常用的物件（镜中人脸、肖像的地上印子、粒子）不进这次阻塞的预编译，开场按钮可用之后再编（见下面 ready 之后）。
  // 它们一起会让冷启动多等 1 秒左右（实测：粒子约 0.5 秒，镜子和肖像的新材质约 0.6 秒）
  const deferred: Object3D[] = [];
  c.scene.traverse((o) => { if (o.userData.deferCompile) deferred.push(o); });
  const deferredWasVisible = deferred.map((o) => o.visible);
  for (const o of deferred) o.visible = false;
  await characters.prewarm(compile).catch((err) => console.warn('预编译着色器失败，改为边画边编', err));
  for (const [i, o] of deferred.entries()) o.visible = deferredWasVisible[i];

  /** ready 之后还要把延后编译的物件临时画进去的帧数 */
  const DEFERRED_WARM_FRAMES = 3;
  let warmFrames = 0;
  /** 后台预编译编完后，整栋房子真画一帧（见动画循环） */
  let warmAll = false;
  /** 关掉整个场景的视锥剔除，返回被关掉的那些（画完再开回来） */
  const cullOff = () => {
    const out: Object3D[] = [];
    c.scene.traverse((o) => {
      if (o.frustumCulled) {
        out.push(o);
        o.frustumCulled = false;
      }
    });
    return out;
  };
  const frameWatch = watchFrameTime(() => { if (quality === 'high' && !qualityPicked) setQuality('low'); });
  let last = performance.now();
  let time = 0;
  c.renderer.setAnimationLoop(() => {
    const now = performance.now();
    // 切回标签页时 dt 可能很大：限制在 0.1 秒以内，模拟不会一下跳过很多
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    // 鬼魂位置先交给模拟（贴近发毛），再推进模拟
    world.setGhost(isGhostRig(r) && started ? { x: r.ghost.x, z: r.ghost.z } : null);
    if (started) dispatch(world.step(dt * control.timeScale));
    const ctx: FrameCtx = { dt, time, state: world.state };
    r.update(dt);
    // 第三人称：听者放在镜头处（房屋米坐标 = 世界坐标 − houseRoot 的偏移；houseRoot 只平移不旋转），
    // 鬼魂交给声音（穿墙的「呼」、飘动的冷风；隔墙遮挡从鬼魂的位置算）
    if (isGhostRig(r)) {
      r.camera.updateMatrixWorld();
      const e = r.camera.matrixWorld.elements;
      const o = c.houseRoot.position;
      audio.setListener({ x: e[12] - o.x, y: e[13] - o.y, z: e[14] - o.z }, { x: -e[8], y: -e[9], z: -e[10] });
      audio.setGhost(started ? r.ghost : null);
    }
    for (const m of modules) m.update?.(ctx);
    if (started) frameWatch(dt);
    // 延后编译的物件：ready 之后的头几帧在正常渲染里临时显示（各模块 update 之后、渲染之前），画完恢复
    const warm = warmFrames > 0;
    const was = warm ? deferred.map((o) => o.visible) : null;
    if (warm) for (const o of deferred) o.visible = true;
    // 后台预编译编完、玩家还停在开场画面：整栋房子不剔除地真画一帧，补上 compileAsync 管不到的那些（阴影 pass 等）。
    // 开场遮罩挡着，多花的这一帧看不见；玩家已经开始了就不画（会卡一下）
    const all = warmAll && !started ? cullOff() : null;
    c.render(r.camera);
    if (all) {
      for (const o of all) o.frustumCulled = true;
      warmAll = false;
    }
    if (was) {
      for (const [i, o] of deferred.entries()) o.visible = was[i];
      warmFrames--;
    }
  });

  ready = true;
  hud.setReady(true);
  if (wantBegin) start();

  // 开场按钮已经可用：趁玩家读标题，把延后的物件编好。compileAsync 编的是渲染器默认的渲染目标，
  // 而场景是后处理管线自己的 pass 画的（格式、多重采样都不一样），编出来的管线用不上，所以和预热一样真画一帧。
  // 这一帧画在开场遮罩后面，玩家看不见；这些物件这时都是透明 / 缩成 0 的，下一帧各模块的 update 再按需要藏起来
  warmFrames = DEFERRED_WARM_FRAMES;

  // 镜头视锥外的物体（别的房间里的物件、家具）也在后台编好：不编的话第三人称第一次飞到肖像、摇椅、八音盒、镜子跟前
  // 各卡 0.2–0.7 秒（2026-10-28 实测）。不放进上面那次阻塞的预编译：整栋房子一起编，冷启动从约 4 秒变成约 9 秒。
  // 编给后处理的场景 pass；compileAsync 逐个物体让出主线程，开场画面照常动，玩家读标题、看开场镜头的这几秒里编完
  // 延后编译的物件（镜中人脸、肖像的地上印子、粒子）也一起：上面那几帧暖机只画得到视锥里的，别的房间的照样会卡。
  // precompileAll 在调用的这一下就把要编的物体收集完了，调用一返回就能把它们藏回去
  const t0 = performance.now();
  const deferredVisible = deferred.map((o) => o.visible);
  for (const o of deferred) o.visible = true;
  const precompiled = c.precompileAll(r.camera);
  for (const [i, o] of deferred.entries()) o.visible = deferredVisible[i];
  precompiled.then(
    () => {
      warmAll = true;
      if (new URLSearchParams(location.search).has('debug')) console.info(`[boot] 后台预编译完成 ${Math.round(performance.now() - t0)} ms`);
    },
    (err) => console.warn('[boot] 后台预编译失败，改为边画边编', err),
  );
}

// 渲染器建好之后的任何一步抛错（某些浏览器 / 显卡不支持某个节点等），都要告诉玩家，而不是让开场按钮永远停在加载中
boot().catch((err) => {
  console.error(err);
  hud.showError(STRINGS.bootFailed);
});
