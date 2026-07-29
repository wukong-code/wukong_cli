export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';

export interface CLIHeadlessGoal {
  readonly kind: 'loop';
  readonly objective: string;
  readonly replace: false;
  readonly stopCondition: 'proof-pass';
  readonly maxIterations: number;
  readonly minIntervalMs?: number;
  readonly reviewModel?: string;
  readonly completionCriterion?: string;
  readonly constraints?: readonly string[];
  readonly checks?: readonly string[];
  readonly discoveredCheckDecision?: 'accept' | 'only-explicit';
  readonly trustWorkspaceChallenge?: string;
  readonly approveGatePlanDigest?: string;
  readonly approveBootstrapPlanDigest?: string;
  readonly acknowledgeWarningSetDigest?: string;
  readonly verificationCatalogDigest?: string;
  readonly verificationSkills?: readonly {
    readonly selectionId: string;
    readonly provenanceDigest: string;
  }[];
  readonly trustReviewSubjectChallenge?: string;
  readonly acknowledgeReviewSubjectConsentDigest?: string;
  readonly selectedUntrackedPaths?: readonly string[];
  readonly promoteCandidateDigest?: string;
}

export interface CLIOptions {
  session: string | undefined;
  continue: boolean;
  yolo: boolean;
  /** Explicit confirmation required for unrestricted headless execution. */
  yes?: boolean;
  auto: boolean;
  plan: boolean;
  model: string | undefined;
  outputFormat: PromptOutputFormat | undefined;
  prompt: string | undefined;
  /** Structured `wukong loop` input; avoids lossy slash-command re-parsing. */
  headlessGoal?: CLIHeadlessGoal;
  skillsDirs: string[];
  addDirs?: string[];
}

export interface ValidatedOptions {
  options: CLIOptions;
  uiMode: UIMode;
}

export class OptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionConflictError';
  }
}

export function validateOptions(opts: CLIOptions): ValidatedOptions {
  const prompt = opts.prompt;
  const promptMode = prompt !== undefined;
  if (promptMode && prompt.trim().length === 0) {
    throw new OptionConflictError('Prompt cannot be empty.');
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new OptionConflictError('Model cannot be empty.');
  }
  if (!promptMode && opts.outputFormat !== undefined) {
    throw new OptionConflictError('Output format is only supported in prompt mode.');
  }
  if (opts.yes === true && !opts.yolo) {
    throw new OptionConflictError(
      '--yes no longer enables YOLO. Use --yolo --yes for unrestricted headless execution.',
    );
  }
  if (promptMode && opts.yolo && opts.yes !== true) {
    throw new OptionConflictError(
      'Headless YOLO requires explicit confirmation: use --yolo --yes.',
    );
  }
  if (promptMode && opts.plan) {
    throw new OptionConflictError('Cannot combine --prompt with --plan.');
  }
  if (promptMode && opts.session === '') {
    throw new OptionConflictError('Cannot use --session without an id in prompt mode.');
  }
  if (opts.continue && opts.session !== undefined) {
    throw new OptionConflictError('Cannot combine --continue, --session.');
  }
  if (opts.yolo && opts.auto) {
    throw new OptionConflictError('Cannot combine --yolo with --auto.');
  }
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
