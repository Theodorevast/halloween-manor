// 界面上的全部英文文案
import type { Personality, ScareType } from '../sim/types';

export const STRINGS = {
  title: 'Halloween Manor',
  start: {
    headphones: 'Put on headphones.',
    begin: 'Click to begin the haunting.',
    /** 渲染器和模型还在加载、着色器还在编时，开场按钮上的文案（下面跟一条慢慢变满的细线） */
    loading: 'Lighting the candles…',
    /** 这一局的目标：三步说明上面那一行 */
    goal: 'Scare the visitors out the front door.',
    /**
     * 三步说明（2026-10-30 用户试玩：「F 没有任何提示，要有游戏说明」）。hud.ts 的 titleSteps 按设备挑：
     * 触屏第二步用 Tap 的说法；没有现身的（触屏、娃娃屋）第三步换成 again。appear 里单独的 F 排成键帽
     */
    steps: {
      find: 'Find someone with a flashlight.',
      look: 'Possess what they are looking at — an eye appears above it. Make a sound first if no one is looking.',
      tapLook: 'Tap what they are looking at — an eye appears above it. Make a sound first if no one is looking.',
      appear: 'Step into their light and press F to appear.',
      again: 'Scare them again before they calm down, and they will run.',
    },
    /** 三步说明下面一行：一夜多长、天亮时怎样 */
    night: 'A night lasts about five minutes. At dawn the house empties.',
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
    /** 收夜以后（不再有人来）出门的那一行：不再问 Who's next?（2026-10-30 试玩 P2-1；hud.ts 按收夜状态选） */
    exitClosed: (name: string) => `${name} is gone.`,
    /** 机关设下以后一直没人来、到时间自己解除（trap expired，2026-10-30 试玩 P2-4）：安静的一行，物件名用显示名 */
    trapExpired: (prop: string) => `The ${prop.toLowerCase()} stopped waiting.`,
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
    /** 还在点蜡烛时就点了开始（记下了，编好就自动开场，2026-10-30 newbie G5）：按钮上的字，细线照常往前走 */
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
      /** 2026-10-30 试玩 P1-1：把「先引诱、人转过来看、再附身」的套路说出来（原来只说找眼睛，眼睛又是一闪一闪的） */
      firstMiss: 'Scares only work when someone is watching. Make a sound first, or wait for the eye.',
      firstLure: "They'll come to look. Wait until they see something.",
      firstRevealed: 'They see you only in their light. Right-click or F to appear.',
    },
    /** firstAim 的后半句：玩家已经附身过（会点了）时只说这半句（2026-10-30 试玩 P2-3，见 ui/hints.ts 的 textOf） */
    aimTrapOnly: 'Hold to set a trap',
    /** 做不到时的一句回应（每次都有，但很轻） */
    refused: {
      manifestCooldown: 'Not yet.',
      manifestWall: 'Not from inside the walls.',
      trapsFull: 'Two traps are already set.',
      tooFar: 'Too far away.',
    },
    /** 一次附身落空（惊吓类的生效窗口结束都没吓到人）：播报一行。第一次附身吓到人之前每次都说，之后只在头几次（hud.ts 的 missLineDue） */
    missed: (prop: string) => `No one saw the ${prop.toLowerCase()}.`,
    /** 现身落下、谁也没吓到（2026-10-30 newbie S1：原来一个字都没有）。和 missed 同一个规矩 */
    manifestMissed: 'No one saw you. Stand in their light.',
    /**
     * 常驻的按键说明（右下角，2026-10-30 HT-2）：每一行一个键、一个动作；F 那一行后面写状态（STRINGS.ready / STRINGS.cooldown）。
     * 三样都用过一次以后只留 F 和状态
     */
    legend: {
      click: 'Click',
      possess: 'possess',
      hold: 'Hold',
      trap: 'set a trap',
      appear: 'appear',
    },
    /** 现身的键（标题页第三步、右下角、准星旁的键帽都排成这一个字） */
    fKey: 'F',
    /** 触屏 */
    tapToBegin: 'Tap to begin the haunting.',
    turnSideways: 'Turn your phone sideways for a better view.',
  },
  /**
   * 结果（2026-10-30 手感分析 FEEL-3）：附身以后，准星（手指）还对着这个物件时，悬停标签的第二行先报结果，停一会儿再回到冷却秒数。
   * 骨白 / 灰烬色的小型大写，和播报一个口气：一句话、没有感叹号
   */
  outcome: {
    /** 惊吓类：被它吓到的人（名字用下面的 names 连起来） */
    jumped: (who: string) => `${who} jumped`,
    /** 引诱类：听见了、会过来查看的人 */
    heard: (who: string) => `${who} heard it`,
    /** 生效窗口结束都没人 */
    noneSaw: 'No one saw it',
    noneHeard: 'No one heard it',
  },
  /** 名字连起来（结果、播报里合并的尖叫传染共用）：Theo / Theo and Mia / Theo, Mia and Sam / Theo, Mia and 2 others */
  names: (list: readonly string[]): string => {
    if (list.length <= 1) return list[0] ?? '';
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    if (list.length === 3) return `${list[0]}, ${list[1]} and ${list[2]}`;
    return `${list[0]}, ${list[1]} and ${list.length - 2} others`;
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
    scream: (time: string) => `ran at ${time} when someone screamed`,
    trap: (prop: string, time: string) => `the ${prop.toLowerCase()} was waiting for them at ${time}`,
    stillInside: 'still inside',
    /** 天亮自己走的（exit 带 calm）：不评价恐惧（被吓过一下、只是没跑的人也写这一句），只写天色 */
    leftAtDawn: (time: string) => `walked out at ${time}, as the sky paled`,
    /** 人太多时：只写前面这么多行，剩下的一句带过 */
    andOthers: (n: string) => `and ${n} others`,
    /** 数字写进句子（页脚、andOthers；register.ts 的 inWords）：下标就是那个数，one 到 twenty 写英文单词，再多写阿拉伯数字 */
    numbers: [
      '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
      'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
    ] as readonly string[],
    /** 钟点后面的上午 / 下午（register.ts 的 clockAt；registerView.ts 折行时把钟点和它粘在一起） */
    meridiem: { am: 'am', pm: 'pm' },
    /**
     * 收夜那一页页脚的第一句（2026-10-30 路 GP）：按这一夜吓跑的比例给一句克制的话，不打分、不评级、不写数字。
     * all 全吓跑了；most 至少一半；few 有人跑、不到一半；none 一个都没跑
     */
    verdict: {
      all: 'Word will spread about this house.',
      most: 'Some of them will not come back.',
      few: 'Most of them will sleep tonight.',
      none: 'They will say the house is only old.',
    },
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
