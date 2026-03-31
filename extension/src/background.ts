/**
 * OpenCLI — Service Worker (background script).
 *
 * Connects to the remote bridge via WebSocket, receives commands,
 * dispatches them to Chrome APIs (debugger/tabs/cookies), returns results.
 */

import type {
  Command,
  ConnectionState,
  ExtensionConfig,
  RegisterMessage,
  RemoteCommandEnvelope,
  Result,
  StatusResponse,
} from './protocol';
import {
  DEFAULT_HARD_MEMORY_BYTES,
  DEFAULT_WARN_MEMORY_BYTES,
  WS_RECONNECT_BASE_DELAY,
  WS_RECONNECT_MAX_DELAY,
  commandFromEnvelope,
  isRegisteredMessage,
  isRemoteCommandEnvelope,
  normalizeBackendUrl,
  toBridgeHealthUrl,
  toBridgeWebSocketUrl,
} from './protocol';
import * as executor from './cdp';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let connectionState: ConnectionState = 'disconnected';
let lastError = '';

const STORAGE_KEY_BACKEND_URL = 'backendUrl';
const STORAGE_KEY_TOKEN = 'token';
const STORAGE_KEY_CLIENT_ID = 'clientId';
const CONFIG_STORAGE_KEYS = [STORAGE_KEY_BACKEND_URL, STORAGE_KEY_TOKEN, STORAGE_KEY_CLIENT_ID] as const;
const HEARTBEAT_ALARM = 'keepalive';
const configCache: ExtensionConfig = {
  backendUrl: '',
  token: '',
  clientId: '',
};

async function hydrateConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEYS);
  configCache.backendUrl = typeof stored.backendUrl === 'string' ? normalizeBackendUrl(stored.backendUrl) : '';
  configCache.token = typeof stored.token === 'string' ? stored.token.trim() : '';
  configCache.clientId = typeof stored.clientId === 'string' ? stored.clientId : '';
  return { ...configCache };
}

async function persistConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const next: ExtensionConfig = {
    backendUrl: patch.backendUrl !== undefined ? normalizeBackendUrl(patch.backendUrl) : configCache.backendUrl,
    token: patch.token !== undefined ? patch.token.trim() : configCache.token,
    clientId: patch.clientId !== undefined ? patch.clientId : configCache.clientId,
  };
  await chrome.storage.local.set(next);
  configCache.backendUrl = next.backendUrl;
  configCache.token = next.token;
  configCache.clientId = next.clientId;
  return { ...next };
}

function hasRemoteBridgeConfig(): boolean {
  return configCache.backendUrl.length > 0 && configCache.token.length > 0;
}

function setConnectionState(state: ConnectionState, error = ''): void {
  connectionState = state;
  lastError = error;
}

async function getStatusPayload(): Promise<StatusResponse> {
  await hydrateConfig();
  return {
    ...configCache,
    connected: ws?.readyState === WebSocket.OPEN,
    reconnecting: reconnectTimer !== null,
    state: connectionState,
    lastError: lastError || undefined,
  };
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function disconnectSocket(): void {
  clearReconnectTimer();
  if (!ws) {
    setConnectionState('disconnected');
    return;
  }
  const current = ws;
  ws = null;
  current.onopen = null;
  current.onmessage = null;
  current.onclose = null;
  current.onerror = null;
  try {
    current.close();
  } catch {
    // ignore close failures during reconfigure
  }
  setConnectionState('disconnected');
}

function buildRegisterMessage(): RegisterMessage {
  return {
    type: 'register',
    token: configCache.token,
    extensionVersion: chrome.runtime.getManifest().version,
    browserInfo: typeof navigator?.userAgent === 'string' ? navigator.userAgent : 'unknown',
    capabilities: {
      fileInputMemory: true,
      fileInputDisk: false,
      warnMemoryBytes: DEFAULT_WARN_MEMORY_BYTES,
      hardMemoryBytes: DEFAULT_HARD_MEMORY_BYTES,
    },
  };
}

// ─── Console log forwarding ──────────────────────────────────────────
// Keep console overrides local. Remote bridge protocol currently does not
// accept log frames, so this is intentionally a no-op for network traffic.

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  void level;
  void args;
}

