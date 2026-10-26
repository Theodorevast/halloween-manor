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
// 浏览器可能在切标签页后挂起音频：开场之后的每次点击都顺手恢复
addEventListener('pointerdown', () => { if (wantBegin) void audio.unlock(); });
// 标签页隐藏时主循环停了，模拟也停了，环境声却还在响：临时静音，回来时恢复玩家自己的静音设置
let mutedBeforeHide = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    mutedBeforeHide = audio.muted;
    audio.setMuted(true);
  } else {
    audio.setMuted(mutedBeforeHide);
  }
});

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
    setQuality(quality === 'high' ? 'low' : 'high');
    return quality;
  },
});
hud.showStart();

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
    core = await createRenderCore(canvas);
  } catch (err) {
    console.error(err);
    hud.showError(STRINGS.noWebGL);
    return;
  }
  const c = core;
  const r = (rig = createCameraRig(canvas));
  const fit = () => {
    c.resize(canvas.clientWidth, canvas.clientHeight);
    r.resize(canvas.clientWidth, canvas.clientHeight);
  };
  new ResizeObserver(fit).observe(canvas);
  fit();

  const props = createPropsView(c);
  const overlays = createOverlays(document.getElementById('overlay')!, r);
  modules.push(createHouseView(c, r), props, await createCharactersView(c), createJuice(r, c), audio, overlays, hud);

  const picker = createPicker(canvas, r, () => props.pickTargets());
  picker.onHover((id) => {
    props.setHover(id);
    overlays.setHover(id);
  });
  picker.onPick((id) => { if (started) world.trigger(id); });

  installDebug({ world, dispatch, control, rig: r, core: c });

  const frameWatch = watchFrameTime(() => { if (quality === 'high') setQuality('low'); });
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
  if (wantBegin) start();
}

void boot();
