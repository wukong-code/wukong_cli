import { createHash } from 'node:crypto';

import { gte, lte, valid } from 'semver';

import { WUKONG_CODE_ANNOUNCEMENTS_URL } from '#/constant/app';
import type { BannerAction, BannerDisplay, BannerLevel, BannerState } from '#/tui/types';

import type { BannerDisplayState } from './state';

interface TipsBannerFallbackItem {
  banner_id?: string | null;
  enabled?: boolean;
  banner_title?: string | null;
  banner_maintext?: string;
  banner_subtext?: string | null;
  banner_min_version?: string | null;
  banner_display?: unknown;
  banner_display_ttl_hours?: unknown;
}

interface TipsBannerJson {
  banner_id?: string | null;
  banner_enabled?: boolean;
  banner_title?: string | null;
  banner_maintext?: string;
  banner_subtext?: string | null;
  banner_start_time?: string | null;
  banner_end_time?: string | null;
  banner_min_version?: string | null;
  banner_display?: unknown;
  banner_display_ttl_hours?: unknown;
  banner_fallback_enabled?: boolean;
  banner_fallback_list?: unknown[];
}

interface AnnouncementJson {
  id?: unknown;
  enabled?: unknown;
  level?: unknown;
  title?: unknown;
  message?: unknown;
  details?: unknown;
  action?: unknown;
  display?: unknown;
  cooldown_hours?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  min_client_version?: unknown;
  max_client_version?: unknown;
}

interface AnnouncementsJson {
  schema_version?: unknown;
  announcements?: unknown;
}

interface BannerHashInput {
  level: BannerLevel;
  tag: string | null;
  mainText: string;
  subText: string | null;
  action: BannerAction | null;
  startTime: string | null;
  endTime: string | null;
  display: BannerDisplay;
  ttlHours?: number;
}

interface BannerCandidateInput {
  id: unknown;
  level: BannerLevel;
  tag: unknown;
  mainText: string;
  subText: unknown;
  action: BannerAction | null;
  display: BannerDisplay;
  ttlHours?: number;
  startTime?: unknown;
  endTime?: unknown;
}

export interface SelectDisplayableBannerArgs {
  json: unknown;
  clientVersion: string;
  now: Date;
  random: () => number;
  state: BannerDisplayState;
}

