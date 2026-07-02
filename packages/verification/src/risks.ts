import type { ChangedFile, GitInspection, VerificationRisk } from './types';

interface AddedLine {
  readonly file: string;
  readonly line?: number;
  readonly text: string;
}

const SOURCE_EXTENSIONS = /\.(cjs|cts|go|js|jsx|mjs|mts|py|rs|ts|tsx)$/;
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;

export function scanRisks(input: {
  readonly git: GitInspection;
  readonly selectedCommands?: readonly string[];
  readonly includeCommandRisks?: boolean;
}): VerificationRisk[] {
  const risks: VerificationRisk[] = [];
  if (!input.git.isRepo) {
    risks.push({
      id: 'workspace.not_git_repo',
      severity: 'medium',
      message: 'Current workspace is not a git repository.',
    });
  }

  for (const file of input.git.changedFiles) {
    if (isSecretLikePath(file.path)) {
      risks.push({
        id: 'file.secret_like_changed',
        severity: 'high',
        message: 'Secret-looking file changed.',
        file: file.path,
      });
    }
  }

  for (const added of parseAddedLines(input.git.diffText)) {
    const lineRisks = risksForAddedLine(added);
    risks.push(...lineRisks);
  }

  const changedFiles = input.git.changedFiles;
  if (hasSourceChange(changedFiles) && !hasTestChange(changedFiles)) {
    risks.push({
      id: 'coverage.source_without_tests',
      severity: 'medium',
      message: 'Source files changed without matching test file changes.',
    });
  }

  if (input.includeCommandRisks === true && (input.selectedCommands?.length ?? 0) === 0) {
    risks.push({
      id: 'commands.none_detected',
      severity: 'high',
      message: 'No verification commands were detected. Add package scripts or pass --command.',
    });
  }

  return dedupeRisks(risks);
}

function risksForAddedLine(added: AddedLine): VerificationRisk[] {
  const text = added.text;
  const lower = text.toLowerCase();
  const risks: VerificationRisk[] = [];
  if (/\b(todo|fixme|placeholder|not implemented|coming soon)\b/i.test(text)) {
    risks.push(makeLineRisk('diff.placeholder_added', 'high', 'Placeholder or unfinished marker added.', added));
  }
  if (/\b(mock|fake|dummy|hardcoded|sample data)\b/i.test(text)) {
    risks.push(makeLineRisk('diff.mock_or_fake_added', 'high', 'Mock/fake/hardcoded implementation marker added.', added));
  }
  if (/\b(describe|it|test)\.only\b/.test(lower)) {
    risks.push(makeLineRisk('diff.only_test_added', 'medium', 'Focused test marker added.', added));
  }
  if (/\b(describe|it|test)\.skip\b/.test(lower)) {
    risks.push(makeLineRisk('diff.skipped_test_added', 'medium', 'Skipped test marker added.', added));
  }
  if (/\bconsole\.log\b|\bdebugger\b/.test(lower)) {
    risks.push(makeLineRisk('diff.debug_output_added', 'medium', 'Debug output added.', added));
  }
  return risks;
}

function makeLineRisk(
  id: string,
  severity: VerificationRisk['severity'],
  message: string,
  added: AddedLine,
): VerificationRisk {
  const base: VerificationRisk = {
    id,
    severity,
    message,
    file: added.file,
    evidence: added.text.trim(),
  };
  if (added.line === undefined) return base;
  return { ...base, line: added.line };
}

function parseAddedLines(diffText: string): AddedLine[] {
  const added: AddedLine[] = [];
  let currentFile = '';
  let nextNewLine: number | undefined;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('@@')) {
      nextNewLine = parseNewLineStart(line);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    added.push({ file: currentFile, line: nextNewLine, text: line.slice(1) });
    if (nextNewLine !== undefined) nextNewLine += 1;
  }
  return added;
}

function parseNewLineStart(hunk: string): number | undefined {
  const match = /\+(\d+)/.exec(hunk);
  if (match?.[1] === undefined) return undefined;
  return Number.parseInt(match[1], 10);
}

function isSecretLikePath(filePath: string): boolean {
  return /(^|\/)\.env($|[./])|secret|credential|private-key|id_rsa/i.test(filePath);
}

function hasSourceChange(files: readonly ChangedFile[]): boolean {
  return files.some((file) => SOURCE_EXTENSIONS.test(file.path) && !TEST_PATH.test(file.path));
}

function hasTestChange(files: readonly ChangedFile[]): boolean {
  return files.some((file) => TEST_PATH.test(file.path));
}

function dedupeRisks(risks: readonly VerificationRisk[]): VerificationRisk[] {
  const seen = new Set<string>();
  const result: VerificationRisk[] = [];
  for (const risk of risks) {
    const key = `${risk.id}:${risk.file ?? ''}:${risk.line ?? ''}:${risk.evidence ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(risk);
  }
  return result;
}
