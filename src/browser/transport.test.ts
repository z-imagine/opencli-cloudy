import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createRemoteBridgeServer } from '../remote-bridge/server.js';
import { listRemoteClients, RemoteBridgeTransport } from './transport.js';

describe('browser transport', () => {
  let server: ReturnType<typeof createRemoteBridgeServer>;
  const originalEnv = {
    OPENCLI_REMOTE_URL: process.env.OPENCLI_REMOTE_URL,
    OPENCLI_REMOTE_TOKEN: process.env.OPENCLI_REMOTE_TOKEN,
    OPENCLI_REMOTE_CLIENT: process.env.OPENCLI_REMOTE_CLIENT,
  };

  beforeEach(async () => {
    server = createRemoteBridgeServer({ token: 'secret', port: 19867, logger: console });
    await server.start();
    process.env.OPENCLI_REMOTE_URL = 'http://127.0.0.1:19867';
    process.env.OPENCLI_REMOTE_TOKEN = 'secret';
    delete process.env.OPENCLI_REMOTE_CLIENT;
  });

  afterEach(async () => {
    process.env.OPENCLI_REMOTE_URL = originalEnv.OPENCLI_REMOTE_URL;
    process.env.OPENCLI_REMOTE_TOKEN = originalEnv.OPENCLI_REMOTE_TOKEN;
    process.env.OPENCLI_REMOTE_CLIENT = originalEnv.OPENCLI_REMOTE_CLIENT;
    await server.stop();
  });

  it('lists remote clients', async () => {
    const ws = new WebSocket('ws://127.0.0.1:19867/agent');
    const registered = await new Promise<{ clientId: string }>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'register',
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

    process.env.OPENCLI_REMOTE_CLIENT = registered.clientId;
    const clients = await listRemoteClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].clientId).toBe(registered.clientId);
    ws.close();
  });

  it('sends commands through remote bridge transport', async () => {
    const ws = new WebSocket('ws://127.0.0.1:19867/agent');
    const registered = await new Promise<{ clientId: string }>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'register',
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

    process.env.OPENCLI_REMOTE_CLIENT = registered.clientId;
    const transport = new RemoteBridgeTransport();
    const responsePromise = transport.send('exec', { workspace: 'site:test', code: '1+1' });

    const command = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'exec') resolve(msg);
      });
    });

    expect(command.workspace).toBe('site:test');
    expect(command.payload.code).toBe('1+1');

    ws.send(JSON.stringify({
      type: 'result',
      clientId: registered.clientId,
      commandId: command.commandId,
      ok: true,
      data: { ok: 1 },
    }));

    await expect(responsePromise).resolves.toEqual({ ok: 1 });
    ws.close();
  });
});
