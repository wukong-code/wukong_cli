import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  WorkspaceChangedError,
  buildStandaloneGateReviewPrompt,
  createGateRunId,
  createWorkspaceSnapshot,
  deterministicBlockReasons,
  evaluateStandaloneGateDecision,
  inspectGit,
  parseStandaloneReviewerVerdict,
  redactCommand,
  renderDeliveryProofCard,
  resolveWorkspaceIdentity,
  runProof,
  sanitizeGateRunRecord,
  selectVerificationCommands,
  type GateRiskSummary,
  type GateRunRecord,
  type ProofResult,
  type StandaloneReviewerOutcome,
} from '@wukong/verification';
import {
  createWukongHarness,
  isWukongError,
  resolveWukongHome,
  runIsolatedReviewCompletion,
} from '@wukong/wukong-sdk';
import type { Command } from 'commander';

import { saveGateRun } from '#/cli/lib/gate-run-store';
import { createWukongCodeHostIdentity } from '#/cli/version';

interface WritableLike {
  write(chunk: string): boolean;
}

export type GateReviewerExecutor = (input: {
  readonly modelAlias?: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly timeoutMs?: number;
}) => Promise<{
  readonly modelAlias: string;
  readonly providerId: string;
  readonly text: string;
}>;

export interface GateCliOptions {
  readonly cwd?: string;
  readonly objective?: string;
  readonly model?: string;
  readonly commands?: readonly string[];
  readonly includeBuild?: boolean;
  readonly timeoutSeconds?: number;
  readonly reviewTimeoutSeconds?: number;
  readonly strict?: boolean;
  readonly summary?: boolean;
  readonly saveSummary?: string;
  readonly json?: boolean;
}

export interface GateDeps {
  readonly cwd: () => string;
  readonly homeDir: () => string | undefined;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly runProof: typeof runProof;
  readonly createSnapshot: typeof createWorkspaceSnapshot;
  readonly inspectGit: typeof inspectGit;
  readonly selectCommands: typeof selectVerificationCommands;
  readonly resolveWorkspaceIdentity: typeof resolveWorkspaceIdentity;
  readonly runReviewer: GateReviewerExecutor;
  readonly saveRun: (record: GateRunRecord, homeDir?: string) => Promise<string>;
  readonly now: () => Date;
}

