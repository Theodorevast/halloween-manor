// 入口：把模拟、画面、声音、界面接起来（设计文档 2. 架构）。
// 模拟层只在开场点击之后才开始走；画面从一开始就渲染，开场遮罩后面的房子已经准备好
import './styles.css';
import { createAudio, type AudioSys } from './audio/engine';
import { NIGHT } from './config/night';
import { STRINGS } from './config/strings';
import { MANIFEST, nightWorld } from './config/visitors';
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
import { PROP_TEXTURES, createPaintings, loadPaintings } from './view/paintings';
import { createParticlesView } from './view/particles';
import { createPropsView } from './view/props';
import { createRangeFrost } from './view/rangeFrost';
import { COMPILE_STREAMS, PREHEAT_LIMIT, bootProgress, compileInStreams, compileWhole, createLoopGuard, createSettleGate, drawNothing, withDeadline, type BootStage } from './warmup';

const stage = document.getElementById('stage')!;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none';
stage.appendChild(canvas);

let core: RenderCore | undefined;
let rig: CameraRig | undefined;
let cinematic: Cinematic | undefined;
let quality: Quality = 'high';
let qualityPicked = false;
/**
 * 一切都准备好了：整栋房子编好、真画过、GPU 也缓过来了（WebGL2 上其余几套造型也有了着落），点了开始就开场、不再等
 * （2026-10-30 开局不空等：原来按钮在一半的时候就亮，点了开始还要再等后台预编译 8 秒，见 boot 里「开场前的预热」）。
 * 开场按钮在这之前写 Lighting the candles…、下面一条细线显示进度；加载中就点了的（wantBegin）记下来，好了自动开场
 */
let ready = false;
let wantBegin = false;
let started = false;
/** begin 的那次点击里锁过指针没有（渲染器还没起来时点的，那时没有镜头，锁不了；start 再补一次） */
let lockAsked = false;
/** 整栋房子的后台预编译编完了没有 */
let bgDone = false;
/**
 * 其余几套访客造型都有了着落（加入轮换、加载失败、放弃）没有。WebGL2 上准备好之前要等它：那里加新造型要在主线程上
 * 同步传贴图，开局以后加会卡，所以趁开场遮罩还挡着加完（2026-10-29 用户定的「等它们加完」）。WebGPU 开局以后照样能加，一开始就算好了
 */
let outfitsSettled = false;
/** WebGL2：别的都好了以后，最多再等其余几套造型这么多秒，到时候还没加完就带着已经加好的几套开场（某一套下载卡住时按钮不会一直不亮） */
const OUTFIT_WAIT = 30;
/**
 * OUTFIT_WAIT 只停得住下载：已经在解析、编管线的那一套要等它自己做完。再过这么多秒（秒）无论如何都算准备好，
 * 遮罩不会因为某一步挂住而永远不收起（2026-10-29 加载路复审 N1）
 */
const OUTFIT_GRACE = 10;
/** 图形设备丢了：不再开场（准备好的判断也看它），错误界面留着，点一下重新加载 */
let lost = false;
/** 不等其余几套了（boot 里设）：没下载完的停掉、还没开始加的不加了；正在编的那一套编完照样加，所有造型都有了着落才开场 */
let stopOutfits: (() => void) | null = null;
/** 收走后台预编译用的临时访客（boot 里设） */
let releaseStaged: (() => void) | null = null;
/** 开场按钮那条细线（src/warmup.ts 的 bootProgress）：各段走到哪儿了 */
const stage0: BootStage = { renderer: false, scene: false, compile: 0, drawn: false, gpu: false, settled: false };
const progress = (patch: Partial<BootStage>) => {
  Object.assign(stage0, patch);
  hud.setProgress(bootProgress(stage0));
};
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

// 有鼠标和键盘的设备用第三人称操控鬼魂；触屏设备（没有精确指针）继续用娃娃屋俯视。?dollhouse 强制俯视。
// 标题页的三步说明也按它挑（有没有 F），所以在建 HUD 之前就定下来
const ghostMode = matchMedia('(pointer: fine)').matches && !new URLSearchParams(location.search).has('dollhouse');

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
}, { ghost: ghostMode });
hud.showStart();
hud.setReady(false);
progress({});

