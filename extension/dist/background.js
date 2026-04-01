const DEFAULT_WARN_MEMORY_BYTES = 10 * 1024 * 1024;
const DEFAULT_HARD_MEMORY_BYTES = 25 * 1024 * 1024;
const WS_RECONNECT_BASE_DELAY = 2e3;
const WS_RECONNECT_MAX_DELAY = 6e4;
function normalizeBackendUrl(raw) {
  return raw.trim().replace(/\/+$/, "");
}
function toBridgeHealthUrl(raw) {
  const normalized = normalizeBackendUrl(raw);
  const url = new URL(normalized);
  url.protocol = url.protocol === "https:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}
function toBridgeWebSocketUrl(raw) {
  const normalized = normalizeBackendUrl(raw);
  const url = new URL(normalized);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/agent";
  url.search = "";
  url.hash = "";
  return url.toString();
}
function isRegisteredMessage(value) {
  if (typeof value !== "object" || value === null) return false;
  const data = value;
  return data.type === "registered" && typeof data.clientId === "string" && typeof data.serverTime === "number";
}
function isRemoteCommandEnvelope(value) {
  if (typeof value !== "object" || value === null) return false;
  const data = value;
  return typeof data.clientId === "string" && typeof data.commandId === "string" && typeof data.action === "string";
}
function commandFromEnvelope(envelope) {
  const payload = envelope.payload ?? {};
  return {
    ...payload,
    id: envelope.commandId,
    action: envelope.action,
    workspace: envelope.workspace
  };
}

const attached = /* @__PURE__ */ new Set();
const BLANK_PAGE$1 = "data:text/html,<html></html>";
function isDebuggableUrl$1(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === BLANK_PAGE$1;
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
function buildRemoteFileLimitError(bytes, hardMemoryBytes) {
  return `memory mode limit exceeded: ${formatBytes(bytes)} > ${formatBytes(hardMemoryBytes)}. disk mode reserved for future implementation`;
}
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
async function prepareRemoteFilesForInjection(payload, fetchImpl = fetch) {
  const declaredBytes = payload.remoteFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (declaredBytes > payload.hardMemoryBytes) {
    throw new Error(buildRemoteFileLimitError(declaredBytes, payload.hardMemoryBytes));
  }
  const warnings = [];
  if (declaredBytes > payload.warnMemoryBytes) {
    warnings.push(`memory mode warning threshold exceeded: ${formatBytes(declaredBytes)} > ${formatBytes(payload.warnMemoryBytes)}`);
  }
  const files = [];
  let actualBytes = 0;
  for (const remoteFile of payload.remoteFiles) {
    const response = await fetchImpl(remoteFile.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch remote file "${remoteFile.name}": HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    actualBytes += buffer.byteLength;
    if (actualBytes > payload.hardMemoryBytes) {
      throw new Error(buildRemoteFileLimitError(actualBytes, payload.hardMemoryBytes));
    }
    files.push({
      name: remoteFile.name,
      mimeType: remoteFile.mimeType,
      sizeBytes: buffer.byteLength,
      base64: arrayBufferToBase64(buffer)
    });
  }
  if (warnings.length === 0 && actualBytes > payload.warnMemoryBytes) {
    warnings.push(`memory mode warning threshold exceeded: ${formatBytes(actualBytes)} > ${formatBytes(payload.warnMemoryBytes)}`);
  }
  return {
    files,
    bytes: actualBytes,
    warnings
  };
}
function buildRemoteFileInjectionExpression(files, selector) {
  return `
    (async () => {
      const files = ${JSON.stringify(files)};
      const query = ${JSON.stringify(selector || 'input[type="file"]')};
      const input = document.querySelector(query);
      if (!input) {
        return { ok: false, error: \`No element found matching selector: \${query}\` };
      }
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') {
        return { ok: false, error: \`Target is not a file input: \${query}\` };
      }

      const dt = new DataTransfer();
      let totalBytes = 0;
      for (const file of files) {
        const binary = atob(file.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        totalBytes += bytes.byteLength;
        const blob = new Blob([bytes], { type: file.mimeType || 'application/octet-stream' });
        dt.items.add(new File([blob], file.name, { type: file.mimeType || 'application/octet-stream' }));
      }

      try {
        input.files = dt.files;
      } catch {
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: dt.files,
        });
      }

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, count: dt.files.length, bytes: totalBytes };
    })()
  `;
}
async function ensureAttached(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl$1(tab.url)) {
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? "unknown"}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Cannot debug tab")) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }
  if (attached.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true
      });
      return;
    } catch {
      attached.delete(tabId);
    }
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = msg.includes("chrome-extension://") ? ". Tip: another Chrome extension may be interfering — try disabling other extensions" : "";
    if (msg.includes("Another debugger is already attached")) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
      }
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch {
        throw new Error(`attach failed: ${msg}${hint}`);
      }
    } else {
      throw new Error(`attach failed: ${msg}${hint}`);
    }
  }
  attached.add(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  } catch {
  }
}
async function evaluate(tabId, expression) {
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
    throw new Error(errMsg);
  }
  return result.result?.value;
}
const evaluateAsync = evaluate;
async function screenshot(tabId, options = {}) {
  await ensureAttached(tabId);
  const format = options.format ?? "png";
  if (options.fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1
      });
    }
  }
  try {
    const params = { format };
    if (format === "jpeg" && options.quality !== void 0) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }
    const result = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", params);
    return result.data;
  } finally {
    if (options.fullPage) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {
      });
    }
  }
}
async function setFileInputFiles(tabId, files, selector) {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
  const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument");
  const query = selector || 'input[type="file"]';
  const result = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: query
  });
  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }
  await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
    files,
    nodeId: result.nodeId
  });
}
async function setRemoteFileInputFiles(tabId, payload) {
  await ensureAttached(tabId);
  const prepared = await prepareRemoteFilesForInjection(payload);
  const result = await evaluateAsync(
    tabId,
    buildRemoteFileInjectionExpression(prepared.files, payload.selector)
  );
  if (!result?.ok) {
    throw new Error(result?.error ?? "Remote file injection failed");
  }
  return {
    count: result.count ?? prepared.files.length,
    bytes: result.bytes ?? prepared.bytes,
    warnings: prepared.warnings.length > 0 ? prepared.warnings : void 0
  };
}
async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
  }
}
function registerListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl$1(info.url)) {
      await detach(tabId);
    }
  });
}

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectionState = "disconnected";
let lastError = "";
const STORAGE_KEY_BACKEND_URL = "backendUrl";
const STORAGE_KEY_TOKEN = "token";
const STORAGE_KEY_CLIENT_ID = "clientId";
const CONFIG_STORAGE_KEYS = [STORAGE_KEY_BACKEND_URL, STORAGE_KEY_TOKEN, STORAGE_KEY_CLIENT_ID];
const HEARTBEAT_ALARM = "keepalive";
const configCache = {
  backendUrl: "",
  token: "",
  clientId: ""
};
async function hydrateConfig() {
  const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEYS);
  configCache.backendUrl = typeof stored.backendUrl === "string" ? normalizeBackendUrl(stored.backendUrl) : "";
  configCache.token = typeof stored.token === "string" ? stored.token.trim() : "";
  configCache.clientId = typeof stored.clientId === "string" ? stored.clientId : "";
  return { ...configCache };
}
async function persistConfig(patch) {
  const next = {
    backendUrl: patch.backendUrl !== void 0 ? normalizeBackendUrl(patch.backendUrl) : configCache.backendUrl,
    token: patch.token !== void 0 ? patch.token.trim() : configCache.token,
    clientId: patch.clientId !== void 0 ? patch.clientId : configCache.clientId
  };
  await chrome.storage.local.set(next);
  configCache.backendUrl = next.backendUrl;
  configCache.token = next.token;
  configCache.clientId = next.clientId;
  return { ...next };
}
function hasRemoteBridgeConfig() {
  return configCache.backendUrl.length > 0 && configCache.token.length > 0;
}
function setConnectionState(state, error = "") {
  connectionState = state;
  lastError = error;
}
async function getStatusPayload() {
  await hydrateConfig();
  return {
    ...configCache,
    connected: ws?.readyState === WebSocket.OPEN,
    reconnecting: reconnectTimer !== null,
    state: connectionState,
    lastError: lastError || void 0
  };
}
function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}
function disconnectSocket() {
  clearReconnectTimer();
  if (!ws) {
    setConnectionState("disconnected");
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
  }
  setConnectionState("disconnected");
}
function buildRegisterMessage() {
  return {
    type: "register",
    token: configCache.token,
    extensionVersion: chrome.runtime.getManifest().version,
    browserInfo: typeof navigator?.userAgent === "string" ? navigator.userAgent : "unknown",
    capabilities: {
      fileInputMemory: true,
      fileInputDisk: false,
      warnMemoryBytes: DEFAULT_WARN_MEMORY_BYTES,
      hardMemoryBytes: DEFAULT_HARD_MEMORY_BYTES
    }
  };
}
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log = (...args) => {
  _origLog(...args);
};
console.warn = (...args) => {
  _origWarn(...args);
};
console.error = (...args) => {
  _origError(...args);
};
async function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  await hydrateConfig();
  if (!hasRemoteBridgeConfig()) {
    setConnectionState("disconnected");
    return;
  }
  setConnectionState("connecting");
  const healthUrl = toBridgeHealthUrl(configCache.backendUrl);
  const wsUrl = toBridgeWebSocketUrl(configCache.backendUrl);
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1e3) });
    if (!res.ok) {
      setConnectionState("disconnected", `Bridge health check failed: ${res.status}`);
      scheduleReconnect();
      return;
    }
  } catch {
    setConnectionState("disconnected", "Bridge is unreachable");
    scheduleReconnect();
    return;
  }
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    setConnectionState("disconnected", "Failed to create bridge WebSocket");
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    console.log("[opencli] Connected to remote bridge");
    clearReconnectTimer();
    ws?.send(JSON.stringify(buildRegisterMessage()));
  };
  ws.onmessage = async (event) => {
    try {
      await handleBridgeMessage(event.data);
    } catch (err) {
      console.error("[opencli] Message handling error:", err);
    }
  };
  ws.onclose = () => {
    console.log("[opencli] Disconnected from remote bridge");
    ws = null;
    reconnectAttempts = 0;
    setConnectionState("disconnected", "Bridge connection closed");
    scheduleReconnect();
  };
  ws.onerror = () => {
    setConnectionState("disconnected", "Bridge WebSocket error");
    ws?.close();
  };
}
async function handleBridgeMessage(raw) {
  const parsed = JSON.parse(raw);
  if (isRegisteredMessage(parsed)) {
    reconnectAttempts = 0;
    await persistConfig({ clientId: parsed.clientId });
    setConnectionState("connected");
    console.log(`[opencli] Registered with remote bridge as ${parsed.clientId}`);
    return;
  }
  if (isRemoteCommandEnvelope(parsed)) {
    const envelope = parsed;
    if (configCache.clientId && envelope.clientId !== configCache.clientId) {
      throw new Error(`Client mismatch: expected ${configCache.clientId}, got ${envelope.clientId}`);
    }
    const command = commandFromEnvelope(envelope);
    const result = await handleCommand(command);
    ws?.send(JSON.stringify({
      type: "result",
      clientId: envelope.clientId,
      commandId: envelope.commandId,
      ok: result.ok,
      data: result.data,
      error: result.error
    }));
    return;
  }
  throw new Error("Unsupported bridge message");
}
const MAX_EAGER_ATTEMPTS = 6;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return;
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}
function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !configCache.clientId) return;
  ws.send(JSON.stringify({
    type: "heartbeat",
    clientId: configCache.clientId,
    ts: Date.now()
  }));
}
const automationSessions = /* @__PURE__ */ new Map();
const WINDOW_IDLE_TIMEOUT = 3e4;
function getWorkspaceKey(workspace) {
  return workspace?.trim() || "default";
}
function resetWindowIdleTimer(workspace) {
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
    }
    automationSessions.delete(workspace);
  }, WINDOW_IDLE_TIMEOUT);
}
async function getAutomationWindow(workspace) {
  const existing = automationSessions.get(workspace);
  if (existing) {
    try {
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      automationSessions.delete(workspace);
    }
  }
  const win = await chrome.windows.create({
    url: BLANK_PAGE,
    focused: false,
    width: 1280,
    height: 900,
    type: "normal"
  });
  const session = {
    windowId: win.id,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
    owned: true,
    preferredTabId: null
  };
  automationSessions.set(workspace, session);
  console.log(`[opencli] Created automation window ${session.windowId} (${workspace})`);
  resetWindowIdleTimer(workspace);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return session.windowId;
}
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [workspace, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[opencli] Automation window closed (${workspace})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(workspace);
    }
  }
});
let initialized = false;
function initialize() {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.4 });
  registerListeners();
  void hydrateConfig().then(() => connect());
  console.log("[opencli] OpenCLI extension initialized");
}
void hydrateConfig();
async function saveRemoteBridgeConfig(backendUrl, token) {
  disconnectSocket();
  reconnectAttempts = 0;
  await persistConfig({
    backendUrl,
    token,
    clientId: ""
  });
  if (hasRemoteBridgeConfig()) {
    await connect();
  } else {
    setConnectionState("disconnected");
  }
  return getStatusPayload();
}
function isRuntimeMessage(value) {
  return typeof value === "object" && value !== null && typeof value.type === "string";
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isRuntimeMessage(msg)) return false;
  if (msg.type === "getStatus") {
    void getStatusPayload().then(sendResponse);
    return true;
  }
  if (msg.type === "saveConfig") {
    void saveRemoteBridgeConfig(typeof msg.backendUrl === "string" ? msg.backendUrl : "", typeof msg.token === "string" ? msg.token : "").then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
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
async function handleCommand(cmd) {
  const workspace = getWorkspaceKey(cmd.workspace);
  resetWindowIdleTimer(workspace);
  try {
    switch (cmd.action) {
      case "exec":
        return await handleExec(cmd, workspace);
      case "navigate":
        return await handleNavigate(cmd, workspace);
      case "tabs":
        return await handleTabs(cmd, workspace);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        return await handleScreenshot(cmd, workspace);
      case "close-window":
        return await handleCloseWindow(cmd, workspace);
      case "sessions":
        return await handleSessions(cmd);
      case "set-file-input":
        return await handleSetFileInput(cmd, workspace);
      case "set-file-input-remote":
        return await handleSetFileInputRemote(cmd, workspace);
      case "bind-current":
        return await handleBindCurrent(cmd, workspace);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
const BLANK_PAGE = "data:text/html,<html></html>";
function isDebuggableUrl(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === BLANK_PAGE;
}
function isSafeNavigationUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}
function normalizeUrlForComparison(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.port === "443" || parsed.protocol === "http:" && parsed.port === "80") {
      parsed.port = "";
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
function isTargetUrl(currentUrl, targetUrl) {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}
function matchesDomain(url, domain) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
function matchesBindCriteria(tab, cmd) {
  if (!tab.id || !isDebuggableUrl(tab.url)) return false;
  if (cmd.matchDomain && !matchesDomain(tab.url, cmd.matchDomain)) return false;
  if (cmd.matchPathPrefix) {
    try {
      const parsed = new URL(tab.url);
      if (!parsed.pathname.startsWith(cmd.matchPathPrefix)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
function isNotebooklmWorkspace(workspace) {
  return workspace === "site:notebooklm";
}
function classifyNotebooklmUrl(url) {
  if (!url) return "other";
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "notebooklm.google.com") return "other";
    return parsed.pathname.startsWith("/notebook/") ? "notebook" : "home";
  } catch {
    return "other";
  }
}
function scoreWorkspaceTab(workspace, tab) {
  if (!tab.id || !isDebuggableUrl(tab.url)) return -1;
  if (isNotebooklmWorkspace(workspace)) {
    const kind = classifyNotebooklmUrl(tab.url);
    if (kind === "other") return -1;
    if (kind === "notebook") return tab.active ? 400 : 300;
    return tab.active ? 200 : 100;
  }
  return -1;
}
function setWorkspaceSession(workspace, session) {
  const existing = automationSessions.get(workspace);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  automationSessions.set(workspace, {
    ...session,
    idleTimer: null,
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT
  });
}
async function maybeBindWorkspaceToExistingTab(workspace) {
  if (!isNotebooklmWorkspace(workspace)) return null;
  const tabs = await chrome.tabs.query({});
  let bestTab = null;
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
    preferredTabId: bestTab.id
  });
  console.log(`[opencli] Workspace ${workspace} bound to existing tab ${bestTab.id} in window ${bestTab.windowId}`);
  resetWindowIdleTimer(workspace);
  return bestTab.id;
}
async function resolveTabId(tabId, workspace) {
  if (tabId !== void 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = automationSessions.get(workspace);
      const matchesSession = session ? session.preferredTabId !== null ? session.preferredTabId === tabId : tab.windowId === session.windowId : false;
      if (isDebuggableUrl(tab.url) && matchesSession) return tabId;
      if (session && !matchesSession) {
        console.warn(`[opencli] Tab ${tabId} is not bound to workspace ${workspace}, re-resolving`);
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(`[opencli] Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`);
      }
    } catch {
      console.warn(`[opencli] Tab ${tabId} no longer exists, re-resolving`);
    }
  }
  const adoptedTabId = await maybeBindWorkspaceToExistingTab(workspace);
  if (adoptedTabId !== null) return adoptedTabId;
  const existingSession = automationSessions.get(workspace);
  if (existingSession && existingSession.preferredTabId !== null) {
    try {
      const preferredTab = await chrome.tabs.get(existingSession.preferredTabId);
      if (isDebuggableUrl(preferredTab.url)) return preferredTab.id;
    } catch {
      automationSessions.delete(workspace);
    }
  }
  const windowId = await getAutomationWindow(workspace);
  const tabs = await chrome.tabs.query({ windowId });
  const debuggableTab = tabs.find((t) => t.id && isDebuggableUrl(t.url));
  if (debuggableTab?.id) return debuggableTab.id;
  const reuseTab = tabs.find((t) => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return reuseTab.id;
      console.warn(`[opencli] data: URI was intercepted (${updated.url}), creating fresh tab`);
    } catch {
    }
  }
  const newTab = await chrome.tabs.create({ windowId, url: BLANK_PAGE, active: true });
  if (!newTab.id) throw new Error("Failed to create tab in automation window");
  return newTab.id;
}
async function listAutomationTabs(workspace) {
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
async function listAutomationWebTabs(workspace) {
  const tabs = await listAutomationTabs(workspace);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}
async function handleExec(cmd, workspace) {
  if (!cmd.code) return { id: cmd.id, ok: false, error: "Missing code" };
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleNavigate(cmd, workspace) {
  if (!cmd.url) return { id: cmd.id, ok: false, error: "Missing url" };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: "Blocked URL scheme -- only http:// and https:// are allowed" };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  const beforeTab = await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;
  if (beforeTab.status === "complete" && isTargetUrl(beforeTab.url, targetUrl)) {
    return {
      id: cmd.id,
      ok: true,
      data: { title: beforeTab.title, url: beforeTab.url, tabId, timedOut: false }
    };
  }
  await detach(tabId);
  await chrome.tabs.update(tabId, { url: targetUrl });
  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    let timeoutTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };
    const isNavigationDone = (url) => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };
    const listener = (id, info, tab2) => {
      if (id !== tabId) return;
      if (info.status === "complete" && isNavigationDone(tab2.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === "complete" && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch {
      }
    }, 100);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[opencli] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15e3);
  });
  const tab = await chrome.tabs.get(tabId);
  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut }
  };
}
async function handleTabs(cmd, workspace) {
  switch (cmd.op) {
    case "list": {
      const tabs = await listAutomationWebTabs(workspace);
      const data = tabs.map((t, i) => ({
        index: i,
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active
      }));
      return { id: cmd.id, ok: true, data };
    }
    case "new": {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: "Blocked URL scheme -- only http:// and https:// are allowed" };
      }
      const windowId = await getAutomationWindow(workspace);
      const tab = await chrome.tabs.create({ windowId, url: cmd.url ?? BLANK_PAGE, active: true });
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case "close": {
      if (cmd.index !== void 0) {
        const tabs = await listAutomationWebTabs(workspace);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        await chrome.tabs.remove(target.id);
        await detach(target.id);
        return { id: cmd.id, ok: true, data: { closed: target.id } };
      }
      const tabId = await resolveTabId(cmd.tabId, workspace);
      await chrome.tabs.remove(tabId);
      await detach(tabId);
      return { id: cmd.id, ok: true, data: { closed: tabId } };
    }
    case "select": {
      if (cmd.index === void 0 && cmd.tabId === void 0)
        return { id: cmd.id, ok: false, error: "Missing index or tabId" };
      if (cmd.tabId !== void 0) {
        const session = automationSessions.get(workspace);
        let tab;
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
      const target = tabs[cmd.index];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      return { id: cmd.id, ok: true, data: { selected: target.id } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}
async function handleCookies(cmd) {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: "Cookie scope required: provide domain or url to avoid dumping all cookies" };
  }
  const details = {};
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
    expirationDate: c.expirationDate
  }));
  return { id: cmd.id, ok: true, data };
}
async function handleScreenshot(cmd, workspace) {
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleCloseWindow(cmd, workspace) {
  const session = automationSessions.get(workspace);
  if (session) {
    if (session.owned) {
      try {
        await chrome.windows.remove(session.windowId);
      } catch {
      }
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    automationSessions.delete(workspace);
  }
  return { id: cmd.id, ok: true, data: { closed: true } };
}
async function handleSetFileInput(cmd, workspace) {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: "Missing or empty files array" };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    await setFileInputFiles(tabId, cmd.files, cmd.selector);
    return { id: cmd.id, ok: true, data: { count: cmd.files.length } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function isRemoteFileDescriptor(value) {
  if (typeof value !== "object" || value === null) return false;
  const file = value;
  return typeof file.url === "string" && typeof file.name === "string" && typeof file.mimeType === "string" && typeof file.sizeBytes === "number" && file.sizeBytes >= 0;
}
async function handleSetFileInputRemote(cmd, workspace) {
  if (cmd.mode && cmd.mode !== "memory") {
    return { id: cmd.id, ok: false, error: "Only memory mode is supported in the first version. disk mode reserved for future implementation" };
  }
  if (!cmd.remoteFiles || !Array.isArray(cmd.remoteFiles) || cmd.remoteFiles.length === 0) {
    return { id: cmd.id, ok: false, error: "Missing or empty remoteFiles array" };
  }
  if (!cmd.remoteFiles.every(isRemoteFileDescriptor)) {
    return { id: cmd.id, ok: false, error: "Invalid remoteFiles payload" };
  }
  const tabId = await resolveTabId(cmd.tabId, workspace);
  try {
    const data = await setRemoteFileInputFiles(tabId, {
      remoteFiles: cmd.remoteFiles,
      selector: cmd.selector,
      warnMemoryBytes: cmd.warnMemoryBytes ?? DEFAULT_WARN_MEMORY_BYTES,
      hardMemoryBytes: cmd.hardMemoryBytes ?? DEFAULT_HARD_MEMORY_BYTES
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleSessions(cmd) {
  const now = Date.now();
  const data = await Promise.all([...automationSessions.entries()].map(async ([workspace, session]) => ({
    workspace,
    windowId: session.windowId,
    tabCount: (await chrome.tabs.query({ windowId: session.windowId })).filter((tab) => isDebuggableUrl(tab.url)).length,
    idleMsRemaining: Math.max(0, session.idleDeadlineAt - now)
  })));
  return { id: cmd.id, ok: true, data };
}
async function handleBindCurrent(cmd, workspace) {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallbackTabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const allTabs = await chrome.tabs.query({});
  const boundTab = activeTabs.find((tab) => matchesBindCriteria(tab, cmd)) ?? fallbackTabs.find((tab) => matchesBindCriteria(tab, cmd)) ?? allTabs.find((tab) => matchesBindCriteria(tab, cmd));
  if (!boundTab?.id) {
    return {
      id: cmd.id,
      ok: false,
      error: cmd.matchDomain || cmd.matchPathPrefix ? `No visible tab matching ${cmd.matchDomain ?? "domain"}${cmd.matchPathPrefix ? ` ${cmd.matchPathPrefix}` : ""}` : "No active debuggable tab found"
    };
  }
  setWorkspaceSession(workspace, {
    windowId: boundTab.windowId,
    owned: false,
    preferredTabId: boundTab.id
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
      workspace
    }
  };
}
