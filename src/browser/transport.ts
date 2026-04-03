import { sleep } from '../utils.js';
import { DEFAULT_DAEMON_PORT } from '../constants.js';
import type { RemoteFileInputDescriptor } from '../types.js';
import { ConfigError } from '../errors.js';

export interface BrowserTransport {
  send(action: string, payload?: Record<string, unknown>): Promise<unknown>;
}

export interface RemoteClientInfo {
  clientId: string;
  connectedAt: number;
  lastSeenAt: number;
  extensionVersion?: string;
  browserInfo?: string;
  capabilities?: Record<string, unknown>;
}

export interface DaemonCommand {
  id: string;
  action: 'exec' | 'navigate' | 'tabs' | 'cookies' | 'screenshot' | 'close-window' | 'sessions' | 'set-file-input' | 'set-file-input-remote' | 'bind-current';
  tabId?: number;
  code?: string;
  workspace?: string;
  url?: string;
  op?: string;
  index?: number;
  domain?: string;
  matchDomain?: string;
  matchPathPrefix?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  files?: string[];
  remoteFiles?: RemoteFileInputDescriptor[];
  selector?: string;
  mode?: 'memory' | 'disk';
  warnMemoryBytes?: number;
  hardMemoryBytes?: number;
}

interface DaemonResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface RemoteCommandResult {
  commandId?: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

let localIdCounter = 0;
let remoteIdCounter = 0;

function nextLocalId(): string {
  return `cmd_${Date.now()}_${++localIdCounter}`;
}

function nextRemoteId(): string {
  return `rcmd_${Date.now()}_${++remoteIdCounter}`;
}

function getDaemonUrl(): string {
  const port = parseInt(process.env.OPENCLI_DAEMON_PORT ?? String(DEFAULT_DAEMON_PORT), 10);
  return `http://127.0.0.1:${port}`;
}

function formatMissingRemoteParams(params: string[]): string {
  return params.map((param) => {
    switch (param) {
      case 'OPENCLI_REMOTE_URL':
        return '--remote-url / OPENCLI_REMOTE_URL';
      case 'OPENCLI_REMOTE_TOKEN':
        return '--token / OPENCLI_REMOTE_TOKEN';
      case 'OPENCLI_REMOTE_CLIENT':
        return '--client / OPENCLI_REMOTE_CLIENT';
      default:
        return param;
    }
  }).join(', ');
}

export function ensureRemoteBridgeRouting(requireClient: boolean): {
  baseUrl: string;
  token: string;
  clientId?: string;
} {
  const baseUrl = process.env.OPENCLI_REMOTE_URL?.trim() ?? '';
  const token = process.env.OPENCLI_REMOTE_TOKEN?.trim() ?? '';
  const clientId = process.env.OPENCLI_REMOTE_CLIENT?.trim() ?? '';
  const missing: string[] = [];

  if (!baseUrl) missing.push('OPENCLI_REMOTE_URL');
  if (!token) missing.push('OPENCLI_REMOTE_TOKEN');
  if (requireClient && !clientId) missing.push('OPENCLI_REMOTE_CLIENT');

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required Browser Bridge routing parameters: ${formatMissingRemoteParams(missing)}.`,
      requireClient
        ? 'Browser commands must include --remote-url, --token, and --client. If you do not know the clientId yet, run `opencli clients --remote-url <bridge-url> --token <token>` first.'
        : 'The clients command requires --remote-url and --token so it can query the Browser Bridge.',
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    token,
    clientId: requireClient ? clientId : undefined,
  };
}

function getRemoteBaseUrl(): string {
  return ensureRemoteBridgeRouting(false).baseUrl;
}

function getRemoteToken(): string {
  return ensureRemoteBridgeRouting(false).token;
}

function getRemoteClientId(): string {
  return ensureRemoteBridgeRouting(true).clientId!;
}

export class LocalDaemonTransport implements BrowserTransport {
  async send(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const maxRetries = 4;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const command: DaemonCommand = {
        id: nextLocalId(),
        action: action as DaemonCommand['action'],
        ...payload,
      };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(`${getDaemonUrl()}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-OpenCLI': '1' },
          body: JSON.stringify(command),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const result = (await res.json()) as DaemonResult;
        if (!result.ok) {
          const errMsg = result.error ?? '';
          const isTransient = errMsg.includes('Extension disconnected')
            || errMsg.includes('Extension not connected')
            || errMsg.includes('attach failed')
            || errMsg.includes('no longer exists');
          if (isTransient && attempt < maxRetries) {
            await sleep(1500);
            continue;
          }
          throw new Error(result.error ?? 'Daemon command failed');
        }
        return result.data;
      } catch (err) {
        const isRetryable = err instanceof TypeError
          || (err instanceof Error && err.name === 'AbortError');
        if (isRetryable && attempt < maxRetries) {
          await sleep(500);
          continue;
        }
        throw err;
      }
    }
    throw new Error('LocalDaemonTransport: max retries exhausted');
  }
}

export class RemoteBridgeTransport implements BrowserTransport {
  async send(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const workspace = typeof payload.workspace === 'string' ? payload.workspace : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(`${getRemoteBaseUrl()}/api/command`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getRemoteToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: getRemoteClientId(),
          commandId: nextRemoteId(),
          workspace,
          action,
          payload,
          timeoutMs: 30000,
        }),
        signal: controller.signal,
      });
      const result = (await response.json()) as RemoteCommandResult;
      if (!response.ok || !result.ok) {
        throw new Error(result.error ?? `Remote bridge request failed with status ${response.status}`);
      }
      return result.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function listRemoteClients(): Promise<RemoteClientInfo[]> {
  const response = await fetch(`${getRemoteBaseUrl()}/api/clients`, {
    headers: { Authorization: `Bearer ${getRemoteToken()}` },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? `Failed to list remote clients (${response.status})`);
  }
  const clients = await response.json() as unknown;
  return Array.isArray(clients) ? clients as RemoteClientInfo[] : [];
}

export function isRemoteBridgeConfigured(): boolean {
  return !!process.env.OPENCLI_REMOTE_URL
    && !!process.env.OPENCLI_REMOTE_TOKEN
    && !!process.env.OPENCLI_REMOTE_CLIENT;
}