// 一夜（2026-10-30）：正式游戏给开局间隔（第一个人独自进来，过一会儿才有第二个敲门）。机器人、平衡测试不给，数字不变
const world = createWorld({ seed: Date.now() % 2147483647, openingGaps: NIGHT.openingGaps, ...nightWorld(nightTiming().length, ghostMode) });
const control = { timeScale: 1 };
const dispatch = (evs: SimEvent[]) => {
  for (const e of evs) for (const m of modules) m.onEvent?.(e, world.state);
};
/** 现身的冷却还剩多少（0..1）给准星外面的环：正在现身时算满，冷却中按剩下的秒数；取到 1/100，界面不用每帧都改 */
const manifestLeft = (m: ManifestState) =>
  m.phase === 'windup' || m.phase === 'hold' ? 1 : m.phase === 'cooldown' ? Math.ceil((m.cooldown / MANIFEST.cooldown) * 100) / 100 : 0;

function begin(): boolean {
  if (wantBegin) return started;
  wantBegin = true;
  void audio.unlock();
  // 指针锁定也必须在这次点击的调用栈里（渲染器还没起来时没有镜头，锁不了：start 再补一次）
  if (rig && isGhostRig(rig)) {
    rig.lockPointer();
    lockAsked = true;
    // 还没准备好的这段不收输入：指针已经锁上了，随手一动鼠标就把开场镜头转走（试玩 P1-1）。
    // 真正开场时放开（start）；下面马上就开场的话也是一样，hold 一下就放
    rig.hold(true);
  }
  if (ready && !lost) {
    start();
    return true;
  }
  // 还在点蜡烛（2026-10-30 newbie G5：原来加载中点了没反应、也不记）：记下来，准备好了自动开场（boot 里的 becomeReady）
  return false;
}

function start() {
  started = true;
  if (rig && isGhostRig(rig)) {
    // 渲染器还没起来时就点了开始：那一下没有镜头、锁不了指针，这里补一次。不在点击的调用栈里，浏览器多半不认，
    // 那就是「Click to resume」，点一下就锁上（不补的话鬼魂一直不算开场，点画布也不会去锁）
    if (!lockAsked) rig.lockPointer();
    rig.hold(false);
  }
  // 后台预编译用的临时访客（站在地板下面）：开始了就收走，不再白画
  releaseStaged?.();
  cinematic?.intro(2.5);
}

/** ?debug：冷启动各段的时刻（离导航开始的毫秒），排查「开场按钮为什么这么久才可用」 */
const bootMark = (what: string) => { if (new URLSearchParams(location.search).has('debug')) console.info(`[boot] ${what} ${Math.round(performance.now())} ms`); };

