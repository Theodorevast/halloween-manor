// 界面上的全部英文文案
import type { Personality, ScareType } from '../sim/types';

export const STRINGS = {
  title: 'Halloween Manor',
  start: {
    headphones: 'Put on headphones.',
    begin: 'Click to begin the haunting.',
    /** 渲染器和模型还在加载时，开场按钮上的文案 */
    loading: 'Lighting the candles…',
    hint: 'Possess objects to scare the visitors out the front door.',
  },
  counter: (n: number) => `Scared off tonight: ${n}`,
  buttons: {
    rotateLeft: 'Rotate left (Q)',
    rotateRight: 'Rotate right (E)',
    mute: 'Mute',
    unmute: 'Unmute',
    qualityHigh: 'Quality: High',
    qualityLow: 'Quality: Low',
    /** 画质按钮上露出的短标签 */
    qualityShort: { high: 'High', low: 'Low' },
  },
  /** 第三人称（有鼠标的设备，engine/ghostRig.ts） */
  ghost: {
    /** 开场后在画面下方停几秒的操作说明，只出现一次 */
    controls: 'WASD drift · Mouse look · Click to possess · Wheel zoom',
    /** 丢了指针锁定（按了 Esc、切走了窗口）：点一下继续 */
    resume: 'Click to resume',
  },
  /** 悬停标签里的剩余冷却 */
  cooldown: (seconds: number) => `${Math.ceil(seconds)}s`,
  noWebGL: "Your browser can't run WebGL2, so the manor stays dark. Try a recent Chrome, Edge, Firefox or Safari.",
  bootFailed: 'Something went wrong while lighting the manor. Reload the page, or try a recent Chrome, Edge, Firefox or Safari.',
  deviceLost: 'The candles went out: your browser lost its graphics device. Click anywhere to relight the manor.',
  ready: 'Ready',
  personalityTag: { timid: 'scaredy-cat', average: '', brave: 'skeptic' } satisfies Record<Personality, string>,
  propName: {
    musicBox: 'Music box',
    door: 'Kitchen door',
    lamp: 'Lamp',
    rockingChair: 'Rocking chair',
    portrait: 'Portrait',
    mirror: 'Mirror',
  } satisfies Record<ScareType, string>,
  ticker: {
    spawn: (name: string) => `${name} let themselves in`,
    heard: (name: string, prop: string) => `${name} heard the ${prop.toLowerCase()}`,
    startle: (name: string, prop: string) => `${name} jumped at the ${prop.toLowerCase()}`,
    startleScream: (name: string) => `${name} flinched at a scream`,
    /** 鬼魂贴在身后够久：「后颈一凉」 */
    neck: (name: string) => `${name} felt a cold breath on their neck`,
    flee: (name: string) => `${name} fled screaming!`,
    exit: (name: string) => `${name} is gone. Who's next?`,
  },
};
