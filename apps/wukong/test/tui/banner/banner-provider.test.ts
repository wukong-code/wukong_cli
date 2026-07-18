import { describe, expect, it, vi } from 'vitest';

import {
  BannerProvider,
  selectBannerState,
  selectDisplayableBanner,
  shouldDisplayBanner,
} from '#/tui/banner/banner-provider';
import { WUKONG_CODE_ANNOUNCEMENTS_URL } from '#/constant/app';
import type { BannerState } from '#/tui/types';

const LIVE_ANNOUNCEMENTS_URL = process.env['WUKONG_CODE_LIVE_ANNOUNCEMENTS_URL'];

describe('selectBannerState', () => {
  const now = new Date('2026-06-15T12:00:00+08:00');

  function expectAlwaysBanner(
    result: BannerState | null,
    expected: Pick<BannerState, 'tag' | 'mainText' | 'subText'>,
  ): BannerState {
    expect(result).not.toBeNull();
    const banner = result!;
    expect(banner).toMatchObject({ ...expected, display: 'always' });
    expect(banner.key).toEqual(expect.any(String));
    expect(banner.ttlHours).toBeUndefined();
    return banner;
  }

  it('returns the active banner when enabled and no time window is set', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: 'New',
        banner_maintext: 'Active',
        banner_subtext: 'Details',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: 'New', mainText: 'Active', subText: 'Details' });
  });

  it('returns null when the active banner is outside its time window', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: 'Old',
        banner_maintext: 'Expired',
        banner_start_time: '2026-05-01T00:00:00+08:00',
        banner_end_time: '2026-05-31T00:00:00+08:00',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('filters out the active banner when the client version is too low', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'New',
        banner_min_version: '0.15.0',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('picks a random enabled fallback when the active banner is not shown', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          { enabled: true, banner_title: 'Tip', banner_maintext: 'First' },
          { enabled: true, banner_title: 'Tip', banner_maintext: 'Second' },
        ],
      },
      '0.14.0',
      now,
      () => 0.75,
    );
    expectAlwaysBanner(result, { tag: 'Tip', mainText: 'Second', subText: null });
  });

  it('filters out fallback entries when the client version is too low', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          { enabled: true, banner_maintext: 'Old tip' },
          { enabled: true, banner_maintext: 'New tip', banner_min_version: '0.15.0' },
        ],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Old tip', subText: null });
  });

  it('returns null when no enabled fallback entries exist', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [{ enabled: false, banner_maintext: 'Hidden' }],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('returns null for malformed input fields', () => {
    expect(selectBannerState({ weird: true }, '0.14.0', now, () => 0)).toBeNull();
  });

  it('falls back to the fallback list when banner_enabled is missing', () => {
    const result = selectBannerState(
      {
        banner_fallback_enabled: true,
        banner_fallback_list: [{ enabled: true, banner_maintext: 'Fallback' }],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Fallback', subText: null });
  });

  it('treats an empty tag as null while still showing the banner', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: '',
        banner_maintext: 'No tag',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'No tag', subText: null });
  });

  it('makes the active banner unavailable when mainText is empty', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: 'New',
        banner_maintext: '',
        banner_fallback_enabled: true,
        banner_fallback_list: [{ enabled: true, banner_maintext: 'Fallback' }],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Fallback', subText: null });
  });

  it('treats missing subtext as null', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'Main only',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Main only', subText: null });
  });

  it('treats empty time fields as always valid', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'Always on',
        banner_start_time: '',
        banner_end_time: null,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Always on', subText: null });
  });

  it('falls back to UTC when timestamps have no timezone', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'UTC fallback',
        banner_start_time: '2026-06-15T04:00:00',
        banner_end_time: '2026-06-15T20:00:00',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'UTC fallback', subText: null });
  });

  it('returns null when the fallback list is empty', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('returns null when the fallback list is missing', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('uses banner_id as the banner key when present', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({ key: 'active-1', display: 'always' });
  });

  it('generates a stable hash key when banner_id is missing', () => {
    const json = {
      banner_enabled: true,
      banner_title: 'New',
      banner_maintext: 'Active',
      banner_subtext: 'Details',
    };

    const first = selectBannerState(json, '0.14.0', now, () => 0);
    const second = selectBannerState(json, '0.14.0', now, () => 0);
    const changedDisplay = selectBannerState(
      {
        ...json,
        banner_display: 'cooldown',
        banner_display_ttl_hours: 72,
      },
      '0.14.0',
      now,
      () => 0,
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(changedDisplay).not.toBeNull();
    expect(first!.key).toMatch(/^[0-9a-f]{32}$/);
    expect(second!.key).toBe(first!.key);
    expect(changedDisplay!.key).not.toBe(first!.key);
  });

  it('parses cooldown display and ttl hours', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 72,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({
      key: 'active-1',
      display: 'cooldown',
      ttlHours: 72,
    });
  });

  it('falls back to 24 hours when cooldown ttl is invalid', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 0,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({ display: 'cooldown', ttlHours: 24 });
  });

  it('falls back to always for unknown display values', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
        banner_display: '24h',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({ display: 'always' });
    expect(result?.ttlHours).toBeUndefined();
  });

  it('supports fallback display and ttl fields', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback-1',
            banner_maintext: 'Fallback',
            banner_display: 'cooldown',
            banner_display_ttl_hours: 168,
          },
        ],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({
      key: 'fallback-1',
      display: 'cooldown',
      ttlHours: 168,
    });
  });

  it('reads the versioned announcements envelope', () => {
    const result = selectBannerState(
      {
        schema_version: 1,
        announcements: [
          {
            id: 'release-0.0.11',
            enabled: true,
            level: 'warning',
            title: '升级提醒',
            message: 'Wukong Code 0.0.11 已发布',
            details: '本次更新修复了终端显示问题。',
            action: { label: '查看更新', url: 'https://wukong.today/changelog' },
            display: 'once',
            min_client_version: '0.0.1',
            max_client_version: '0.14.0',
          },
        ],
      },
      '0.14.0',
      now,
      () => 0,
    );

    expect(result).toMatchObject({
      key: 'release-0.0.11',
      level: 'warning',
      tag: '升级提醒',
      mainText: 'Wukong Code 0.0.11 已发布',
      subText: '本次更新修复了终端显示问题。',
      action: { label: '查看更新', url: 'https://wukong.today/changelog' },
      display: 'once',
    });
  });

  it('matches the hosted proof onboarding announcement only once on 0.0.11', () => {
    const json = {
      schema_version: 1,
      announcements: [{
        id: 'hosted-proof-sharing-0.0.11',
        enabled: true,
        level: 'info',
        title: 'HOSTED PROOF',
        message: 'Run a Loop with real checks and structured results.',
        details: 'Run wukong loop with real checks and structured results.',
        action: {
          label: 'View v0.0.11 release',
          url: 'https://github.com/mutnpc/wukong-code/releases/tag/v0.0.11',
        },
        display: 'once',
        start_time: '2026-07-13T07:17:12Z',
        end_time: '2026-08-31T23:59:59Z',
        min_client_version: '0.0.11',
        max_client_version: '0.0.11',
      }],
    };
    const activeAt = new Date('2026-07-13T08:00:00Z');
    const emptyState = { version: 1 as const, shown: {} };
    const current = selectDisplayableBanner({
      json,
      clientVersion: '0.0.11',
      now: activeAt,
      random: () => 0,
      state: emptyState,
    });

    expect(current).toMatchObject({
      key: 'hosted-proof-sharing-0.0.11',
      mainText: 'Run a Loop with real checks and structured results.',
      display: 'once',
      action: {
        label: 'View v0.0.11 release',
        url: 'https://github.com/mutnpc/wukong-code/releases/tag/v0.0.11',
      },
    });
    for (const clientVersion of ['0.0.10', '0.0.12']) {
      expect(selectDisplayableBanner({
        json,
        clientVersion,
        now: activeAt,
        random: () => 0,
        state: emptyState,
      })).toBeNull();
    }
    expect(selectDisplayableBanner({
      json,
      clientVersion: '0.0.11',
      now: activeAt,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          'hosted-proof-sharing-0.0.11': { lastShownAt: activeAt.toISOString() },
        },
      },
    })).toBeNull();
  });

  it.skipIf(!LIVE_ANNOUNCEMENTS_URL)('matches the hosted proof announcement from the live endpoint', async () => {
    const response = await fetch(LIVE_ANNOUNCEMENTS_URL!);
    expect(response.ok).toBe(true);
    const json: unknown = await response.json();
    const activeAt = new Date('2026-07-13T08:00:00Z');
    const emptyState = { version: 1 as const, shown: {} };
    const select = (clientVersion: string, state = emptyState) => selectDisplayableBanner({
      json,
      clientVersion,
      now: activeAt,
      random: () => 0,
      state,
    });

    expect(select('0.0.11')).toMatchObject({
      key: 'hosted-proof-sharing-0.0.11',
      display: 'once',
    });
    expect(select('0.0.10')).toBeNull();
    expect(select('0.0.12')).toBeNull();
    expect(select('0.0.11', {
      version: 1,
      shown: {
        'hosted-proof-sharing-0.0.11': { lastShownAt: activeAt.toISOString() },
      },
    })).toBeNull();
  });

  it('selects the first eligible announcement in file order', () => {
    const result = selectBannerState(
      {
        schema_version: 1,
        announcements: [
          {
            id: 'future',
            enabled: true,
            level: 'info',
            title: 'Future',
            message: 'Future client only',
            display: 'always',
            min_client_version: '1.0.0',
          },
          {
            id: 'current',
            enabled: true,
            level: 'info',
            title: 'Current',
            message: 'Visible now',
            display: 'always',
          },
        ],
      },
      '0.14.0',
      now,
      () => 0.9,
    );
    expect(result).toMatchObject({ key: 'current', mainText: 'Visible now' });
  });

  it('rejects malformed announcement policy fields and timestamps', () => {
    for (const announcement of [
      { id: 'bad-level', enabled: true, level: 'urgent', message: 'Bad', display: 'always' },
      { id: 'bad-display', enabled: true, level: 'info', message: 'Bad', display: 'daily' },
      {
        id: 'bad-time',
        enabled: true,
        level: 'info',
        message: 'Bad',
        display: 'always',
        start_time: 'not-a-date',
      },
    ]) {
      expect(selectBannerState(
        { schema_version: 1, announcements: [announcement] },
        '0.14.0',
        now,
        () => 0,
      )).toBeNull();
    }
  });

  it('sanitizes terminal controls and drops unapproved action hosts', () => {
    const result = selectBannerState(
      {
        schema_version: 1,
        announcements: [{
          id: 'safe',
          enabled: true,
          level: 'critical',
          title: '\u001B[31m安全通知',
          message: '\u001B]8;;https://evil.example\u0007请升级',
          action: { label: '立即查看', url: 'https://evil.example/phishing' },
          display: 'always',
        }],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result?.tag).not.toContain('\u001B');
    expect(result?.mainText).not.toContain('\u001B');
    expect(result?.action).toBeNull();
  });
});

