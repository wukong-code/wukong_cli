#!/usr/bin/env node
/**
 * Wukong Datasource MCP server.
 *
 * Exposes two generic tools that proxy to the Wukong datasource API:
 *   - get_data_source_desc
 *   - call_data_source_tool
 *
 * Communicates over stdio using JSON-RPC 2.0. Reads managed-Wukong OAuth
 * credentials from WUKONG_CODE_HOME/credentials and respects the env-scoped
 * credential slot derived from WUKONG_CODE_BASE_URL + WUKONG_CODE_OAUTH_HOST.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, basename, extname } from 'node:path';

const DEFAULT_WUKONG_CODE_BASE_URL = 'https://api.wukong.today/coding/v1';
const DEFAULT_WUKONG_CODE_OAUTH_HOST = 'https://auth.wukong.today';
const WUKONG_CODE_OAUTH_KEY = 'oauth.wukong';
const WUKONG_CODE_SCOPED_OAUTH_KEY_PREFIX = 'oauth.wukong-env-';

const DATA_SOURCE_NAMES = Object.freeze([
  'world_bank_open_data',
  'arxiv',
  'yuandian_law',
]);

/** Trim and strip trailing slashes from an endpoint URL. */
function normalizeEndpoint(value) {
  return value.trim().replace(/\/+$/, '');
}

/** Resolve a base URL, falling back to the managed-Wukong default. */
function defaultBaseUrl(baseUrl) {
  return (baseUrl ?? process.env['WUKONG_CODE_BASE_URL'] ?? DEFAULT_WUKONG_CODE_BASE_URL).replace(
    /\/+$/,
    '',
  );
}

/**
 * Reproduce the credential slot logic from @wukong/wukong-oauth so the plugin
 * reads the same file that the CLI login flow writes to.
 */
function resolveWukongOAuthKey(options) {
  const oauthHost = normalizeEndpoint(options.oauthHost ?? process.env['WUKONG_CODE_OAUTH_HOST'] ?? DEFAULT_WUKONG_CODE_OAUTH_HOST);
  const baseUrl = defaultBaseUrl(options.baseUrl);
  const defaultOauthHost = normalizeEndpoint(DEFAULT_WUKONG_CODE_OAUTH_HOST);

  if (oauthHost === defaultOauthHost && baseUrl === normalizeEndpoint(DEFAULT_WUKONG_CODE_BASE_URL)) {
    return WUKONG_CODE_OAUTH_KEY;
  }

  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost, baseUrl }))
    .digest('hex')
    .slice(0, 16);
  return `${WUKONG_CODE_SCOPED_OAUTH_KEY_PREFIX}${digest}`;
}

function homeDir() {
  const home = process.env['WUKONG_CODE_HOME'];
  if (!home) {
    throw new Error('WUKONG_CODE_HOME is not set');
  }
  return home;
}

