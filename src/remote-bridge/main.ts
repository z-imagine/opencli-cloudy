import { createRemoteBridgeServer } from './server.js';
import { DEFAULT_REMOTE_BRIDGE_PORT } from './protocol.js';

function readPort(): number {
  const raw = process.env.OPENCLI_REMOTE_BRIDGE_PORT;
  if (!raw) return DEFAULT_REMOTE_BRIDGE_PORT;
  const port = parseInt(raw, 10);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid OPENCLI_REMOTE_BRIDGE_PORT: ${raw}`);
  }
  return port;
}

function readHost(): string {
  const raw = process.env.OPENCLI_REMOTE_BRIDGE_HOST?.trim();
  return raw || '0.0.0.0';
}

const token = process.env.OPENCLI_REMOTE_BRIDGE_TOKEN;
if (!token) {
  throw new Error('OPENCLI_REMOTE_BRIDGE_TOKEN is required');
}

const server = createRemoteBridgeServer({
  token,
  host: readHost(),
  port: readPort(),
});

await server.start();
