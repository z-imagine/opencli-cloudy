import type { IPage } from '../types.js';
import type { IBrowserFactory } from '../runtime.js';
import { Page } from './page.js';
import { RemoteBridgeTransport, isRemoteBridgeConfigured } from './transport.js';

export class RemoteBrowserBridge implements IBrowserFactory {
  private page: Page | null = null;

  async connect(opts: { timeout?: number; workspace?: string } = {}): Promise<IPage> {
    if (!isRemoteBridgeConfigured()) {
      throw new Error('OPENCLI_REMOTE_URL is required for remote browser mode');
    }
    this.page = new Page(opts.workspace, new RemoteBridgeTransport());
    return this.page;
  }

  async close(): Promise<void> {
    this.page = null;
  }
}
