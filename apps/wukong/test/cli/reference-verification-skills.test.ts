import { join } from 'node:path';

import {
  digestVerificationCriteriaAssetRoot,
  discoverVerificationCriteriaCatalog,
} from '@wukong/verification';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', 'reference-verification-skills');

const cases = {
  'api-compatibility': {
    triggers: [
      'api/openapi.json',
      'apps/web/api/login.ts',
      'packages/protocol/events.ts',
      'src/api/users.ts',
      'src/routes/auth.ts',
    ],
    misses: [
      'README.md',
      'docs/api.md',
      'migrations/001.sql',
      'scripts/release.ts',
      'src/components/Button.tsx',
      'src/logger.ts',
      'src/models/user.ts',
      'src/services/mail.ts',
      'test/fixtures/api.json',
      'tools/generate.ts',
    ],
  },
  'migration-safety': {
    triggers: [
      'db/schema.sql',
      'migrations/001_add_user.sql',
      'schema/account.prisma',
      'src/migrations/backfill.ts',
      'wrangler/migrations/0001.sql',
    ],
    misses: [
      'README.md',
      'docs/migrations.md',
      'scripts/migrate-help.ts',
      'src/api/migrations.ts',
      'src/components/Schema.tsx',
      'src/db-client.ts',
      'src/logger.ts',
      'test/migration.test.ts',
      'tools/schema.ts',
      'types/database.ts',
    ],
  },
  'log-security': {
    triggers: [
      'apps/api/src/logger.ts',
      'apps/web/telemetry/events.ts',
      'logs/retention.json',
      'src/diagnostics/report.ts',
      'src/logging/redact.ts',
    ],
    misses: [
      'README.md',
      'docs/logging.md',
      'scripts/print.ts',
      'src/api/events.ts',
      'src/components/LogView.tsx',
      'src/log.ts',
      'src/models/event.ts',
      'test/log-redaction.test.ts',
      'tools/telemetry.ts',
      'types/logging.ts',
    ],
  },
  'frontend-design': {
    triggers: [
      'apps/admin/src/components/Nav.tsx',
      'apps/admin/src/pages/Home.tsx',
      'apps/web/src/routes/settings.tsx',
      'src/components/Button.tsx',
      'src/pages/Login.tsx',
    ],
    misses: [
      'README.md',
      'apps/web/api/page.ts',
      'docs/design.md',
      'public/index.html',
      'src/api/ui.ts',
      'src/design/tokens.ts',
      'src/routes/server.ts',
      'styles/global.css',
      'test/components.test.ts',
      'tools/screenshot.ts',
    ],
  },
} as const;

describe('packaged reference verification criteria', () => {
  for (const [skillName, fixture] of Object.entries(cases)) {
    it(`${skillName} has deterministic 5 trigger / 10 non-trigger coverage`, async () => {
      const assetDigest = await digestVerificationCriteriaAssetRoot(root);
      const source = {
        kind: 'builtin' as const,
        root,
        version: '0.0.20-test',
        assetDigest,
      };
      for (const path of fixture.triggers) {
        const catalog = await discoverVerificationCriteriaCatalog({
          workspaceRoot: import.meta.dirname,
          roots: [source],
          changedPaths: [path],
        });
        expect(
          catalog.suggestions.some((suggestion) =>
            suggestion.selectionId.includes(`/${skillName}:`)),
          `expected ${skillName} to suggest for ${path}`,
        ).toBe(true);
      }
      for (const path of fixture.misses) {
        const catalog = await discoverVerificationCriteriaCatalog({
          workspaceRoot: import.meta.dirname,
          roots: [source],
          changedPaths: [path],
        });
        expect(
          catalog.suggestions.some((suggestion) =>
            suggestion.selectionId.includes(`/${skillName}:`)),
          `expected ${skillName} not to suggest for ${path}`,
        ).toBe(false);
      }
      const repeated = await Promise.all(Array.from({ length: 3 }, () =>
        discoverVerificationCriteriaCatalog({
          workspaceRoot: import.meta.dirname,
          roots: [source],
          changedPaths: fixture.triggers,
        })));
      expect(new Set(repeated.map((catalog) => catalog.catalogDigest))).toHaveLength(1);
      expect(new Set(repeated.map((catalog) =>
        JSON.stringify(catalog.suggestions)))).toHaveLength(1);
    });
  }
});