export async function handleGate(deps: GateDeps, options: GateCliOptions): Promise<number> {
  try {
    const cwd = resolve(options.cwd ?? deps.cwd());
    const homeDir = deps.homeDir();
    const workspaceIdentity = await deps.resolveWorkspaceIdentity(cwd);
    const workspaceName = basename(workspaceIdentity.canonicalRealpath) || 'workspace';
    const selectedCommands = await deps.selectCommands({
      cwd,
      commands: options.commands,
      includeBuild: options.includeBuild === true,
    });
    const commandTimeoutMs =
      options.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000;
    const reviewTimeoutMs =
      options.reviewTimeoutSeconds === undefined ? undefined : options.reviewTimeoutSeconds * 1000;

    let proof: ProofResult;
    try {
      proof = await deps.runProof({
        cwd,
        selectedCommands,
        strict: options.strict === true,
        timeoutMs: commandTimeoutMs,
        writeReport: false,
        retryOnWorkspaceChange: true,
      });
    } catch (error) {
      if (isWorkspaceChangedError(error)) {
        const git = await deps.inspectGit(cwd);
        const rawRecord: GateRunRecord = {
          schemaVersion: 1,
          runId: createGateRunId('workspace-changed', deps.now()),
          source: 'gate',
          generatedAt: deps.now().toISOString(),
          workspaceIdentityDigest: workspaceIdentity.workspaceIdentityDigest,
          workspaceName,
          objective: options.objective,
          git: {
            isRepo: git.isRepo,
            headSha: undefined,
            dirty: git.changedFiles.length > 0,
            changedFileCount: git.changedFiles.length,
          },
          snapshotId: 'workspace-changed',
          status: 'ERROR',
          reasonCode: 'workspace_changed',
          summary: 'Workspace changed while verification was running twice; no verdict was produced.',
          checks: [],
          risks: [],
          reviewer: {
            status: 'not_run',
            model: options.model,
            providerId: undefined,
            summary: undefined,
            errorCode: 'workspace_changed',
            errorMessage: 'Workspace changed during deterministic verification.',
          },
          findings: [],
          uncoveredItems: ['Workspace changed while verification was running; rerun gate on a steady tree.'],
          nextSteps: ['Wait for edits to settle, then re-run `wukong gate`.'],
          reviewPolicyLoaded: existsSync(join(cwd, '.wukong', 'review-policy.md')),
        };
        const record = sanitizeGateRunRecord(rawRecord, homeDir);
        await deps.saveRun(record, homeDir);
        await emitGateOutput(deps, record, options, homeDir, cwd);
        return 2;
      }
      throw error;
    }

    const git = await deps.inspectGit(cwd);
    const reviewPolicyText = await readOptionalReviewPolicy(cwd);
    const reviewPolicyLoaded =
      reviewPolicyText !== undefined && reviewPolicyText.trim().length > 0;
    const strict = options.strict === true;
    const deterministic = deterministicBlockReasons(proof, strict);

    let evaluation;
    if (deterministic.blocked) {
      evaluation = evaluateStandaloneGateDecision({
        proof,
        strict,
        reviewPolicyLoaded,
      });
    } else {
      const prompt = buildStandaloneGateReviewPrompt({
        objective: options.objective,
        reviewPolicyText,
        git,
        proof,
      });

      let reviewerOutcome: StandaloneReviewerOutcome;
      try {
        const response = await deps.runReviewer({
          modelAlias: options.model,
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          timeoutMs: reviewTimeoutMs,
        });
        const afterSnapshot = await deps.createSnapshot({
          cwd,
          commands: selectedCommands,
        });
        if (afterSnapshot.id !== proof.snapshotId) {
          reviewerOutcome = {
            kind: 'workspace_changed',
            model: response.modelAlias,
            providerId: response.providerId,
          };
        } else {
          const parsed = parseStandaloneReviewerVerdict(response.text);
          if (!parsed.valid) {
            reviewerOutcome = {
              kind: 'invalid',
              reason: parsed.reason,
              model: response.modelAlias,
              providerId: response.providerId,
            };
          } else {
            reviewerOutcome = {
              kind: 'verdict',
              verdict: parsed.verdict,
              model: response.modelAlias,
              providerId: response.providerId,
            };
          }
        }
      } catch (error) {
        const classified = classifyReviewerError(error);
        reviewerOutcome = {
          kind: 'error',
          errorCode: classified.errorCode,
          errorMessage: classified.message,
          model: options.model,
          providerId: undefined,
        };
      }

      evaluation = evaluateStandaloneGateDecision({
        proof,
        strict,
        reviewPolicyLoaded,
        diffTruncated: prompt.diffTruncated,
        skippedSecretFiles: prompt.skippedSecretFiles,
        reviewerOutcome,
      });
    }

    const rawRecord: GateRunRecord = {
      schemaVersion: 1,
      runId: createGateRunId(proof.snapshotId, deps.now()),
      source: 'gate',
      generatedAt: deps.now().toISOString(),
      workspaceIdentityDigest: workspaceIdentity.workspaceIdentityDigest,
      workspaceName,
      objective: options.objective,
      git: {
        isRepo: git.isRepo,
        headSha: proof.workspaceFingerprint.headSha,
        dirty: git.changedFiles.length > 0,
        changedFileCount: git.changedFiles.length,
      },
      snapshotId: proof.snapshotId,
      status: evaluation.status,
      reasonCode: evaluation.reasonCode,
      summary: evaluation.summary,
      checks: proof.verification.commandResults.map((command) => ({
        command: redactCommand(command.command),
        status: command.status,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
      })),
      risks: collectUniqueRisks(proof),
      reviewer: evaluation.reviewer,
      findings: evaluation.findings,
      uncoveredItems: evaluation.uncoveredItems,
      nextSteps: evaluation.nextSteps,
      reviewPolicyLoaded,
    };

    const record = sanitizeGateRunRecord(rawRecord, homeDir);
    await deps.saveRun(record, homeDir);
    await emitGateOutput(deps, record, options, homeDir, cwd);

    if (record.status === 'PASS') return 0;
    if (record.status === 'NEEDS_WORK') return 1;
    return 2;
  } catch (error) {
    deps.stderr.write(`wukong gate failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

export function registerGateCommand(parent: Command, deps?: Partial<GateDeps>): void {
  parent
    .command('gate')
    .description('Run the standalone verification & fresh-context review gate (PASS / NEEDS_WORK / ERROR).')
    .option('--objective <text>', 'Optional task objective for independent review.')
    .option('-m, --model <alias>', 'Reviewer model alias override. Defaults to default_model in config.toml.')
    .option('--command <command>', 'Run an explicit check command. Can be repeated.', collect, [])
    .option('--build', 'Include package build scripts when auto-detecting checks.', false)
    .option('--timeout <seconds>', 'Per-command timeout in seconds.')
    .option('--review-timeout <seconds>', 'Independent reviewer timeout in seconds.')
    .option('--strict', 'Block on any risk, including medium and low.', false)
    .option('--summary', 'Print a sanitized PR-ready Markdown Delivery Proof Card.', false)
    .option('--save-summary <path>', 'Save the sanitized Markdown Delivery Proof Card to a file.')
    .option('--json', 'Print structured gate verdict JSON.', false)
    .action(async (raw: RawGateOptions) => {
      const resolved = resolveDeps(deps);
      let timeoutSeconds: number | undefined;
      if (raw.timeout !== undefined) {
        timeoutSeconds = parsePositiveInteger(raw.timeout);
        if (timeoutSeconds === undefined) {
          resolved.stderr.write('error: --timeout must be a positive integer.\n');
          process.exitCode = 1;
          return;
        }
      }
      let reviewTimeoutSeconds: number | undefined;
      if (raw.reviewTimeout !== undefined) {
        reviewTimeoutSeconds = parsePositiveInteger(raw.reviewTimeout);
        if (reviewTimeoutSeconds === undefined) {
          resolved.stderr.write('error: --review-timeout must be a positive integer.\n');
          process.exitCode = 1;
          return;
        }
      }

      const code = await handleGate(resolved, {
        objective: raw.objective,
        model: raw.model,
        commands: raw.command,
        includeBuild: raw.build === true,
        timeoutSeconds,
        reviewTimeoutSeconds,
        strict: raw.strict === true,
        summary: raw.summary === true,
        saveSummary: raw.saveSummary,
        json: raw.json === true,
      });
      if (code !== 0) process.exitCode = code;
    });
}

interface RawGateOptions {
  readonly objective?: string;
  readonly model?: string;
  readonly command?: string[];
  readonly build?: boolean;
  readonly timeout?: string;
  readonly reviewTimeout?: string;
  readonly strict?: boolean;
  readonly summary?: boolean;
  readonly saveSummary?: string;
  readonly json?: boolean;
}

function resolveDeps(overrides: Partial<GateDeps> = {}): GateDeps {
  const identity = createWukongCodeHostIdentity();
  const homeDirFn = overrides.homeDir ?? (() => resolveWukongHome());
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    homeDir: homeDirFn,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    runProof: overrides.runProof ?? runProof,
    createSnapshot: overrides.createSnapshot ?? createWorkspaceSnapshot,
    inspectGit: overrides.inspectGit ?? inspectGit,
    selectCommands: overrides.selectCommands ?? selectVerificationCommands,
    resolveWorkspaceIdentity: overrides.resolveWorkspaceIdentity ?? resolveWorkspaceIdentity,
    runReviewer: overrides.runReviewer ?? (async (input) => {
      const homeDir = homeDirFn();
      const harness = createWukongHarness({ homeDir, identity });
      try {
        const config = await harness.getConfig();
        return await runIsolatedReviewCompletion({
          config,
          modelAlias: input.modelAlias,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          homeDir,
          identity,
          resolveOAuthTokenProvider: harness.auth.resolveOAuthTokenProvider,
          timeoutMs: input.timeoutMs,
        });
      } finally {
        await harness.close();
      }
    }),
    saveRun: overrides.saveRun ?? saveGateRun,
    now: overrides.now ?? (() => new Date()),
  };
}

async function emitGateOutput(
  deps: GateDeps,
  record: GateRunRecord,
  options: GateCliOptions,
  homeDir: string | undefined,
  cwd: string,
): Promise<void> {
  const markdown = options.summary === true || options.saveSummary !== undefined
    ? renderDeliveryProofCard(record, { homeDir })
    : undefined;

  if (options.saveSummary !== undefined && markdown !== undefined) {
    const targetPath = resolve(cwd, options.saveSummary);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, markdown, 'utf8');
  }

  if (options.json === true) {
    deps.stdout.write(
      `${JSON.stringify({ ...record, savedSummaryPath: options.saveSummary }, null, 2)}\n`,
    );
    return;
  }

  if (options.summary === true && markdown !== undefined) {
    deps.stdout.write(markdown);
    return;
  }

  deps.stdout.write(formatHumanGateOutput(record, options.saveSummary));
}

function formatHumanGateOutput(record: GateRunRecord, savedSummaryPath?: string): string {
  const passedChecks = record.checks.filter((check) => check.status === 'passed').length;
  const lines = [
    'Wukong gate',
    '',
    `Verdict: ${record.status} (${record.reasonCode})`,
    `Run ID: ${record.runId}`,
    `Summary: ${record.summary}`,
    `Checks: ${String(passedChecks)}/${String(record.checks.length)} passed`,
    `Risks: ${String(record.risks.length)}`,
    formatReviewerLine(record),
  ];

  if (record.findings.length > 0) {
    lines.push('', 'Findings:');
    for (const finding of record.findings) {
      const location = finding.file === undefined
        ? ''
        : ` (${finding.file}${finding.line === undefined ? '' : `:${String(finding.line)}`})`;
      lines.push(`  [${finding.severity}] ${finding.message}${location}`);
      lines.push(`    Next: ${finding.nextAction}`);
    }
  }

  if (record.uncoveredItems.length > 0) {
    lines.push('', 'Uncovered:');
    for (const item of record.uncoveredItems) {
      lines.push(`  - ${item}`);
    }
  }

  if (record.nextSteps.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of record.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }

  if (savedSummaryPath !== undefined) {
    lines.push('', `Saved proof card: ${savedSummaryPath}`);
  }
  lines.push(`Run \`wukong summary --run ${record.runId}\` to preview a PR-ready proof card.`, '');
  return lines.join('\n');
}

function formatReviewerLine(record: GateRunRecord): string {
  if (record.reviewer.status === 'not_run') {
    return 'Reviewer: not_run';
  }
  if (record.reviewer.status === 'error') {
    const model = record.reviewer.model ?? 'unconfigured';
    const detail = record.reviewer.errorMessage ?? record.reviewer.errorCode ?? 'error';
    return `Reviewer: error (${model}) — ${detail}`;
  }
  const model = record.reviewer.model ?? 'default';
  return `Reviewer: ${record.reviewer.status} (${model})`;
}

async function readOptionalReviewPolicy(cwd: string): Promise<string | undefined> {
  const path = join(cwd, '.wukong', 'review-policy.md');
  if (!existsSync(path)) return undefined;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function collectUniqueRisks(proof: ProofResult): GateRiskSummary[] {
  const seen = new Set<string>();
  const risks: GateRiskSummary[] = [];
  for (const risk of [...proof.verification.risks, ...proof.scan.risks]) {
    const key = `${risk.id}\0${risk.severity}\0${risk.file ?? ''}\0${String(risk.line ?? '')}\0${risk.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    risks.push({
      id: risk.id,
      severity: risk.severity,
      message: risk.message,
      file: risk.file,
      line: risk.line,
    });
  }
  return risks;
}

function classifyReviewerError(error: unknown): {
  readonly errorCode: string;
  readonly message: string;
} {
  if (isWukongError(error)) {
    return {
      errorCode: error.code,
      message: error.message,
    };
  }
  if (
    error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError' || /timed out/iu.test(error.message))
  ) {
    return {
      errorCode: 'reviewer_timeout',
      message: error.message || 'Independent reviewer timed out.',
    };
  }
  return {
    errorCode: 'reviewer_error',
    message: errorMessage(error),
  };
}

function isWorkspaceChangedError(error: unknown): boolean {
  if (error instanceof WorkspaceChangedError) return true;
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'workspace_changed'
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
