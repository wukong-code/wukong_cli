import { isAbsolute, relative, resolve } from 'node:path';

export const CANDIDATE_BOOTSTRAP_CWD_REF =
  'wukong-candidate-cwd:' as const;

const CANDIDATE_PATH_ENVIRONMENT_NAMES = new Set([
  'GOCACHE',
  'GOMODCACHE',
  'GOPATH',
]);

export type CandidateBootstrapEnvironmentErrorCode =
  | 'candidate_bootstrap_environment_invalid';

export class CandidateBootstrapEnvironmentError extends Error {
  constructor(
    readonly reasonCode: CandidateBootstrapEnvironmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CandidateBootstrapEnvironmentError';
  }
}

/**
 * Resolves the small, recipe-owned candidate path vocabulary immediately
 * before spawn. The confirmed plan binds the opaque candidate-relative value;
 * callers cannot inject arbitrary absolute paths or opt additional names in.
 */
export function resolveCandidateBootstrapEnvironment(
  environment: Readonly<Record<string, string>>,
  candidateCwd: string,
): Readonly<Record<string, string>> {
  const absoluteCandidateCwd = resolve(candidateCwd);
  const resolvedEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!value.startsWith(CANDIDATE_BOOTSTRAP_CWD_REF)) {
      if (value.includes(CANDIDATE_BOOTSTRAP_CWD_REF)) {
        fail('The candidate cwd reference must occupy the full value prefix.');
      }
      resolvedEnvironment[name] = value;
      continue;
    }
    if (!CANDIDATE_PATH_ENVIRONMENT_NAMES.has(name)) {
      fail('The candidate cwd reference is not allowed for this environment name.');
    }
    const candidateRelativePath =
      value.slice(CANDIDATE_BOOTSTRAP_CWD_REF.length);
    if (candidateRelativePath.length === 0
      || isAbsolute(candidateRelativePath)
      || candidateRelativePath.includes('\\')
      || candidateRelativePath.split('/').some(
        (segment) => segment.length === 0
          || segment === '.'
          || segment === '..',
      )) {
      fail('The candidate cwd reference contains an unsafe relative path.');
    }
    const absolutePath = resolve(
      absoluteCandidateCwd,
      candidateRelativePath,
    );
    const projection = relative(absoluteCandidateCwd, absolutePath);
    if (projection.length === 0
      || projection === '..'
      || projection.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(projection)) {
      fail('The candidate cwd reference escapes the candidate workspace.');
    }
    resolvedEnvironment[name] = absolutePath;
  }
  return Object.freeze(resolvedEnvironment);
}

function fail(message: string): never {
  throw new CandidateBootstrapEnvironmentError(
    'candidate_bootstrap_environment_invalid',
    message,
  );
}
