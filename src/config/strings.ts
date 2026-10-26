// 界面上的全部英文文案
import type { Personality, ScareType } from '../sim/types';

export const STRINGS = {
  title: 'Halloween Manor',
  start: {
    headphones: 'Put on headphones.',
    begin: 'Click to begin the haunting.',
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
  /** 悬停标签里的剩余冷却 */
  cooldown: (seconds: number) => `${Math.ceil(seconds)}s`,
  noWebGL: "Your browser can't run WebGL2, so the manor stays dark. Try a recent Chrome, Edge, Firefox or Safari.",
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
    flee: (name: string) => `${name} fled screaming!`,
    exit: (name: string) => `${name} is gone. Who's next?`,
  },
};
