/**
 * opencli browser protocol — shared types between extension and remote bridge.
 */

export type Action = 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot' | 'close-window' | 'sessions' | 'set-file-input' | 'set-file-input-remote' | 'bind-current';

export interface RemoteFileInputDescriptor {
  url: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface Command {
  /** Unique request ID */
  id: string;
  /** Action type */
  action: Action;
  /** Target tab ID (omit for active tab) */
  tabId?: number;
  /** JS code to evaluate in page context (exec action) */
  code?: string;
  /** Logical workspace for automation session reuse */
  workspace?: string;
  /** URL to navigate to (navigate action) */
  url?: string;
  /** Sub-operation for tabs: list, new, close, select */
  op?: 'list' | 'new' | 'close' | 'select';
  /** Tab index for tabs select/close */
  index?: number;
  /** Cookie domain filter */
  domain?: string;
  /** Optional hostname/domain to require for current-tab binding */
  matchDomain?: string;
  /** Optional pathname prefix to require for current-tab binding */
  matchPathPrefix?: string;
  /** Screenshot format: png (default) or jpeg */
  format?: 'png' | 'jpeg';
  /** JPEG quality (0-100), only for jpeg format */
  quality?: number;
  /** Whether to capture full page (not just viewport) */
  fullPage?: boolean;
  /** Local file paths for set-file-input action */
  files?: string[];
  /** Remote file descriptors for set-file-input-remote action */
  remoteFiles?: RemoteFileInputDescriptor[];
  /** CSS selector for file input element (set-file-input action) */
  selector?: string;
  /** Upload mode for remote file injection */
  mode?: 'memory' | 'disk';
  /** Warning threshold for in-memory injection */
  warnMemoryBytes?: number;
  /** Hard threshold for in-memory injection */
  hardMemoryBytes?: number;
}

export interface Result {
  /** Matching request ID */
  id: string;
  /** Whether the command succeeded */
  ok: boolean;
  /** Result data on success */
  data?: unknown;
  /** Error message on failure */
  error?: string;
}

export interface ExtensionConfig {
  backendUrl: string;
  token: string;
  clientId: string;
}

export function createClientId(): string {
  return `cli_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface StatusResponse extends ExtensionConfig {
  connected: boolean;
  reconnecting: boolean;
  state: ConnectionState;
  lastError?: string;
}

export interface RegisterMessage {
  type: 'register';
  clientId: string;
  token: string;
  extensionVersion?: string;
  browserInfo?: string;
  capabilities: {
    fileInputMemory: boolean;
    fileInputDisk: boolean;
    warnMemoryBytes: number;
    hardMemoryBytes: number;
  };
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

export interface RemoteCommandEnvelope {
  clientId: string;
  commandId: string;
  workspace?: string;
  action: Action;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}

export const DEFAULT_WARN_MEMORY_BYTES = 10 * 1024 * 1024;
export const DEFAULT_HARD_MEMORY_BYTES = 25 * 1024 * 1024;

/** Base reconnect delay for extension WebSocket (ms) */
export const WS_RECONNECT_BASE_DELAY = 2000;
/** Max reconnect delay (ms) */
export const WS_RECONNECT_MAX_DELAY = 60000;

export function normalizeBackendUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function toBridgeHealthUrl(raw: string): string {
  const normalized = normalizeBackendUrl(raw);
  const url = new URL(normalized);
  url.protocol = url.protocol === 'https:' ? 'https:' : 'http:';
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function toBridgeWebSocketUrl(raw: string): string {
  const normalized = normalizeBackendUrl(raw);
  const url = new URL(normalized);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/agent';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function isRegisteredMessage(value: unknown): value is RegisteredMessage {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return data.type === 'registered' && typeof data.clientId === 'string' && typeof data.serverTime === 'number';
}

export function isRemoteCommandEnvelope(value: unknown): value is RemoteCommandEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data.clientId === 'string'
    && typeof data.commandId === 'string'
    && typeof data.action === 'string';
}

export function commandFromEnvelope(envelope: RemoteCommandEnvelope): Command {
  const payload = envelope.payload ?? {};
  return {
    ...(payload as Partial<Command>),
    id: envelope.commandId,
    action: envelope.action,
    workspace: envelope.workspace,
  };
}
