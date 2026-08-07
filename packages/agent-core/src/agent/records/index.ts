import type { Agent } from '..';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from './migration';
import type { AgentRecord, AgentRecordPersistence } from './types';

export * from './types';
export { AGENT_WIRE_PROTOCOL_VERSION } from './migration';
export {
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
} from './persistence';
export type { FileSystemAgentRecordPersistenceOptions } from './persistence';
export { BlobStore, isBlobRef } from './blobref';
export type { BlobStoreOptions } from './blobref';

// Contract: restore MUST only rebuild in-memory state. It must not emit UI
// events, call the LLM, execute tools, start background work, make network
// requests, or touch the filesystem in a way that triggers external side effects.
//
// Prefer restoring by calling the same method that wrote the record, so live
// execution and resume share one state mutation path. For example,
// permission.set_mode replays through agent.permission.setMode(input.mode),
// not by assigning modeOverride here. records.logRecord, emitEvent, and
// emitStatusUpdated already gate on records.restoring, so those calls are safe
// during resume.
function restoreAgentRecord(agent: Agent, input: AgentRecord): void {
  switch (input.type) {
    case 'metadata':
      return;
    case 'forked':
      agent.goal.restoreForked(input);
      return;
    case 'turn.prompt':
      agent.turn.restorePrompt();
      return;
    case 'turn.steer':
      agent.turn.restoreSteer(input.input, input.origin);
      return;
    case 'turn.cancel':
      agent.turn.cancel(input.turnId);
      return;
    case 'config.update':
      agent.config.update(input);
      return;
    case 'permission.set_mode':
      agent.permission.setMode(input.mode);
      return;
    case 'permission.record_approval_result':
      agent.permission.recordApprovalResult(input);
      return;
    case 'usage.record':
      agent.usage.record(input.model, input.usage, 'session');
      return;
    case 'full_compaction.begin':
      agent.fullCompaction.begin(input);
      return;
    case 'full_compaction.cancel':
      agent.fullCompaction.cancel();
      return;
    case 'full_compaction.complete':
      agent.fullCompaction.markCompleted();
      return;
    case 'micro_compaction.apply':
      agent.microCompaction.apply(input.cutoff);
      return;
    case 'plan_mode.enter':
      agent.planMode.restoreEnter(input);
      return;
    case 'plan_mode.cancel':
      agent.planMode.cancel(input.id);
      return;
    case 'plan_mode.exit':
      agent.planMode.exit(input.id);
      return;
    case 'swarm_mode.enter':
      agent.swarmMode.restoreEnter(input.trigger);
      return;
    case 'swarm_mode.exit':
      agent.swarmMode.exit();
      return;
    case 'context.append_message':
      agent.context.appendMessage(input.message);
      return;
    case 'context.append_loop_event':
      agent.context.appendLoopEvent(input.event);
      // Advance the turn counter past internally-driven turns (goal
      // continuations, steer-launched turns) that allocate a turnId without a
      // `turn.prompt` record. Their loop events still carry the real turnId.
      if ('turnId' in input.event) {
        const restoredTurnId = Number.parseInt(input.event.turnId, 10);
        if (!Number.isNaN(restoredTurnId)) {
          agent.turn.observeRestoredTurnId(restoredTurnId);
        }
      }
      return;
    case 'context.clear':
      agent.context.clear();
      return;
    case 'context.apply_compaction':
      agent.context.applyCompaction(input);
      return;
    case 'context.undo':
      agent.context.undo(input.count);
      return;
    case 'tools.register_user_tool':
      agent.tools.registerUserTool(input);
      return;
    case 'tools.unregister_user_tool':
      agent.tools.unregisterUserTool(input.name);
      return;
    case 'tools.set_active_tools':
      agent.tools.setActiveTools(input.names);
      return;
    case 'tools.update_store':
      agent.tools.updateStore(input.key, input.value);
      return;
    case 'goal.create':
      agent.goal.restoreCreate(input);
      return;
    case 'goal.update':
      agent.goal.restoreUpdate(input);
      return;
    case 'goal.workspace-path-touch.create':
    case 'goal.workspace-path-touch.update':
      agent.goal.restoreWorkspacePathTouch(input);
      return;
    case 'goal.contract.create':
      agent.goal.restoreContractCreate(input);
      return;
    case 'goal.contract.identity.assign':
      agent.goal.restoreContractIdentityAssign(input);
      return;
    case 'goal.lineage.create':
      agent.goal.restoreGoalLineage(input);
      return;
    case 'loop.run.create':
      agent.goal.restoreLoopRunCreate(input);
      return;
    case 'loop.run-review-settings.assign':
      agent.goal.restoreLoopRunReviewSettingsAssignment(input);
      return;
    case 'loop.run.terminal':
      agent.goal.restoreLoopRunTerminal(input);
      return;
    case 'loop.gate-attempt.complete':
      agent.goal.restoreGateAttemptComplete(input);
      return;
    case 'loop.gate-attempt.create':
    case 'loop.gate-check-result.create':
    case 'loop.builtin-risk-scan-result.create':
    case 'loop.reviewer-result.create':
    case 'loop.review-subject-manifest.create':
    case 'loop.fresh-criteria-verdict.create':
    case 'loop.proof-aggregate.create':
    case 'loop.evidence-snapshot.create':
    case 'loop.continuation.create':
      agent.goal.restoreLoopAuditRecord(input);
      return;
    case 'goal.review.record':
      agent.goal.restoreReviewRecord(input);
      return;
    case 'goal.strategy.record':
      agent.goal.restoreStrategyRecord(input);
      return;
    case 'goal.clear':
      agent.goal.restoreClear(input);
      return;
    default:
      throw new Error(
        `AgentRecords replay encountered unsupported record type: ${String(
          (input as { readonly type?: unknown }).type,
        )}`,
      );
  }
}

