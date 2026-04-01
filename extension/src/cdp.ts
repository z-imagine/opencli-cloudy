/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

const attached = new Set<number>();

export interface RemoteFileInjectionPayload {
  remoteFiles: Array<{
    url: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  selector?: string;
  warnMemoryBytes: number;
  hardMemoryBytes: number;
}

export interface RemoteFileInjectionPreparedFile {
  name: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
}

export interface RemoteFileInjectionResult {
  count: number;
  bytes: number;
  warnings?: string[];
}

/** Internal blank page used when no user URL is provided. */
const BLANK_PAGE = 'data:text/html,<html></html>';

/** Check if a URL can be attached via CDP — only allow http(s) and our internal blank page. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === BLANK_PAGE;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

export function buildRemoteFileLimitError(bytes: number, hardMemoryBytes: number): string {
  return `memory mode limit exceeded: ${formatBytes(bytes)} > ${formatBytes(hardMemoryBytes)}. disk mode reserved for future implementation`;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function prepareRemoteFilesForInjection(
  payload: RemoteFileInjectionPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ files: RemoteFileInjectionPreparedFile[]; bytes: number; warnings: string[] }> {
  const declaredBytes = payload.remoteFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (declaredBytes > payload.hardMemoryBytes) {
    throw new Error(buildRemoteFileLimitError(declaredBytes, payload.hardMemoryBytes));
  }

  const warnings: string[] = [];
  if (declaredBytes > payload.warnMemoryBytes) {
    warnings.push(`memory mode warning threshold exceeded: ${formatBytes(declaredBytes)} > ${formatBytes(payload.warnMemoryBytes)}`);
  }

  const files: RemoteFileInjectionPreparedFile[] = [];
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
      base64: arrayBufferToBase64(buffer),
    });
  }

  if (warnings.length === 0 && actualBytes > payload.warnMemoryBytes) {
    warnings.push(`memory mode warning threshold exceeded: ${formatBytes(actualBytes)} > ${formatBytes(payload.warnMemoryBytes)}`);
  }

  return {
    files,
    bytes: actualBytes,
    warnings,
  };
}

export function buildRemoteFileInjectionExpression(
  files: RemoteFileInjectionPreparedFile[],
  selector?: string,
): string {
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

async function ensureAttached(tabId: number): Promise<void> {
  // Verify the tab URL is debuggable before attempting attach
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      // Invalidate cache if previously attached
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (e) {
    // Re-throw our own error, catch only chrome.tabs.get failures
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  if (attached.has(tabId)) {
    // Verify the debugger is still actually attached by sending a harmless command
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      });
      return; // Still attached and working
    } catch {
      // Stale cache entry — need to re-attach
      attached.delete(tabId);
    }
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = msg.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    if (msg.includes('Another debugger is already attached')) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch {
        throw new Error(`attach failed: ${msg}${hint}`);
      }
    } else {
      throw new Error(`attach failed: ${msg}${hint}`);
    }
  }
  attached.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable
  }
}

export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  await ensureAttached(tabId);

  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';

  // For full-page screenshots, get the full page dimensions first
  if (options.fullPage) {
    // Get full page metrics
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics') as {
      contentSize?: { width: number; height: number };
      cssContentSize?: { width: number; height: number };
    };
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      // Set device metrics to full page size
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1,
      });
    }
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64-encoded
    };

    return result.data;
  } finally {
    // Reset device metrics if we changed them for full-page
    if (options.fullPage) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
 * This bypasses the need to send large base64 payloads through the message channel —
 * Chrome reads the files directly from the local filesystem.
 *
 * @param tabId - Target tab ID
 * @param files - Array of absolute local file paths
 * @param selector - CSS selector to find the file input (optional, defaults to first file input)
 */
export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  // Enable DOM domain (required for DOM.querySelector and DOM.setFileInputFiles)
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');

  // Get the document root
  const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument') as {
    root: { nodeId: number };
  };

  // Find the file input element
  const query = selector || 'input[type="file"]';
  const result = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: query,
  }) as { nodeId: number };

  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }

  // Set files directly via CDP — Chrome reads from local filesystem
  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
    files,
    nodeId: result.nodeId,
  });
}

export async function setRemoteFileInputFiles(
  tabId: number,
  payload: RemoteFileInjectionPayload,
): Promise<RemoteFileInjectionResult> {
  await ensureAttached(tabId);
  const prepared = await prepareRemoteFilesForInjection(payload);
  const result = await evaluateAsync(
    tabId,
    buildRemoteFileInjectionExpression(prepared.files, payload.selector),
  ) as { ok?: boolean; count?: number; bytes?: number; error?: string };

  if (!result?.ok) {
    throw new Error(result?.error ?? 'Remote file injection failed');
  }

  return {
    count: result.count ?? prepared.files.length,
    bytes: result.bytes ?? prepared.bytes,
    warnings: prepared.warnings.length > 0 ? prepared.warnings : undefined,
  };
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
}
