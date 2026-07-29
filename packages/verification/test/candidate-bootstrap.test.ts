import { describe, expect, it } from 'vitest';

import {
  canonicalDigest,
  createCandidateBootstrapPlan,
  createCandidateBootstrapStep,
  createNoBootstrapCandidatePlan,
  validateCandidateBootstrapPlan,
  validateCandidateBootstrapStep,
} from '../src';

function digest(label: string): string {
  return canonicalDigest('wukong/test/candidate-bootstrap/v1', label);
}

function step(overrides: Record<string, unknown> = {}) {
  return createCandidateBootstrapStep({
    stepId: 'pnpm_install',
    recipeRef: 'builtin:pnpm-frozen-install',
    recipeVersion: '1.0.0',
    executableIdentity: digest('pnpm-executable'),
    runtimeVersionDigest: digest('node-version'),
    exactArgvPrivateRef: 'private/bootstrap/argv/step-1',
    argvDigest: digest('argv'),
    effectiveEnvironmentPrivateRef: 'private/bootstrap/env/step-1',
    effectiveEnvironmentDigest: digest('environment'),
    candidateRelativeCwd: '.',
    generatedPathScopes: ['node_modules'],
    timeoutMs: 120_000,
    ...overrides,
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  return createCandidateBootstrapPlan({
    bootstrapPlanId: '019f8ba1-1034-7abc-8def-0123456789ab',
    sourceSnapshotDigest: digest('snapshot'),
    gatePlanDigest: digest('gate'),
    ecosystemRefs: ['node:pnpm'],
    lockfileDigests: [digest('pnpm-lock')],
    steps: [step()],
    injectedEnvironmentNames: [],
    networkPolicy: 'deny',
    allowedRegistryEndpointDigests: [],
    permissionDigest: digest('permission'),
    bootstrapBudgetDigest: digest('budget'),
    ...overrides,
  });
}

describe('CandidateBootstrapPlanV1', () => {
  it('reconstructs the same default-deny no-bootstrap plan', () => {
    const input = {
      sourceSnapshotDigest: digest('source'),
      gatePlanDigest: digest('gate'),
    };
    const first = createNoBootstrapCandidatePlan(input);
    const second = createNoBootstrapCandidatePlan(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ecosystemRefs: [],
      lockfileDigests: [],
      steps: [],
      injectedEnvironmentNames: [],
      networkPolicy: 'deny',
      allowedRegistryEndpointDigests: [],
    });
    expect(validateCandidateBootstrapPlan(first)).toBe(true);
  });

  it('seals a deterministic deny-network plan', () => {
    const value = plan();

    expect(validateCandidateBootstrapPlan(value)).toBe(true);
    expect(validateCandidateBootstrapStep(value.steps[0])).toBe(true);
    expect(value.steps[0]?.lifecycleScripts).toBe('deny');
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.steps)).toBe(true);
  });

  it('allows explicit-once networking only with frozen endpoint digests', () => {
    const value = plan({
      networkPolicy: 'explicit_once',
      allowedRegistryEndpointDigests: [digest('registry.npmjs.org')],
    });

    expect(validateCandidateBootstrapPlan(value)).toBe(true);
    expect(() => plan({
      networkPolicy: 'explicit_once',
      allowedRegistryEndpointDigests: [],
    })).toThrow(TypeError);
    expect(() => plan({
      networkPolicy: 'deny',
      allowedRegistryEndpointDigests: [digest('registry.npmjs.org')],
    })).toThrow(TypeError);
  });

  it('rejects digest tampering and unknown fields', () => {
    const value = plan();

    expect(validateCandidateBootstrapPlan({
      ...value,
      permissionDigest: digest('changed-permission'),
    })).toBe(false);
    expect(validateCandidateBootstrapPlan({
      ...value,
      command: 'pnpm install',
    })).toBe(false);
    expect(validateCandidateBootstrapStep({
      ...value.steps[0],
      timeoutMs: 30_000,
    })).toBe(false);
  });

  it('requires canonical sorted unique bindings', () => {
    expect(() => plan({
      ecosystemRefs: ['python:uv', 'node:pnpm'],
    })).toThrow(TypeError);
    expect(() => plan({
      lockfileDigests: [digest('z'), digest('a')],
    })).toThrow(TypeError);
    expect(() => plan({
      injectedEnvironmentNames: ['TOKEN', 'TOKEN'],
    })).toThrow(TypeError);
    expect(() => plan({
      steps: [step(), step()],
    })).toThrow(TypeError);
  });

  it('rejects overlapping or protected generated scopes', () => {
    expect(() => step({
      generatedPathScopes: ['build', 'build/cache'],
    })).toThrow(TypeError);
    expect(() => step({
      generatedPathScopes: ['.git/objects'],
    })).toThrow(TypeError);
    expect(() => step({
      generatedPathScopes: ['src', 'node_modules'],
    })).toThrow(TypeError);
  });

  it('never accepts lifecycle scripts or raw argv as plan extensions', () => {
    const value = step();

    expect(validateCandidateBootstrapStep({
      ...value,
      lifecycleScripts: 'allow',
    })).toBe(false);
    expect(validateCandidateBootstrapStep({
      ...value,
      argv: ['install'],
    })).toBe(false);
  });

  it('preserves digest determinism across independent construction', () => {
    expect(plan().bootstrapPlanDigest).toBe(plan().bootstrapPlanDigest);
    expect(step().stepDigest).toBe(step().stepDigest);
  });
});
