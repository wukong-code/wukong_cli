import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function parseStableTag(tag, label) {
  const match = STABLE_TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(`${label} must be an exact stable v-prefixed SemVer tag: ${tag}`);
  }
  return match.slice(1).map((part) => BigInt(part));
}

export function assertStablePromotion(candidateTag, currentLatestTag) {
  const candidate = parseStableTag(candidateTag, 'Candidate');
  const current = parseStableTag(currentLatestTag, 'Current latest');
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] > current[index]) return;
    if (candidate[index] < current[index]) break;
  }
  throw new Error(`Stable ${candidateTag} must be newer than current latest ${currentLatestTag}.`);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assertStablePromotion(process.argv[2], process.argv[3]);
  console.log(`${process.argv[2]} is a valid promotion over ${process.argv[3]}.`);
}
