export const DEFAULT_REMOTE_BRIDGE_PORT = 19826;

export interface ClientCapabilities {
  fileInputMemory: boolean;
  fileInputDisk: boolean;
  warnMemoryBytes?: number;
  hardMemoryBytes?: number;
}

export interface RegisterMessage {
  type: 'register';
  token: string;
  extensionVersion?: string;
  browserInfo?: string;
  capabilities: ClientCapabilities;
}

export interface RegisteredMessage {
  type: 'registered';
  clientId: string;
  serverTime: number;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  clientId: string;
  ts: number;
}

export interface ResultMessage {
  type: 'result';
  clientId: string;
  commandId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type AgentMessage = RegisterMessage | HeartbeatMessage | ResultMessage;

export interface CommandEnvelope {
  clientId: string;
  commandId: string;
  workspace?: string;
  action: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ClientRecord {
  clientId: string;
  connectedAt: number;
  lastSeenAt: number;
  extensionVersion?: string;
  browserInfo?: string;
  capabilities: ClientCapabilities;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseAgentMessage(raw: string): AgentMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new Error('Invalid agent message');
  }
  switch (parsed.type) {
    case 'register':
      if (typeof parsed.token !== 'string' || !isRecord(parsed.capabilities)) {
        throw new Error('Invalid register message');
      }
      return {
        type: 'register',
        token: parsed.token,
        extensionVersion: typeof parsed.extensionVersion === 'string' ? parsed.extensionVersion : undefined,
        browserInfo: typeof parsed.browserInfo === 'string' ? parsed.browserInfo : undefined,
        capabilities: {
          fileInputMemory: parsed.capabilities.fileInputMemory === true,
          fileInputDisk: parsed.capabilities.fileInputDisk === true,
          warnMemoryBytes: typeof parsed.capabilities.warnMemoryBytes === 'number' ? parsed.capabilities.warnMemoryBytes : undefined,
          hardMemoryBytes: typeof parsed.capabilities.hardMemoryBytes === 'number' ? parsed.capabilities.hardMemoryBytes : undefined,
        },
      };
    case 'heartbeat':
      if (typeof parsed.clientId !== 'string' || typeof parsed.ts !== 'number') {
        throw new Error('Invalid heartbeat message');
      }
      return { type: 'heartbeat', clientId: parsed.clientId, ts: parsed.ts };
    case 'result':
      if (typeof parsed.clientId !== 'string' || typeof parsed.commandId !== 'string' || typeof parsed.ok !== 'boolean') {
        throw new Error('Invalid result message');
      }
      return {
        type: 'result',
        clientId: parsed.clientId,
        commandId: parsed.commandId,
        ok: parsed.ok,
        data: parsed.data,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      };
    default:
      throw new Error(`Unsupported agent message type: ${parsed.type}`);
  }
}

export function parseCommandEnvelope(raw: unknown): CommandEnvelope {
  if (!isRecord(raw)) throw new Error('Invalid command payload');
  if (typeof raw.clientId !== 'string' || typeof raw.commandId !== 'string' || typeof raw.action !== 'string') {
    throw new Error('Invalid command payload');
  }
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  const timeoutMs = typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : undefined;
  return {
    clientId: raw.clientId,
    commandId: raw.commandId,
    workspace: typeof raw.workspace === 'string' ? raw.workspace : undefined,
    action: raw.action,
    payload,
    timeoutMs,
  };
}
