#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

const host = process.env.WUKONG_STUB_HOST ?? '127.0.0.1';
const port = Number(process.env.WUKONG_STUB_PORT ?? 58627);
const startedAt = new Date().toISOString();
const root = process.env.WUKONG_STUB_WORKSPACE ?? process.cwd();
const serverId = `stub-${randomUUID()}`;
const epoch = `stub-epoch-${randomUUID()}`;
const bearerToken = process.env.WUKONG_STUB_TOKEN ?? 'stub-local';

const workspaces = new Map();
const sessions = new Map();
const messages = new Map();
const sequenceBySession = new Map();

const defaultWorkspace = {
  id: 'stub-workspace',
  root,
  name: basename(root) || 'workspace',
  is_git_repo: true,
  branch: 'main',
  last_opened_at: startedAt,
  session_count: 0,
};
workspaces.set(defaultWorkspace.id, defaultWorkspace);

let config = {
  providers: {
    stub: {
      type: 'openai',
      default_model: 'stub-chat',
      has_api_key: true,
    },
  },
  default_provider: 'stub',
  default_model: 'stub-chat',
  models: {
    'stub-chat': { provider: 'stub', model: 'stub-chat' },
  },
  default_thinking: false,
  default_permission_mode: 'manual',
  default_plan_mode: false,
  telemetry: false,
};

function requestId(request) {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : randomUUID();
}

function sendJson(response, request, data, _status = 200) {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify({ code: 0, msg: 'ok', data, request_id: requestId(request) }));
}

function sendError(response, request, status, code, msg) {
  void status;
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify({ code, msg, data: null, request_id: requestId(request) }));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? {} : JSON.parse(text);
}

function usage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 128000,
    turn_count: 0,
  };
}

