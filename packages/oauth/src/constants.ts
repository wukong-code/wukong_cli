import type { OAuthFlowConfig } from './types';

export const DEFAULT_WUKONG_CODE_OAUTH_HOST = 'https://wukong.today';

export const WUKONG_CODE_FLOW_CONFIG: OAuthFlowConfig = {
  name: 'wukong',
  oauthHost:
    process.env['WUKONG_CODE_OAUTH_HOST'] ??
    process.env['WUKONG_OAUTH_HOST'] ??
    DEFAULT_WUKONG_CODE_OAUTH_HOST,
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
};
