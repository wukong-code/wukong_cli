import { createServer } from 'node:http';

const MAX_REQUEST_BYTES = 1024 * 1024;

export async function createNativeSmokeProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end('not found');
        return;
      }
      const bodyText = await readRequestBody(request);
      const body = JSON.parse(bodyText);
      const smokeResponse = nativeSmokeResponse({
        authorization: request.headers.authorization,
        body,
        sequence: requests.length + 1,
      });
      requests.push(smokeResponse.record);
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: smokeResponse.responseId,
          object: 'response',
          status: 'completed',
          model: body.model,
          output: [{
            type: 'message',
            id: `message_${String(smokeResponse.sequence)}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: smokeResponse.text, annotations: [] }],
          }],
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      for (const event of smokeResponse.events) writeSse(response, event);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Native smoke provider did not bind an IPv4 port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

export function nativeSmokeResponse({ authorization, body, sequence }) {
  const responseId = `resp_native_smoke_${String(sequence)}`;
  const text = `native smoke response ${String(sequence)} 雪`;
  return {
    sequence,
    responseId,
    text,
    record: {
      authorization,
      model: body.model,
      stream: body.stream,
      body,
    },
    events: [
      {
        type: 'response.created',
        response: { id: responseId, status: 'in_progress' },
      },
      { type: 'response.output_text.delta', delta: text },
      {
        type: 'response.completed',
        response: {
          id: responseId,
          status: 'completed',
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        },
      },
    ],
  };
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('native smoke request too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeSse(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}
