import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_BOOTSTRAP_CWD_REF,
  resolveCandidateBootstrapEnvironment,
} from '../src/candidate-bootstrap-environment';

describe('candidate bootstrap environment', () => {
  it('resolves only the recipe-owned Go cache paths below candidate cwd', () => {
    const cwd = resolve('candidate-bootstrap-environment-test');
    expect(resolveCandidateBootstrapEnvironment({
      CI: '1',
      GOCACHE:
        `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go-cache`,
      GOMODCACHE:
        `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go-path/pkg/mod`,
      GOPATH:
        `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go-path`,
    }, cwd)).toEqual({
      CI: '1',
      GOCACHE: resolve(cwd, '.wukong-bootstrap/go-cache'),
      GOMODCACHE: resolve(
        cwd,
        '.wukong-bootstrap/go-path/pkg/mod',
      ),
      GOPATH: resolve(cwd, '.wukong-bootstrap/go-path'),
    });
  });

  it('rejects candidate path references for unapproved names', () => {
    expect(() => resolveCandidateBootstrapEnvironment({
      HOME: `${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/home`,
    }, resolve('candidate'))).toThrow(expect.objectContaining({
      reasonCode: 'candidate_bootstrap_environment_invalid',
    }));
  });

  it.each([
    '',
    '../outside',
    '.wukong-bootstrap/../outside',
    '/absolute',
    String.raw`.wukong-bootstrap\outside`,
  ])('rejects unsafe candidate path reference %j', (path) => {
    expect(() => resolveCandidateBootstrapEnvironment({
      GOPATH: `${CANDIDATE_BOOTSTRAP_CWD_REF}${path}`,
    }, resolve('candidate'))).toThrow(expect.objectContaining({
      reasonCode: 'candidate_bootstrap_environment_invalid',
    }));
  });

  it('rejects a reference embedded inside an ordinary value', () => {
    expect(() => resolveCandidateBootstrapEnvironment({
      GOPATH: `prefix-${CANDIDATE_BOOTSTRAP_CWD_REF}.wukong-bootstrap/go`,
    }, resolve('candidate'))).toThrow(expect.objectContaining({
      reasonCode: 'candidate_bootstrap_environment_invalid',
    }));
  });
});