function createWireSession(input = {}) {
  const now = new Date().toISOString();
  const workspaceId = input.workspace_id ?? defaultWorkspace.id;
  const workspace = workspaces.get(workspaceId) ?? defaultWorkspace;
  const id = `stub-session-${randomUUID()}`;
  const session = {
    id,
    title: input.title ?? 'New conversation',
    created_at: now,
    updated_at: now,
    status: 'idle',
    archived: false,
    workspace_id: workspace.id,
    metadata: { cwd: input.metadata?.cwd ?? workspace.root },
    agent_config: {
      model: input.agent_config?.model ?? config.default_model,
      thinking: 'off',
      permission_mode: 'manual',
      plan_mode: false,
      swarm_mode: false,
    },
    usage: usage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
  sessions.set(id, session);
  messages.set(id, []);
  sequenceBySession.set(id, 0);
  workspace.session_count += 1;
  return session;
}

function sessionOrError(id, response, request) {
  const session = sessions.get(id);
  if (session) return session;
  sendError(response, request, 404, 40401, `Session not found: ${id}`);
  return null;
}

function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

async function handleHttpRequest(request, response) {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
    if (!url.pathname.startsWith('/api/v1')) {
      sendError(response, request, 404, 40400, 'Use the /api/v1 stub API.');
      return;
    }
    const path = url.pathname.slice('/api/v1'.length) || '/';
    if (request.headers.authorization !== `Bearer ${bearerToken}`) {
      sendError(response, request, 401, 40101, 'Server bearer token required.');
      return;
    }

    if (request.method === 'GET' && path === '/healthz') {
      sendJson(response, request, { ok: true, uptime_sec: Math.floor(process.uptime()) });
      return;
    }
    if (request.method === 'GET' && path === '/meta') {
      sendJson(response, request, {
        server_version: 'dev-stub',
        server_id: serverId,
        started_at: startedAt,
        capabilities: { events: true, workspaces: true },
        open_in_apps: [],
      });
      return;
    }
    if (request.method === 'GET' && path === '/auth') {
      sendJson(response, request, {
        ready: true,
        providers_count: 1,
        default_model: config.default_model,
        managed_provider: null,
      });
      return;
    }
    if (request.method === 'GET' && path === '/config') {
      sendJson(response, request, config);
      return;
    }
    if (request.method === 'POST' && path === '/config') {
      config = { ...config, ...(await readJson(request)) };
      sendJson(response, request, config);
      return;
    }
    if (request.method === 'GET' && path === '/models') {
      sendJson(response, request, {
        items: [{
          provider: 'stub',
          model: 'stub-chat',
          display_name: 'Stub Chat',
          max_context_size: 128000,
          capabilities: ['text'],
        }],
      });
      return;
    }
    if (request.method === 'GET' && path === '/providers') {
      sendJson(response, request, {
        items: [{
          id: 'stub',
          type: 'openai',
          default_model: 'stub-chat',
          has_api_key: true,
          status: 'connected',
          models: ['stub-chat'],
        }],
      });
      return;
    }
    if (request.method === 'GET' && path === '/workspaces') {
      sendJson(response, request, { items: Array.from(workspaces.values()), has_more: false });
      return;
    }
    if (request.method === 'POST' && path === '/workspaces') {
      const input = await readJson(request);
      const id = `stub-workspace-${randomUUID()}`;
      const workspace = {
        id,
        root: input.root,
        name: input.name ?? basename(input.root),
        is_git_repo: true,
        branch: 'main',
        last_opened_at: new Date().toISOString(),
        session_count: 0,
      };
      workspaces.set(id, workspace);
      sendJson(response, request, workspace, 201);
      return;
    }
    const workspaceDelete = path.match(/^\/workspaces\/([^/]+)$/);
    if (request.method === 'PATCH' && workspaceDelete) {
      const workspace = workspaces.get(decodeURIComponent(workspaceDelete[1]));
      if (!workspace) {
        sendError(response, request, 404, 40404, 'Workspace not found.');
        return;
      }
      const input = await readJson(request);
      if (typeof input.name === 'string' && input.name.trim()) workspace.name = input.name.trim();
      sendJson(response, request, workspace);
      return;
    }
    if (request.method === 'DELETE' && workspaceDelete) {
      workspaces.delete(decodeURIComponent(workspaceDelete[1]));
      sendJson(response, request, { deleted: true });
      return;
    }
    if (request.method === 'GET' && path === '/fs:home') {
      sendJson(response, request, { home: homedir(), recent_roots: [root] });
      return;
    }
    if (request.method === 'GET' && path === '/fs/browse') {
      const selected = url.searchParams.get('path') ?? root;
      sendJson(response, request, { path: selected, parent: dirname(selected), entries: [] });
      return;
    }
    if (request.method === 'GET' && path === '/sessions') {
      const workspaceId = url.searchParams.get('workspace_id');
      const includeArchive = url.searchParams.get('include_archive') === 'true';
      const items = Array.from(sessions.values())
        .filter((session) => includeArchive || !session.archived)
        .filter((session) => workspaceId === null || session.workspace_id === workspaceId)
        .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at));
      sendJson(response, request, { items, has_more: false });
      return;
    }
    if (request.method === 'POST' && path === '/sessions') {
      sendJson(response, request, createWireSession(await readJson(request)), 201);
      return;
    }

    const profileMatch = path.match(/^\/sessions\/([^/]+)\/profile$/);
    if (request.method === 'POST' && profileMatch) {
      const id = decodeURIComponent(profileMatch[1]);
      const session = sessionOrError(id, response, request);
      if (!session) return;
      const input = await readJson(request);
      if (typeof input.title === 'string') session.title = input.title;
      if (input.metadata && typeof input.metadata === 'object') {
        session.metadata = { ...session.metadata, ...input.metadata };
      }
      if (input.agent_config && typeof input.agent_config === 'object') {
        session.agent_config = { ...session.agent_config, ...input.agent_config };
      }
      session.updated_at = new Date().toISOString();
      sendJson(response, request, session);
      return;
    }

    const statusMatch = path.match(/^\/sessions\/([^/]+)\/status$/);
    if (request.method === 'GET' && statusMatch) {
      const session = sessionOrError(decodeURIComponent(statusMatch[1]), response, request);
      if (!session) return;
      sendJson(response, request, {
        model: session.agent_config.model,
        thinking_level: session.agent_config.thinking ?? 'off',
        permission: session.agent_config.permission_mode ?? 'manual',
        plan_mode: session.agent_config.plan_mode ?? false,
        swarm_mode: session.agent_config.swarm_mode ?? false,
        context_tokens: session.usage.context_tokens,
        max_context_tokens: session.usage.context_limit,
        context_usage: 0,
      });
      return;
    }

    const warningsMatch = path.match(/^\/sessions\/([^/]+)\/warnings$/);
    if (request.method === 'GET' && warningsMatch) {
      sendJson(response, request, { warnings: [] });
      return;
    }
    const tasksMatch = path.match(/^\/sessions\/([^/]+)\/tasks$/);
    if (request.method === 'GET' && tasksMatch) {
      sendJson(response, request, { items: [] });
      return;
    }
    const skillsMatch = path.match(/^\/sessions\/([^/]+)\/skills$/);
    if (request.method === 'GET' && skillsMatch) {
      sendJson(response, request, { skills: [] });
      return;
    }
    const terminalsMatch = path.match(/^\/sessions\/([^/]+)\/terminals$/);
    if (request.method === 'GET' && terminalsMatch) {
      sendJson(response, request, { items: [] });
      return;
    }
    const gitStatusMatch = path.match(/^\/sessions\/([^/]+)\/fs:git_status$/);
    if (request.method === 'POST' && gitStatusMatch) {
      sendJson(response, request, {
        branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0,
        pullRequest: null,
      });
      return;
    }

    const messagesMatch = path.match(/^\/sessions\/([^/]+)\/messages$/);
    if (request.method === 'GET' && messagesMatch) {
      const id = decodeURIComponent(messagesMatch[1]);
      if (!sessionOrError(id, response, request)) return;
      sendJson(response, request, { items: messages.get(id) ?? [], has_more: false });
      return;
    }
    const snapshotMatch = path.match(/^\/sessions\/([^/]+)\/snapshot$/);
    if (request.method === 'GET' && snapshotMatch) {
      const id = decodeURIComponent(snapshotMatch[1]);
      const session = sessionOrError(id, response, request);
      if (!session) return;
      sendJson(response, request, {
        as_of_seq: sequenceBySession.get(id) ?? 0,
        epoch,
        session,
        messages: { items: messages.get(id) ?? [], has_more: false },
        in_flight_turn: null,
        pending_approvals: [],
        pending_questions: [],
      });
      return;
    }

    const promptMatch = path.match(/^\/sessions\/([^/]+)\/prompts$/);
    if (request.method === 'POST' && promptMatch) {
      const id = decodeURIComponent(promptMatch[1]);
      const session = sessionOrError(id, response, request);
      if (!session) return;
      const input = await readJson(request);
      const now = new Date().toISOString();
      const promptId = `stub-prompt-${randomUUID()}`;
      const userMessageId = `stub-message-${randomUUID()}`;
      const assistantMessageId = `stub-message-${randomUUID()}`;
      const text = contentText(input.content);
      const userMessage = {
        id: userMessageId,
        session_id: id,
        role: 'user',
        content: Array.isArray(input.content) ? input.content : [],
        created_at: now,
        prompt_id: promptId,
      };
      const reply = text.length > 0
        ? `Stub response: ${text}`
        : 'Stub response: attachment received.';
      const assistantMessage = {
        id: assistantMessageId,
        session_id: id,
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        created_at: now,
        prompt_id: promptId,
      };
      const list = messages.get(id) ?? [];
      list.push(userMessage);
      messages.set(id, list);
      session.status = 'running';
      session.current_prompt_id = promptId;
      session.last_prompt = text;
      session.title = session.message_count === 0 && text ? text.slice(0, 48) : session.title;
      session.message_count = list.length;
      session.updated_at = now;
      sendJson(response, request, {
        prompt_id: promptId,
        user_message_id: userMessageId,
        status: 'running',
      }, 202);

      setTimeout(() => {
        broadcast(id, 'event.session.status_changed', {
          status: 'running', previous_status: 'idle', current_prompt_id: promptId,
        });
        broadcast(id, 'event.message.created', { message: userMessage });
        broadcast(id, 'event.message.created', {
          message: { ...assistantMessage, content: [{ type: 'text', text: '' }] },
        });
      }, 20);
      setTimeout(() => {
        broadcast(id, 'event.assistant.delta', {
          message_id: assistantMessageId,
          content_index: 0,
          delta: { text: reply },
        });
        list.push(assistantMessage);
        session.status = 'idle';
        delete session.current_prompt_id;
        session.message_count = list.length;
        session.usage.turn_count += 1;
        session.updated_at = new Date().toISOString();
        broadcast(id, 'event.assistant.completed', {
          message_id: assistantMessageId,
          finish_reason: 'stop',
        });
        broadcast(id, 'event.session.status_changed', {
          status: 'idle', previous_status: 'running',
        });
      }, 90);
      return;
    }

    const archiveMatch = path.match(/^\/sessions\/([^/]+):archive$/);
    if (request.method === 'POST' && archiveMatch) {
      const session = sessionOrError(decodeURIComponent(archiveMatch[1]), response, request);
      if (!session) return;
      session.archived = true;
      sendJson(response, request, { archived: true });
      return;
    }
    const abortMatch = path.match(/^\/sessions\/([^/]+):abort$/);
    if (request.method === 'POST' && abortMatch) {
      const session = sessionOrError(decodeURIComponent(abortMatch[1]), response, request);
      if (!session) return;
      session.status = 'aborted';
      delete session.current_prompt_id;
      sendJson(response, request, { aborted: true });
      return;
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (request.method === 'GET' && sessionMatch) {
      const session = sessionOrError(decodeURIComponent(sessionMatch[1]), response, request);
      if (session) sendJson(response, request, session);
      return;
    }

    sendError(response, request, 404, 40400, `Stub endpoint not implemented: ${request.method} ${path}`);
  } catch (error) {
    sendError(response, request, 500, 50000, error instanceof Error ? error.message : String(error));
  }
}

