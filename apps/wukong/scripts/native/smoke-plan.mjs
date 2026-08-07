const OBJECTIVE = 'Verify a "quoted" native Loop with Unicode 雪';

export function nativeLoopDryRunSmoke(baseUrl = 'http://127.0.0.1:9/v1') {
  return {
    config: [
      'default_model = "native-smoke"',
      '',
      '[providers."native-smoke-provider"]',
      'type = "openai_responses"',
      `base_url = "${baseUrl}"`,
      'api_key = "native-smoke-key"',
      '',
      '[models."native-smoke"]',
      'provider = "native-smoke-provider"',
      'model = "native-smoke-model"',
      'max_context_size = 128000',
      '',
    ].join('\n'),
    args: [
      '--output-format',
      'stream-json',
      'loop',
      OBJECTIVE,
      '--dry-run',
      '--model',
      'native-smoke',
      '--max-iterations',
      '2',
      '--writer-call-limit',
      '3',
      '--reviewer-call-limit',
      '2',
      '--token-budget',
      '1000',
      '--done-when',
      'The explicit quoted check passes for Unicode 雪.',
      '--constraint',
      'Do not remove the "quoted" Unicode input.',
      '--check',
      'node -e "process.exit(0)"',
      '--only-explicit-checks',
    ],
    expectedOutput: [
      '"kind":"loop.finish_line.dry_run"',
      '"writerProviderCallLimit":3',
      '"reviewerProviderCallLimit":2',
      '"tokenBudget":1000',
      '"providerId":"native-smoke-provider"',
    ],
  };
}

export function nativePromptResumeSmoke(baseUrl) {
  const common = ['--output-format', 'stream-json', '--model', 'native-smoke'];
  return {
    config: [
      'default_model = "native-smoke"',
      '',
      '[providers."native-smoke-provider"]',
      'type = "openai_responses"',
      `base_url = "${baseUrl}"`,
      'api_key = "native-smoke-key"',
      '',
      '[models."native-smoke"]',
      'provider = "native-smoke-provider"',
      'model = "native-smoke-model"',
      'max_context_size = 128000',
      '',
    ].join('\n'),
    firstArgs: [
      ...common,
      '--prompt',
      'Handle the first "quoted" prompt 雪 without tools.',
    ],
    resumeArgs: (sessionId) => [
      ...common,
      '--resume',
      sessionId,
      '--prompt',
      'Handle the second resumed prompt 雪 without tools.',
    ],
    expectedAssistant: [
      'native smoke response 1 雪',
      'native smoke response 2 雪',
    ],
  };
}
