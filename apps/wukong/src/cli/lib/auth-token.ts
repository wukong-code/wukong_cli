import { WUKONG_CODE_PROVIDER_NAME } from '@wukong/wukong-oauth';
import { WukongAuthFacade, resolveConfigPath, resolveWukongHome } from '@wukong/wukong-sdk';

import { createWukongCodeHostIdentity, getVersion } from '#/cli/version';

function createAuthFacade(): WukongAuthFacade {
  const homeDir = resolveWukongHome();
  const configPath = resolveConfigPath({ homeDir });
  return new WukongAuthFacade({
    homeDir,
    configPath,
    identity: createWukongCodeHostIdentity(getVersion()),
  });
}

export async function getCliAccessToken(): Promise<string | null> {
  const auth = createAuthFacade();
  try {
    return (await auth.getCachedAccessToken(WUKONG_CODE_PROVIDER_NAME)) ?? null;
  } catch {
    return null;
  }
}