interface BannerProviderLoadOptions {
  state?: BannerDisplayState;
  now?: Date;
  random?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_COOLDOWN_TTL_HOURS = 24;
const MAX_TAG_LENGTH = 60;
const MAX_MAIN_TEXT_LENGTH = 500;
const MAX_SUB_TEXT_LENGTH = 300;
const MAX_ACTION_LABEL_LENGTH = 60;

function sanitizeRemoteText(value: string, maxLength: number): string {
  return value
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = sanitizeRemoteText(value, MAX_TAG_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = sanitizeRemoteText(value, maxLength);
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUtcDate(value: string): string {
  if (value.endsWith('Z')) return value;
  if (/[+-]\d{2}:\d{2}$/.test(value)) return value;
  return `${value}Z`;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = normalizeUtcDate(value);
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinWindow(start: Date | null, end: Date | null, now: Date): boolean {
  if (start !== null && now < start) return false;
  if (end !== null && now > end) return false;
  return true;
}

function meetsMinVersion(minVersion: unknown, clientVersion: string): boolean {
  if (minVersion === undefined || minVersion === null) return true;
  if (typeof minVersion !== 'string' || minVersion.length === 0) return true;
  const min = valid(minVersion);
  const current = valid(clientVersion);
  if (min === null || current === null) return false;
  return gte(current, min);
}

function meetsVersionRange(
  minVersion: unknown,
  maxVersion: unknown,
  clientVersion: string,
): boolean {
  if (!meetsMinVersion(minVersion, clientVersion)) return false;
  if (maxVersion === undefined || maxVersion === null || maxVersion === '') return true;
  if (typeof maxVersion !== 'string') return false;
  const max = valid(maxVersion);
  const current = valid(clientVersion);
  if (max === null || current === null) return false;
  return lte(current, max);
}

function parseBannerDisplay(value: unknown): BannerDisplay {
  if (value === 'once') return 'once';
  if (value === 'cooldown') return 'cooldown';
  return 'always';
}

function parseBannerLevel(value: unknown): BannerLevel {
  if (value === 'warning') return 'warning';
  if (value === 'critical') return 'critical';
  return 'info';
}

function isAllowedActionUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'wukong.today' || url.hostname.endsWith('.wukong.today')) return true;
  return url.hostname === 'github.com'
    && (url.pathname === '/mutnpc/wukong-code' || url.pathname.startsWith('/mutnpc/wukong-code/'));
}

function parseBannerAction(value: unknown): BannerAction | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as { label?: unknown; url?: unknown };
  const label = normalizeText(raw.label, MAX_ACTION_LABEL_LENGTH);
  if (label === null || typeof raw.url !== 'string') return null;
  try {
    const url = new URL(raw.url);
    if (!isAllowedActionUrl(url)) return null;
    return { label, url: url.toString() };
  } catch {
    return null;
  }
}

function parseBannerDisplayTtlHours(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_COOLDOWN_TTL_HOURS;
}

function normalizeBannerId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hashBannerIdentity(input: BannerHashInput): string {
  const raw = JSON.stringify([
    input.level,
    input.tag ?? '',
    input.mainText,
    input.subText ?? '',
    input.action?.label ?? '',
    input.action?.url ?? '',
    input.startTime ?? '',
    input.endTime ?? '',
    input.display,
    input.ttlHours ?? '',
  ]);
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function getBannerKey(rawBannerId: unknown, input: BannerHashInput): string {
  return normalizeBannerId(rawBannerId) ?? hashBannerIdentity(input);
}

function toBannerState(input: BannerCandidateInput): BannerState {
  const tag = normalizeTag(input.tag);
  const subText = normalizeText(input.subText, MAX_SUB_TEXT_LENGTH);
  const display = input.display;
  const ttlHours = display === 'cooldown' ? parseBannerDisplayTtlHours(input.ttlHours) : undefined;
  const startTime = normalizeText(input.startTime, 64);
  const endTime = normalizeText(input.endTime, 64);
  const key = getBannerKey(input.id, {
    level: input.level,
    tag,
    mainText: input.mainText,
    subText,
    action: input.action,
    startTime,
    endTime,
    display,
    ttlHours,
  });

  return {
    key,
    level: input.level,
    tag,
    mainText: input.mainText,
    subText,
    action: input.action,
    display,
    ttlHours,
  };
}

function pickActiveBanner(
  json: TipsBannerJson,
  clientVersion: string,
  now: Date,
): BannerState | null {
  if (json.banner_enabled !== true) return null;
  if (!meetsMinVersion(json.banner_min_version, clientVersion)) return null;
  const start = parseDate(json.banner_start_time);
  const end = parseDate(json.banner_end_time);
  if (!isWithinWindow(start, end, now)) return null;
  const mainText = normalizeText(json.banner_maintext, MAX_MAIN_TEXT_LENGTH);
  if (mainText === null) return null;
  const display = parseBannerDisplay(json.banner_display);
  return toBannerState({
    id: json.banner_id,
    level: 'info',
    tag: json.banner_title,
    mainText,
    subText: json.banner_subtext,
    action: null,
    display,
    ttlHours: display === 'cooldown' ? parseBannerDisplayTtlHours(json.banner_display_ttl_hours) : undefined,
    startTime: json.banner_start_time,
    endTime: json.banner_end_time,
  });
}

function pickFallbackCandidates(
  json: TipsBannerJson,
  clientVersion: string,
): BannerState[] {
  if (json.banner_fallback_enabled !== true) return [];
  const list = Array.isArray(json.banner_fallback_list) ? json.banner_fallback_list : [];
  const candidates: BannerState[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as TipsBannerFallbackItem;
    if (item.enabled !== true) continue;
    if (!meetsMinVersion(item.banner_min_version, clientVersion)) continue;
    const mainText = normalizeText(item.banner_maintext, MAX_MAIN_TEXT_LENGTH);
    if (mainText === null) continue;
    const display = parseBannerDisplay(item.banner_display);
    candidates.push(
      toBannerState({
        id: item.banner_id,
        level: 'info',
        tag: item.banner_title,
        mainText,
        subText: item.banner_subtext,
        action: null,
        display,
        ttlHours: display === 'cooldown' ? parseBannerDisplayTtlHours(item.banner_display_ttl_hours) : undefined,
      }),
    );
  }
  return candidates;
}

function isAnnouncementsEnvelope(value: unknown): value is AnnouncementsJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const json = value as AnnouncementsJson;
  return json.schema_version === 1 && Array.isArray(json.announcements);
}

function pickAnnouncementCandidates(
  json: AnnouncementsJson,
  clientVersion: string,
  now: Date,
): BannerState[] {
  const rawItems = Array.isArray(json.announcements) ? json.announcements : [];
  const candidates: BannerState[] = [];
  for (const rawItem of rawItems) {
    if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) continue;
    const item = rawItem as AnnouncementJson;
    if (item.enabled !== true) continue;
    if (!meetsVersionRange(item.min_client_version, item.max_client_version, clientVersion)) continue;
    const start = parseDate(item.start_time);
    const end = parseDate(item.end_time);
    if (typeof item.start_time === 'string' && item.start_time.length > 0 && start === null) continue;
    if (typeof item.end_time === 'string' && item.end_time.length > 0 && end === null) continue;
    if (!isWithinWindow(start, end, now)) continue;
    const mainText = normalizeText(item.message, MAX_MAIN_TEXT_LENGTH);
    if (mainText === null) continue;
    if (item.display !== 'always' && item.display !== 'once' && item.display !== 'cooldown') continue;
    if (item.level !== 'info' && item.level !== 'warning' && item.level !== 'critical') continue;
    const display = parseBannerDisplay(item.display);
    candidates.push(toBannerState({
      id: item.id,
      level: parseBannerLevel(item.level),
      tag: item.title,
      mainText,
      subText: item.details,
      action: parseBannerAction(item.action),
      display,
      ttlHours: display === 'cooldown' ? parseBannerDisplayTtlHours(item.cooldown_hours) : undefined,
      startTime: item.start_time,
      endTime: item.end_time,
    }));
  }
  return candidates;
}