describe('shouldDisplayBanner', () => {
  const now = new Date('2026-06-16T12:00:00.000Z');

  const banner: BannerState = {
    key: 'always',
    level: 'info',
    tag: null,
    mainText: 'Always',
    subText: null,
    action: null,
    display: 'always',
  };

  it('returns true for always banners even when they were shown before', () => {
    expect(
      shouldDisplayBanner(
        banner,
        {
          version: 1,
          shown: {
            always: { lastShownAt: '2026-06-16T11:59:59.000Z' },
          },
        },
        now,
      ),
    ).toBe(true);
  });

  it('returns true for once banners without a shown record', () => {
    expect(shouldDisplayBanner({ ...banner, key: 'once', display: 'once' }, { version: 1, shown: {} }, now)).toBe(
      true,
    );
  });

  it('returns false for once banners with a shown record', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'once', display: 'once' },
        {
          version: 1,
          shown: {
            once: { lastShownAt: '2026-06-16T11:59:59.000Z' },
          },
        },
        now,
      ),
    ).toBe(false);
  });

  it('treats an invalid shown record as not shown', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'once', display: 'once' },
        {
          version: 1,
          shown: {
            once: { lastShownAt: 'not-a-date' },
          },
        },
        now,
      ),
    ).toBe(true);
  });

  it('returns false during cooldown ttl', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 24 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-16T00:00:00.000Z' },
          },
        },
        now,
      ),
    ).toBe(false);
  });

  it('returns true at the cooldown ttl boundary', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 24 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-15T12:00:00.000Z' },
          },
        },
        now,
      ),
    ).toBe(true);
  });

  it('supports custom cooldown ttl values', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 1 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-16T11:30:00.000Z' },
          },
        },
        now,
      ),
    ).toBe(false);
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 168 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-09T12:00:01.000Z' },
          },
        },
        now,
      ),
    ).toBe(false);
  });
});

