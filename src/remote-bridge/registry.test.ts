import { describe, expect, it, vi } from 'vitest';
import { RemoteBridgeRegistry } from './registry.js';

describe('RemoteBridgeRegistry', () => {
  it('registers and lists clients', () => {
    const registry = new RemoteBridgeRegistry();
    const ws = {} as any;
    const client = registry.registerClient(ws, {
      clientId: 'cli_fixed_1',
      extensionVersion: '1.0.0',
      browserInfo: 'Chrome',
      capabilities: { fileInputMemory: true, fileInputDisk: false },
    });

    expect(client.clientId).toBe('cli_fixed_1');
    expect(registry.hasClient(client.clientId)).toBe(true);
    expect(registry.listClients()).toHaveLength(1);
  });

  it('rejects pending commands on disconnect', () => {
    vi.useFakeTimers();
    const registry = new RemoteBridgeRegistry();
    const ws = {} as any;
    const client = registry.registerClient(ws, {
      clientId: 'cli_fixed_2',
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

  it('reuses the same clientId when the browser reconnects', () => {
    const registry = new RemoteBridgeRegistry();
    const ws1 = {} as any;
    const ws2 = {} as any;

    const first = registry.registerClient(ws1, {
      clientId: 'cli_stable_1',
      capabilities: { fileInputMemory: true, fileInputDisk: false },
    });
    const second = registry.registerClient(ws2, {
      clientId: 'cli_stable_1',
      capabilities: { fileInputMemory: true, fileInputDisk: false },
    });

    expect(first.clientId).toBe('cli_stable_1');
    expect(second.clientId).toBe('cli_stable_1');
    expect(registry.listClients()).toHaveLength(1);
    expect(registry.getSocket('cli_stable_1')).toBe(ws2);
  });
});