async function boot() {
  // 开场按钮要等的模型最先开始下载，和下面建渲染器、搭房子同时进行（解析、摆正都不用渲染器）：
  // 第一个访客穿的那套造型（其余几套开场按钮可用之后才下载，见 ready 之后的 streamOutfits）；第三人称时还有鬼魂的模型
  // （config/ghost.ts 的 url 为 null 时用程序化的人形，不下载）
  const firstOutfit = loadFirstOutfit();
  // 恐怖画的贴图（view/paintings.ts）：现在就开始下载（低优先级，让第一套造型先下），和预编译同时进行。开场按钮等它，一般早就下完了（见下面的 warmAll）。
  // 第三人称 9 张约 0.89 MB；娃娃屋没有墙上那六幅，只下画像两张、镜中人脸（约 0.24 MB）
  const paintingsLoaded = loadPaintings(ghostMode ? {} : { ids: PROP_TEXTURES });
  void paintingsLoaded.then((p) => bootMark(`恐怖画的贴图：${p.ready.length} 张好了，${p.failed.length} 张失败，${p.late.length} 张没等到`));
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
  progress({ renderer: true });
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
  // 墙上的六幅恐怖画（第三人称才有，娃娃屋的内墙是矮墙挂不住）：开场的预编译之前就在场景里，六幅共用一条管线
  const paintings = createPaintings(c, r);
  // 关门声跟着画面：一群人出门时门等最后一个才甩，只响那一声（前门在 modules 里排在声音前面，同一批事件先到它）
  audio.setFrontDoor(frontDoor);
  // 和玩家的鬼魂同一个外形（共用几何体和阴影管线）；给了镜头才只放在玩家看得见的墙上、躲开玩家的鬼魂
  const otherShadow = createOtherShadow(c, { model: ghostFx?.model ?? null, rig: r });
  const uiRoot = document.getElementById('hud')!;
  const hints = createHints(uiRoot);
  const registerView = createRegisterView(uiRoot);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // 地上的范围霜线（手感 FEEL-2、FEEL-11）：准星 / 手指对上物件时画出它的范围，现身蓄力时跑到 5 米，冷却好了往外呼一次。
  // 网格标了 deferCompile，要在下面开场的预编译收集之前建好。
  // 收夜的静、光收回、登记簿那一页（night.quiet），或者登记簿翻着：安静，不画（night 在下面才建，调到的时候早建好了）。
  // 现身、设机关、附身也看这一个（整体审查 M-1：收尾这几秒屋里已经空了，画面在收回前门）
  const hushed = () => registerView.isOpen || night.quiet;
  const rangeFrost = createRangeFrost(c, r, {
    reduced: () => reducedMotion.matches,
    quiet: hushed,
  });
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
    // Keep haunting 是新的一夜（整体审查 I-3）：登记簿换一页、钟点从这一刻算；墙上多一个影子「一晚最多几次」重新数
    newNight: (t0) => {
      registerView.newNight(t0);
      otherShadow.newNight();
      hud.newNight();
    },
    reduced: () => reducedMotion.matches,
  }, nightTiming());
  /** 场景叠层收起着没有（收尾时收起，Keep haunting 以后放开；只在变化时动 DOM） */
  let overlaysHidden = false;
  modules.push(
    house, createFogView(c, r), props, rangeFrost, characters, frontDoor, paintings, otherShadow, createParticlesView(c),
    ...(ghostFx && isGhostRig(r) ? [createGhostView(c, r, ghostFx), ghostFx.lights, ghostFx.frost] : []),
    createJuice(r, c), cine, audio, overlays, hud, hints, registerView,
    // 一夜只在开场之后走（开场前模拟没动；图形设备丢了以后也不再往下走，免得登记簿翻在错误界面上）
    // 收夜以后出门那一行不问 Who's next?、光收回时准星和冷却环淡掉（2026-10-30 试玩 P2-1）：HUD 每帧问一次段落（只在变化时动 DOM）
    // 收尾（静、光收回、收夜那一页）时名牌、眼睛、悬停标签整层淡出，不在全黑的画面上亮着（整体审查 M-1）
    {
      onEvent: (e, s) => night.onEvent(e, s),
      update: (ctx) => {
        if (started) night.update(ctx);
        hud.setNightPhase(night.phase);
        if (night.quiet !== overlaysHidden) overlays.setHidden((overlaysHidden = night.quiet));
      },
    },
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
    // 只画够得着的物件的范围：靠的是 onHover 只发够得着的（第三人称 4 米内、看得见；够不着的走 onTooFar，不经过这里）。
    // 以后谁让 onHover 也发够不着的，这里要先判断够不够得着再 show
    rangeFrost.show(id);
    if (id && !hushed()) hints.aimed(id);
  });
  // 登记簿翻开着时不附身、不设机关：它自己的底子盖着画面，这里再保险一下（俯视模式点到底下的物件）；
  // 收尾的静、光收回这几秒也不（hushed，整体审查 M-1）
  picker.onPick((id) => { if (started && !hushed()) world.trigger(id); });
  // 第三人称：按住设机关；右键或 F 现身（冷却中、正在现身、鬼魂在墙格里时模拟自己不理）。
  // 做不到时回应一句（hints.refused，判断在 ui/hints.ts）：机关满了（这个物件自己没设着）；
  // 现身被拒：冷却中说 Not yet，就绪却被拒是在墙里，正在现身（蓄力、停留）时再按不回应。
  // 够不着不在这里回应：准星一对准，悬停标签就写着 Too far away.（手感分析 FEEL-7，view/overlays.ts），点下去再说一句是重复
  picker.onArm((id) => {
    if (!started || hushed() || world.arm(id)) return;
    if (trapsFull(world.state.objects, id)) hints.refused('trapsFull');
  });
  if (isGhostRig(r)) r.onManifest(() => {
    if (!started || hushed() || world.manifest()) return;
    const why = manifestRefusal(world.state.manifest.phase);
    if (why) hints.refused(why);
  });

  installDebug({
    world, dispatch, control, rig: r, core: c,
    night: {
      endNight: () => night.endNight(),
      dawn: () => night.dawnNow(),
      keepHaunting: () => night.keepHaunting(),
      snapshot: () => ({ ...night.snapshot(), register: registerView.isOpen, door: frontDoor.openness, otherShadow: otherShadow.appeared }),
    },
  });

  // ── 开场前的预热（2026-10-30 开局不空等，src/warmup.ts）────────────────────────────
  // 原来：先编镜头看得见的那部分（约 5 秒）→ 开场按钮可用 → 整栋房子的后台预编译这时才开始（约 10 秒）→ 点了开始要等它编完。
  // 现在都挪到点之前，开场按钮写 Lighting the candles…、下面一条细线显示进度，全好了才亮；点了就开场，不再等：
  //   1. 空画一帧（drawNothing）：后处理链这时才 setup，场景 pass 的 renderTarget.samples 才定下来，不先画的话下面按 1 倍采样编，编出来的真画时全用不上
  //   2. 整栋房子分 COMPILE_STREAMS 路异步编（别的房间里的物件、家具也编：不编的话第三人称第一次飞到肖像、摇椅、八音盒、镜子跟前各卡 0.2–0.7 秒）。
  //      延后编译的物件（镜中人脸、肖像的地上印子、粒子）也一起；这一下就收集完了，收完马上藏回去
  //   3. 第一套访客（characters.prewarm，不透明、半透明各一遍）真画两帧：阴影、后处理、蒙皮这些预编译编不到的，在这里现编
  //   4. 动画循环开始：延后的物件画几帧（warmFrames）、整栋不剔除地真画一帧（warmAll），再等 GPU 把这些活干完、帧间隔稳下来（见动画循环末尾）
  // 本机实测（2026-10-30，一能点就点）：打开网页到能动约 16.5 秒 → 约 10 秒；4 Mbps 约 22 秒 → 约 14.5 秒；点了以后约 30 ms。
  // 新的网格、材质要在这里之前就在场景里（第 2 步那一下就收集完要编的物体）；?nobgcompile：不做第 2 步（对比卡顿用）
  progress({ scene: true });
  const deferred: Object3D[] = [];
  c.scene.traverse((o) => { if (o.userData.deferCompile) deferred.push(o); });
  const deferredWasVisible = deferred.map((o) => o.visible);
  /** 延后编译的物件要在正常渲染里临时画进去的帧数 */
  const DEFERRED_WARM_FRAMES = 3;
  let warmFrames = 0;
  /** 整栋房子编完以后，不剔除地真画一帧（见动画循环） */
  let warmAll = false;
  /** 第 3 步做完了没有 */
  let prewarmed = false;
  /** 整栋真画过以后等帧间隔稳下来，见 src/warmup.ts */
  const settle = createSettleGate();
  /**
   * 整栋真画过以后，GPU 把交上去的活都干完了没有（WebGPU：queue.onSubmittedWorkDone。那几帧同步新建的管线 GPU 要编好几秒，
   * 而主线程还能接着出几帧才被挡住，所以只看帧间隔不够：实测「稳了」之后 1.5 秒又停 4 秒，正好落在点了开始以后。WebGL2 没有这一步，直接算干完）。
   * 干完了才开始数平稳的帧。最多等 PREHEAT_LIMIT.gpuMs（整体审查 I-1：它不回，按钮就永远不亮）
   */
  let gpuAsked = false;
  const askGpu = () => {
    gpuAsked = true;
    const device = (c.renderer.backend as { device?: { queue?: { onSubmittedWorkDone?: () => Promise<unknown> } } }).device;
    const done = device?.queue?.onSubmittedWorkDone?.() ?? Promise.resolve();
    void withDeadline(done, PREHEAT_LIMIT.gpuMs, '等 GPU 把活干完').then(
      () => progress({ gpu: true }),
      (err) => {
        console.warn('[boot] 不等 GPU 了，接着往下走', err);
        progress({ gpu: true });
      },
    );
  };
  drawNothing(c.scene, () => c.render(r.camera));
  const t0 = performance.now();
  for (const o of deferred) o.visible = true;
  const precompiled = new URLSearchParams(location.search).has('nobgcompile')
    ? Promise.resolve()
    // 最多等 PREHEAT_LIMIT.compileMs（整体审查 I-1）：到点走下面「边画边编」那个分支，没编完的继续在后台编
    : withDeadline(
        compileInStreams(c.scene, COMPILE_STREAMS, (p) => compileWhole(c, r.camera, engine.post?.sceneTarget(r.camera) ?? null, p), (f) => progress({ compile: f })),
        PREHEAT_LIMIT.compileMs,
        '整栋房子预编译',
      );
  for (const o of deferred) o.visible = false;
  // 整栋真画的那一帧（warmAll）也等恐怖画的贴图：那一帧把它们都传上 GPU，开局以后第一次看到时不卡。下载卡住最多等 PAINTING_WAIT_MS（view/paintings.ts）
  Promise.all([precompiled, paintingsLoaded]).then(
    () => {
      bgDone = true;
      warmAll = true;
      progress({ compile: 1 });
      bootMark(`整栋房子预编译完（${COMPILE_STREAMS} 路，用了 ${Math.round(performance.now() - t0)} ms）`);
    },
    (err) => {
      // 编不成也照样往下走：大不了真画的时候现编（遮罩挡着）
      bgDone = true;
      warmAll = true;
      progress({ compile: 1 });
      console.warn('[boot] 整栋房子预编译失败，改为边画边编', err);
    },
  );
  bootMark('场景建好，开始预编译');
  // 等整栋编完再真画：编好的就不用现编，真画时同步新建的管线从约 65 条降到约 36 条（后处理、阴影、蒙皮这些本来就编不到的）
  await characters.prewarm(async () => {
    await precompiled.catch(() => undefined);
    c.render(r.camera);
  }).catch((err) => console.warn('预热访客失败，改为边画边编', err));
  prewarmed = true;
  bootMark('第一套访客真画过');
  for (const [i, o] of deferred.entries()) o.visible = deferredWasVisible[i];

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
  /** WebGL2：别的都好了还在等其余几套造型时，最多再等 OUTFIT_WAIT 秒（只起一次表） */
  let outfitTimers = false;
  /** 都好了：开场按钮亮起来；加载中就点了开始的，直接开场 */
  const becomeReady = () => {
    if (ready || lost || !prewarmed || !bgDone || warmAll || warmFrames > 0 || !stage0.settled) return;
    if (!outfitsSettled) {
      if (!outfitTimers) {
        outfitTimers = true;
        setTimeout(() => { if (!outfitsSettled) stopOutfits?.(); }, OUTFIT_WAIT * 1000);
        setTimeout(() => { outfitsSettled = true; }, (OUTFIT_WAIT + OUTFIT_GRACE) * 1000);
      }
      return;
    }
    ready = true;
    bootMark('准备好了，开场按钮亮');
    hud.setReady(true);
    if (wantBegin) {
      hud.hideStart();
      start();
    }
  };
  const frameWatch = watchFrameTime(() => { if (quality === 'high' && !qualityPicked) setQuality('low'); });
  let last = performance.now();
  let time = 0;
  /** 一帧（抛错的处理见下面的 loopError） */
  const frame = () => {
    const now = performance.now();
    const gap = now - last;
    // 切回标签页时 dt 可能很大：限制在 0.1 秒以内，模拟不会一下跳过很多
    const dt = Math.min(0.1, gap / 1000);
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
    // 延后编译的物件：头几帧在正常渲染里临时显示（各模块 update 之后、渲染之前），画完恢复
    const warm = warmFrames > 0;
    const was = warm ? deferred.map((o) => o.visible) : null;
    if (warm) for (const o of deferred) o.visible = true;
    // 整栋房子编完、玩家还停在开场画面：整栋房子不剔除地真画一帧，补上 compileAsync 管不到的那些（阴影 pass 等）。
    // 开场遮罩挡着，多花的这一帧看不见
    const all = warmAll && !started ? cullOff() : null;
    c.render(r.camera);
    if (all) {
      for (const o of all) o.frustumCulled = true;
      warmAll = false;
      releaseStaged?.();
    }
    if (was) {
      for (const [i, o] of deferred.entries()) o.visible = was[i];
      warmFrames--;
    }
    // 还没准备好：整栋真画过、延后的也画过，就等 GPU 把活干完、帧间隔稳下来，稳了就准备好。时间用真实时间（time 每帧最多走 0.1 秒，慢机器上会多等好几倍）
    if (!ready && !lost) {
      if (!settle.started) {
        if (bgDone && !warmAll && warmFrames === 0) {
          if (!gpuAsked) {
            progress({ drawn: true });
            askGpu();
          }
          if (stage0.gpu) settle.start(now / 1000);
        }
      } else if (!stage0.settled && settle.frame(gap, now / 1000)) {
        progress({ settled: true });
        bootMark('GPU 缓过来了');
      }
      becomeReady();
    }
  };
  // 循环里抛错（整体审查 I-2）：就绪判断排在真画后面，一抛错就走不到，boot().catch 也接不到 rAF 回调里的异常，按钮会永远不亮。
  // 还没开局（遮罩挂着，包括按钮已经亮了、玩家还没点）：挂错误界面、停循环，点了也开不了场；开局以后只记日志（一次偶发的错不该把一局停掉）
  const loopError = createLoopGuard({
    fatal: () => {
      lost = true;
      audio.setMuted(true);
      hud.showError(STRINGS.bootFailed);
      void c.renderer.setAnimationLoop(null);
    },
    log: (err) => console.error('[loop] 动画循环抛错', err),
  });
  c.renderer.setAnimationLoop(() => {
    try {
      frame();
    } catch (err) {
      loopError(err, !started && !lost);
    }
  });
  // 动画循环开始：延后编译的物件先在正常渲染里画几帧（玩家看不见：开场遮罩挡着；这些物件这时都是透明 / 缩成 0 的，下一帧各模块的 update 再按需要藏起来）
  warmFrames = DEFERRED_WARM_FRAMES;

  // 第一套访客造型（阻塞的那次只编了镜头看得见的部分）：整栋房子的预编译收集完之后放临时访客（站在地板下面），
  // 留到整栋真画的那一帧把阴影图、手电这些编好再收走（见动画循环）；玩家在那之前就开始了，开始时收走
  releaseStaged = characters.stageOutfits();
  // 其余几套访客造型现在开始下载：一套一套下载，下载好一套、异步编好管线，才放进轮换，在那之前进门的人只穿已经能用的（见 characters.ts 的 streamOutfits）。
  // WebGPU：编要等整栋房子的预编译编完（别跟它抢），之后在标题页后面、开局以后都照样加（不卡，点了开始不等它们）。
  // WebGL2（outfitsBeforeStart）：要在开局之前加完，不等预编译；准备好要等这里都有了着落（最多 OUTFIT_WAIT 秒，见 becomeReady）
  const outfitsStream = characters.streamOutfits({ camera: r.camera, sceneTarget: () => engine.post?.sceneTarget(r.camera) ?? null, hidden: () => !started }, precompiled);
  void outfitsStream.finally(() => bootMark('其余造型都有了着落'));
  if (characters.outfitsBeforeStart) {
    stopOutfits = () => void characters.stopStreaming();
    void outfitsStream.finally(() => { outfitsSettled = true; });
  } else {
    outfitsSettled = true;
  }
}

// 渲染器建好之后的任何一步抛错（某些浏览器 / 显卡不支持某个节点等），都要告诉玩家，而不是让开场按钮永远停在加载中
boot().catch((err) => {
  console.error(err);
  hud.showError(STRINGS.bootFailed);
});
