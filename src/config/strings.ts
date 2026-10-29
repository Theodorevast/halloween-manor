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
    /** 第三人称（能操控鬼魂）时接在 hint 后面 */
    ghostHint: 'They only see what their flashlight shows.',
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
    controls: 'WASD drift · Mouse look · Click to possess · Hold to set a trap · Right-click or F to appear',
    /** 丢了指针锁定（按了 Esc、切走了窗口）：点一下继续 */
    resume: 'Click to resume',
  },
  /** 悬停标签里的剩余冷却 */
  cooldown: (seconds: number) => `${Math.ceil(seconds)}s`,
  noWebGL: "Your browser can't run WebGL2, so the manor stays dark. Try a recent Chrome, Edge, Firefox or Safari.",
  bootFailed: 'Something went wrong while lighting the manor. Reload the page, or try a recent Chrome, Edge, Firefox or Safari.',
  deviceLost: 'The candles went out: your browser lost its graphics device. Click anywhere to relight the manor.',
  ready: 'Ready',
  /** 悬停标签：这个物件设了机关（按住左键设的），等人从它跟前走过 */
  trapSet: 'Trap set',
  personalityTag: { timid: 'scaredy-cat', average: '', brave: 'skeptic' } satisfies Record<Personality, string>,
  propName: {
    musicBox: 'Music box',
    door: 'Kitchen door',
    lamp: 'Lamp',
    rockingChair: 'Rocking chair',
    portrait: 'Portrait',
    mirror: 'Mirror',
    bed: 'Bed',
    wardrobe: 'Wardrobe',
  } satisfies Record<ScareType, string>,
  ticker: {
    spawn: (name: string) => `${name} let themselves in`,
    heard: (name: string, prop: string) => `${name} heard the ${prop.toLowerCase()}`,
    startle: (name: string, prop: string) => `${name} jumped at the ${prop.toLowerCase()}`,
    startleScream: (name: string) => `${name} flinched at a scream`,
    /** 鬼魂贴在身后够久：「后颈一凉」 */
    neck: (name: string) => `${name} felt a cold breath on their neck`,
    /** 主动现身吓到了他（manifest drop 的 scared） */
    seen: (name: string) => `${name} saw you in the dark`,
    flee: (name: string) => `${name} fled screaming!`,
    exit: (name: string) => `${name} is gone. Who's next?`,
    /** 一夜（2026-10-30）：收夜那一刻；收夜时屋里没人、最后再来的那一位 */
    lastCall: 'No one else is coming tonight.',
    lastArrival: (name: string) => `${name} is the last to arrive.`,
    /** 天亮：还没被吓走的人自己出门（World.dawn） */
    dawn: 'The sky is growing pale.',
    leftCalm: (name: string) => `${name} walked out into the morning`,
  },
  /**
   * 上手（2026-10-30 试玩报告 P1-1 / P1-2 / P1-3，用户选了「开场和提示」「标签说实话」）。
   * 文案克制：一句话、没有感叹号、没有数字，和播报一个口气
   */
  onboarding: {
    /** 点了开始、遮罩还挂着的时候按钮上的字（原来回到 Lighting the candles…，看着像退回去了） */
    almostLit: 'The candles are almost lit…',
    /** 「点一下继续」下面挂的操作说明（Esc 就是暂停：随时能再看） */
    controlsOnPause: 'WASD drift · Mouse look · Click to possess · Hold to set a trap · Right-click or F to appear · Wheel zoom',
    /** 惊吓类物件悬停标签的第二行：有人看着 / 没人看着（引诱类照旧 Ready） */
    watching: (name: string) => `${name} is watching`,
    watchingMany: (name: string, more: number) => `${name} and ${more === 1 ? 'one other' : 'others'} are watching`,
    noOneWatching: 'No one is watching',
    /** 只出现一次的情境提示（每种第一次碰到时） */
    hints: {
      firstAim: 'Click to possess · Hold to set a trap',
      firstMiss: 'Scares only work when someone is watching. Look for the eye.',
      firstLure: "They'll come to look. Wait until they see something.",
      firstRevealed: 'They see you only in their light. Right-click or F to appear.',
    },
    /** 做不到时的一句回应（每次都有，但很轻） */
    refused: {
      manifestCooldown: 'Not yet.',
      manifestWall: 'Not from inside the walls.',
      trapsFull: 'Two traps are already set.',
      tooFar: 'Too far away.',
    },
    /** 一次附身落空（惊吓类的生效窗口结束都没吓到人）：播报一行，只在头几次 */
    missed: (prop: string) => `No one saw the ${prop.toLowerCase()}.`,
    /** 触屏 */
    tapToBegin: 'Tap to begin the haunting.',
    tapHint: 'Tap a glowing object when someone is looking at it.',
    turnSideways: 'Turn your phone sideways for a better view.',
  },
  /** 访客登记簿（2026-10-30「一夜」；收夜时翻开，中途也能翻） */
  register: {
    title: 'Register of Visitors',
    subtitle: 'Halloween Manor · the night of October 31st',
    /** 中途翻开时 */
    notOver: 'The night is not over.',
    /** 右下角本子按钮的提示 */
    open: 'Register of visitors',
    keepHaunting: 'Keep haunting',
    anotherNight: 'Another night',
    back: 'Back to the manor',
    /** 一行的第二部分：几点进来、怎么走的 */
    cameIn: (time: string) => `came in at ${time}`,
    ranFrom: (prop: string, time: string) => `ran from the ${prop.toLowerCase()} at ${time}`,
    sawYou: (time: string) => `saw you in the dark, and ran at ${time}`,
    coldBreath: (time: string) => `felt a cold breath, and ran at ${time}`,
    scream: (time: string) => `ran when someone screamed, at ${time}`,
    trap: (prop: string, time: string) => `the ${prop.toLowerCase()} was waiting for them at ${time}`,
    stillInside: 'still inside',
    /** 天亮自己走的（exit 带 calm） */
    leftAtDawn: (time: string) => `walked out at ${time}, unafraid`,
    /** 人太多时：只写前面这么多行，剩下的一句带过 */
    andOthers: (n: string) => `and ${n} others`,
    /** 页脚两三句：数字用英文单词写在句子里，不做大号数字、不做表格、不打分 */
    footer: {
      cameRan: (came: string, ran: string) => `${came} came in. ${ran} ran.`,
      /** 有人天亮自己走了 */
      neverRan: (n: string) => `${n} never ran.`,
      noneSaw: 'None of them saw you.',
      someSaw: (n: string) => `${n} of them saw you.`,
      mostWork: (prop: string) => `The ${prop.toLowerCase()} did most of the work.`,
      stayedLongest: (name: string, time: string) => `${name} stayed the longest, until ${time}.`,
      /** 墙上多一个影子出现过的那一夜 */
      oneMore: 'And one more, who did not sign.',
    },
    /**
     * 穿哪套（每行第一部分的最后一项），按访客造型的 id。联名的两套不写在这里：它们的名字放在 character.ts 的 COLLAB_SPECS 里，
     * 跟着 __COLLAB__ 一起被摇掉（默认构建里不能出现联名的任何字样，见 vite.config.ts）
     */
    outfit: {
      vampire: 'the vampire',
      'lantern-explorer': 'the explorer',
      witch: 'the witch',
      skeleton: 'the skeleton',
      fox: 'the fox',
    } as Record<string, string>,
  },
};
