// 入口：把模拟、画面、声音、界面接起来（设计文档 2. 架构）。
// 模拟层只在开场点击之后才开始走；画面从一开始就渲染，开场遮罩后面的房子已经准备好
import './styles.css';
import { createAudio, type AudioSys } from './audio/engine';
import { NIGHT } from './config/night';
import { STRINGS } from './config/strings';
import { MANIFEST } from './config/visitors';
import { installDebug, nightTiming } from './debug';
import { createCameraRig } from './engine/camera';
import { createGhostRig, setGhostUi } from './engine/ghostRig';
import { createCinematic, type Cinematic } from './engine/cinematic';
import { createJuice } from './engine/juice';
import { createPicker } from './engine/picking';
import { createRenderCore, watchFrameTime, type EngineCore } from './engine/renderer';
import { isGhostRig, type CameraRig, type FrameCtx, type Module, type Quality, type RenderCore } from './engine/types';
import type { Object3D } from 'three/webgpu';
import { createNight } from './night';
import type { ManifestState, SimEvent } from './sim/types';
import { createWorld } from './sim/world';
import { createHints, manifestRefusal, trapsFull } from './ui/hints';
import { createHud } from './ui/hud';
import { createRegisterView } from './ui/registerView';
import { createCharactersView, loadFirstOutfit } from './view/characters';
import { createFrost } from './view/frost';
import { GHOST, createGhostView, loadGhostModel } from './view/ghost';
import { createFogView } from './view/fog';
import { createFrontDoor } from './view/frontDoor';
import { createHouseView } from './view/house';
import { createLightFx } from './view/lightfx';
import { createOtherShadow } from './view/otherShadow';
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
/** boot 全部完成（第一套访客造型等模型加载完、开场前那次预编译编完）才算 ready；开场点击可能早于 ready，先记下 wantBegin */
let ready = false;
let wantBegin = false;
let started = false;
/** 开场按钮可用之后的后台预编译编完了没有（没编完时点开始，要等它，见 begin） */
let bgDone = false;
/**
 * 其余几套访客造型都有了着落（加入轮换、加载失败、放弃）没有。WebGL2 上点了开始要等它（见 begin）：那里加新造型要在主线程上
 * 同步传贴图，开局以后加会卡，所以趁开场遮罩还挡着加完（2026-10-29 用户定的「点了开始等它们加完」）。WebGPU 开局以后照样能加，一开始就算好了
 */
let outfitsSettled = false;
/** WebGL2：点了开始以后最多再等其余几套造型这么多秒，到时候还没加完就带着已经加好的几套开场（某一套下载卡住时遮罩不会一直挂着） */
const OUTFIT_WAIT = 30;
/**
 * OUTFIT_WAIT 只停得住下载：已经在解析、编管线的那一套要等它自己做完。再过这么多秒（秒）无论如何都开场，
 * 遮罩不会因为某一步挂住而永远不收起（2026-10-29 加载路复审 N1）
 */
const OUTFIT_GRACE = 10;
/** 图形设备丢了：不再开场（动画循环的开场条件也看它），错误界面留着，点一下重新加载 */
let lost = false;
/** 不等其余几套了（boot 里设）：没下载完的停掉、还没开始加的不加了；正在编的那一套编完照样加，所有造型都有了着落才开场 */
let stopOutfits: (() => void) | null = null;
/** 收走后台预编译用的临时访客（boot 里设） */
let releaseStaged: (() => void) | null = null;
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

// 一夜（2026-10-30）：正式游戏给开局间隔（第一个人独自进来，过一会儿才有第二个敲门）。机器人、平衡测试不给，数字不变
const world = createWorld({ seed: Date.now() % 2147483647, openingGaps: NIGHT.openingGaps });
const control = { timeScale: 1 };
const dispatch = (evs: SimEvent[]) => {
  for (const e of evs) for (const m of modules) m.onEvent?.(e, world.state);
};
/** 现身的冷却还剩多少（0..1）给准星外面的环：正在现身时算满，冷却中按剩下的秒数；取到 1/100，界面不用每帧都改 */
const manifestLeft = (m: ManifestState) =>
  m.phase === 'windup' || m.phase === 'hold' ? 1 : m.phase === 'cooldown' ? Math.ceil((m.cooldown / MANIFEST.cooldown) * 100) / 100 : 0;

