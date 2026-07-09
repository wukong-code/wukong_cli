/**
 * Wukong mascot emblem shown in the welcome card header.
 *
 * This is the compact Monkey King mascot, kept byte-for-byte in sync with the
 * web app's `MINI_ART` (`wukong_web/app/components/AsciiWukong.tsx`) so the CLI
 * and the website share one brand figure: an arched headband (the iconic 金箍),
 * two eyes, a nose, and a small body.
 *
 * Rows have different visible widths; callers pad each row to the widest row
 * (see `welcome.ts`) so the right-hand text column never drifts.
 */
export const WUKONG_EMBLEM: readonly string[] = [
  '  ▄██▄',
  '▄█●  ●█▄',
  '█  ▄  █',
  '▀█▄▄█▀',
  ' ▐██▌',
  '  ╰█▄',
];

/** Row index of the headband arch (金箍); rendered in the gold `warning` tone. */
export const WUKONG_EMBLEM_HEADBAND_ROW = 0;
