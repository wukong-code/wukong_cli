import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import RESUME_CLAUDE_BODY from './resume-claude.md?raw';
import RESUME_CODEX_BODY from './resume-codex.md?raw';
import RESUME_CURSOR_BODY from './resume-cursor.md?raw';

function createResumeSkill(name: string, text: string): SkillDefinition {
  const pseudoPath = `builtin://${name}`;
  const parsed = parseSkillText({
    skillMdPath: `/builtin/skills/${name}.md`,
    skillDirName: name,
    source: 'builtin',
    text,
  });
  return {
    ...parsed,
    path: pseudoPath,
    dir: pseudoPath,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      disableModelInvocation: true,
    },
  };
}

export const RESUME_CODEX_SKILL = createResumeSkill('resume-codex', RESUME_CODEX_BODY);
export const RESUME_CLAUDE_SKILL = createResumeSkill('resume-claude', RESUME_CLAUDE_BODY);
export const RESUME_CURSOR_SKILL = createResumeSkill('resume-cursor', RESUME_CURSOR_BODY);
