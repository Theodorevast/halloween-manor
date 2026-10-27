// 调试接口：地址带 ?debug 时挂到 window.__haunt，给冒烟测试和手动排查用。正常访问不挂
import type { CameraRig, RenderCore } from './engine/types';
import type { SimEvent, SpawnOptions, World, WorldState } from './sim/types';

export interface DebugDeps {
  world: World;
  /** 把模拟事件分发给各模块（和主循环同一个函数），快进时画面和声音也跟着反应 */
  dispatch(evs: SimEvent[]): void;
  /** 主循环每帧用 dt × timeScale 推进模拟 */
  control: { timeScale: number };
  rig: CameraRig;
  core: RenderCore;
}

export interface HauntDebug {
  backend: RenderCore['backend'];
  /** 文字版状态，一眼看清每个访客和物件 */
  state(): string;
  /** 状态的深拷贝 */
  raw(): WorldState;
  /** 立刻快进 ms 毫秒（按 1/60 秒切分），期间的事件照常分发 */
  step(ms: number): void;
  trigger(id: string): boolean;
  spawn(opts?: SpawnOptions): ReturnType<World['spawn']>;
  rotate(dir: 1 | -1): void;
  setTimeScale(n: number): void;
  /** 物件在画布上的像素位置（离地 0.8 米处，大致是物件中部），测试用它来点中物件 */
  screenOf(objectId: string): { x: number; y: number } | null;
}

const f1 = (n: number) => n.toFixed(1);

export function installDebug(d: DebugDeps) {
  if (!new URLSearchParams(location.search).has('debug')) return;
  const api: HauntDebug = {
    backend: d.core.backend,
    state() {
      const s = d.world.state;
      const lines = [`t=${f1(s.time)}s scaredOff=${s.scaredOff} hitStop=${f1(s.hitStop)} timeScale=${d.control.timeScale}`];
      for (const n of s.npcs) {
        lines.push(`npc#${n.id} ${n.name} (${n.personality}) ${n.mode} fear=${f1(n.fear)} pos=(${f1(n.pos.x)},${f1(n.pos.z)}) look=${f1(n.lookDir)} speed=${f1(n.speed)}`);
      }
      for (const o of s.objects) {
        lines.push(`obj ${o.id} cd=${f1(o.cooldown)} active=${f1(o.active)} broken=${f1(o.broken)} seenBy=[${o.seenBy.join(',')}]`);
      }
      return lines.join('\n');
    },
    raw: () => structuredClone(d.world.state),
    step(ms) {
      let left = ms / 1000;
      while (left > 1e-6) {
        const dt = Math.min(1 / 60, left);
        d.dispatch(d.world.step(dt));
        left -= dt;
      }
    },
    trigger: (id) => d.world.trigger(id),
    spawn: (opts) => structuredClone(d.world.spawn(opts)),
    rotate: (dir) => d.rig.rotate(dir),
    setTimeScale(n) {
      d.control.timeScale = Math.max(0, n);
    },
    screenOf(objectId) {
      const o = d.world.state.objects.find((x) => x.id === objectId);
      return o ? d.rig.toScreen(o.pos, 0.8) : null;
    },
  };
  (window as unknown as { __haunt: HauntDebug }).__haunt = api;
  console.info('[debug] window.__haunt 已就绪：state() / raw() / step(ms) / trigger(id) / spawn(opts) / rotate(dir) / setTimeScale(n)');
}
