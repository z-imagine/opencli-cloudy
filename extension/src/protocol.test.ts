import { describe, expect, it } from 'vitest';

import { commandFromEnvelope, toBridgeHealthUrl, toBridgeWebSocketUrl } from './protocol';

describe('extension protocol helpers', () => {
  it('derives bridge endpoints from backend url', () => {
    expect(toBridgeHealthUrl('https://bridge.example.com/')).toBe('https://bridge.example.com/health');
    expect(toBridgeWebSocketUrl('https://bridge.example.com/base')).toBe('wss://bridge.example.com/agent');
    expect(toBridgeWebSocketUrl('http://127.0.0.1:19826')).toBe('ws://127.0.0.1:19826/agent');
  });

  it('maps remote envelope to background command shape', () => {
    expect(commandFromEnvelope({
      clientId: 'cli_1',
      commandId: 'cmd_1',
      action: 'navigate',
      workspace: 'site:xiaohongshu',
      payload: {
        url: 'https://example.com',
      },
    })).toEqual({
      id: 'cmd_1',
      action: 'navigate',
      workspace: 'site:xiaohongshu',
      url: 'https://example.com',
    });
  });
});
