import { isAbsolute } from 'node:path';
export interface AdmissionArtifactConfig { binaryPath: string; binarySha256: string; configPath: string; configSha256: string }
export function parseAdmissionArtifacts(env: NodeJS.ProcessEnv): AdmissionArtifactConfig | undefined {
  const binaryPath = env.PERPS_ADMISSION_BINARY_PATH, binarySha256 = env.PERPS_ADMISSION_BINARY_SHA256,
    configPath = env.PERPS_ADMISSION_CONFIG_PATH, configSha256 = env.PERPS_ADMISSION_CONFIG_SHA256;
  if ([binaryPath, binarySha256, configPath, configSha256].every(value => value === undefined)) return undefined;
  if (!binaryPath || !isAbsolute(binaryPath) || !configPath || !isAbsolute(configPath) ||
      !binarySha256 || !/^[0-9a-f]{64}$/.test(binarySha256) || !configSha256 || !/^[0-9a-f]{64}$/.test(configSha256)) {
    throw new Error('Perps admission requires exact absolute binary/config paths and SHA-256 pins.');
  }
  return { binaryPath, binarySha256, configPath, configSha256 };
}
