import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  captureProcessLivenessProof,
  probeProcessLiveness,
  validateProcessLivenessProof,
} from '../src/process-liveness-proof';

describe('process liveness proof', () => {
  it('distinguishes the exact live process from a reused pid', async () => {
    const proof = await captureProcessLivenessProof(42, {
      platform: 'linux',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('linux:Mon Jul 29 12:00:00 2026'),
    });

    expect(validateProcessLivenessProof(proof)).toBe(true);
    await expect(probeProcessLiveness(proof, {
      platform: 'linux',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('linux:Mon Jul 29 12:00:00 2026'),
    })).resolves.toBe('live');
    await expect(probeProcessLiveness(proof, {
      platform: 'linux',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('linux:Mon Jul 29 12:00:01 2026'),
    })).resolves.toBe('dead');
  });

  it('only reports dead from exact absence or a different start marker', async () => {
    const proof = await captureProcessLivenessProof(42, {
      platform: 'darwin',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('darwin:Mon Jul 29 12:00:00 2026'),
    });

    await expect(probeProcessLiveness(proof, {
      platform: 'darwin',
      processPresence: () => 'absent',
      readStartMarker: () => Promise.reject(new Error('must not read')),
    })).resolves.toBe('dead');
    await expect(probeProcessLiveness(proof, {
      platform: 'darwin',
      processPresence: () => 'unknown',
    })).resolves.toBe('unknown');
    await expect(probeProcessLiveness(proof, {
      platform: 'darwin',
      processPresence: () => 'present',
      readStartMarker: () => Promise.reject(new Error('ps failed')),
    })).resolves.toBe('unknown');
  });

  it('fails closed across platforms and rejects tampering', async () => {
    const proof = await captureProcessLivenessProof(42, {
      platform: 'linux',
      processPresence: () => 'present',
      readStartMarker: () => Promise.resolve('linux:start'),
    });

    await expect(probeProcessLiveness(proof, {
      platform: 'darwin',
    })).resolves.toBe('unknown');
    expect(validateProcessLivenessProof({
      ...proof,
      processId: 43,
    })).toBe(false);
    await expect(captureProcessLivenessProof(42, {
      platform: 'freebsd',
    })).rejects.toMatchObject({
      reasonCode: 'process_liveness_unsupported',
    });
  });

  it('binds a Windows proof to the exact creation FILETIME marker', async () => {
    const proof = await captureProcessLivenessProof(42, {
      platform: 'win32',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('win32:01dbdeadbeef0001'),
    });

    expect(validateProcessLivenessProof(proof)).toBe(true);
    await expect(probeProcessLiveness(proof, {
      platform: 'win32',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('win32:01dbdeadbeef0001'),
    })).resolves.toBe('live');
    await expect(probeProcessLiveness(proof, {
      platform: 'win32',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('win32:01dbdeadbeef0002'),
    })).resolves.toBe('dead');
    await expect(probeProcessLiveness(proof, {
      platform: 'linux',
      processPresence: () => 'present',
      readStartMarker: () =>
        Promise.resolve('win32:01dbdeadbeef0001'),
    })).resolves.toBe('unknown');
  });

  it.runIf(
    process.platform === 'darwin'
    || process.platform === 'linux'
    || process.platform === 'win32',
  )(
    'captures and probes the current real process',
    async () => {
      const proof = await captureProcessLivenessProof();
      expect(proof.processId).toBe(process.pid);
      await expect(probeProcessLiveness(proof)).resolves.toBe('live');
    },
  );

  it.runIf(process.platform === 'win32')(
    'proves a terminated real Windows process is dead',
    async () => {
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1_000)'],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      try {
        await once(child, 'spawn');
        if (child.pid === undefined) {
          throw new Error('The Windows child has no process id.');
        }
        const proof = await captureProcessLivenessProof(child.pid);
        child.kill();
        await once(child, 'exit');
        await expect(probeProcessLiveness(proof)).resolves.toBe('dead');
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
  );
});
