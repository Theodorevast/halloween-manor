// 联名皮肤（config/character.ts 的 COLLAB_SPECS）什么时候进访客轮换、排在哪（2026-10-29 最终审查 I2、M3）。
// 默认构建里连地址都不能有：那一条靠构建以后在 dist 里 grep 查（见 vite.config.ts），这里查的是代码里的开关和顺序。
// character.ts 载入时就决定并不并（读 location 和 __COLLAB__），每条测试先 stub 好再重新载入
import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(search: string | null, collab?: boolean) {
  vi.resetModules();
  if (search !== null) vi.stubGlobal('location', { search });
  // vitest 把 define 的值挂在 globalThis 上（vitest.config.ts 给的是 true），stub 一下就是默认构建里的 false
  if (collab !== undefined) vi.stubGlobal('__COLLAB__', collab);
  return import('../src/config/character');
}
const names = (specs: { url: string }[]) => specs.map((s) => s.url.replace(/^.*\/(.+)\.glb$/, '$1'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('联名皮肤进不进访客轮换', () => {
  it('带 ?nocollab：只有公开的四套', async () => {
    expect(names((await load('?nocollab')).VISITOR_SPECS)).toEqual(['vampire', 'lantern-explorer', 'witch', 'skeleton']);
    expect(names((await load('?debug&nocollab')).VISITOR_SPECS)).toEqual(['vampire', 'lantern-explorer', 'witch', 'skeleton']);
  });

  it('默认（2026-10-30 起公开构建也带）：两套联名插在第一套后面——开场照旧是公开的那一套，第 2、3 个进门的人穿联名；node 里没有 location 也一样', async () => {
    expect(names((await load(null)).VISITOR_SPECS)).toEqual(['vampire', 'jotaro', 'dio', 'lantern-explorer', 'witch', 'skeleton']);
    const c = await load('?debug');
    expect(names(c.VISITOR_SPECS)).toEqual(['vampire', 'jotaro', 'dio', 'lantern-explorer', 'witch', 'skeleton']);
    expect(c.VISITOR_SPECS[1]).toBe(c.COLLAB_SPECS[0]);
    expect(c.VISITOR_SPECS[2]).toBe(c.COLLAB_SPECS[1]);
  });

  it('COLLAB=0 构建（__COLLAB__ 为 false）：不并', async () => {
    expect(names((await load('?debug', false)).VISITOR_SPECS)).toEqual(['vampire', 'lantern-explorer', 'witch', 'skeleton']);
  });
});
