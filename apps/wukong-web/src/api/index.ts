// apps/wukong-web/src/api/index.ts
// Singleton factory for the WukongWebApi daemon client.

import { readWukongApiConfig } from './config';
import type { WukongWebApi } from './types';
import { DaemonWukongWebApi } from './daemon/client';

let singleton: WukongWebApi | undefined;

export function getWukongWebApi(): WukongWebApi {
  singleton ??= new DaemonWukongWebApi(readWukongApiConfig());
  return singleton;
}
