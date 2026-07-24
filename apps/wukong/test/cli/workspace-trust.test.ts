import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionWorkspaceTrustForTests,
  findWorkspaceTrust,
  grantWorkspaceTrust,
  listWorkspaceTrustGrants,
  revokeWorkspaceTrust,
} from '#/cli/lib/workspace-trust';
import { resolveWorkspaceIdentity } from '@wukong/verification';

const paths: string[] = [];

afterEach(async () => {
  clearSessionWorkspaceTrustForTests();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('workspace trust store', () => {
  it('keeps trust once in memory and supports revocation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'wukong-trust-workspace-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'wukong-trust-home-'));
    paths.push(workspace, homeDir);
    const identity = await resolveWorkspaceIdentity(workspace);
    const grant = await grantWorkspaceTrust(identity, 'session', { homeDir, now: 100 });

    await expect(findWorkspaceTrust(identity.workspaceIdentityDigest, { homeDir }))
      .resolves.toMatchObject({ trustGrantId: grant.trustGrantId, persistence: 'session' });
    await expect(revokeWorkspaceTrust(grant.trustGrantId, { homeDir, now: 200 }))
      .resolves.toBe(true);
    await expect(findWorkspaceTrust(identity.workspaceIdentityDigest, { homeDir }))
      .resolves.toBeUndefined();
  });

  it('writes remembered grants as mode 0600 and retains a revocation audit entry', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'wukong-trust-workspace-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'wukong-trust-home-'));
    paths.push(workspace, homeDir);
    const identity = await resolveWorkspaceIdentity(workspace);
    const grant = await grantWorkspaceTrust(identity, 'remembered-local', { homeDir, now: 100 });
    const path = join(homeDir, 'security', 'trusted-workspaces.json');

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain('API_KEY');
    await expect(revokeWorkspaceTrust(grant.trustGrantId, { homeDir, now: 200 }))
      .resolves.toBe(true);
    await expect(listWorkspaceTrustGrants({ homeDir })).resolves.toEqual([]);
    await expect(listWorkspaceTrustGrants({ homeDir, includeRevoked: true }))
      .resolves.toEqual([expect.objectContaining({ trustGrantId: grant.trustGrantId, revokedAt: 200 })]);
  });
});
