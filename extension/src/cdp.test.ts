import { describe, expect, it, vi } from 'vitest';

import {
  buildRemoteFileInjectionExpression,
  buildRemoteFileLimitError,
  prepareRemoteFilesForInjection,
} from './cdp';

describe('remote file injection helpers', () => {
  it('prepares remote files and emits warning when exceeding warn threshold', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
    })) as unknown as typeof fetch;

    const result = await prepareRemoteFilesForInjection({
      remoteFiles: [
        {
          url: 'https://oss.example.com/hello.txt',
          name: 'hello.txt',
          mimeType: 'text/plain',
          sizeBytes: 5,
        },
      ],
      warnMemoryBytes: 1,
      hardMemoryBytes: 1024,
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('https://oss.example.com/hello.txt');
    expect(result.bytes).toBe(5);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].base64).toBeTruthy();
    expect(result.warnings).toEqual([
      'memory mode warning threshold exceeded: 5B > 1B',
    ]);
  });

  it('fails fast when declared size exceeds hard threshold', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(prepareRemoteFilesForInjection({
      remoteFiles: [
        {
          url: 'https://oss.example.com/big.mov',
          name: 'big.mov',
          mimeType: 'video/quicktime',
          sizeBytes: 30 * 1024 * 1024,
        },
      ],
      warnMemoryBytes: 10 * 1024 * 1024,
      hardMemoryBytes: 25 * 1024 * 1024,
    }, fetchImpl)).rejects.toThrow(buildRemoteFileLimitError(30 * 1024 * 1024, 25 * 1024 * 1024));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('builds a page-side expression that reconstructs files and dispatches events', () => {
    const expression = buildRemoteFileInjectionExpression([
      {
        name: 'image.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 4,
        base64: 'AQIDBA==',
      },
    ], 'input[type="file"]');

    expect(expression).toContain('new DataTransfer()');
    expect(expression).toContain('new File([blob], file.name');
    expect(expression).toContain("input.dispatchEvent(new Event('change'");
    expect(expression).toContain('const query = "input[type=\\"file\\"]"');
  });
});
