import type { FinishLineProposal } from '@wukong/verification';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type FinishLineReviewChoice =
  | 'start'
  | 'edit'
  | 'checks'
  | 'workspace'
  | 'criteria'
  | 'advanced'
  | 'cancel';

export interface FinishLineReviewOptions {
  readonly proposal: FinishLineProposal;
  readonly summary: string;
  readonly maxIterations: number;
  readonly suggestedCriteriaCount?: number;
  readonly selectedCriteriaCount?: number;
  readonly permissionMode?: 'manual' | 'auto' | 'yolo';
  readonly missingUsageCaps?: boolean;
  readonly workspaceGit?: {
    readonly isRepo: boolean;
    readonly changedFileCount: number;
    readonly changedFiles: readonly {
      readonly path: string;
      readonly status: string;
    }[];
  };
  readonly onSelect: (choice: FinishLineReviewChoice) => void;
  readonly onCancel: () => void;
}

export class FinishLineReviewComponent extends ChoicePickerComponent {
  constructor(options: FinishLineReviewOptions) {
    const proposal = options.proposal;
    const warningCount = proposal.finishLineReview.warnings.length;
    const workspaceNeedsReview = options.workspaceGit !== undefined
      && (!options.workspaceGit.isRepo || options.workspaceGit.changedFileCount > 0);
    const dangerous = warningCount > 0
      || workspaceNeedsReview
      || options.permissionMode === 'yolo'
      || options.missingUsageCaps === true;
    const startChoice: ChoiceOption = {
      value: 'start',
      label: dangerous ? 'Continue anyway to approvals' : 'Continue to approvals',
      description: dangerous
        ? 'Keep the risks shown above and review each local-read, provider-send, permission, and check-execution approval. No Loop starts until required approvals are granted.'
        : 'Review each local-read, provider-send, permission, and check-execution approval. No Loop starts until required approvals are granted.',
      tone: dangerous ? 'danger' : undefined,
    };
    const reviewChoices: ChoiceOption[] = [
      {
        value: 'edit',
        label: warningCount === 0 ? 'Edit finish line' : 'Fix finish line warnings',
        description: warningCount === 0
          ? 'Change Goal, Done when, or Must not rules before anything is persisted.'
          : 'Review Goal, Done when, and Must not rules before accepting the warnings.',
      },
    ];
    if (proposal.gatePlan.requiredChecks.length > 0 || proposal.gatePlan.excludedChecks.length > 0) {
      reviewChoices.push({
        value: 'checks',
        label: 'Review checks',
        description: `Inspect ${String(proposal.gatePlan.requiredChecks.length)} selected and ${String(proposal.gatePlan.excludedChecks.length)} excluded checks.`,
      });
    }
    if (options.workspaceGit?.changedFileCount !== undefined && options.workspaceGit.changedFileCount > 0) {
      reviewChoices.push({
        value: 'workspace',
        label: 'Review pre-existing workspace changes',
        description: `Inspect the bounded status/path summary for ${String(options.workspaceGit.changedFileCount)} file${options.workspaceGit.changedFileCount === 1 ? '' : 's'} before allowing the Loop to write.`,
      });
    }
    if ((options.selectedCriteriaCount ?? 0) > 0 || (options.suggestedCriteriaCount ?? 0) > 0) {
      reviewChoices.push({
        value: 'criteria',
        label: 'Review verification criteria',
        description: `${String(options.selectedCriteriaCount ?? 0)} selected and ${String(options.suggestedCriteriaCount ?? 0)} deterministically suggested. Suggestions are never selected automatically.`,
      });
    }
    reviewChoices.push(
      {
        value: 'advanced',
        label: 'Edit run limits',
        description: options.missingUsageCaps === true
          ? `Edit the ${String(options.maxIterations)}-iteration limit and configure provider-call/token ceilings.`
          : `Edit the ${String(options.maxIterations)}-iteration limit and current provider-call/token ceilings.`,
      },
    );
    const choices: readonly ChoiceOption[] = [
      ...(dangerous ? [] : [startChoice]),
      ...reviewChoices,
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'Create no trust grant, contract, or run.',
      },
      ...(dangerous ? [startChoice] : []),
    ];
    super({
      title: 'Loop preflight',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      notice: options.summary,
      noticeTone: dangerous ? 'warning' : 'success',
      options: choices,
      onSelect: (value) => {
        if (isChoice(value)) options.onSelect(value);
      },
      onCancel: options.onCancel,
    });
  }
}

function isChoice(value: string): value is FinishLineReviewChoice {
  return value === 'start'
    || value === 'edit'
    || value === 'checks'
    || value === 'workspace'
    || value === 'criteria'
    || value === 'advanced'
    || value === 'cancel';
}
