import { loadConfig, readRegistryFile } from '../config';
import { loadOpcodes } from '../utils/opcodes';

const config = loadConfig();

try {
  const registry = readRegistryFile(config.registryPath);
  const opcodes = loadOpcodes(config.opcodesPath);
  console.log('config ok', {
    network: config.network,
    registryKeys: Object.keys(registry).length,
    opSwap: opcodes.swap.size,
  });
  process.exit(0);
} catch (error) {
  console.error('smoke failed', (error as Error).message);
  process.exit(1);
}
