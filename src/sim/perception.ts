// 感知：看见 = 手电光锥（距离 + 半角）+ 格子视线；听见 = 距离，隔墙时距离打折。
import { WALL_HEARING_FACTOR } from '../config/scares';
import { VISION } from '../config/visitors';
import { angleDiff, angleOf } from '../lib/angle';
import type { Grid } from './grid';
import type { NpcState, Vec2 } from './types';

/** 访客能不能看见 target：距离 ≤ range、在手电光锥半角内、中间没有墙 */
export function canSee(grid: Grid, npc: Pick<NpcState, 'pos' | 'lookDir'>, target: Vec2, range: number): boolean {
  const dx = target.x - npc.pos.x, dz = target.z - npc.pos.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > range * range) return false;
  // 贴脸的东西不用看角度
  if (d2 > 1e-12 && angleDiff(npc.lookDir, angleOf(dx, dz)) > VISION.halfAngle) return false;
  return grid.lineOfSight(npc.pos, target);
}

/** listener 能不能听见 source：有视线时距离 ≤ range；隔墙时距离 ≤ range × WALL_HEARING_FACTOR */
export function canHear(grid: Grid, listener: Vec2, source: Vec2, range: number): boolean {
  const d2 = (source.x - listener.x) ** 2 + (source.z - listener.z) ** 2;
  if (d2 > range * range) return false;
  const muffled = range * WALL_HEARING_FACTOR;
  if (d2 <= muffled * muffled) return true;
  return grid.lineOfSight(listener, source);
}
