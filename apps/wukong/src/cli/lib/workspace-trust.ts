import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveWukongHome } from '@wukong/wukong-sdk';
import { z } from 'zod';

import type { WorkspaceIdentity } from '@wukong/verification';

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

const WorkspaceTrustStoreSchema = z.object({
  schemaVersion: z.literal(1),
  grants: z.array(WorkspaceTrustGrantSchema),
});

const sessionGrants = new Map<string, WorkspaceTrustGrant>();

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
          entry.workspaceIdentityDigest !== identity.workspaceIdentityDigest
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
    grant.workspaceIdentityDigest === workspaceIdentityDigest
    && grant.revokedAt === undefined
  ));
  if (session !== undefined) return session;
  const stored = await readRememberedTrustStore(options.homeDir);
  return stored.grants
    .filter((grant) => (
      grant.workspaceIdentityDigest === workspaceIdentityDigest
      && grant.revokedAt === undefined
    ))
    .toSorted((left, right) => right.createdAt - left.createdAt)[0];
}

export async function listWorkspaceTrustGrants(
  options: { readonly homeDir?: string; readonly includeRevoked?: boolean } = {},
): Promise<readonly WorkspaceTrustGrant[]> {
  const remembered = (await readRememberedTrustStore(options.homeDir)).grants;
  const all = [...sessionGrants.values(), ...remembered];
  return all
    .filter((grant) => options.includeRevoked === true || grant.revokedAt === undefined)
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export async function revokeWorkspaceTrust(
  trustGrantId: string,
  options: { readonly homeDir?: string; readonly now?: number } = {},
): Promise<boolean> {
  if (sessionGrants.delete(trustGrantId)) return true;
  const stored = await readRememberedTrustStore(options.homeDir);
  let changed = false;
  const grants = stored.grants.map((grant) => {
    if (grant.trustGrantId !== trustGrantId || grant.revokedAt !== undefined) return grant;
    changed = true;
    return { ...grant, revokedAt: options.now ?? Date.now() };
  });
  if (!changed) return false;
  await writeRememberedTrustStore({ schemaVersion: 1, grants }, options.homeDir);
  return true;
}

export function clearSessionWorkspaceTrustForTests(): void {
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
