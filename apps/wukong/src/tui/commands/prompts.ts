import {
  catalogModelToAlias,
  inferWireType,
  type Catalog,
  type CatalogModel,
  type ModelAlias,
} from '@wukong/wukong-sdk';
import { capabilitiesForModel } from '@wukong/wukong-oauth';
import type {
  ManagedWukongModelInfo,
  OpenPlatformDefinition,
} from '@wukong/wukong-oauth';

import { ApiKeyInputDialogComponent, type ApiKeyInputResult } from '../components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { FeedbackInputDialogComponent, type FeedbackInputDialogResult } from '../components/dialogs/feedback-input-dialog';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import { PlatformSelectorComponent } from '../components/dialogs/platform-selector';
import type { SlashCommandHost } from './dispatch';

export function promptPlatformSelection(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    const selector = new PlatformSelectorComponent({
      onSelect: (platformId) => {
        host.restoreEditor();
        resolve(platformId);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}

export function promptLogoutProviderSelection(
  host: SlashCommandHost,
  options: readonly ChoiceOption[],
  currentValue: string | undefined,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Select a provider to log out',
      options,
      currentValue,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export interface FeedbackPromptResult {
  readonly value: string;
}

export type FeedbackCategory = 'bug' | 'onboarding' | 'loop_result' | 'feature_request' | 'other';

const FEEDBACK_CATEGORY_OPTIONS: readonly ChoiceOption[] = [
  { value: 'bug', label: 'Bug', description: 'Something did not work as expected' },
  { value: 'onboarding', label: 'Onboarding', description: 'Installation or first-run feedback' },
  { value: 'loop_result', label: 'Loop result', description: 'Feedback about a Loop outcome' },
  { value: 'feature_request', label: 'Feature request', description: 'A capability you need' },
  { value: 'other', label: 'Other', description: 'Anything else' },
];

export function promptFeedbackInput(host: SlashCommandHost): Promise<FeedbackPromptResult | undefined> {
  return new Promise((resolve) => {
    const dialog = new FeedbackInputDialogComponent((result: FeedbackInputDialogResult) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? { value: result.value } : undefined);
    });
    host.mountEditorReplacement(dialog);
  });
}

export function promptFeedbackCategory(
  host: SlashCommandHost,
): Promise<FeedbackCategory | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Feedback category',
      options: FEEDBACK_CATEGORY_OPTIONS,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value as FeedbackCategory);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptFeedbackConfirmation(
  host: SlashCommandHost,
  payload: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Submit this feedback?',
      notice:
        `Payload: ${JSON.stringify(payload)}\n` +
        'No files, logs, source code, prompts, or local evidence are attached automatically.',
      options: [
        { value: 'submit', label: 'Submit', description: 'Send exactly the payload shown above' },
        { value: 'cancel', label: 'Cancel', description: 'Return without sending anything' },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value === 'submit');
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export function promptApiKey(
  host: SlashCommandHost,
  platformName: string,
  subtitleLines: readonly string[] = ['Your key will be saved to ~/.wukong/config.toml'],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = new ApiKeyInputDialogComponent(
      platformName,
      subtitleLines,
      (result: ApiKeyInputResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog);
  });
}

export function promptCatalogProviderSelection(host: SlashCommandHost, catalog: Catalog): Promise<string | undefined> {
  return new Promise((resolve) => {
    const options: ChoiceOption[] = Object.entries(catalog)
      .filter(([, entry]) => inferWireType(entry) !== undefined)
      .map(([id, entry]) => ({
        value: id,
        label: entry.name ?? id,
        description:
          typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    if (options.length === 0) {
      host.showError('Catalog has no providers with supported wire types.');
      resolve(undefined);
      return;
    }

    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options,
      searchable: true,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

export async function promptModelSelectionForOpenPlatform(
  host: SlashCommandHost,
  models: ManagedWukongModelInfo[],
  platform: OpenPlatformDefinition,
): Promise<{ model: ManagedWukongModelInfo; thinking: boolean } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${platform.id}/${m.id}`] = {
      provider: platform.id,
      model: m.id,
      maxContextSize: m.contextLength,
      capabilities: capabilitiesForModel(m),
      displayName: m.displayName,
    };
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${platform.id}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export async function promptModelSelectionForCatalog(
  host: SlashCommandHost,
  providerId: string,
  models: CatalogModel[],
): Promise<{ model: CatalogModel; thinking: boolean } | undefined> {
  const modelDict: Record<string, ModelAlias> = {};
  for (const m of models) {
    modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
  }
  const selection = await runModelSelector(host, modelDict);
  if (selection === undefined) return undefined;
  const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
  return model ? { model, thinking: selection.thinking } : undefined;
}

export function runModelSelector(
  host: SlashCommandHost,
  modelDict: Record<string, ModelAlias>,
): Promise<{ alias: string; thinking: boolean } | undefined> {
  return new Promise((resolve) => {
    const firstAlias = Object.keys(modelDict)[0] ?? '';
    const caps = modelDict[firstAlias]?.capabilities ?? [];
    const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
    const selector = new ModelSelectorComponent({
      models: modelDict,
      currentValue: firstAlias,
      currentThinking: initialThinking,
      searchable: true,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        resolve({ alias, thinking });
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector);
  });
}
