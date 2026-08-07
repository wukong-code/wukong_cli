import { describe, expect, it } from 'vitest';

import { injectionModeForTarget } from '../../../scripts/native/03-inject.mjs';
import { officialNodeVersion } from '../../../scripts/native/sea-node.mjs';
import {
  nativeLoopDryRunSmoke,
  nativePromptResumeSmoke,
} from '../../../scripts/native/smoke-plan.mjs';
import { nativeSmokeResponse } from '../../../scripts/native/smoke-provider.mjs';

describe('native SEA runtime selection', () => {
  it('uses the Node 24 postject fallback for Intel macOS', () => {
    expect(officialNodeVersion('darwin-x64')).toBe('v24.18.0');
    expect(injectionModeForTarget('darwin-x64')).toBe('legacy-postject');
  });

  it('keeps the Node 26 direct SEA builder for the other release targets', () => {
    for (const target of [
      'darwin-arm64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]) {
      expect(officialNodeVersion(target)).toBe('v26.4.0');
      expect(injectionModeForTarget(target)).toBe('node-build-sea');
    }
  });

  it('defines a provider-backed Loop Preflight smoke with limits, quoting, and Unicode', () => {
    const smoke = nativeLoopDryRunSmoke();

    expect(smoke.config).toContain('type = "openai_responses"');
    expect(smoke.config).toContain('default_model = "native-smoke"');
    expect(smoke.args).toEqual(expect.arrayContaining([
      '--output-format',
      'stream-json',
      'loop',
      '--writer-call-limit',
      '3',
      '--reviewer-call-limit',
      '2',
      '--token-budget',
      '1000',
      '--only-explicit-checks',
    ]));
    expect(smoke.args.join(' ')).toContain('Unicode 雪');
    expect(smoke.args.join(' ')).toContain('quoted');
    expect(smoke.expectedOutput).toEqual([
      '"kind":"loop.finish_line.dry_run"',
      '"writerProviderCallLimit":3',
      '"reviewerProviderCallLimit":2',
      '"tokenBudget":1000',
      '"providerId":"native-smoke-provider"',
    ]);
  });

  it('defines two provider-backed prompt turns joined by the real Resume session id', () => {
    const smoke = nativePromptResumeSmoke('http://127.0.0.1:43123/v1');

    expect(smoke.config).toContain('base_url = "http://127.0.0.1:43123/v1"');
    expect(smoke.firstArgs.join(' ')).toContain('first "quoted" prompt 雪');
    expect(smoke.resumeArgs('session-123')).toEqual(expect.arrayContaining([
      '--resume',
      'session-123',
      '--prompt',
      expect.stringContaining('second resumed prompt'),
    ]));
  });

  it('builds deterministic Responses API streams while recording request identity', () => {
    const response = nativeSmokeResponse({
      authorization: 'Bearer smoke-secret',
      body: { model: 'native-smoke-model', stream: true },
      sequence: 1,
    });

    expect(response.record).toMatchObject({
      authorization: 'Bearer smoke-secret',
      model: 'native-smoke-model',
      stream: true,
    });
    expect(response.events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp_native_smoke_1', status: 'completed' },
    });
    expect(response.text).toBe('native smoke response 1 雪');
  });
});