describe('selectDisplayableBanner', () => {
  const now = new Date('2026-06-16T12:00:00.000Z');

  it('falls back when the active once banner was already shown', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: true,
        banner_id: 'active',
        banner_maintext: 'Active',
        banner_display: 'once',
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback',
            banner_maintext: 'Fallback',
            banner_display: 'once',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          active: { lastShownAt: '2026-06-16T00:00:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'fallback', display: 'once' });
  });

  it('falls back when active cooldown is within ttl', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: true,
        banner_id: 'active',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 1,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback',
            banner_maintext: 'Fallback',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          active: { lastShownAt: '2026-06-16T11:30:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'fallback', display: 'always' });
  });

  it('returns active cooldown after ttl instead of fallback', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: true,
        banner_id: 'active',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 24,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback',
            banner_maintext: 'Fallback',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          active: { lastShownAt: '2026-06-15T12:00:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'active', display: 'cooldown', ttlHours: 24 });
  });

  it('randomly chooses only displayable fallback candidates', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback-once',
            banner_maintext: 'Fallback once',
            banner_display: 'once',
          },
          {
            enabled: true,
            banner_id: 'fallback-always',
            banner_maintext: 'Fallback always',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          'fallback-once': { lastShownAt: '2026-06-16T00:00:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'fallback-always', display: 'always' });
  });
});

describe('BannerProvider', () => {
  it('fetches the public announcements endpoint and parses its envelope', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1,
      announcements: [{
        id: 'remote-announcement',
        enabled: true,
        level: 'info',
        title: 'NOTICE',
        message: 'Remote message',
        display: 'always',
      }],
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await new BannerProvider('0.14.0').load(fetchImpl, {
      now: new Date('2026-06-16T12:00:00.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      WUKONG_CODE_ANNOUNCEMENTS_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toMatchObject({ key: 'remote-announcement', mainText: 'Remote message' });
  });

  it('fails open when the announcement request fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(new BannerProvider('0.14.0').load(fetchImpl)).resolves.toBeNull();
  });
});
