/**
 * Child-process fixture for the fresh-process determinism regression: prints
 * one JSON line with the catalog digest and the ordered suggestion ids for a
 * fixed changed-path set, so the parent test can compare outputs across
 * separate processes.
 */

import { join } from 'node:path';

import {
  digestVerificationCriteriaAssetRoot,
  discoverVerificationCriteriaCatalog,
} from '@wukong/verification';

const root = join(import.meta.dirname, '..', '..', '..', 'reference-verification-skills');
const assetDigest = await digestVerificationCriteriaAssetRoot(root);
const catalog = await discoverVerificationCriteriaCatalog({
  workspaceRoot: import.meta.dirname,
  roots: [{ kind: 'builtin', root, version: '0.0.20-test', assetDigest }],
  changedPaths: [
    'src/api/users.ts',
    'migrations/001_add_user.sql',
    'src/logging/redact.ts',
    'src/components/Button.tsx',
  ],
});
process.stdout.write(
  JSON.stringify({
    catalogDigest: catalog.catalogDigest,
    suggestions: catalog.suggestions.map((suggestion) => suggestion.selectionId),
  }),
);
