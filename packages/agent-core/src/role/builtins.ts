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
    capabilityMode: 'read-only',
    tools: ['Read', 'Grep', 'Glob', 'ReadMediaFile'],
    inputs: [
      { name: 'loop_contract', type: 'json', required: true },
      { name: 'prior_blockers', type: 'json', required: false },
    ],
    outputs: [{ name: 'verdict', schema: 'reviewer-verdict-v1', required: true }],
  },
  {
    name: 'planner',
    description: 'Create a read-only implementation plan against explicit constraints.',
    prompt: 'Act as a read-only implementation planner. Inspect the codebase, preserve the stated constraints, and return a concrete ordered plan without modifying files.',
    capabilityMode: 'read-only',
    tools: ['Read', 'Grep', 'Glob', 'ReadMediaFile'],
    inputs: [
      { name: 'objective', type: 'text', required: true },
      { name: 'constraints', type: 'json', required: false },
    ],
    outputs: [{ name: 'plan', schema: 'implementation-plan-v1', required: true }],
  },
  {
    name: 'strategist',
    description: 'Change strategy when a Loop repeats the same blockers.',
    prompt: 'Act as a read-only Loop strategist. Preserve the immutable acceptance contract and propose one materially different way to resolve the repeated blocker set.',
    capabilityMode: 'read-only',
    tools: ['Read', 'Grep', 'Glob', 'ReadMediaFile'],
    inputs: [
      { name: 'loop_contract', type: 'json', required: true },
      { name: 'repeated_blockers', type: 'json', required: true },
    ],
    outputs: [{ name: 'strategy', schema: 'loop-strategy-v1', required: true }],
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
