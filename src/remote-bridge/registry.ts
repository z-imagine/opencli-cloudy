import type { WebSocket } from 'ws';
import type { ClientCapabilities, ClientRecord, ResultMessage } from './protocol.js';

export interface PendingCommand {
  clientId: string;
  resolve: (value: ResultMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ClientEntry extends ClientRecord {
  ws: WebSocket;
}

export class RemoteBridgeRegistry {
  private clients = new Map<string, ClientEntry>();
  private sockets = new Map<WebSocket, string>();
  private pending = new Map<string, PendingCommand>();
  private idCounter = 0;

  nextClientId(): string {
    this.idCounter += 1;
    return `cli_${Date.now().toString(36)}_${this.idCounter.toString(36)}`;
  }

  registerClient(ws: WebSocket, meta: {
    extensionVersion?: string;
    browserInfo?: string;
    capabilities: ClientCapabilities;
  }): ClientRecord {
    const existing = this.sockets.get(ws);
    if (existing) this.unregisterSocket(ws);

    const now = Date.now();
    const clientId = this.nextClientId();
    const entry: ClientEntry = {
      clientId,
      ws,
      connectedAt: now,
      lastSeenAt: now,
      extensionVersion: meta.extensionVersion,
      browserInfo: meta.browserInfo,
      capabilities: meta.capabilities,
    };
    this.clients.set(clientId, entry);
    this.sockets.set(ws, clientId);
    return this.toClientRecord(entry);
  }

  touchClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastSeenAt = Date.now();
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  getSocket(clientId: string): WebSocket | undefined {
    return this.clients.get(clientId)?.ws;
  }

  listClients(): ClientRecord[] {
    return [...this.clients.values()]
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map((entry) => this.toClientRecord(entry));
  }

  unregisterSocket(ws: WebSocket): void {
    const clientId = this.sockets.get(ws);
    if (!clientId) return;
    this.sockets.delete(ws);
    this.clients.delete(clientId);
    for (const [commandId, pending] of this.pending.entries()) {
      if (pending.clientId !== clientId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Client disconnected: ${clientId}`));
      this.pending.delete(commandId);
    }
  }

  addPending(commandId: string, pending: PendingCommand): void {
    this.pending.set(commandId, pending);
  }

  settlePending(result: ResultMessage): boolean {
    const pending = this.pending.get(result.commandId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(result.commandId);
    pending.resolve(result);
    return true;
  }

  rejectPending(commandId: string, error: Error): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    pending.reject(error);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private toClientRecord(entry: ClientEntry): ClientRecord {
    return {
      clientId: entry.clientId,
      connectedAt: entry.connectedAt,
      lastSeenAt: entry.lastSeenAt,
      extensionVersion: entry.extensionVersion,
      browserInfo: entry.browserInfo,
      capabilities: entry.capabilities,
    };
  }
}
