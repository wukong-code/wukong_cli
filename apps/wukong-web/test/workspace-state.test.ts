import { computed, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession } from '../src/api/types';
import { createInitialState } from '../src/api/daemon/eventReducer';
import { useWorkspaceState, type UseWorkspaceStateDeps } from '../src/composables/client/useWorkspaceState';
import type { ExtendedState } from '../src/composables/useWukongWebClient';

const apiMock = vi.hoisted(() => ({
  abortPrompt: vi.fn(),
  abortSession: vi.fn(),
  addWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
}));

vi.mock('../src/api', () => ({
  getWukongWebApi: () => apiMock,
}));

function createSession(): AppSession {
  return {
    id: 'sess_1',
    title: 'Session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    archived: false,
    currentPromptId: 'prompt_live',
    cwd: '/workspace',
    model: 'wukong',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
  };
}

function createState(): ExtendedState {
  return {
    ...createInitialState(),
    sessions: [createSession()],
    activeSessionId: 'sess_1',
    connected: true,
    serverVersion: '',
    workspaceName: 'wukong-web',
    connection: 'connected',
    permission: 'manual',
    thinking: 'high',
    planMode: false,
    swarmMode: false,
    goalMode: false,
    loading: false,
    sessionLoading: false,
    sessionLoadError: false,
    queuedBySession: {},
    gitStatusBySession: {},
    promptIdBySession: { sess_1: 'prompt_stale' },
    sendingBySession: {},
    unreadBySession: {},
    authReady: true,
    bootstrapError: false,
    defaultModel: null,
    managedProviderStatus: null,
    workspaces: [],
    activeWorkspaceId: null,
    fsHome: null,
    recentRoots: [],
    hiddenWorkspaceRoots: [],
    availableOpenInApps: [],
    config: null,
    sideChatMessagesByAgent: {},
    sideChatSendingByAgent: {},
    sideChatUserMessageIdsBySession: {},
    messagesLoadingMoreBySession: {},
    messagesHasMoreBySession: {},
    messagesLoadMoreErrorBySession: {},
  };
}

function createDeps(): UseWorkspaceStateDeps {
  return {
    taskPoller: {},
    sideChat: {},
    modelProvider: {},
    pushOperationFailure: vi.fn(),
    activity: computed(() => 'running'),
    inFlightPromptSessions: new Set(),
    sessionsKnownEmpty: new Set(),
    setSessions: vi.fn(),
    updateSession: vi.fn(),
    upsertSessionFront: vi.fn(),
    appendSession: vi.fn(),
    forgetSession: vi.fn(),
    setActiveSessionId: vi.fn(),
    updateSessionMessages: vi.fn(),
    nextOptimisticMsgId: () => 'msg_opt_1',
    getEventConn: () => null,
    syncSessionFromSnapshot: vi.fn(),
    subscribeToSessionEvents: vi.fn(),
    hasLoadedMessages: vi.fn(),
    refreshSessionStatus: vi.fn(),
    persistSessionProfile: vi.fn().mockResolvedValue(true),
    mergedWorkspaces: computed(() => []),
    workspacesView: computed(() => []),
    status: computed(() => ({})),
    workspaceIdForSession: vi.fn(),
    savePermissionToStorage: vi.fn(),
    savePlanModeToStorage: vi.fn(),
    saveSwarmModeToStorage: vi.fn(),
    saveGoalModeToStorage: vi.fn(),
    saveUnread: vi.fn(),
    saveActiveWorkspaceToStorage: vi.fn(),
    saveHiddenWorkspacesToStorage: vi.fn(),
    goalErrorMessage: vi.fn(),
    basename: (path: string) => path.split('/').at(-1) ?? path,
    resetFastMoon: vi.fn(),
    initialized: ref(true),
    selectedDiffPath: ref(null),
    fileDiffLines: ref([]),
    fileDiffLoading: ref(false),
  } as unknown as UseWorkspaceStateDeps;
}

describe('useWorkspaceState — abortCurrentPrompt', () => {
  beforeEach(() => {
    apiMock.abortPrompt.mockReset();
    apiMock.abortSession.mockReset();
    apiMock.addWorkspace.mockReset();
    apiMock.updateWorkspace.mockReset();
  });

  it('falls back to session abort when the cached prompt id is already completed', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: false });
    apiMock.abortSession.mockResolvedValue({ aborted: true });
    const state = createState();
    const workspace = useWorkspaceState(state, createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'prompt_stale');
    expect(apiMock.abortSession).toHaveBeenCalledWith('sess_1');
    expect(state.promptIdBySession).toEqual({});
  });

  it('does not fall back when prompt abort succeeds', async () => {
    apiMock.abortPrompt.mockResolvedValue({ aborted: true });
    const workspace = useWorkspaceState(createState(), createDeps());

    await workspace.abortCurrentPrompt();

    expect(apiMock.abortPrompt).toHaveBeenCalledWith('sess_1', 'prompt_stale');
    expect(apiMock.abortSession).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceState — workspace persistence', () => {
  it('does not manufacture a local workspace when server validation fails', async () => {
    apiMock.addWorkspace.mockRejectedValueOnce(new Error('path not found'));
    const state = createState();
    const deps = createDeps();
    const workspace = useWorkspaceState(state, deps);

    await expect(workspace.addWorkspaceByPath('/missing')).resolves.toBe(false);

    expect(state.workspaces).toEqual([]);
    expect(deps.pushOperationFailure).toHaveBeenCalledWith(
      'addWorkspace',
      expect.any(Error),
    );
  });

  it('persists workspace renames through the daemon', async () => {
    const renamed = {
      id: 'workspace-1',
      root: '/workspace',
      name: 'Renamed workspace',
      isGitRepo: true,
      sessionCount: 0,
    };
    apiMock.updateWorkspace.mockResolvedValueOnce(renamed);
    const state = createState();
    state.workspaces = [{ ...renamed, name: 'Old name' }];
    const workspace = useWorkspaceState(state, createDeps());

    await workspace.renameWorkspace('workspace-1', '  Renamed workspace  ');

    expect(apiMock.updateWorkspace).toHaveBeenCalledWith('workspace-1', {
      name: 'Renamed workspace',
    });
    expect(state.workspaces[0]?.name).toBe('Renamed workspace');
  });
});

describe('useWorkspaceState — profile controls', () => {
  it('rolls back plan mode when the session profile write fails', async () => {
    const state = createState();
    const deps = createDeps();
    vi.mocked(deps.persistSessionProfile).mockResolvedValue(false);
    const workspace = useWorkspaceState(state, deps);

    workspace.setPlanMode(true);
    expect(state.planMode).toBe(true);
    await vi.waitFor(() => {
      expect(state.planMode).toBe(false);
    });
    expect(deps.savePlanModeToStorage).toHaveBeenLastCalledWith(false);
  });

  it('keeps the new permission mode when the session profile write succeeds', async () => {
    const state = createState();
    const deps = createDeps();
    const workspace = useWorkspaceState(state, deps);

    workspace.setPermission('auto');
    await vi.waitFor(() => {
      expect(deps.persistSessionProfile).toHaveBeenCalled();
    });

    expect(state.permission).toBe('auto');
    expect(deps.savePermissionToStorage).toHaveBeenLastCalledWith('auto');
  });
});
