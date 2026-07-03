export type WukongMascotFrameName = 'idle' | 'blink' | 'scan' | 'happy' | 'staff';

export const WUKONG_MASCOT_FRAME_NAMES: readonly WukongMascotFrameName[] = [
  'idle',
  'blink',
  'scan',
  'happy',
  'staff',
];

export const WUKONG_MASCOT_FRAMES: Record<WukongMascotFrameName, readonly string[]> = {
  idle: [
    '.........GGG.........',
    '.......GGgggGG.......',
    '......FFFFFFFFF......',
    '....FFFFSSSSSFFFF....',
    '...FFFSSSSSSSSSFFF...',
    '..FFFSSSSSSSSSSSFFF..',
    '.FFFSSSESSSSSESSSFFF.',
    '.FFFSSSSSPSSPSSSSFFF.',
    '..FFFSSSSSNSSSSSFFF..',
    '..FFFSSMMMMMMMSSFFF..',
    '...FFFSSMNNNMSSFFF...',
    '....FFFSSSSSSSFFF....',
    '......FFFSSSFFF......',
    '.......FFSSSFF.......',
    '.......FSSSSSF...K...',
    '......FFSSSSSFF..K...',
    '.......FF...FF..K....',
    '......FF.....FFK.....',
  ],
  blink: [
    '.........GGG.........',
    '.......GGgggGG.......',
    '......FFFFFFFFF......',
    '....FFFFSSSSSFFFF....',
    '...FFFSSSSSSSSSFFF...',
    '..FFFSSSSSSSSSSSFFF..',
    '.FFFSSSNSSSSSNSSSFFF.',
    '.FFFSSSSSPSSPSSSSFFF.',
    '..FFFSSSSSNSSSSSFFF..',
    '..FFFSSMMMMMMMSSFFF..',
    '...FFFSSMNNNMSSFFF...',
    '....FFFSSSSSSSFFF....',
    '......FFFSSSFFF......',
    '.......FFSSSFF.......',
    '.......FSSSSSF...K...',
    '......FFSSSSSFF..K...',
    '.......FF...FF..K....',
    '......FF.....FFK.....',
  ],
  scan: [
    '.........GGG.........',
    '.......GGgggGG.......',
    '......FFFFFFFFF......',
    '....FFFFSSSSSFFFF....',
    '...FFFSSSSSSSSSFFF...',
    '..FFFSSSSSSSSSSSFFF..',
    'CC.FSSSESSSSSESSSF.CC',
    '.FFFSSSSSPSSPSSSSFFF.',
    '..FFFSSSSSNSSSSSFFF..',
    '..FFFSSMMMMMMMSSFFF..',
    '...FFFSSMNNNMSSFFF...',
    '....FFFSSSSSSSFFF....',
    '......FFFSSSFFF......',
    '.......FFSSSFF.......',
    '.......FSSSSSF...K...',
    '......FFSSSSSFF..K...',
    '.......FF...FF..K....',
    '......FF.....FFK.....',
  ],
  happy: [
    '.........GGG.........',
    '.......GGgggGG.......',
    '......FFFFFFFFF......',
    '....FFFFSSSSSFFFF....',
    '...FFFSSSSSSSSSFFF...',
    '..FFFSSSSSSSSSSSFFF..',
    '.FFFSSSUSSUSUSSSSFFF.',
    '.FFFSSSSSPSSPSSSSFFF.',
    '..FFFSSSSSNSSSSSFFF..',
    '..FFFSSMMMMMMMMMSSFF.',
    '...FFFSSMNNNMSSFFF...',
    '....FFFSSSSSSSFFF....',
    '......FFFSSSFFF......',
    '.......FFSSSFF.......',
    '.......FSSSSSF...K...',
    '......FFSSSSSFF..K...',
    '.......FF...FF..K....',
    '......FF.....FFK.....',
  ],
  staff: [
    '.........GGG.........',
    '.......GGgggGG.......',
    '......FFFFFFFFF......',
    '....FFFFSSSSSFFFF....',
    '...FFFSSSSSSSSSFFF...',
    '..FFFSSSSSSSSSSSFFF..',
    '.FFFSSSESSSSSESSSFFF.',
    '.FFFSSSSSPSSPSSSSFFF.',
    '..FFFSSSSSNSSSSSFFF..',
    '..FFFSSMMMMMMMSSFFF..',
    '...FFFSSMNNNMSSFFF...',
    '....FFFSSSSSSSFFF....',
    '......FFFSSSFFF......',
    '.......FFSSSFF.......',
    '.......FSSSSSF..K....',
    '......FFSSSSSFFK.....',
    '.......FF...FKF......',
    '......FF....KFF......',
  ],
};

export const WUKONG_MASCOT_WIDTH = Math.max(...Object.values(WUKONG_MASCOT_FRAMES).flat().map((row) => row.length));
export const WUKONG_MASCOT_HEIGHT = WUKONG_MASCOT_FRAMES.idle.length;

export const WUKONG_MASCOT_LEGEND: Record<string, string> = {
  F: 'fur',
  S: 'face',
  G: 'gold circlet',
  g: 'gold highlight',
  E: 'fire eye',
  U: 'happy eye',
  P: 'cheek',
  M: 'muzzle',
  N: 'nose and mouth',
  K: 'staff',
  C: 'scan beam',
};

const DEFAULT_GLYPHS: Record<string, string> = {
  '.': ' ',
  F: '█',
  S: '▓',
  G: '▀',
  g: '▄',
  E: '◆',
  U: '⌒',
  P: '•',
  M: '░',
  N: '▪',
  K: '━',
  C: '═',
};

export function renderWukongMascotGlyphRows(
  frameName: WukongMascotFrameName,
  glyphs: Partial<Record<string, string>> = {},
): string[] {
  const mergedGlyphs = { ...DEFAULT_GLYPHS, ...glyphs };
  return WUKONG_MASCOT_FRAMES[frameName].map((row) =>
    row
      .padEnd(WUKONG_MASCOT_WIDTH, '.')
      .split('')
      .map((token) => mergedGlyphs[token] ?? ' ')
      .join(''),
  );
}