console.log = (...args: unknown[]) => { _origLog(...args); forwardLog('info', args); };
console.warn = (...args: unknown[]) => { _origWarn(...args); forwardLog('warn', args); };
console.error = (...args: unknown[]) => { _origError(...args); forwardLog('error', args); };

// ─── WebSocket connection ────────────────────────────────────────────

async function connect(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  await hydrateConfig();
  if (!hasRemoteBridgeConfig()) {
    setConnectionState('disconnected');
    return;
  }

  setConnectionState('connecting');

  const healthUrl = toBridgeHealthUrl(configCache.backendUrl);
  const wsUrl = toBridgeWebSocketUrl(configCache.backendUrl);

  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) {
      setConnectionState('disconnected', `Bridge health check failed: ${res.status}`);
      scheduleReconnect();
      return;
    }
  } catch {
    setConnectionState('disconnected', 'Bridge is unreachable');
    scheduleReconnect();
    return;
  }

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    setConnectionState('disconnected', 'Failed to create bridge WebSocket');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[opencli] Connected to remote bridge');
    clearReconnectTimer();
    ws?.send(JSON.stringify(buildRegisterMessage()));
  };

  ws.onmessage = async (event) => {
    try {
      await handleBridgeMessage(event.data as string);
    } catch (err) {
      console.error('[opencli] Message handling error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[opencli] Disconnected from remote bridge');
    ws = null;
    reconnectAttempts = 0;
    void persistConfig({ clientId: '' });
    setConnectionState('disconnected', 'Bridge connection closed');
    scheduleReconnect();
  };

  ws.onerror = () => {
    setConnectionState('disconnected', 'Bridge WebSocket error');
    ws?.close();
  };
}

async function handleBridgeMessage(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as unknown;
  if (isRegisteredMessage(parsed)) {
    reconnectAttempts = 0;
    await persistConfig({ clientId: parsed.clientId });
    setConnectionState('connected');
    console.log(`[opencli] Registered with remote bridge as ${parsed.clientId}`);
    return;
  }
  if (isRemoteCommandEnvelope(parsed)) {
    const envelope = parsed as RemoteCommandEnvelope;
    if (configCache.clientId && envelope.clientId !== configCache.clientId) {
      throw new Error(`Client mismatch: expected ${configCache.clientId}, got ${envelope.clientId}`);
    }
    const command = commandFromEnvelope(envelope);
    const result = await handleCommand(command);
    ws?.send(JSON.stringify({
      type: 'result',
      clientId: envelope.clientId,
      commandId: envelope.commandId,
      ok: result.ok,
      data: result.data,
      error: result.error,
    }));
    return;
  }
  throw new Error('Unsupported bridge message');
}

/**
 * After MAX_EAGER_ATTEMPTS (reaching 60s backoff), stop scheduling reconnects.
 * The keepalive alarm (~24s) will still call connect() periodically.
 */
const MAX_EAGER_ATTEMPTS = 6; // 2s, 4s, 8s, 16s, 32s, 60s — then stop

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return; // let keepalive alarm handle it
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function sendHeartbeat(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !configCache.clientId) return;
  ws.send(JSON.stringify({
    type: 'heartbeat',
    clientId: configCache.clientId,
    ts: Date.now(),
  }));
}

// ─── Automation window isolation ─────────────────────────────────────
// All opencli operations happen in a dedicated Chrome window so the
// user's active browsing session is never touched.
// The window auto-closes after 120s of idle (no commands).

type AutomationSession = {
  windowId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
  owned: boolean;
  preferredTabId: number | null;
};

const automationSessions = new Map<string, AutomationSession>();
const WINDOW_IDLE_TIMEOUT = 30000; // 30s — quick cleanup after command finishes

function getWorkspaceKey(workspace?: string): string {
  return workspace?.trim() || 'default';
}

