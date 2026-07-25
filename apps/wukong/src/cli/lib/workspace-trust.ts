import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { resolveWukongHome } from '@wukong/wukong-sdk';
import { z } from 'zod';

import {
  grantBrokerReviewTrust as createBrokerReviewTrustBinding,
  canonicalDigest,
  registerBrokerReviewTrustBinding,
  revokeBrokerReviewTrustBinding,
  type BrokerReviewTrustBindingV1,
  type BrokerReviewTrustProposalV1,
  type WorkspaceIdentity,
} from '@wukong/verification';

export type WorkspaceTrustPersistence = 'session' | 'remembered-local';

export interface WorkspaceTrustGrant {
  readonly schemaVersion: 1;
  readonly trustGrantId: string;
  readonly canonicalRealpath: string;
  readonly workspaceIdentityDigest: string;
  readonly scope: 'loop-project-checks';
  readonly persistence: WorkspaceTrustPersistence;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export interface BrokerReviewTrustGrant {
  readonly schemaVersion: 1;
  readonly trustGrantId: string;
  readonly workspaceIdentityDigest: string;
  readonly scope: 'brokered-review-subject';
  readonly trustProposalDigest: string;
  readonly reviewSubjectPolicyVersion: string;
  readonly persistence: WorkspaceTrustPersistence;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export interface CriteriaSourceTrustGrant {
  readonly schemaVersion: 1;
  readonly trustGrantId: string;
  readonly sourceId: string;
  readonly canonicalRealpath: string;
  readonly rootIdentityDigest: string;
  readonly scope: 'verification-criteria-source';
  readonly persistence: 'remembered-local';
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export type SecurityTrustGrant =
  | WorkspaceTrustGrant
  | BrokerReviewTrustGrant
  | CriteriaSourceTrustGrant;

const WorkspaceTrustGrantSchema = z.object({
  schemaVersion: z.literal(1),
  trustGrantId: z.string().uuid(),
  canonicalRealpath: z.string().min(1),
  workspaceIdentityDigest: z.string().startsWith('sha256:'),
  scope: z.literal('loop-project-checks'),
  persistence: z.enum(['session', 'remembered-local']),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().optional(),
});

const BrokerReviewTrustGrantSchema = z.object({
  schemaVersion: z.literal(1),
  trustGrantId: z.string().uuid(),
  workspaceIdentityDigest: z.string().startsWith('sha256:'),
  scope: z.literal('brokered-review-subject'),
  trustProposalDigest: z.string().startsWith('sha256:'),
  reviewSubjectPolicyVersion: z.string().min(1),
  persistence: z.enum(['session', 'remembered-local']),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().optional(),
});

const CriteriaSourceTrustGrantSchema = z.object({
  schemaVersion: z.literal(1),
  trustGrantId: z.string().uuid(),
  sourceId: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u),
  canonicalRealpath: z.string().min(1),
  rootIdentityDigest: z.string().startsWith('sha256:'),
  scope: z.literal('verification-criteria-source'),
  persistence: z.literal('remembered-local'),
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().optional(),
});

const WorkspaceTrustStoreSchema = z.object({
  schemaVersion: z.literal(1),
  grants: z.array(z.discriminatedUnion('scope', [
    WorkspaceTrustGrantSchema,
    BrokerReviewTrustGrantSchema,
    CriteriaSourceTrustGrantSchema,
  ])),
});

const sessionGrants = new Map<string, SecurityTrustGrant>();

function trustStorePath(homeDir?: string): string {
  return join(resolveWukongHome(homeDir), 'security', 'trusted-workspaces.json');
}

export async function grantWorkspaceTrust(
  identity: WorkspaceIdentity,
  persistence: WorkspaceTrustPersistence,
  options: { readonly homeDir?: string; readonly now?: number } = {},
): Promise<WorkspaceTrustGrant> {
  const existing = await findWorkspaceTrust(identity.workspaceIdentityDigest, options);
  if (existing !== undefined && existing.persistence === persistence) return existing;
  const grant: WorkspaceTrustGrant = {
    schemaVersion: 1,
    trustGrantId: randomUUID(),
    canonicalRealpath: identity.canonicalRealpath,
    workspaceIdentityDigest: identity.workspaceIdentityDigest,
    scope: 'loop-project-checks',
    persistence,
    createdAt: options.now ?? Date.now(),
  };
  if (persistence === 'session') {
    sessionGrants.set(grant.trustGrantId, grant);
    return grant;
  }
  const stored = await readRememberedTrustStore(options.homeDir);
  await writeRememberedTrustStore(
    {
      schemaVersion: 1,
      grants: [
        ...stored.grants.filter((entry) => (
          entry.scope !== 'loop-project-checks'
          || entry.workspaceIdentityDigest !== identity.workspaceIdentityDigest
          || entry.revokedAt !== undefined
        )),
        grant,
      ],
    },
    options.homeDir,
  );
  return grant;
}

export async function findWorkspaceTrust(
  workspaceIdentityDigest: string,
  options: { readonly homeDir?: string } = {},
): Promise<WorkspaceTrustGrant | undefined> {
  const session = [...sessionGrants.values()].find((grant) => (
    grant.scope === 'loop-project-checks'
    &&
    grant.workspaceIdentityDigest === workspaceIdentityDigest
    && grant.revokedAt === undefined
  ));
  if (session?.scope === 'loop-project-checks') return session;
  const stored = await readRememberedTrustStore(options.homeDir);
  return stored.grants
    .filter((grant): grant is WorkspaceTrustGrant => (
      grant.scope === 'loop-project-checks'
      &&
      grant.workspaceIdentityDigest === workspaceIdentityDigest
      && grant.revokedAt === undefined
    ))
    .toSorted((left, right) => right.createdAt - left.createdAt)[0];
}

export async function listWorkspaceTrustGrants(
  options: { readonly homeDir?: string; readonly includeRevoked?: boolean } = {},
): Promise<readonly WorkspaceTrustGrant[]> {
  const remembered = (await readRememberedTrustStore(options.homeDir)).grants;
  const all = [...sessionGrants.values(), ...remembered]
    .filter((grant): grant is WorkspaceTrustGrant =>
      grant.scope === 'loop-project-checks');
  return all
    .filter((grant) => options.includeRevoked === true || grant.revokedAt === undefined)
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export async function grantBrokerReviewTrustLocally(
  proposal: BrokerReviewTrustProposalV1,
  persistence: WorkspaceTrustPersistence,
  options: { readonly homeDir?: string; readonly now?: number } = {},
): Promise<BrokerReviewTrustGrant> {
  const existing = await findBrokerReviewTrust(proposal.workspaceIdentityDigest, options);
  if (
    existing !== undefined
    && existing.persistence === persistence
    && existing.reviewSubjectPolicyVersion === proposal.reviewSubjectPolicyVersion
  ) {
    return existing;
  }
  const binding = createBrokerReviewTrustBinding(
    proposal,
    proposal.trustProposalDigest,
  );
  const grant: BrokerReviewTrustGrant = {
    schemaVersion: 1,
    ...binding,
    reviewSubjectPolicyVersion: proposal.reviewSubjectPolicyVersion,
    persistence,
    createdAt: options.now ?? Date.now(),
  };
  if (persistence === 'session') {
    sessionGrants.set(grant.trustGrantId, grant);
    return grant;
  }
  const stored = await readRememberedTrustStore(options.homeDir);
  await writeRememberedTrustStore({
    schemaVersion: 1,
    grants: [
      ...stored.grants.filter((entry) => (
        entry.scope !== 'brokered-review-subject'
        || entry.workspaceIdentityDigest !== proposal.workspaceIdentityDigest
        || entry.revokedAt !== undefined
      )),
      grant,
    ],
  }, options.homeDir);
  return grant;
}

export async function findBrokerReviewTrust(
  workspaceIdentityDigest: string,
  options: { readonly homeDir?: string } = {},
): Promise<BrokerReviewTrustGrant | undefined> {
  const session = [...sessionGrants.values()].find((grant) => (
    grant.scope === 'brokered-review-subject'
    && grant.workspaceIdentityDigest === workspaceIdentityDigest
    && grant.revokedAt === undefined
  ));
  if (session?.scope === 'brokered-review-subject') return session;
  const stored = await readRememberedTrustStore(options.homeDir);
  return stored.grants
    .filter((grant): grant is BrokerReviewTrustGrant => (
      grant.scope === 'brokered-review-subject'
      && grant.workspaceIdentityDigest === workspaceIdentityDigest
      && grant.revokedAt === undefined
    ))
    .toSorted((left, right) => right.createdAt - left.createdAt)[0];
}

export async function listBrokerReviewTrustGrants(
  options: { readonly homeDir?: string; readonly includeRevoked?: boolean } = {},
): Promise<readonly BrokerReviewTrustGrant[]> {
  const remembered = (await readRememberedTrustStore(options.homeDir)).grants;
  return [...sessionGrants.values(), ...remembered]
    .filter((grant): grant is BrokerReviewTrustGrant =>
      grant.scope === 'brokered-review-subject')
    .filter((grant) => options.includeRevoked === true || grant.revokedAt === undefined)
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export async function grantCriteriaSourceTrust(
  root: string,
  options: { readonly homeDir?: string; readonly now?: number } = {},
): Promise<CriteriaSourceTrustGrant> {
  const canonicalRealpath = await realpath(root);
  const info = await lstat(canonicalRealpath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Verification criteria source must be a regular local directory.');
  }
  const rootIdentityDigest = canonicalDigest('wukong/extra-criteria-root/v1', {
    canonicalRealpath,
    device: info.dev,
    inode: info.ino,
  });
  const sourceSlug = basename(canonicalRealpath)
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^a-z0-9._-]+/gu, '-')
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .slice(0, 72) || 'criteria';
  const sourceId = `${sourceSlug}-${rootIdentityDigest.slice(-12)}`;
  const stored = await readRememberedTrustStore(options.homeDir);
  const existing = stored.grants.find((grant): grant is CriteriaSourceTrustGrant => (
    grant.scope === 'verification-criteria-source'
    && grant.canonicalRealpath === canonicalRealpath
    && grant.rootIdentityDigest === rootIdentityDigest
    && grant.revokedAt === undefined
  ));
  if (existing !== undefined) return existing;
  const grant: CriteriaSourceTrustGrant = {
    schemaVersion: 1,
    trustGrantId: randomUUID(),
    sourceId,
    canonicalRealpath,
    rootIdentityDigest,
    scope: 'verification-criteria-source',
    persistence: 'remembered-local',
    createdAt: options.now ?? Date.now(),
  };
  await writeRememberedTrustStore({
    schemaVersion: 1,
    grants: [
      ...stored.grants.filter((entry) => (
        entry.scope !== 'verification-criteria-source'
        || entry.canonicalRealpath !== canonicalRealpath
        || entry.revokedAt !== undefined
      )),
      grant,
    ],
  }, options.homeDir);
  return grant;
}

export async function listCriteriaSourceTrustGrants(
  options: { readonly homeDir?: string; readonly includeRevoked?: boolean } = {},
): Promise<readonly CriteriaSourceTrustGrant[]> {
  const remembered = (await readRememberedTrustStore(options.homeDir)).grants;
  return remembered
    .filter((grant): grant is CriteriaSourceTrustGrant =>
      grant.scope === 'verification-criteria-source')
    .filter((grant) => options.includeRevoked === true || grant.revokedAt === undefined)
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function brokerReviewTrustBinding(
  grant: BrokerReviewTrustGrant,
): BrokerReviewTrustBindingV1 {
  const binding = {
    trustGrantId: grant.trustGrantId,
    workspaceIdentityDigest: grant.workspaceIdentityDigest,
    scope: grant.scope,
    trustProposalDigest: grant.trustProposalDigest,
  };
  registerBrokerReviewTrustBinding(binding);
  return binding;
}

export async function revokeWorkspaceTrust(
  trustGrantId: string,
  options: { readonly homeDir?: string; readonly now?: number } = {},
): Promise<boolean> {
  if (sessionGrants.delete(trustGrantId)) {
    revokeBrokerReviewTrustBinding(trustGrantId);
    return true;
  }
  const stored = await readRememberedTrustStore(options.homeDir);
  let changed = false;
  const grants = stored.grants.map((grant) => {
    if (grant.trustGrantId !== trustGrantId || grant.revokedAt !== undefined) return grant;
    changed = true;
    return { ...grant, revokedAt: options.now ?? Date.now() };
  });
  if (!changed) return false;
  revokeBrokerReviewTrustBinding(trustGrantId);
  await writeRememberedTrustStore({ schemaVersion: 1, grants }, options.homeDir);
  return true;
}

export function clearSessionWorkspaceTrustForTests(): void {
  for (const grant of sessionGrants.values()) {
    if (grant.scope === 'brokered-review-subject') {
      revokeBrokerReviewTrustBinding(grant.trustGrantId);
    }
  }
  sessionGrants.clear();
}

async function readRememberedTrustStore(
  homeDir?: string,
): Promise<z.infer<typeof WorkspaceTrustStoreSchema>> {
  try {
    return WorkspaceTrustStoreSchema.parse(
      JSON.parse(await readFile(trustStorePath(homeDir), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, grants: [] };
    }
    throw error;
  }
}

async function writeRememberedTrustStore(
  store: z.infer<typeof WorkspaceTrustStoreSchema>,
  homeDir?: string,
): Promise<void> {
  const path = trustStorePath(homeDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid.toString()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
