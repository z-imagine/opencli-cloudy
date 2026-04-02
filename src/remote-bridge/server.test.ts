import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createRemoteBridgeServer } from './server.js';

describe('remote bridge server', () => {
  let server: ReturnType<typeof createRemoteBridgeServer>;

  beforeEach(async () => {
    server = createRemoteBridgeServer({ token: 'secret', port: 19866, logger: console });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('serves health and clients endpoint', async () => {
    const health = await fetch('http://127.0.0.1:19866/health');
    expect(health.ok).toBe(true);

    const clients = await fetch('http://127.0.0.1:19866/api/clients', {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(clients.ok).toBe(true);
    expect(await clients.json()).toEqual([]);
  });

  it('registers agent and routes a command', async () => {
    const ws = new WebSocket('ws://127.0.0.1:19866/agent');
    const registered = await new Promise<any>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'register',
          clientId: 'cli_browser_a',
          token: 'secret',
          extensionVersion: '1.0.0',
          browserInfo: 'Chrome Test',
          capabilities: { fileInputMemory: true, fileInputDisk: false },
        }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'registered') resolve(msg);
      });
      ws.once('error', reject);
    });

    const responsePromise = fetch('http://127.0.0.1:19866/api/command', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: registered.clientId,
        commandId: 'cmd-1',
        action: 'exec',
        payload: { code: '1 + 1' },
        timeoutMs: 3000,
      }),
    });

    const command = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.commandId === 'cmd-1') resolve(msg);
      });
    });

    expect(command.action).toBe('exec');
    ws.send(JSON.stringify({
      type: 'result',
      clientId: registered.clientId,
      commandId: 'cmd-1',
      ok: true,
      data: { title: 'ok' },
    }));

    const response = await responsePromise;
    expect(response.ok).toBe(true);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.data).toEqual({ title: 'ok' });
    ws.close();
  });

  it('keeps the same clientId when the extension reconnects', async () => {
    const register = async () => {
      const ws = new WebSocket('ws://127.0.0.1:19866/agent');
      const registered = await new Promise<any>((resolve, reject) => {
        ws.once('open', () => {
          ws.send(JSON.stringify({
            type: 'register',
            clientId: 'cli_browser_stable',
            token: 'secret',
            extensionVersion: '1.0.0',
            browserInfo: 'Chrome Test',
            capabilities: { fileInputMemory: true, fileInputDisk: false },
          }));
        });
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'registered') resolve({ ws, msg });
        });
        ws.once('error', reject);
      });
      return registered;
    };

    const first = await register();
    expect(first.msg.clientId).toBe('cli_browser_stable');
    first.ws.close();

    const second = await register();
    expect(second.msg.clientId).toBe('cli_browser_stable');

    const clients = await fetch('http://127.0.0.1:19866/api/clients', {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(await clients.json()).toEqual([
      expect.objectContaining({ clientId: 'cli_browser_stable' }),
    ]);
    second.ws.close();
  });
});