function resetWindowIdleTimer(workspace: string): void {
  const session = automationSessions.get(workspace);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;
  session.idleTimer = setTimeout(async () => {
    const current = automationSessions.get(workspace);
    if (!current) return;
    if (!current.owned) {
      console.log(`[opencli] Borrowed workspace ${workspace} detached from window ${current.windowId} (idle timeout)`);
      automationSessions.delete(workspace);
      return;
    }
    try {
      await chrome.windows.remove(current.windowId);
      console.log(`[opencli] Automation window ${current.windowId} (${workspace}) closed (idle timeout)`);
    } catch {
      // Already gone
    }
    automationSessions.delete(workspace);
  }, WINDOW_IDLE_TIMEOUT);
}

/** Get or create the dedicated automation window. */
async function getAutomationWindow(workspace: string): Promise<number> {
  // Check if our window is still alive
  const existing = automationSessions.get(workspace);
  if (existing) {
    try {
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      // Window was closed by user
      automationSessions.delete(workspace);
    }
  }

  // Create a new window with a data: URI that New Tab Override extensions cannot intercept.
  // Using about:blank would be hijacked by extensions like "New Tab Override".
  // Note: Do NOT set `state` parameter here. Chrome 146+ rejects 'normal' as an invalid
  // state value for windows.create(). The window defaults to 'normal' state anyway.
  const win = await chrome.windows.create({
    url: BLANK_PAGE,
    focused: false,
    width: 1280,
    height: 900,
    type: 'normal',
  });
  const session: AutomationSession = {
    windowId: win.id!,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
    owned: true,
    preferredTabId: null,
  };
  automationSessions.set(workspace, session);
  console.log(`[opencli] Created automation window ${session.windowId} (${workspace})`);
  resetWindowIdleTimer(workspace);
  // Brief delay to let Chrome load the initial data: URI tab
  await new Promise(resolve => setTimeout(resolve, 200));
  return session.windowId;
}

// Clean up when the automation window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[opencli] Automation window closed (${workspace})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
    }
  }
});

// ─── Lifecycle events ────────────────────────────────────────────────

let initialized = false;

function initialize(): void {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.4 }); // ~24 seconds
  executor.registerListeners();
  void hydrateConfig().then(() => connect());
  console.log('[opencli] OpenCLI extension initialized');
}

void hydrateConfig();

async function saveRemoteBridgeConfig(backendUrl: string, token: string): Promise<StatusResponse> {
  disconnectSocket();
  reconnectAttempts = 0;
  await persistConfig({
    backendUrl,
    token,
    clientId: '',
  });
  if (hasRemoteBridgeConfig()) {
    await connect();
  } else {
    setConnectionState('disconnected');
  }
  return getStatusPayload();
}

function isRuntimeMessage(value: unknown): value is { type: string; backendUrl?: string; token?: string } {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isRuntimeMessage(msg)) return false;
  if (msg.type === 'getStatus') {
    void getStatusPayload().then(sendResponse);
    return true;
  }
  if (msg.type === 'saveConfig') {
    void saveRemoteBridgeConfig(typeof msg.backendUrl === 'string' ? msg.backendUrl : '', typeof msg.token === 'string' ? msg.token : '')
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  if (ws?.readyState === WebSocket.OPEN) {
    sendHeartbeat();
    return;
  }
  void connect();
});

