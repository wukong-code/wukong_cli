import type { Command } from 'commander';

import { runLogoutFlow } from './logout-flow';

export function registerLogoutCommand(parent: Command): void {
  parent
    .command('logout')
    .description('Revoke the Wukong account session and remove local credentials.')
    .action(async () => {
      await runLogoutFlow();
    });
}
