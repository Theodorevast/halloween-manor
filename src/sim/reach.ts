// 「这一下会吓到谁」（2026-10-30 手感分析 FEEL-1）：玩家下一个动作（附身某个物件、或者在鬼魂所在处现身）会影响到哪些访客。
// 画面（view/overlays.ts）按它在名牌名字前面亮一只小眼睛。纯函数、只读：不改状态、不抽随机数，机器人和平衡测试的数字不受影响。
// 规则不另立，照搬结算（world.ts），所以眼睛不会说谎（tests/reach.test.ts 拿真的模拟逐人对照）：
// - 惊吓类物件：就是 seenBy（world.ts 每步按结算的同一条规则算：光锥 + 视线 + min(range, VISION.range) + 正面）
// - 引诱类：触发那一步结算，能被吓（canBeScared）、听得见（canHear，隔墙打折）的人
// - 现身：鬼魂所在的格子挡视线（墙、窗）时模拟不让现身，空；否则落下时看得见那里（canSee，MANIFEST.range）的人，
//   加上蓄力时会转过来的人：MANIFEST.noticeRadius 米内、有视线（蓄力察觉不看视线、隔墙也转头，但隔着墙落下时看不见）、
//   此刻能察觉（受惊僵着的人 notice 不接，手电还定在吓到他的东西上，见 npc.ts 的 notice）。
//   蓄力 0.6 秒里手电以 BEHAVIOR.turnRate × NOTICE.torchTurn = 10 弧度/秒转过来，转得到
// 「能不能被吓」直接用 npc.ts 的 canBeScared（逃跑中、已离开的不算），不另写一份
import { cellOf } from '../config/house';
import { SCARES } from '../config/scares';
import { MANIFEST } from '../config/visitors';
import type { Grid } from './grid';
import { canBeScared, type Npc } from './npc';
import { canHear, canSee } from './perception';
import type { NpcState, Vec2, WorldState } from './types';

/** 玩家下一个动作：附身物件 id，或者在 at 处现身 */
export type ReachAct = { kind: 'object'; id: string } | { kind: 'manifest'; at: Vec2 };

/**
 * canBeScared 收的是模拟内部的 Npc，它只看 NpcState（n.s.mode）：包一层，画面拿到的 NpcState 也能直接问。
 * 规则还是 npc.ts 那一份，以后改了这里自动跟上
 */
const scareable = (n: NpcState) => canBeScared({ s: n } as Npc);

/**
 * 蓄力那一步会不会转过来（npc.ts 的 notice 对现身的那一拍：能被吓、不在受惊僵着；现身的察觉优先级最高，不会被别的来源挡掉）。
 * 天亮自己往外走的人（leaving，模拟那一路）只顾着出门、不察觉，所以也不转过来
 */
const turnsToward = (n: NpcState) => scareable(n) && n.mode !== 'startled' && n.mode !== 'leaving';

/** 下一个动作 act 会影响到的访客 id（引诱类：会听见、会过来；惊吓类、现身：会被吓到），按 state.npcs 的顺序 */
export function reachOf(grid: Grid, s: Readonly<WorldState>, act: ReachAct): number[] {
  if (act.kind === 'object') {
    const o = s.objects.find((x) => x.id === act.id);
    if (!o) return [];
    const spec = SCARES[o.type];
    if (spec.kind === 'sight') return o.seenBy.slice();
    const out: number[] = [];
    for (const n of s.npcs) if (scareable(n) && canHear(grid, n.pos, o.pos, spec.range)) out.push(n.id);
    return out;
  }
  const at = act.at;
  if (grid.isOpaque(...cellOf(at.x, at.z))) return [];
  const near = Math.min(MANIFEST.noticeRadius, MANIFEST.range);
  const out: number[] = [];
  for (const n of s.npcs) {
    if (!scareable(n)) continue;
    const d = Math.hypot(n.pos.x - at.x, n.pos.z - at.z);
    const turns = d <= near && turnsToward(n) && grid.lineOfSight(n.pos, at);
    if (turns || canSee(grid, n, at, MANIFEST.range)) out.push(n.id);
  }
  return out;
}
