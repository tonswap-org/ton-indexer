import { createServer } from 'node:net';
import type { IndexerMode } from './index';

export type PortProbe = (host: string, port: number) => Promise<boolean>;

export const isPortAvailable: PortProbe = (host, port) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host });
  });

export async function selectListenPort(
  host: string,
  port: number,
  mode: IndexerMode,
  attempts = 20,
  probe: PortProbe = isPortAvailable,
): Promise<number> {
  if (port === 0) return 0;

  if (mode === 'production') {
    if (!(await probe(host, port))) {
      throw new Error(`PORT ${port} is unavailable on ${host}; production will not select a different port.`);
    }
    return port;
  }

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = port + offset;
    if (candidate > 65_535) break;
    if (await probe(host, candidate)) return candidate;
  }
  throw new Error(`No available port found starting at ${port}.`);
}
