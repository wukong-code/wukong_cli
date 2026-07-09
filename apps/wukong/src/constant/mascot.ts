import mascotData from './mascot-data.json' with { type: 'json' };

export type WukongMascotFrameName = 'idle' | 'blink' | 'scan' | 'happy' | 'staff';

export const WUKONG_MASCOT_FRAME_NAMES: readonly WukongMascotFrameName[] = [
  'idle',
  'blink',
  'scan',
  'happy',
  'staff',
];

export const WUKONG_MASCOT_FRAMES = mascotData.frames as Record<
  WukongMascotFrameName,
  readonly string[]
>;

export const WUKONG_MASCOT_PALETTE = mascotData.palette as Readonly<Record<string, string>>;
export const WUKONG_MASCOT_WIDTH = mascotData.width;
export const WUKONG_MASCOT_HEIGHT = mascotData.height;
export const WUKONG_MASCOT_VERSION = mascotData.version;

export const WUKONG_MASCOT_LEGEND: Record<string, string> = {
  D: 'dark outline',
  F: 'fur',
  H: 'fur highlight',
  S: 'face',
  L: 'face highlight',
  G: 'gold circlet',
  g: 'circlet highlight',
  E: 'fire eye',
  U: 'happy eye',
  N: 'feature line',
  P: 'cheek',
  K: 'staff',
  R: 'staff cap',
  C: 'scan beam',
  T: 'tail',
};

const DEFAULT_GLYPHS: Record<string, string> = {
  '.': ' ',
  D: '█',
  F: '▓',
  H: '▒',
  S: '▒',
  L: '░',
  G: '▀',
  g: '▄',
  E: '◆',
  U: '⌒',
  N: '▪',
  P: '•',
  K: '┃',
  R: '◆',
  C: '═',
  T: '▓',
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