function pickRandomCandidate(candidates: BannerState[], random: () => number): BannerState | null {
  if (candidates.length === 0) return null;
  const index = Math.floor(random() * candidates.length);
  return candidates[index]!;
}

function pickFallbackBanner(
  json: TipsBannerJson,
  clientVersion: string,
  random: () => number,
): BannerState | null {
  return pickRandomCandidate(pickFallbackCandidates(json, clientVersion), random);
}

function parseShownAt(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCooldownTtlHours(banner: BannerState): number {
  return typeof banner.ttlHours === 'number' && Number.isFinite(banner.ttlHours) && banner.ttlHours > 0
    ? banner.ttlHours
    : DEFAULT_COOLDOWN_TTL_HOURS;
}

export function shouldDisplayBanner(
  banner: BannerState,
  state: BannerDisplayState,
  now: Date,
): boolean {
  if (banner.display === 'always') return true;
  const lastShownAt = parseShownAt(state.shown[banner.key]?.lastShownAt);
  if (lastShownAt === null) return true;
  if (banner.display === 'once') return false;
  return now.getTime() - lastShownAt.getTime() >= getCooldownTtlHours(banner) * HOUR_MS;
}

export function selectBannerState(
  json: unknown,
  clientVersion: string,
  now: Date,
  random: () => number,
): BannerState | null {
  if (isAnnouncementsEnvelope(json)) {
    return pickAnnouncementCandidates(json, clientVersion, now)[0] ?? null;
  }
  const typed = typeof json === 'object' && json !== null ? (json as TipsBannerJson) : {};
  return (
    pickActiveBanner(typed, clientVersion, now) ??
    pickFallbackBanner(typed, clientVersion, random)
  );
}

export function selectDisplayableBanner({
  json,
  clientVersion,
  now,
  random,
  state,
}: SelectDisplayableBannerArgs): BannerState | null {
  if (isAnnouncementsEnvelope(json)) {
    return pickAnnouncementCandidates(json, clientVersion, now)
      .find((candidate) => shouldDisplayBanner(candidate, state, now)) ?? null;
  }
  const typed = typeof json === 'object' && json !== null ? (json as TipsBannerJson) : {};
  const active = pickActiveBanner(typed, clientVersion, now);
  if (active !== null && shouldDisplayBanner(active, state, now)) return active;
  const candidates = pickFallbackCandidates(typed, clientVersion).filter((candidate) =>
    shouldDisplayBanner(candidate, state, now),
  );
  return pickRandomCandidate(candidates, random);
}

export class BannerProvider {
  constructor(
    private readonly clientVersion: string,
    private readonly url: string = WUKONG_CODE_ANNOUNCEMENTS_URL,
  ) {}

  async load(
    fetchImpl: typeof fetch = fetch,
    options: BannerProviderLoadOptions = {},
  ): Promise<BannerState | null> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => {
        controller.abort();
      }, 3000);
      const response = await fetchImpl(this.url, { signal: controller.signal });
      if (!response.ok) return null;
      const json = await response.json();
      const now = options.now ?? new Date();
      const random = options.random ?? Math.random;
      return options.state === undefined
        ? selectBannerState(json, this.clientVersion, now, random)
        : selectDisplayableBanner({
            json,
            clientVersion: this.clientVersion,
            now,
            random,
            state: options.state,
          });
    } catch {
      return null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
