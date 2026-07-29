import type { CandidateBootstrapPlanV1 } from '@wukong/verification';

import { Agent, type AgentOptions } from './agent';
import { CandidateDeltaStore } from './candidate-delta-store';
import {
  CandidateRootCapabilityV1,
  type WorktreeLeaseStore,
} from './worktree-lease-store';
import {
  CandidateWorkspacePathPolicyV1,
} from './tools/support/workspace';

const CANDIDATE_WRITER_TOOLS = Object.freeze([
  'Read',
  'ReadMediaFile',
  'Write',
  'Edit',
  'Grep',
  'Glob',
] as const);

/**
 * Deliberately small construction surface for the isolated candidate writer.
 * Extensible capabilities (MCP, Skills, hooks, subagents, network services,
 * shell and additional directories) are intentionally absent.
 */
export interface CandidateWriterAgentOptions {
  readonly kaos: AgentOptions['kaos'];
  readonly modelProvider: NonNullable<AgentOptions['modelProvider']>;
  readonly modelAlias: string;
  readonly systemPrompt: string;
  readonly config?: AgentOptions['config'];
  readonly rpc?: AgentOptions['rpc'];
  readonly persistence?: AgentOptions['persistence'];
  readonly generate?: AgentOptions['generate'];
  readonly permission?: AgentOptions['permission'];
  readonly log?: AgentOptions['log'];
  readonly experimentalFlags?: AgentOptions['experimentalFlags'];
  readonly replay?: AgentOptions['replay'];
  readonly compactionStrategy?: AgentOptions['compactionStrategy'];
  readonly microCompaction?: AgentOptions['microCompaction'];
}

/**
 * Creates a short-lived Writer bound to one authentic candidate-root
 * capability. The store validates the exact lease/fencing marker around the
 * lifecycle, while every file tool validates it again around each I/O call.
 */
export async function withCandidateWriterAgent<Result>(
  store: WorktreeLeaseStore,
  deltaStore: CandidateDeltaStore,
  capability: CandidateRootCapabilityV1,
  bootstrapPlan: CandidateBootstrapPlanV1,
  options: CandidateWriterAgentOptions,
  callback: (agent: Agent) => Promise<Result> | Result,
): Promise<Result> {
  if (!(capability instanceof CandidateRootCapabilityV1)
    || !(deltaStore instanceof CandidateDeltaStore)
    || typeof callback !== 'function'
    || typeof options.modelAlias !== 'string'
    || options.modelAlias.length === 0
    || typeof options.systemPrompt !== 'string'
    || options.systemPrompt.length === 0) {
    throw new Error('Candidate Writer options are invalid.');
  }
  await deltaStore.initializeBaseline({
    worktreeLeaseStore: store,
    rootCapability: capability,
    bootstrapPlan,
  });
  const pathPolicy = CandidateWorkspacePathPolicyV1.create(bootstrapPlan);
  return store.withCandidateRoot(capability, async (view) => {
    const agent = new Agent({
      kaos: options.kaos.withCwd(view.candidateRelativeCwd),
      config: options.config,
      rpc: options.rpc,
      persistence: options.persistence,
      type: 'independent',
      generate: options.generate,
      compactionStrategy: options.compactionStrategy,
      microCompaction: options.microCompaction,
      modelProvider: options.modelProvider,
      permission: options.permission,
      log: options.log,
      experimentalFlags: options.experimentalFlags,
      replay: options.replay,
      toolMode: 'candidate-writer',
      workspace: view.workspace,
    });
    agent.validateModel(options.modelAlias);
    agent.config.updateTransient({
      cwd: view.candidateRelativeCwd,
      modelAlias: options.modelAlias,
      systemPrompt: options.systemPrompt,
      profileName: 'candidate-writer',
    });
    agent.tools.setActiveToolsTransient(CANDIDATE_WRITER_TOOLS);
    return callback(agent);
  }, pathPolicy);
}
