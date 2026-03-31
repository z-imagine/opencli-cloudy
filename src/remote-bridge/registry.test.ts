import { describe, expect, it, vi } from 'vitest';
import { RemoteBridgeRegistry } from './registry.js';

describe('RemoteBridgeRegistry', () => {
  it('registers and lists clients', () => {
    const registry = new RemoteBridgeRegistry();
    const ws = {} as any;
    const client = registry.registerClient(ws, {
      extensionVersion: '1.0.0',
      browserInfo: 'Chrome',
      capabilities: { fileInputMemory: true, fileInputDisk: false },
    });

    expect(client.clientId).toContain('cli_');
    expect(registry.hasClient(client.clientId)).toBe(true);
    expect(registry.listClients()).toHaveLength(1);
  });

  it('rejects pending commands on disconnect', () => {
    vi.useFakeTimers();
    const registry = new RemoteBridgeRegistry();
    const ws = {} as any;
    const client = registry.registerClient(ws, {
      capabilities: { fileInputMemory: true, fileInputDisk: false },
    });
    const reject = vi.fn();
    const resolve = vi.fn();
    registry.addPending('cmd1', {
      clientId: client.clientId,
      resolve,
      reject,
      timer: setTimeout(() => {}, 1000),
    });

    registry.unregisterSocket(ws);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(registry.pendingCount()).toBe(0);
    vi.useRealTimers();
  });
});