const httpServer = createServer((request, response) => {
  void handleHttpRequest(request, response);
});

const wsServer = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
  if (url.pathname !== '/api/v1/ws') {
    socket.destroy();
    return;
  }
  const protocols = (request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim());
  if (!protocols.includes(`wukong.bearer.${bearerToken}`)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client));
});

wsServer.on('connection', (client) => {
  client.subscriptions = new Set();
  client.send(JSON.stringify({
    type: 'server_hello',
    timestamp: new Date().toISOString(),
    payload: {
      server_id: serverId,
      heartbeat_ms: 30000,
      max_event_buffer_size: 1000,
      capabilities: { event_batching: false, compression: false },
    },
  }));

  client.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      const sessionIds = frame.payload?.subscriptions ?? frame.payload?.session_ids ?? [];
      if (frame.type === 'unsubscribe') {
        for (const id of sessionIds) client.subscriptions.delete(id);
      } else if (frame.type === 'client_hello' || frame.type === 'subscribe') {
        for (const id of sessionIds) client.subscriptions.add(id);
      } else if (frame.type === 'pong') {
        return;
      }
      if (typeof frame.id === 'string') {
        client.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, msg: 'ok', payload: {} }));
      }
      if (frame.type === 'client_hello' || frame.type === 'subscribe') {
        for (const id of sessionIds) {
          const currentSeq = sequenceBySession.get(id) ?? 0;
          const cursor = frame.payload?.cursors?.[id]?.seq ?? 0;
          if (currentSeq <= cursor) continue;
          client.send(JSON.stringify({
            type: 'resync_required',
            timestamp: new Date().toISOString(),
            payload: {
              session_id: id,
              reason: 'buffer_overflow',
              current_seq: currentSeq,
              epoch,
            },
          }));
        }
      }
    } catch {
      client.send(JSON.stringify({
        type: 'error',
        timestamp: new Date().toISOString(),
        payload: { code: 40000, msg: 'Invalid client frame', fatal: false },
      }));
    }
  });
});

function broadcast(sessionId, type, payload) {
  const seq = (sequenceBySession.get(sessionId) ?? 0) + 1;
  sequenceBySession.set(sessionId, seq);
  const session = sessions.get(sessionId);
  if (session) session.last_seq = seq;
  const frame = JSON.stringify({
    type,
    seq,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload,
  });
  for (const client of wsServer.clients) {
    if (client.readyState === WebSocket.OPEN && client.subscriptions?.has(sessionId)) {
      client.send(frame);
    }
  }
}

httpServer.listen(port, host, () => {
  const address = httpServer.address();
  const resolvedPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write([
    `Wukong web stub daemon listening on http://${host}:${String(resolvedPort)}/api/v1`,
    `Workspace: ${root}`,
    `Bearer token: ${bearerToken}`,
    `Open Web UI: ${process.env.WUKONG_STUB_WEB_URL ?? `http://127.0.0.1:5173/#token=${encodeURIComponent(bearerToken)}`}`,
    '',
  ].join('\n'));
});

function shutdown() {
  for (const client of wsServer.clients) client.close(1001, 'Stub shutting down');
  httpServer.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
