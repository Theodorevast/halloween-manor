// 机关设下后的空心眼睛（src/view/overlays.ts 的 updateMarks、src/styles.css 的 .ov-mark.is-armed .ov-eye）。
// node 里没有 DOM，overlays 的 DOM 没法跑；这里读 styles.css 和 overlays.ts 的文本，守三件事：
// 规则在、颜色滤镜变换是设计定的值；它排在 .is-seen / .is-ready 两条之后（优先级一样，后写的赢，不然 ready 的幽绿会盖回来）；
// overlays.ts 不再给眼睛写行内样式（行内样式比样式表里任何规则都高，之后在 CSS 里就改不动了）
import { describe, expect, it } from 'vitest';

// tsconfig 的 types 里只有 vite/client、没有 node 的类型，也不为一个测试把 node 类型加进整个工程：用变量当模块名取 node:fs。
// （不用 ?raw：vitest 默认把 .css 当空文件，?raw 也读不到内容）
const fsId = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsId)) as { readFileSync(path: URL, encoding: 'utf8'): string };
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const overlays = readFileSync(new URL('../src/view/overlays.ts', import.meta.url), 'utf8');

/** 样式表里「只有这一个选择器」的那条规则：声明块和它在文件里的位置；没有就是 null */
function rule(selector: string): { body: string; at: number } | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? { body: m[1], at: m.index } : null;
}

describe('空心眼睛：样式写在 styles.css 的 .ov-mark.is-armed .ov-eye，不用行内样式（P-5）', () => {
  const armed = rule('.ov-mark.is-armed .ov-eye');

  it('styles.css 里有这条规则：霜的冷白、只留一圈黑边（不发绿光）、眼睛一直睁着（不管有没有人看着它）', () => {
    expect(armed).not.toBeNull();
    const body = armed?.body ?? '';
    expect(body).toMatch(/color:\s*rgb\(190,\s*205,\s*224\)\s*;/);
    expect(body).toMatch(/filter:\s*drop-shadow\(0 0 2px rgba\(0, 0, 0, 0\.95\)\)\s*;/); // 只有黑边这一层
    expect(body).not.toMatch(/125,\s*255,\s*168/); // 不是 .is-ready 那层幽绿的光
    expect(body).toMatch(/transform:\s*scaleY\(1\)\s*;/);
  });

  it('写在 .is-seen、.is-ready 两条规则的后面（选择器的优先级一样，后写的赢；设了机关的物件也可能 is-ready）', () => {
    const seen = rule('.ov-mark.is-seen .ov-eye');
    const ready = rule('.ov-mark.is-ready .ov-eye');
    expect(seen).not.toBeNull();
    expect(ready).not.toBeNull();
    expect(armed?.at ?? -1).toBeGreaterThan(seen?.at ?? Infinity);
    expect(armed?.at ?? -1).toBeGreaterThan(ready?.at ?? Infinity);
  });

  it('overlays.ts 不再给眼睛写行内样式（颜色、滤镜、变换都在样式表里）；换空心 / 实心的内容和 is-armed 类名还在', () => {
    expect(overlays).not.toMatch(/HOLLOW_STYLE/);
    expect(overlays).not.toMatch(/\.eye\.style\b/);
    expect(overlays).toMatch(/classList\.toggle\('is-armed'/);
    expect(overlays).toMatch(/EYE_HOLLOW/);
  });
});
