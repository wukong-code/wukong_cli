import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRPC, WukongCore, type CoreAPI, type SDKAPI } from '../../src';

const CONFIG = `
default_model = "default"

[experimental]
role_profiles = true

[providers.test]
type = "openai"
api_key = "test-key"
base_url = "https://example.test/v1"

[models.default]
provider = "test"
model = "default-model"
max_context_size = 100000

[models.fast]
provider = "test"
model = "fast-model"
max_context_size = 100000
`;

describe('role profile sessions', () => {
  let root: string;
  let homeDir: string;
  let workDir: string;
  let configPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wukong-role-session-'));
    homeDir = join(root, 'home');
    workDir = join(root, 'work');
    configPath = join(root, 'config.toml');
    await mkdir(join(homeDir, 'roles'), { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, CONFIG);
    await writeFile(
      join(homeDir, 'roles', 'backend.md'),
      '---\ndescription: Backend role\nmodel: fast\ncapabilityMode: execute\ntools:\n  - Read\n  - Bash\ninputs:\n  - name: task_context\n    type: json\n    required: true\noutputs:\n  - name: result\n    schema: text-v1\n    required: true\n---\n\nFocus on backend invariants.',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('changes prompt, tools, and model, then restores the base session', async () => {
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir, model: 'default' });

    await expect(rpc.setRole({ sessionId: created.id })).resolves.toMatchObject({
      active: false,
      model: 'default',
    });

    await expect(rpc.setRole({ sessionId: created.id, role: 'backend' })).resolves.toMatchObject({
      active: true,
      role: { selection: 'backend', source: 'user' },
      model: 'fast',
    });
    const transformed = await rpc.getConfig({ sessionId: created.id, agentId: 'main' });
    const transformedTools = await rpc.getTools({ sessionId: created.id, agentId: 'main' });
    expect(transformed.systemPrompt).toContain('Focus on backend invariants.');
    expect(transformed.systemPrompt).toContain('Capability mode: execute');
    expect(transformed.systemPrompt).toContain('task_context');
    expect(transformed.modelAlias).toBe('fast');
    expect(transformedTools.find((tool) => tool.name === 'Read')?.active).toBe(true);
    expect(transformedTools.find((tool) => tool.name === 'Write')?.active).toBe(false);

    await expect(rpc.setRole({ sessionId: created.id })).resolves.toMatchObject({
      active: false,
      model: 'default',
    });
    const restored = await rpc.getConfig({ sessionId: created.id, agentId: 'main' });
    const restoredTools = await rpc.getTools({ sessionId: created.id, agentId: 'main' });
    expect(restored.systemPrompt).not.toContain('Focus on backend invariants.');
    expect(restored.modelAlias).toBe('default');
    expect(restoredTools.find((tool) => tool.name === 'Write')?.active).toBe(true);

    await writeFile(
      join(homeDir, 'roles', 'unsafe.md'),
      '---\ntools:\n  - MadeUpTool\n---\n\nTry to expand tool access.',
    );
    await expect(rpc.setRole({ sessionId: created.id, role: 'unsafe' })).rejects.toThrow(
      /cannot enable tools outside the base agent profile/,
    );
    const afterRejectedRole = await rpc.getConfig({ sessionId: created.id, agentId: 'main' });
    expect(afterRejectedRole.systemPrompt).not.toContain('Try to expand tool access.');
    expect(afterRejectedRole.modelAlias).toBe('default');
  });

  async function createTestRpc() {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    void new WukongCore(coreRpc, { homeDir, configPath });
    return sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async () => ({ decision: 'rejected' as const })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
  }
});
