import { describe, expect, it, vi, beforeEach } from 'vitest';

import { handleReportUpload, type ReportUploadDeps, type ReportUploadCliOptions } from '#/cli/sub/report-upload';

vi.mock('#/cli/lib/report-upload', () => ({
  getCliAccessToken: vi.fn(),
  uploadReport: vi.fn(),
}));

function writable(): { readonly chunks: string[]; readonly writer: { write(chunk: string): boolean } } {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

function createDeps(overrides?: Partial<ReportUploadDeps>): ReportUploadDeps {
  const stdout = writable();
  const stderr = writable();
  return {
    stdout: stdout.writer,
    stderr: stderr.writer,
    readFile: async () => '# Report',
    getAccessToken: async () => 'token',
    upload: async () => ({ ok: true, id: 'r-1', shareUrl: 'https://wukong.today/r/r-1' }),
    ...overrides,
  };
}

describe('handleReportUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 1 when the user is not logged in', async () => {
    const stderr = writable();
    const deps = createDeps({ getAccessToken: async () => null, stderr: stderr.writer });

    const code = await handleReportUpload(deps, { path: '/tmp/report.md' });

    expect(code).toBe(1);
    expect(stderr.chunks.join('')).toContain('not logged in');
  });

  it('returns 2 when the report path is missing', async () => {
    const stderr = writable();
    const deps = createDeps({ stderr: stderr.writer });

    const code = await handleReportUpload(deps, {});

    expect(code).toBe(2);
    expect(stderr.chunks.join('')).toContain('path is required');
  });

  it('returns 2 when the report file cannot be read', async () => {
    const stderr = writable();
    const deps = createDeps({
      stderr: stderr.writer,
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });

    const code = await handleReportUpload(deps, { path: '/missing.md' });

    expect(code).toBe(2);
    expect(stderr.chunks.join('')).toContain('could not read /missing.md');
  });

  it('uploads the report and prints the share URL', async () => {
    const stdout = writable();
    const stderr = writable();
    const upload = vi.fn().mockResolvedValue({ ok: true, id: 'r-1', shareUrl: 'https://wukong.today/r/r-1' });
    const deps = createDeps({ stdout: stdout.writer, stderr: stderr.writer, upload });

    const code = await handleReportUpload(deps, { path: '/tmp/report.md' });

    expect(code).toBe(0);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'verify',
        report_markdown: '# Report',
        visibility: 'private',
      }),
    );
    expect(stdout.chunks.join('')).toContain('https://wukong.today/r/r-1');
    expect(stderr.chunks).toEqual([]);
  });

  it('detects the report type from markdown content', async () => {
    const upload = vi.fn().mockResolvedValue({ ok: true, id: 'r-2', shareUrl: 'https://wukong.today/r/r-2' });
    const deps = createDeps({
      upload,
      readFile: async () => '# Merge Proof Report\n\nsummary',
    });

    await handleReportUpload(deps, { path: '/tmp/proof.md' });

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ type: 'proof' }));
  });

  it('prefers the explicit type option over auto-detection', async () => {
    const upload = vi.fn().mockResolvedValue({ ok: true, id: 'r-3', shareUrl: 'https://wukong.today/r/r-3' });
    const deps = createDeps({
      upload,
      readFile: async () => '# Risk Scan Report\n\nsummary',
    });

    await handleReportUpload(deps, { path: '/tmp/scan.md', type: 'verify' });

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ type: 'verify' }));
  });

  it('uploads publicly only when explicitly requested', async () => {
    const upload = vi.fn().mockResolvedValue({ ok: true, id: 'r-public', shareUrl: 'https://wukong.today/r/r-public' });
    const deps = createDeps({ upload });

    await handleReportUpload(deps, { path: '/tmp/proof.md', public: true });

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' }));
  });

  it('returns 1 and prints the reason when the upload fails', async () => {
    const stderr = writable();
    const deps = createDeps({
      stderr: stderr.writer,
      upload: async () => ({ ok: false, reason: 'quota exceeded' }),
    });

    const code = await handleReportUpload(deps, { path: '/tmp/report.md' });

    expect(code).toBe(1);
    expect(stderr.chunks.join('')).toContain('quota exceeded');
  });
});
