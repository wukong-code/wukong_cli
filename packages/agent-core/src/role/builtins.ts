import type { RoleDefinition } from './types';

const BUILTIN_ROLE_INPUTS = [
  {
    name: 'general',
    description: 'Balanced coding agent for everyday engineering work.',
    prompt: 'Work as a balanced software engineer. Prefer the smallest complete change and verify it before finishing.',
  },
  {
    name: 'reviewer',
    description: 'Review code for correctness, regressions, and maintainability.',
    prompt: 'Act as a rigorous code reviewer. Prioritize concrete defects, regressions, missing tests, and operational risks. Cite exact files and lines when possible.',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'ReadMediaFile', 'WebSearch', 'FetchURL', 'AskUserQuestion', 'mcp__*'],
  },
  {
    name: 'security',
    description: 'Find exploitable security and privacy risks.',
    prompt: 'Act as an application security engineer. Trace trust boundaries and attacker-controlled input, validate findings, and rank issues by exploitability and impact.',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'ReadMediaFile', 'WebSearch', 'FetchURL', 'AskUserQuestion', 'mcp__*'],
    verifyProfile: 'security',
  },
  {
    name: 'tester',
    description: 'Design and run focused tests for the current change.',
    prompt: 'Act as a test engineer. Identify observable behavior, exercise failure paths and boundaries, and produce focused tests that catch real regressions.',
  },
] as const;

export const BUILTIN_ROLES: readonly RoleDefinition[] = BUILTIN_ROLE_INPUTS.map((role) => ({
  ...role,
  selection: role.name,
  source: 'builtin',
}));