export interface RestoringContext {
  time?: number;
}

export interface AgentRecordsReplayOptions {
  readonly rewriteMigratedRecords?: boolean;
}

export class AgentRecords {
  private _restoring: RestoringContext | null = null;
  private metadataInitialized = false;
  private writeBlockedReason: string | undefined;

  constructor(
    private readonly agent: Agent,
    private readonly persistence?: AgentRecordPersistence,
  ) {}

  get restoring() {
    return this._restoring;
  }

  logRecord(record: AgentRecord): void {
    if (this._restoring !== null) return;
    if (this.writeBlockedReason !== undefined) {
      throw new Error(
        `Agent records are read-only because replay failed: ${this.writeBlockedReason}`,
      );
    }
    const stamped: AgentRecord =
      record.time !== undefined ? record : { ...record, time: Date.now() };
    if (
      this.persistence !== undefined &&
      !this.metadataInitialized &&
      stamped.type !== 'metadata'
    ) {
      this.persistence.append({
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
      });
      this.metadataInitialized = true;
    }
    if (stamped.type === 'metadata') {
      this.metadataInitialized = true;
    }
    this.persistence?.append(stamped);
  }

  restore(record: AgentRecord): boolean {
    this._restoring = { time: record.time ?? Date.now() };
    try {
      restoreAgentRecord(this.agent, record);
      return this.agent.replayBuilder.finishRestoringRecord(record.type);
    } finally {
      this._restoring = null;
    }
  }

  async replay(options: AgentRecordsReplayOptions = {}): Promise<{ warning?: string }> {
    if (!this.persistence) throw new Error('No persistence provided for AgentRecords');
    const rewriteMigratedRecords = options.rewriteMigratedRecords ?? true;
    let migrations: readonly WireMigration[] = [];
    let hasMetadata = false;
    let shouldRewrite = false;
    const replayedRecords: AgentRecord[] | undefined = rewriteMigratedRecords ? [] : undefined;
    let completed = true;
    try {
      for await (const record of this.persistence.read()) {
        if (!hasMetadata) {
          if (record.type !== 'metadata') {
            throw new Error('AgentRecords replay expected metadata as the first record');
          }
          hasMetadata = true;
          this.metadataInitialized = true;
          const readVersion = record.protocol_version;
          if (isNewerWireVersion(readVersion)) {
            throw new Error(
              `Session wire protocol version ${readVersion} is newer than the current version ${AGENT_WIRE_PROTOCOL_VERSION}. Upgrade Wukong before resuming this session.`,
            );
          }
          migrations = resolveWireMigrations(readVersion);
          shouldRewrite = readVersion !== AGENT_WIRE_PROTOCOL_VERSION;
        }
        let migratedRecord = migrateWireRecord(
          record as WireMigrationRecord,
          migrations,
        ) as AgentRecord;
        if (migratedRecord.type === 'metadata') {
          migratedRecord = {
            ...migratedRecord,
            protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
          };
        }
        replayedRecords?.push(migratedRecord);
        if (this.restore(migratedRecord)) {
          completed = false;
          break;
        }
      }
    } catch (error) {
      this.writeBlockedReason = error instanceof Error ? error.message : 'unknown replay error';
      throw error;
    }
    if (completed && shouldRewrite && replayedRecords !== undefined) {
      this.persistence.rewrite(replayedRecords);
      await this.persistence.flush();
    }
    if (completed && this.agent.blobStore !== undefined) {
      for (const msg of this.agent.context.history) {
        await this.agent.blobStore.rehydrateParts(msg.content);
      }
    }
    return { warning: undefined };
  }

  async flush(): Promise<void> {
    await this.persistence?.flush();
  }
}