function begin(): boolean {
  if (wantBegin) return true;
  wantBegin = true;
  void audio.unlock();
  // 指针锁定也必须在这次点击的调用栈里
  if (rig && isGhostRig(rig)) {
    rig.lockPointer();
    // 开场遮罩还挂着的这段（等预编译、等造型）不收输入：指针已经锁上了，随手一动鼠标就把开场镜头转走（试玩 P1-1）。
    // 真正开场时放开（start）；下面马上就开场的话也是一样，hold 一下就放
    rig.hold(true);
  }
  if (ready && !lost && bgDone && outfitsSettled) {
    start();
    return true;
  }
  // 后台还在编整栋房子：这时开场，镜头一动就要画还没编的东西，会卡死好几秒（2026-10-28 实测 2.5 秒）。
  // WebGL2 上其余几套访客造型还没加完：开局以后再加会卡（见 outfitsSettled）。
  // 两种都是开场遮罩先留着、按钮写回「Lighting the candles…」，都好了（再整栋真画一帧）就收起遮罩开场，见动画循环。
  // 造型最多等 OUTFIT_WAIT 秒，从这次点击算起
  hud.setReady(false);
  if (!outfitsSettled) {
    setTimeout(() => { if (!outfitsSettled) stopOutfits?.(); }, OUTFIT_WAIT * 1000);
    setTimeout(() => { outfitsSettled = true; }, (OUTFIT_WAIT + OUTFIT_GRACE) * 1000);
  }
  return false;
}

function start() {
  started = true;
  if (rig && isGhostRig(rig)) rig.hold(false);
  // 后台预编译用的临时访客（站在地板下面）：开始了就收走，不再白画
  releaseStaged?.();
  cinematic?.intro(2.5);
}

/** ?debug：冷启动各段的时刻（离导航开始的毫秒），排查「开场按钮为什么这么久才可用」 */
const bootMark = (what: string) => { if (new URLSearchParams(location.search).has('debug')) console.info(`[boot] ${what} ${Math.round(performance.now())} ms`); };

