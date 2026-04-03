import { describe, expect, it } from 'vitest';
import { executeCommand } from './execution.js';
import { ConfigError, TimeoutError } from './errors.js';
import { cli, Strategy } from './registry.js';
import { withTimeoutMs } from './runtime.js';

describe('executeCommand — non-browser timeout', () => {
  it('applies timeoutSeconds to non-browser commands', async () => {
    const cmd = cli({
      site: 'test-execution',
      name: 'non-browser-timeout',
      description: 'test non-browser timeout',
      browser: false,
      strategy: Strategy.PUBLIC,
      timeoutSeconds: 0.01,
      func: () => new Promise(() => {}),
    });

    // Sentinel timeout at 200ms — if the inner 10ms timeout fires first,
    // the error will be a TimeoutError with the command label, not 'sentinel'.
    const error = await withTimeoutMs(executeCommand(cmd, {}), 200, 'sentinel timeout')
      .catch((err) => err);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({
      code: 'TIMEOUT',
      message: 'test-execution/non-browser-timeout timed out after 0.01s',
    });
  });

  it('skips timeout when timeoutSeconds is 0', async () => {
    const cmd = cli({
      site: 'test-execution',
      name: 'non-browser-zero-timeout',
      description: 'test zero timeout bypasses wrapping',
      browser: false,
      strategy: Strategy.PUBLIC,
      timeoutSeconds: 0,
      func: () => new Promise(() => {}),
    });

    // With timeout guard skipped, the sentinel fires instead.
    await expect(
      withTimeoutMs(executeCommand(cmd, {}), 50, 'sentinel timeout'),
    ).rejects.toThrow('sentinel timeout');
  });

  it('fails fast with a clear config error when Browser Bridge routing params are missing', async () => {
    delete process.env.OPENCLI_REMOTE_URL;
    delete process.env.OPENCLI_REMOTE_TOKEN;
    delete process.env.OPENCLI_REMOTE_CLIENT;

    const cmd = cli({
      site: 'test-execution',
      name: 'browser-routing-required',
      description: 'test browser routing config',
      browser: true,
      strategy: Strategy.COOKIE,
      domain: 'example.com',
      func: async () => ({ ok: true }),
    });

    const error = await executeCommand(cmd, {}).catch((err) => err);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(
      'Missing required Browser Bridge routing parameters: --remote-url / OPENCLI_REMOTE_URL, --token / OPENCLI_REMOTE_TOKEN, --client / OPENCLI_REMOTE_CLIENT.',
    );
    expect((error as ConfigError).hint).toContain('opencli clients');
  });
});
