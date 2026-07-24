import type { FinishLineProposal } from '@wukong/verification';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type FinishLineReviewChoice = 'start' | 'edit' | 'checks' | 'advanced' | 'cancel';

export interface FinishLineReviewOptions {
  readonly proposal: FinishLineProposal;
  readonly maxIterations: number;
  readonly onSelect: (choice: FinishLineReviewChoice) => void;
  readonly onCancel: () => void;
}

export class FinishLineReviewComponent extends ChoicePickerComponent {
  constructor(options: FinishLineReviewOptions) {
    const proposal = options.proposal;
    const warningCount = proposal.finishLineReview.warnings.length;
    const choices: readonly ChoiceOption[] = [
      {
        value: 'start',
        label: warningCount === 0 ? 'Start Loop' : 'Acknowledge warnings and start',
        description: 'Freeze this exact Finish Line and create the first bounded run.',
      },
      {
        value: 'edit',
        label: 'Edit finish line',
        description: 'Change Goal, Done when, or Must not rules before anything is persisted.',
      },
      {
        value: 'checks',
        label: 'Review checks',
        description: `Inspect ${String(proposal.gatePlan.requiredChecks.length)} selected and ${String(proposal.gatePlan.excludedChecks.length)} excluded checks.`,
      },
      {
        value: 'advanced',
        label: 'Advanced settings',
        description: `Review run limit (${String(options.maxIterations)}), reviewer, and permission settings.`,
      },
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'Create no trust grant, contract, or run.',
      },
    ];
    super({
      title: 'Finish line',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      notice: finishLineNotice(proposal, options.maxIterations),
      noticeTone: warningCount === 0 ? 'success' : 'warning',
      options: choices,
      onSelect: (value) => {
        if (isChoice(value)) options.onSelect(value);
      },
      onCancel: options.onCancel,
    });
  }
}

function finishLineNotice(proposal: FinishLineProposal, maxIterations: number): string {
  const warnings = proposal.finishLineReview.warnings.map(
    (warning) => `Warning: ${warning.message}`,
  );
  return [
    `Goal         ${proposal.objective}`,
    `Done when    ${proposal.completionCriterion ?? 'Not specified separately'}`,
    `Must not     ${String(proposal.constraints.length)} constraint${proposal.constraints.length === 1 ? '' : 's'}`,
    `Verification ${String(proposal.gatePlan.requiredChecks.length)} required project check${proposal.gatePlan.requiredChecks.length === 1 ? '' : 's'}`,
    `Run          up to ${String(maxIterations)} iterations`,
    'Project checks run with your current OS account permissions; this is not a shell sandbox.',
    ...warnings,
  ].join('\n');
}

function isChoice(value: string): value is FinishLineReviewChoice {
  return value === 'start'
    || value === 'edit'
    || value === 'checks'
    || value === 'advanced'
    || value === 'cancel';
}