// ─── Command dispatcher ─────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  const workspace = getWorkspaceKey(cmd.workspace);
  // Reset idle timer on every command (window stays alive while active)
  resetWindowIdleTimer(workspace);
  try {
    switch (cmd.action) {
      case 'exec':
        return await handleExec(cmd, workspace);
      case 'navigate':
        return await handleNavigate(cmd, workspace);
      case 'tabs':
        return await handleTabs(cmd, workspace);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        return await handleScreenshot(cmd, workspace);
      case 'close-window':
        return await handleCloseWindow(cmd, workspace);
      case 'sessions':
        return await handleSessions(cmd);
      case 'set-file-input':
        return await handleSetFileInput(cmd, workspace);
      case 'bind-current':
        return await handleBindCurrent(cmd, workspace);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Action handlers ─────────────────────────────────────────────────

/** Internal blank page used when no user URL is provided. */
const BLANK_PAGE = 'data:text/html,<html></html>';

/** Check if a URL can be attached via CDP — only allow http(s) and our internal blank page. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === BLANK_PAGE;
}

/** Check if a URL is safe for user-facing navigation (http/https only). */
function isSafeNavigationUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Minimal URL normalization for same-page comparison: root slash + default port only. */
function normalizeUrlForComparison(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isTargetUrl(currentUrl: string | undefined, targetUrl: string): boolean {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}

function matchesDomain(url: string | undefined, domain: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function matchesBindCriteria(tab: chrome.tabs.Tab, cmd: Command): boolean {
  if (!tab.id || !isDebuggableUrl(tab.url)) return false;
  if (cmd.matchDomain && !matchesDomain(tab.url, cmd.matchDomain)) return false;
  if (cmd.matchPathPrefix) {
    try {
      const parsed = new URL(tab.url!);
      if (!parsed.pathname.startsWith(cmd.matchPathPrefix)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isNotebooklmWorkspace(workspace: string): boolean {
  return workspace === 'site:notebooklm';
}

function classifyNotebooklmUrl(url?: string): 'notebook' | 'home' | 'other' {
  if (!url) return 'other';
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'notebooklm.google.com') return 'other';
    return parsed.pathname.startsWith('/notebook/') ? 'notebook' : 'home';
  } catch {
    return 'other';
  }
}

function scoreWorkspaceTab(workspace: string, tab: chrome.tabs.Tab): number {
  if (!tab.id || !isDebuggableUrl(tab.url)) return -1;
  if (isNotebooklmWorkspace(workspace)) {
    const kind = classifyNotebooklmUrl(tab.url);
    if (kind === 'other') return -1;
    if (kind === 'notebook') return tab.active ? 400 : 300;
    return tab.active ? 200 : 100;
  }
  return -1;
}

function setWorkspaceSession(workspace: string, session: Omit<AutomationSession, 'idleTimer' | 'idleDeadlineAt'>): void {
  const existing = automationSessions.get(workspace);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  automationSessions.set(workspace, {
    ...session,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
  });
}

async function maybeBindWorkspaceToExistingTab(workspace: string): Promise<number | null> {
  if (!isNotebooklmWorkspace(workspace)) return null;
  const tabs = await chrome.tabs.query({});
  let bestTab: chrome.tabs.Tab | null = null;
  let bestScore = -1;
  for (const tab of tabs) {
    const score = scoreWorkspaceTab(workspace, tab);
    if (score > bestScore) {
      bestScore = score;
      bestTab = tab;
    }
  }
  if (!bestTab?.id || bestScore < 0) return null;
  setWorkspaceSession(workspace, {
    windowId: bestTab.windowId,
    owned: false,
    preferredTabId: bestTab.id,
  });
  console.log(`[opencli] Workspace ${workspace} bound to existing tab ${bestTab.id} in window ${bestTab.windowId}`);
  resetWindowIdleTimer(workspace);
  return bestTab.id;
}

/**
 * Resolve target tab in the automation window.
 * If explicit tabId is given, use that directly.
 * Otherwise, find or create a tab in the dedicated automation window.
 */
async function resolveTabId(tabId: number | undefined, workspace: string): Promise<number> {
  // Even when an explicit tabId is provided, validate it is still debuggable.
  // This prevents issues when extensions hijack the tab URL to chrome-extension://
  // or when the tab has been closed by the user.
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = automationSessions.get(workspace);
      const matchesSession = session
        ? (session.preferredTabId !== null ? session.preferredTabId === tabId : tab.windowId === session.windowId)
        : false;
      if (isDebuggableUrl(tab.url) && matchesSession) return tabId;
      if (session && !matchesSession) {
        console.warn(`[opencli] Tab ${tabId} is not bound to workspace ${workspace}, re-resolving`);
      } else if (!isDebuggableUrl(tab.url)) {
        // Tab exists but URL is not debuggable — fall through to auto-resolve
        console.warn(`[opencli] Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`);
      }
    } catch {
      // Tab was closed — fall through to auto-resolve
      console.warn(`[opencli] Tab ${tabId} no longer exists, re-resolving`);
    }
  }

  const adoptedTabId = await maybeBindWorkspaceToExistingTab(workspace);
  if (adoptedTabId !== null) return adoptedTabId;

  const existingSession = automationSessions.get(workspace);
  if (existingSession && existingSession.preferredTabId !== null) {
    try {
      const preferredTab = await chrome.tabs.get(existingSession.preferredTabId);
      if (isDebuggableUrl(preferredTab.url)) return preferredTab.id!;
    } catch {
      automationSessions.delete(workspace);
    }
  }

  // Get (or create) the automation window
  const windowId = await getAutomationWindow(workspace);

  // Prefer an existing debuggable tab
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find(t => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id) return debuggableTab.id;

  // No debuggable tab — another extension may have hijacked the tab URL.
  // Try to reuse by navigating to a data: URI (not interceptable by New Tab Override).
  const reuseTab = tabs.find(t => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return reuseTab.id;
      console.warn(`[opencli] data: URI was intercepted (${updated.url}), creating fresh tab`);
    } catch {
      // Tab was closed during navigation
    }
  }

  // Fallback: create a new tab
  const newTab = await chrome.tabs.create({ windowId, url: BLANK_PAGE, active: true });
  if (!newTab.id) throw new Error('Failed to create tab in automation window');
  return newTab.id;
}

async function listAutomationTabs(workspace: string): Promise<chrome.tabs.Tab[]> {
  const session = automationSessions.get(workspace);
  if (!session) return [];
  if (session.preferredTabId !== null) {
    try {
      return [await chrome.tabs.get(session.preferredTabId)];
    } catch {
      automationSessions.delete(workspace);
      return [];
    }
  }
  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(workspace);
    return [];
  }
}

async function listAutomationWebTabs(workspace: string): Promise<chrome.tabs.Tab[]> {
  const tabs = await listAutomationTabs(workspace);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}

async function handleExec(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await executor.evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleNavigate(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);

  const beforeTab = await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  // Fast-path: tab is already at the target URL and fully loaded.
  if (beforeTab.status === 'complete' && isTargetUrl(beforeTab.url, targetUrl)) {
    return {
      id: cmd.id,
      ok: true,
      data: { title: beforeTab.title, url: beforeTab.url, tabId, timedOut: false },
    };
  }

  // Detach any existing debugger before top-level navigation.
  // Some sites (observed on creator.xiaohongshu.com flows) can invalidate the
  // current inspected target during navigation, which leaves a stale CDP attach
  // state and causes the next Runtime.evaluate to fail with
  // "Inspected target navigated or closed". Resetting here forces a clean
  // re-attach after navigation.
  await executor.detach(tabId);

  await chrome.tabs.update(tabId, { url: targetUrl });

  // Wait until navigation completes. Resolve when status is 'complete' AND either:
  // - the URL matches the target (handles same-URL / canonicalized navigations), OR
  // - the URL differs from the pre-navigation URL (handles redirects).
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const isNavigationDone = (url: string | undefined): boolean => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isNavigationDone(tab.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Also check if the tab already navigated (e.g. instant cache hit)
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === 'complete' && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch { /* tab gone */ }
    }, 100);

    // Timeout fallback with warning
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[opencli] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15000);
  });

  const tab = await chrome.tabs.get(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut },
  };
}

