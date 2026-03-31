import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { extractBearerToken, isAuthorizedToken } from './auth.js';
import { RemoteBridgeRegistry } from './registry.js';
import {
  DEFAULT_REMOTE_BRIDGE_PORT,
  parseAgentMessage,
  parseCommandEnvelope,
  type CommandEnvelope,
  type RegisteredMessage,
  type ResultMessage,
} from './protocol.js';

export interface RemoteBridgeServerOptions {
  token: string;
  port?: number;
  logger?: Pick<Console, 'log' | 'error' | 'warn'>;
}

export interface RemoteBridgeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  readonly registry: RemoteBridgeRegistry;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendCommandToClient(ws: WebSocket, envelope: CommandEnvelope): void {
  ws.send(JSON.stringify(envelope));
}

export function createRemoteBridgeServer(options: RemoteBridgeServerOptions): RemoteBridgeServer {
  const logger = options.logger ?? console;
  const port = options.port ?? DEFAULT_REMOTE_BRIDGE_PORT;
  const registry = new RemoteBridgeRegistry();

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/agent' });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && pathname === '/health') {
      json(res, 200, { ok: true, clients: registry.listClients().length, pending: registry.pendingCount() });
      return;
    }

    const bearer = extractBearerToken(req.headers.authorization);
    if (!isAuthorizedToken(bearer, options.token)) {
      json(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/clients') {
      json(res, 200, registry.listClients());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/command') {
      try {
        const envelope = parseCommandEnvelope(await readJson(req));
        const ws = registry.getSocket(envelope.clientId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          json(res, 404, { ok: false, error: `Client not found: ${envelope.clientId}` });
          return;
        }

        const timeoutMs = envelope.timeoutMs ?? 30000;
        const result = await new Promise<ResultMessage>((resolve, reject) => {
          const timer = setTimeout(() => {
            registry.rejectPending(envelope.commandId, new Error(`Command timeout (${timeoutMs}ms)`));
          }, timeoutMs);
          registry.addPending(envelope.commandId, {
            clientId: envelope.clientId,
            resolve,
            reject,
            timer,
          });
          sendCommandToClient(ws, envelope);
        });

        json(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request';
        json(res, 400, { ok: false, error: message });
      }
      return;
    }

    json(res, 404, { ok: false, error: 'Not found' });
  }

  wss.on('connection', (ws) => {
    logger.log('[remote-bridge] agent connected');

    ws.on('message', (raw: RawData) => {
      void handleAgentMessage(ws, raw);
    });

    ws.on('close', () => {
      registry.unregisterSocket(ws);
      logger.log('[remote-bridge] agent disconnected');
    });
  });

  async function handleAgentMessage(ws: WebSocket, raw: RawData): Promise<void> {
    try {
      const msg = parseAgentMessage(raw.toString());
      if (msg.type === 'register') {
        if (!isAuthorizedToken(msg.token, options.token)) {
          ws.close(4001, 'Unauthorized');
          return;
        }
        const record = registry.registerClient(ws, {
          extensionVersion: msg.extensionVersion,
          browserInfo: msg.browserInfo,
          capabilities: msg.capabilities,
        });
        const response: RegisteredMessage = {
          type: 'registered',
          clientId: record.clientId,
          serverTime: Date.now(),
        };
        ws.send(JSON.stringify(response));
        logger.log(`[remote-bridge] registered client ${record.clientId}`);
        return;
      }

      if (msg.type === 'heartbeat') {
        registry.touchClient(msg.clientId);
        return;
      }

      if (msg.type === 'result') {
        registry.touchClient(msg.clientId);
        registry.settlePending(msg);
      }
    } catch (error) {
      logger.warn(`[remote-bridge] failed to handle agent message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    port,
    registry,
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          logger.log(`[remote-bridge] listening on http://127.0.0.1:${port}`);
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        for (const client of registry.listClients()) {
          const ws = registry.getSocket(client.clientId);
          ws?.close();
        }
        wss.close((wssErr) => {
          if (wssErr) {
            reject(wssErr);
            return;
          }
          server.close((serverErr) => {
            if (serverErr) reject(serverErr);
            else resolve();
          });
        });
      });
    },
  };
}
