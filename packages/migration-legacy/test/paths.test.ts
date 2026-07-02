import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as paths from '../src/paths.js';

describe('paths', () => {
  it('sourceCredentialsDir joins ~/.wukong/credentials', () => {
    expect(paths.sourceCredentialsDir('/x/.wukong')).toBe(join('/x/.wukong', 'credentials'));
  });

  it('targetConfigFile and targetTuiFile', () => {
    expect(paths.targetConfigFile('/y')).toBe(join('/y', 'config.toml'));
    expect(paths.targetTuiFile('/y')).toBe(join('/y', 'tui.toml'));
  });

  it('targetSessionIndex', () => {
    expect(paths.targetSessionIndex('/y')).toBe(join('/y', 'session_index.jsonl'));
  });

  it('migratedMarker is under source', () => {
    expect(paths.migratedMarker('/x/.wukong')).toBe(join('/x/.wukong', '.migrated-to-wukong'));
  });

  it('skipMarker is under target', () => {
    expect(paths.skipMarker('/y/.wukong')).toBe(join('/y/.wukong', '.skip-migration-from-wukong-cli'));
  });

  it('migrationReportFile is under target', () => {
    expect(paths.migrationReportFile('/y')).toBe(join('/y', 'migration-report.json'));
  });

  it('sourceSessionsDir / sourceUserHistoryDir / sourceWukongJson', () => {
    expect(paths.sourceSessionsDir('/x')).toBe(join('/x', 'sessions'));
    expect(paths.sourceUserHistoryDir('/x')).toBe(join('/x', 'user-history'));
    expect(paths.sourceWukongJson('/x')).toBe(join('/x', 'wukong.json'));
  });
});
