import { createServer, type Server } from 'node:http';

import {
  ChatProviderError,
  createOriginLockedFetch,
  providerRequestOrigin,
} from '../src';
import { afterEach, describe, expect, it, vi } from 'vitest';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    })));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP test server.');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('origin-locked provider requests', () => {
  it('rejects direct origin drift before invoking fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const guardedFetch = createOriginLockedFetch(
      { expectedOrigin: 'https://api.example.test/v1', redirect: 'error' },
      fetchImpl,
    );

    await expect(guardedFetch('https://other.example.test/v1/messages'))
      .rejects.toBeInstanceOf(ChatProviderError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forces redirect:error on the underlying fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('ok'));
    const guardedFetch = createOriginLockedFetch(
      { expectedOrigin: 'https://api.example.test/v1', redirect: 'error' },
      fetchImpl,
    );

    await guardedFetch('https://api.example.test/v1/messages', { redirect: 'follow' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/messages',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('does not resend a request body across an HTTP redirect', async () => {
    let redirectedRequests = 0;
    const secondOrigin = await listen(createServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200).end('unexpected');
    }));
    const firstOrigin = await listen(createServer((_request, response) => {
      response.writeHead(307, { location: `${secondOrigin}/capture` }).end();
    }));
    const guardedFetch = createOriginLockedFetch({
      expectedOrigin: firstOrigin,
      redirect: 'error',
    });

    await expect(guardedFetch(`${firstOrigin}/messages`, {
      method: 'POST',
      body: 'sensitive-review-subject',
    })).rejects.toThrow();
    expect(redirectedRequests).toBe(0);
  });

  it('normalizes an endpoint to its exact origin', () => {
    expect(providerRequestOrigin('https://api.example.test:443/v1/messages'))
      .toBe('https://api.example.test');
  });
});