async function handleTabs(cmd: Command, workspace: string): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      const tabs = await listAutomationWebTabs(workspace);
      const data = tabs
        .map((t, i) => ({
          index: i,
          tabId: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
        }));
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
      }
      const windowId = await getAutomationWindow(workspace);
      const tab = await chrome.tabs.create({ windowId, url: cmd.url ?? BLANK_PAGE, active: true });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case 'close': {
      if (cmd.index !== undefined) {
        const tabs = await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        await chrome.tabs.remove(target.id);
        await executor.detach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      await executor.detach(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case 'select': {
      if (cmd.index === undefined && cmd.tabId === undefined)
        return { id: cmd.id, ok: false, error: 'Missing index or tabId' };
      if (cmd.tabId !== undefined) {
        const session = automationSessions.get(workspace);
        let tab: chrome.tabs.Tab;
        try {
          tab = await chrome.tabs.get(cmd.tabId);
        } catch {
          return { id: cmd.id, ok: false, error: `Tab ${cmd.tabId} no longer exists` };
        }
        if (!session || tab.windowId !== session.windowId) {
          return { id: cmd.id, ok: false, error: `Tab ${cmd.tabId} is not in the automation window` };
        }
        await chrome.tabs.update(cmd.tabId, { active: true });
        return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
      }
      const tabs = await listAutomationWebTabs(workspace);
      const target = tabs[cmd.index!];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: 'Cookie scope required: provide domain or url to avoid dumping all cookies' };
  }
  const details: chrome.cookies.GetAllDetails = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(cmd: Command, workspace: string): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleCloseWindow(cmd: Command, workspace: string): Promise<Result> {
  const session = automationSessions.get(workspace);
  if (session) {
    if (session.owned) {
      try {
        await chrome.windows.remove(session.windowId);
      } catch {
        // Window may already be closed
      }
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}

async function handleSetFileInput(cmd: Command, workspace: string): Promise<Result> {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: 'Missing or empty files array' };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    await executor.setFileInputFiles(tabId, cmd.files, cmd.selector);
    return { id: cmd.id, ok: true, data: { count: cmd.files.length } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleSessions(cmd: Command): Promise<Result> {
  const now = Date.now();
  const data = await Promise.all([...automationSessions.entries()].map(async ([workspace, session]) => ({
    workspace,
    windowId: session.windowId,
    tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((tab) => isDebuggableUrl(tab.url)).length,
    idleMsRemaining: Math.max(0, session.idleDeadlineAt - now),
  })));
  return { id: cmd.id, ok: true, data };
}

async function handleBindCurrent(cmd: Command, workspace: string): Promise<Result> {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallbackTabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const allTabs = await chrome.tabs.query({});
  const boundTab = activeTabs.find((tab) => matchesBindCriteria(tab, cmd))
    ?? fallbackTabs.find((tab) => matchesBindCriteria(tab, cmd))
    ?? allTabs.find((tab) => matchesBindCriteria(tab, cmd));
  if (!boundTab?.id) {
    return {
      id: cmd.id,
      ok: false,
      error: cmd.matchDomain || cmd.matchPathPrefix
        ? `No visible tab matching ${cmd.matchDomain ?? 'domain'}${cmd.matchPathPrefix ? ` ${cmd.matchPathPrefix}` : ''}`
        : 'No active debuggable tab found',
    };
  }

  setWorkspaceSession(workspace, {
    windowId: boundTab.windowId,
    owned: false,
    preferredTabId: boundTab.id,
  });
  resetWindowIdleTimer(workspace);
  console.log(`[opencli] Workspace ${workspace} explicitly bound to tab ${boundTab.id} (${boundTab.url})`);
  return {
    id: cmd.id,
    ok: true,
    data: {
      tabId: boundTab.id,
      windowId: boundTab.windowId,
      url: boundTab.url,
      title: boundTab.title,
      workspace,
    },
  };
}

export const __test__ = {
  getStatusPayload,
  handleBridgeMessage,
  saveRemoteBridgeConfig,
  handleNavigate,
  isTargetUrl,
  handleTabs,
  handleSessions,
  handleBindCurrent,
  resolveTabId,
  resetWindowIdleTimer,
  getSession: (workspace: string = 'default') => automationSessions.get(workspace) ?? null,
  getAutomationWindowId: (workspace: string = 'default') => automationSessions.get(workspace)?.windowId ?? null,
  setAutomationWindowId: (workspace: string, windowId: number | null) => {
    if (windowId === null) {
      const session = automationSessions.get(workspace);
      if (session?.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
      return;
    }
    setWorkspaceSession(workspace, {
      windowId,
      owned: true,
      preferredTabId: null,
    });
  },
  setSession: (workspace: string, session: { windowId: number; owned: boolean; preferredTabId: number | null }) => {
    setWorkspaceSession(workspace, session);
  },
  setConnectionState,
  setClientId: async (clientId: string) => persistConfig({ clientId }),
};
