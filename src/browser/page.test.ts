import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserTransport } from './transport.js';
import { Page } from './page.js';

describe('Page.getCurrentUrl', () => {
  let transport: BrowserTransport;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    transport = { send: send as BrowserTransport['send'] };
  });

  it('reads the real browser URL when no local navigation cache exists', async () => {
    send.mockResolvedValueOnce('https://notebooklm.google.com/notebook/nb-live');

    const page = new Page('site:notebooklm', transport);
    const url = await page.getCurrentUrl();

    expect(url).toBe('https://notebooklm.google.com/notebook/nb-live');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('exec', expect.objectContaining({
      workspace: 'site:notebooklm',
    }));
  });

  it('caches the discovered browser URL for later reads', async () => {
    send.mockResolvedValueOnce('https://notebooklm.google.com/notebook/nb-live');

    const page = new Page('site:notebooklm', transport);
    expect(await page.getCurrentUrl()).toBe('https://notebooklm.google.com/notebook/nb-live');
    expect(await page.getCurrentUrl()).toBe('https://notebooklm.google.com/notebook/nb-live');

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Page.evaluate', () => {
  let transport: BrowserTransport;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    transport = { send: send as BrowserTransport['send'] };
  });

  it('retries once when the inspected target navigated during exec', async () => {
    send
      .mockRejectedValueOnce(new Error('{"code":-32000,"message":"Inspected target navigated or closed"}'))
      .mockResolvedValueOnce(42);

    const page = new Page('site:notebooklm', transport);
    const value = await page.evaluate('21 + 21');

    expect(value).toBe(42);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('Page.setRemoteFileInput', () => {
  it('sends remote file injection payload through the transport', async () => {
    const send = vi.fn().mockResolvedValue({
      count: 1,
      bytes: 1234,
      warnings: ['memory mode warning threshold exceeded: 1.2KB > 1.0KB'],
    });
    const page = new Page('site:xiaohongshu', { send });

    const result = await page.setRemoteFileInput([
      {
        url: 'https://oss.example.com/image.jpg?sign=1',
        name: 'image.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
      },
    ], 'input[type="file"]', {
      mode: 'memory',
      warnMemoryBytes: 1000,
      hardMemoryBytes: 5000,
    });

    expect(send).toHaveBeenCalledWith('set-file-input-remote', expect.objectContaining({
      workspace: 'site:xiaohongshu',
      selector: 'input[type="file"]',
      mode: 'memory',
      warnMemoryBytes: 1000,
      hardMemoryBytes: 5000,
      remoteFiles: [
        expect.objectContaining({
          name: 'image.jpg',
          sizeBytes: 1234,
        }),
      ],
    }));
    expect(result).toEqual({
      count: 1,
      bytes: 1234,
      warnings: ['memory mode warning threshold exceeded: 1.2KB > 1.0KB'],
    });
  });
});