async function readCredential(fileName) {
  try {
    const text = await readFile(`${homeDir()}/credentials/${fileName}`, 'utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isExpired(credential) {
  if (!credential || typeof credential.expires_at !== 'number') return true;
  // Treat tokens that expire within the next minute as expired to avoid edge races.
  return credential.expires_at <= Date.now() / 1000 + 60;
}

async function resolveAccessToken() {
  const key = resolveWukongOAuthKey({});
  const scopedFile = `${key.replace(/^oauth\//, '')}.json`;
  const scoped = await readCredential(scopedFile);
  if (scoped && !isExpired(scoped) && typeof scoped.access_token === 'string') {
    return scoped.access_token;
  }
  const fallback = await readCredential('wukong.json');
  if (fallback && !isExpired(fallback) && typeof fallback.access_token === 'string') {
    return fallback.access_token;
  }
  // Prefer a non-expired scoped token even if the fallback is expired.
  if (scoped && typeof scoped.access_token === 'string') {
    return scoped.access_token;
  }
  if (fallback && typeof fallback.access_token === 'string') {
    return fallback.access_token;
  }
  throw new Error('No valid Wukong OAuth credential found');
}

function apiUrl() {
  if (process.env['WUKONG_DATASOURCE_API_URL']) {
    return process.env['WUKONG_DATASOURCE_API_URL'].replace(/\/+$/, '');
  }
  const base = (process.env['WUKONG_CODE_BASE_URL'] ?? DEFAULT_WUKONG_CODE_BASE_URL).replace(
    /\/+$/,
    '',
  );
  return `${base}/tools`;
}

/**
 * Determine whether a returned file should be written to disk.
 *
 * The datasource API may return auxiliary files (e.g. binary payloads); only
 * write files whose path is clearly related to the user's requested filepath.
 * This prevents a malicious or buggy API response from spraying unrelated files
 * into the working directory.
 */
function shouldWriteFile(requestedPath, returnedPath) {
  if (!requestedPath) return false;
  const requestedDir = dirname(requestedPath);
  const returnedDir = dirname(returnedPath);
  if (requestedDir !== returnedDir) return false;

  const requestedStem = basename(requestedPath, extname(requestedPath));
  const returnedName = basename(returnedPath);
  if (returnedName === basename(requestedPath)) return true;
  return returnedName.startsWith(`${requestedStem}_`);
}

async function writeReturnedFiles(requestedPath, files) {
  const written = [];
  const skipped = [];
  if (!Array.isArray(files)) return { written, skipped };

  for (const file of files) {
    if (!file || typeof file.name !== 'string') continue;
    if (!shouldWriteFile(requestedPath, file.name)) {
      skipped.push(file.name);
      continue;
    }
    try {
      await mkdir(dirname(file.name), { recursive: true });
      if (file.encoding === 'base64' && typeof file.content === 'string') {
        await writeFile(file.name, Buffer.from(file.content, 'base64'));
      } else if (typeof file.content === 'string') {
        await writeFile(file.name, file.content, 'utf8');
      }
      written.push(file.name);
    } catch {
      skipped.push(file.name);
    }
  }
  return { written, skipped };
}

async function callDatasource(method, params, toolCallId) {
  const token = await resolveAccessToken();
  const url = apiUrl();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, params }),
  });

  const requestId = response.headers.get('x-request-id') ?? 'unknown';
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Datasource API returned non-JSON (HTTP ${response.status}): ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Datasource API error (HTTP ${response.status}): ${body.message ?? text}`);
  }

  const assistant = Array.isArray(body.result?.assistant) ? body.result.assistant : [];

  const trace = `[wukong-datasource] request-id: ${requestId} · tool-call-id: ${toolCallId ?? 'unknown'}`;

  const requestedPath = params && typeof params === 'object' ? params.filepath ?? params.params?.filepath : undefined;
  const { written, skipped } = await writeReturnedFiles(requestedPath, body.files);

  const parts = [];
  for (const item of assistant) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  if (written.length > 0 || skipped.length > 0) {
    const fileParts = [];
    if (written.length > 0) fileParts.push(`wrote ${written.length} file${written.length === 1 ? '' : 's'}`);
    if (skipped.length > 0) fileParts.push(`skipped returned file${skipped.length === 1 ? '' : 's'}`);
    parts.push(fileParts.join(', '));
  }
  parts.push(trace);

  const result = {
    content: [{ type: 'text', text: parts.join('\n') }],
  };
  if (body.is_success === false) {
    result.isError = true;
  }
  return result;
}

const TOOLS = [
  {
    name: 'call_data_source_tool',
    description: 'Call a tool exposed by a datasource.',
    inputSchema: {
      type: 'object',
      properties: {
        data_source_name: {
          type: 'string',
          description: 'The datasource name',
          enum: [...DATA_SOURCE_NAMES],
        },
        api_name: { type: 'string', description: 'The API name within the datasource' },
        params: { type: 'object', description: 'Tool-specific parameters' },
      },
      required: ['data_source_name', 'api_name', 'params'],
    },
  },
  {
    name: 'get_data_source_desc',
    description: 'Get the description of an available datasource.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The datasource name',
          enum: [...DATA_SOURCE_NAMES],
        },
      },
      required: ['name'],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'wukong-datasource', version: '1.0.0' } } });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolParams = params?.arguments ?? {};
    if (toolName !== 'get_data_source_desc' && toolName !== 'call_data_source_tool') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
      return;
    }

    void callDatasource(toolName, toolParams, id)
      .then((result) => {
        send({ jsonrpc: '2.0', id, result });
      })
      .catch((error) => {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          },
        });
      });
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.id !== 'number') return;
  handleRequest(message);
});
