import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionWorkspaceTrustForTests,
  findBrokerReviewTrust,
  findWorkspaceTrust,
  grantBrokerReviewTrustLocally,
  grantCriteriaSourceTrust,
  grantWorkspaceTrust,
  listBrokerReviewTrustGrants,
  listCriteriaSourceTrustGrants,
  listWorkspaceTrustGrants,
  revokeWorkspaceTrust,
} from '#/cli/lib/workspace-trust';
import {
  createBrokerReviewTrustProposal,
  resolveWorkspaceIdentity,
} from '@wukong/verification';

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

    const trustStat = await stat(path);
    expect(trustStat.isFile()).toBe(true);
    // Win32 reports synthetic POSIX mode bits, so this assertion cannot
    // evaluate its ACLs. File identity and secret-free content remain covered.
    if (process.platform !== 'win32') {
      expect(trustStat.mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path, 'utf8')).not.toContain('API_KEY');
    await expect(revokeWorkspaceTrust(grant.trustGrantId, { homeDir, now: 200 }))
      .resolves.toBe(true);
    await expect(listWorkspaceTrustGrants({ homeDir })).resolves.toEqual([]);
    await expect(listWorkspaceTrustGrants({ homeDir, includeRevoked: true }))
      .resolves.toEqual([expect.objectContaining({ trustGrantId: grant.trustGrantId, revokedAt: 200 })]);
  });

  it('stores broker-read trust separately without granting project-check execution', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'wukong-trust-home-'));
    paths.push(homeDir);
    const proposal = createBrokerReviewTrustProposal({
      workspaceIdentityDigest: 'sha256:workspace',
      intent: 'remember-locally',
    });
    const grant = await grantBrokerReviewTrustLocally(
      proposal,
      'remembered-local',
      { homeDir, now: 100 },
    );

    await expect(findBrokerReviewTrust('sha256:workspace', { homeDir }))
      .resolves.toMatchObject({
        trustGrantId: grant.trustGrantId,
        scope: 'brokered-review-subject',
      });
    await expect(findWorkspaceTrust('sha256:workspace', { homeDir }))
      .resolves.toBeUndefined();
    await expect(listBrokerReviewTrustGrants({ homeDir }))
      .resolves.toHaveLength(1);
    await expect(revokeWorkspaceTrust(grant.trustGrantId, { homeDir, now: 200 }))
      .resolves.toBe(true);
    await expect(findBrokerReviewTrust('sha256:workspace', { homeDir }))
      .resolves.toBeUndefined();
  });

  it('stores an exact remembered local criteria source and revokes only that grant', async () => {
    const source = await mkdtemp(join(tmpdir(), 'wukong-criteria-source-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'wukong-trust-home-'));
    paths.push(source, homeDir);

    const first = await grantCriteriaSourceTrust(source, { homeDir, now: 100 });
    const repeated = await grantCriteriaSourceTrust(source, { homeDir, now: 200 });

    expect(repeated).toEqual(first);
    await expect(listCriteriaSourceTrustGrants({ homeDir })).resolves.toEqual([
      expect.objectContaining({
        trustGrantId: first.trustGrantId,
        sourceId: first.sourceId,
        canonicalRealpath: await realpath(source),
        scope: 'verification-criteria-source',
      }),
    ]);
    await expect(findWorkspaceTrust('sha256:any', { homeDir })).resolves.toBeUndefined();
    await expect(findBrokerReviewTrust('sha256:any', { homeDir })).resolves.toBeUndefined();
    await expect(revokeWorkspaceTrust(first.trustGrantId, { homeDir, now: 300 }))
      .resolves.toBe(true);
    await expect(listCriteriaSourceTrustGrants({ homeDir })).resolves.toEqual([]);
  });
});
