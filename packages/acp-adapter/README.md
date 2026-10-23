# @wukong/acp-adapter

Agent Client Protocol adapter for wukong. Exposes the wukong agent over the [Agent Client Protocol](https://agentclientprotocol.com/) so that ACP-compatible clients (editors, IDEs, custom front-ends) can drive a wukong session over stdio.

Part of the [Wukong](https://github.com/wukong-code/wukong_cli) monorepo.

## Minimum usage

```ts
import { createWukongHarness } from '@wukong/wukong-sdk';
import { runAcpServer } from '@wukong/acp-adapter';

const harness = await createWukongHarness();
await runAcpServer(harness);
```

`runAcpServer` reads JSON-RPC from `process.stdin`, writes to `process.stdout`, and resolves when the client closes the connection. SIGINT and SIGTERM trigger a graceful drain that calls `harness.close()` before the process exits.

Current repository docs are indexed at `docs/README.md`; run `wukong acp --help` for the supported CLI entrypoint.

## License

MIT