async function boot() {
  // 有鼠标和键盘的设备用第三人称操控鬼魂；触屏设备（没有精确指针）继续用娃娃屋俯视。?dollhouse 强制俯视
  const ghostMode = matchMedia('(pointer: fine)').matches && !new URLSearchParams(location.search).has('dollhouse');
  // 开场按钮要等的模型最先开始下载，和下面建渲染器、搭房子同时进行（解析、摆正都不用渲染器）：
  // 第一个访客穿的那套造型（其余几套开场按钮可用之后才下载，见 ready 之后的 streamOutfits）；第三人称时还有鬼魂的模型
  // （config/ghost.ts 的 url 为 null 时用程序化的人形，不下载）
  const firstOutfit = loadFirstOutfit();
  const ghostModel = ghostMode ? loadGhostModel().catch((err) => {
    console.warn('鬼魂模型加载失败，改用程序化的人形', err);
    return null;
  }) : Promise.resolve(null);
  let engine: EngineCore;
  try {
    // ?webgl 强制走 WebGL2：排查「是不是 WebGPU 的问题」时用，冒烟测试也靠它测回退路径
    core = engine = await createRenderCore(canvas, { forceWebGL: new URLSearchParams(location.search).has('webgl') });
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
    lost = true;
    started = false;
    audio.setMuted(true);
    hud.showError(STRINGS.deviceLost);
    addEventListener('pointerdown', () => location.reload(), { once: true });
  };
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
  bootMark('渲染器就绪');
  const characters = await createCharactersView(c, firstOutfit);
  bootMark('第一套访客造型加载完');
  const cine = (cinematic = createCinematic(r, c));
  // 第三人称：鬼魂现身时借附近的灯闪（lightfx）、脚下结霜（frost）；鬼魂的模型按 config/ghost.ts（url 为 null 用程序化的人形）
  const ghostFx = isGhostRig(r) ? { lights: createLightFx(c), frost: createFrost(c), model: await ghostModel } : null;
  // ?solid=0.1：现身时「实」的那份没被照着时的暗度（默认 0.03 是暗色剪影，0.1 是偏灰的实雾；看样时对比用）。建鬼魂之前改
  const solid = Number(new URLSearchParams(location.search).get('solid') || NaN);
  if (Number.isFinite(solid) && solid >= 0) GHOST.solid.dark = solid;
  // 一夜（2026-10-30）：前门、墙上多一个影子要在下面开场的预编译之前就在场景里（第一次出现不卡）；
  // 情境提示、登记簿是界面，挂在 HUD 的层里（#hud，渲染器起不来时不建：错误界面上不该有本子）
  const house = createHouseView(c, r);
  const frontDoor = createFrontDoor(c, isGhostRig(r) ? r : null);
  // 关门声跟着画面：一群人出门时门等最后一个才甩，只响那一声（前门在 modules 里排在声音前面，同一批事件先到它）
  audio.setFrontDoor(frontDoor);
  // 和玩家的鬼魂同一个外形（共用几何体和阴影管线）；给了镜头才只放在玩家看得见的墙上、躲开玩家的鬼魂
  const otherShadow = createOtherShadow(c, { model: ghostFx?.model ?? null, rig: r });
  const uiRoot = document.getElementById('hud')!;
  const hints = createHints(uiRoot);
  const registerView = createRegisterView(uiRoot);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // 一夜的收尾（src/night.ts）：到点收夜、天亮，屋里没人、前门关上以后静一会儿、光收回前门、翻开登记簿；?night=<分钟> 改夜长
  const night = createNight({
    world,
    say: (text) => hud.say(text, 'quiet'),
    porch: (level, seconds) => house.setPorch(level, seconds),
    dawnLight: (k, seconds) => house.setDawn(k, seconds),
    ambience: (level, seconds) => audio.setAmbience(level, seconds),
    retreat: (seconds) => cine.retreat(seconds),
    spread: (seconds) => cine.spread(seconds),
    door: () => frontDoor.openness,
    openRegister: () => registerView.open({ closing: true }),
    closeRegister: () => registerView.close(),
    reload: () => location.reload(),
    reduced: () => reducedMotion.matches,
  }, nightTiming());
  modules.push(
    house, createFogView(c, r), props, characters, frontDoor, otherShadow, createParticlesView(c),
    ...(ghostFx && isGhostRig(r) ? [createGhostView(c, r, ghostFx), ghostFx.lights, ghostFx.frost] : []),
    createJuice(r, c), cine, audio, overlays, hud, hints, registerView,
    // 一夜只在开场之后走（开场前模拟没动；图形设备丢了以后也不再往下走，免得登记簿翻在错误界面上）
    { onEvent: (e, s) => night.onEvent(e, s), update: (ctx) => { if (started) night.update(ctx); } },
  );

  // 登记簿：翻开时把鼠标还给玩家（第三人称要点得到按钮）；合上时不自动锁回，HUD 自己提示「Click to resume」，点一下画布就继续
  // （Esc 合上时浏览器也不让马上再锁）。翻开着的时候鬼魂不收输入（rig.hold：翻开之前按住的 WASD 也不再推它，鼠标、F、滚轮都不算），
  // 合上时放开，视角回到翻开那一刻。触屏、俯视没有指针锁定，照样翻、照样合。
  // 收夜那一页被合上（不管从哪儿合的）都当 Keep haunting：不然光收回以后画面一直停在黑里（keepHaunting 只认那一页，重复调只算一次）
  registerView.onToggle((open) => {
    if (open && isGhostRig(r) && document.pointerLockElement) document.exitPointerLock();
    if (isGhostRig(r)) r.hold(open);
    if (!open && night.phase === 'register') night.keepHaunting();
  });
  registerView.onKeepHaunting(() => night.keepHaunting());
  registerView.onAnotherNight(() => night.anotherNight());
  // 墙上多一个影子出现过：登记簿页脚多一句
  otherShadow.onAppear(() => registerView.noteOtherOne());

  const picker = createPicker(canvas, r, () => props.pickTargets());
  picker.onHover((id) => {
    props.setHover(id);
    overlays.setHover(id);
    if (id) hints.aimed(id);
  });
  // 登记簿翻开着时不附身、不设机关：它自己的底子盖着画面，这里再保险一下（俯视模式点到底下的物件）
  picker.onPick((id) => { if (started && !registerView.isOpen) world.trigger(id); });
  // 第三人称：按住设机关；右键或 F 现身（冷却中、正在现身、鬼魂在墙格里时模拟自己不理）。
  // 做不到时回应一句（hints.refused，判断在 ui/hints.ts）：机关满了（这个物件自己没设着）；够不着；
  // 现身被拒：冷却中说 Not yet，就绪却被拒是在墙里，正在现身（蓄力、停留）时再按不回应
  picker.onArm((id) => {
    if (!started || registerView.isOpen || world.arm(id)) return;
    if (trapsFull(world.state.objects, id)) hints.refused('trapsFull');
  });
  picker.onTooFar(() => { if (started && !registerView.isOpen) hints.refused('tooFar'); });
  if (isGhostRig(r)) r.onManifest(() => {
    if (!started || world.manifest()) return;
    const why = manifestRefusal(world.state.manifest.phase);
    if (why) hints.refused(why);
  });

  installDebug({
    world, dispatch, control, rig: r, core: c,
    night: {
      endNight: () => night.endNight(),
      dawn: () => night.dawnNow(),
      keepHaunting: () => night.keepHaunting(),
      snapshot: () => ({ ...night.snapshot(), register: registerView.isOpen, door: frontDoor.openness }),
    },
  });

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
  bootMark('场景建好，开始阻塞的预编译');
  await characters.prewarm(compile).catch((err) => console.warn('预编译着色器失败，改为边画边编', err));
  bootMark('阻塞的预编译完');
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
    // 鬼魂位置先交给模拟（贴近发毛、手电照到、穿墙声），再推进模拟
    world.setGhost(isGhostRig(r) && started ? { x: r.ghost.x, z: r.ghost.z, inWall: r.ghost.inWall } : null);
    if (started) dispatch(world.step(dt * control.timeScale));
    // 现身的蓄力和停留期间鬼魂定住（模拟按蓄力开始那一刻的位置结算）；准星外面的冷却环
    if (isGhostRig(r)) {
      const m = world.state.manifest;
      r.pin(m.phase === 'windup' || m.phase === 'hold');
      setGhostUi({ manifestCooldown: manifestLeft(m) });
    }
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
      releaseStaged?.();
    }
    // 点了开始、在等后台预编译（WebGL2 上还在等其余几套造型）：都好了、整栋真画过一帧了，收起开场遮罩开场
    // 设备丢了不再开场：不然下一帧 hideStart 会收起错误界面、把游戏又「开始」起来（2026-10-29 加载路复审发现，原来就有）
    if (wantBegin && !started && !lost && bgDone && !warmAll && outfitsSettled) {
      hud.hideStart();
      start();
    }
    if (was) {
      for (const [i, o] of deferred.entries()) o.visible = was[i];
      warmFrames--;
    }
  });

  ready = true;
  hud.setReady(true);
  if (wantBegin && !lost && bgDone && outfitsSettled) start();

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
  // ?nobgcompile：不做后台预编译（对比卡顿用）
  const precompiled = new URLSearchParams(location.search).has('nobgcompile') ? Promise.resolve() : c.precompileAll(r.camera);
  for (const [i, o] of deferred.entries()) o.visible = deferredVisible[i];
  // 第一套访客造型（开场前只编了镜头看得见的部分）：上面收集完物体之后放临时访客（站在地板下面），
  // 留到下面那一帧整栋真画时把阴影图、手电这些编好再收走（见动画循环）；玩家在那之前就开始了，开始时收走
  const outfitsDone = characters.stageOutfits();
  releaseStaged = outfitsDone;
  // 其余几套访客造型现在才开始下载（开场按钮只等第一套）：一套一套下载，下载好一套、异步编好管线，才放进轮换，
  // 在那之前进门的人只穿已经能用的（见 characters.ts 的 streamOutfits）。编要等上面整栋房子的后台预编译编完：点了开始要等它，别跟它抢。
  // WebGL2 上（outfitsBeforeStart）要在开局之前加完：点了开始以后遮罩留着，等这里都有了着落（最多 OUTFIT_WAIT 秒）再开场
  const outfitsStream = characters.streamOutfits({ camera: r.camera, sceneTarget: () => engine.post?.sceneTarget(r.camera) ?? null, hidden: () => !started }, precompiled);
  if (characters.outfitsBeforeStart) {
    stopOutfits = () => void characters.stopStreaming();
    void outfitsStream.finally(() => {
      outfitsSettled = true;
      if (new URLSearchParams(location.search).has('debug')) console.info(`[boot] 其余造型都有了着落 ${Math.round(performance.now())} ms`);
    });
  } else {
    outfitsSettled = true;
  }
  precompiled.then(
    () => {
      bgDone = true;
      warmAll = true;
      // 玩家已经开始了就不会有整栋房子真画的那一帧（见动画循环），临时访客这时收走
      if (started) releaseStaged?.();
      if (new URLSearchParams(location.search).has('debug')) console.info(`[boot] 后台预编译完成 ${Math.round(performance.now() - t0)} ms`);
    },
    (err) => {
      // 编不成也照样收走临时访客、照样开场：大不了画到的时候现编、卡一下
      releaseStaged?.();
      bgDone = true;
      console.warn('[boot] 后台预编译失败，改为边画边编', err);
    },
  );
}

// 渲染器建好之后的任何一步抛错（某些浏览器 / 显卡不支持某个节点等），都要告诉玩家，而不是让开场按钮永远停在加载中
boot().catch((err) => {
  console.error(err);
  hud.showError(STRINGS.bootFailed);
});
