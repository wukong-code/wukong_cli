import { describe, expect, it } from 'vitest';

import {
  classifyCommandRisk,
  getGuardStats,
  getGuardStatus,
  runGuardedCommand,
  setGuardEnabled,
} from '../src';
import { makeTempRepo } from './helpers';

describe('command policy', () => {
  it('classifies destructive commands', () => {
    expect(classifyCommandRisk(['rm', '-rf', './tmp'])?.id).toBe('guard.rm_recursive_or_force');
    expect(classifyCommandRisk(['git', 'reset', '--hard'])?.id).toBe('guard.git_reset_hard');
    expect(classifyCommandRisk(['echo', 'ok'])).toBeUndefined();
  });

  it('stores guard status and blocked events', async () => {
    const homeDir = await makeTempRepo('wukong-guard-home-');

    await expect(getGuardStatus({ homeDir })).resolves.toMatchObject({ enabled: false });
    await setGuardEnabled(true, { homeDir });
    await expect(getGuardStatus({ homeDir })).resolves.toMatchObject({ enabled: true });

    const result = await runGuardedCommand(['rm', '-rf', './tmp'], { homeDir });
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(1);

    await expect(getGuardStats({ homeDir })).resolves.toMatchObject({
      total: 1,
      blocked: 1,
      allowed: 0,
    });
  });
});
