import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_BOOTSTRAP_RECIPE_REGISTRY,
  candidateBootstrapRecipeFor,
  canonicalDigest,
  createCandidateBootstrapPreflight,
  createCandidateBootstrapPreflightEntry,
  validateCandidateBootstrapPreflight,
  validateCandidateBootstrapPreflightEntry,
  validateCandidateBootstrapRecipeDefinition,
} from '../src';

const SOURCE_DIGEST = canonicalDigest('test/source', 'source');
const GATE_DIGEST = canonicalDigest('test/gate', 'gate');
const MANIFEST_DIGEST = canonicalDigest('test/manifest', 'manifest');
const LOCKFILE_DIGEST = canonicalDigest('test/lockfile', 'lockfile');

describe('candidate bootstrap recipe registry', () => {
  it('freezes one deterministic deny-hook recipe per P0 ecosystem', () => {
    expect(CANDIDATE_BOOTSTRAP_RECIPE_REGISTRY.map(
      (recipe) => recipe.ecosystem,
    )).toEqual(['node', 'python', 'rust', 'go']);

    for (const recipe of CANDIDATE_BOOTSTRAP_RECIPE_REGISTRY) {
      expect(validateCandidateBootstrapRecipeDefinition(recipe)).toBe(true);
      expect(recipe.lifecycleScripts).toBe('deny');
      expect(recipe.nativeBuildHooks).toBe('deny');
      expect(recipe.postInstallCommands).toBe('deny');
      expect(recipe.networkPolicy).toBe('explicit_once');
      expect(recipe.registryEndpoints.length).toBeGreaterThan(0);
    }
  });

  it('selects only an exact ecosystem and lockfile pair', () => {
    expect(candidateBootstrapRecipeFor(
      'node',
      'package-lock.json',
    )?.recipeRef).toBe('builtin:node:npm-ci');
    expect(candidateBootstrapRecipeFor('node', 'pnpm-lock.yaml')).toBeNull();
    expect(candidateBootstrapRecipeFor('python', 'uv.lock')).toBeNull();
  });

  it('rejects a recipe whose safety contract is weakened', () => {
    const recipe = CANDIDATE_BOOTSTRAP_RECIPE_REGISTRY[0]!;
    expect(validateCandidateBootstrapRecipeDefinition({
      ...recipe,
      lifecycleScripts: 'allow',
    })).toBe(false);
    expect(validateCandidateBootstrapRecipeDefinition({
      ...recipe,
      installArgv: ['install'],
    })).toBe(false);
  });
});

describe('candidate bootstrap preflight contract', () => {
  it('seals a deterministic ready proposal requiring explicit consent', () => {
    const recipe = candidateBootstrapRecipeFor(
      'node',
      'package-lock.json',
    )!;
    const entry = createCandidateBootstrapPreflightEntry({
      ecosystem: 'node',
      ecosystemRef: 'node:npm',
      candidateRelativeCwd: '.',
      manifestPath: 'package.json',
      manifestDigest: MANIFEST_DIGEST,
      lockfilePath: 'package-lock.json',
      lockfileDigest: LOCKFILE_DIGEST,
      status: 'ready',
      reasonCode: 'candidate_bootstrap_confirmation_required',
      recipe,
    });
    const preflight = createCandidateBootstrapPreflight({
      sourceSnapshotDigest: SOURCE_DIGEST,
      gatePlanDigest: GATE_DIGEST,
      entries: [entry],
    });

    expect(validateCandidateBootstrapPreflightEntry(entry)).toBe(true);
    expect(validateCandidateBootstrapPreflight(preflight)).toBe(true);
    expect(preflight.status).toBe('ready');
    expect(preflight.requiresExplicitNetworkConsent).toBe(true);
    expect(preflight.reasonCode).toBe(
      'candidate_bootstrap_confirmation_required',
    );
  });

  it('sorts polyglot entries before sealing', () => {
    const node = createCandidateBootstrapPreflightEntry({
      ecosystem: 'node',
      ecosystemRef: 'node:npm',
      candidateRelativeCwd: 'web',
      manifestPath: 'web/package.json',
      manifestDigest: MANIFEST_DIGEST,
      lockfilePath: 'web/package-lock.json',
      lockfileDigest: LOCKFILE_DIGEST,
      status: 'ready',
      reasonCode: 'candidate_bootstrap_confirmation_required',
      recipe: candidateBootstrapRecipeFor('node', 'package-lock.json'),
    });
    const go = createCandidateBootstrapPreflightEntry({
      ecosystem: 'go',
      ecosystemRef: 'go:modules',
      candidateRelativeCwd: '.',
      manifestPath: 'go.mod',
      manifestDigest: MANIFEST_DIGEST,
      lockfilePath: null,
      lockfileDigest: null,
      status: 'not_required',
      reasonCode: 'candidate_bootstrap_not_required',
      recipe: null,
    });
    const preflight = createCandidateBootstrapPreflight({
      sourceSnapshotDigest: SOURCE_DIGEST,
      gatePlanDigest: GATE_DIGEST,
      entries: [node, go],
    });

    expect(preflight.entries.map(
      (entry) => `${entry.candidateRelativeCwd}:${entry.ecosystem}`,
    )).toEqual(['.:go', 'web:node']);
    expect(validateCandidateBootstrapPreflight(preflight)).toBe(true);
  });

  it('makes the first stable unsupported entry the aggregate blocker', () => {
    const unsupported = createCandidateBootstrapPreflightEntry({
      ecosystem: 'python',
      ecosystemRef: 'python:pip',
      candidateRelativeCwd: '.',
      manifestPath: 'pyproject.toml',
      manifestDigest: MANIFEST_DIGEST,
      lockfilePath: null,
      lockfileDigest: null,
      status: 'unsupported',
      reasonCode: 'candidate_bootstrap_lockfile_required',
      recipe: null,
    });
    const preflight = createCandidateBootstrapPreflight({
      sourceSnapshotDigest: SOURCE_DIGEST,
      gatePlanDigest: GATE_DIGEST,
      entries: [unsupported],
    });

    expect(preflight.status).toBe('unsupported');
    expect(preflight.requiresExplicitNetworkConsent).toBe(false);
    expect(preflight.reasonCode).toBe(
      'candidate_bootstrap_lockfile_required',
    );
  });

  it('rejects digest drift and invalid ready bindings', () => {
    const recipe = candidateBootstrapRecipeFor(
      'rust',
      'Cargo.lock',
    )!;
    const entry = createCandidateBootstrapPreflightEntry({
      ecosystem: 'rust',
      ecosystemRef: 'rust:cargo',
      candidateRelativeCwd: '.',
      manifestPath: 'Cargo.toml',
      manifestDigest: MANIFEST_DIGEST,
      lockfilePath: 'Cargo.lock',
      lockfileDigest: LOCKFILE_DIGEST,
      status: 'ready',
      reasonCode: 'candidate_bootstrap_confirmation_required',
      recipe,
    });
    expect(validateCandidateBootstrapPreflightEntry({
      ...entry,
      lockfileDigest: SOURCE_DIGEST,
    })).toBe(false);
    expect(validateCandidateBootstrapPreflightEntry({
      ...entry,
      recipe: null,
    })).toBe(false);
  });
});
