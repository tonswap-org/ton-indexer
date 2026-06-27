#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYMENT_EVIDENCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EVIDENCE_FILE="$ROOT_DIR/scripts/production-deployment-evidence.json"
MAINNET_REGISTRY_FILE="$ROOT_DIR/registry/mainnet.json"
REQUIRE_READY=false

usage() {
  cat <<'USAGE'
Usage: scripts/audit-deployment-evidence.sh [--evidence <path>] [--mainnet-registry <path>] [--require-ready]

Validates production deployment evidence. The default audit allows the current
blocked state, but rejects any ready/release-enabled claim unless the deployment
manifest records a Docker image digest and successful live production smoke.
USAGE
}

while (($#)); do
  case "$1" in
    --evidence)
      [[ $# -ge 2 ]] || { echo "[deployment-evidence][error] --evidence requires a path" >&2; exit 2; }
      EVIDENCE_FILE="$2"
      shift 2
      ;;
    --mainnet-registry)
      [[ $# -ge 2 ]] || { echo "[deployment-evidence][error] --mainnet-registry requires a path" >&2; exit 2; }
      MAINNET_REGISTRY_FILE="$2"
      shift 2
      ;;
    --require-ready)
      REQUIRE_READY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[deployment-evidence][error] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[deployment-evidence][error] node is required for structured JSON validation" >&2
  exit 1
fi

node - "$EVIDENCE_FILE" "$REQUIRE_READY" "$MAINNET_REGISTRY_FILE" <<'NODE'
const fs = require('fs');

const [evidenceFile, requireReadyRaw, mainnetRegistryFile] = process.argv.slice(2);
const requireReady = requireReadyRaw === 'true';
const errors = [];
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const serviceContracts = {
  'ti.soramitsu.io': {
    scope: 'ton-indexer-production-deployment-readiness',
    baseUrl: 'https://ti.soramitsu.io',
    smokeCommand: 'TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production',
    dockerBuildCommand: 'docker build -t ton-indexer:release .',
    mainnetRegistryFile,
    registryPlaceholderBlocker: 'mainnet-registry-placeholders-remain',
    serviceInfo: {
      serviceId: 'ti.soramitsu.io',
      ecosystem: 'ton',
      chainId: 'ton:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://ti.soramitsu.io',
      readOnly: true,
      endpoints: {
        openapi: '/api/indexer/v1/openapi.json'
      }
    },
    requiredBlockers: [
      'production-deployment-evidence-missing',
      'live-production-smoke-failing'
    ]
  },
  'si.soramitsu.io': {
    scope: 'solswap-indexer-production-deployment-readiness',
    baseUrl: 'https://si.soramitsu.io',
    smokeCommand: 'SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production',
    dockerBuildCommand: 'docker build -t solswap-indexer:release .',
    serviceInfo: {
      serviceId: 'si.soramitsu.io',
      ecosystem: 'solana',
      chainId: 'solana:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://si.soramitsu.io',
      readOnly: true,
      endpoints: {
        openapi: '/api/indexer/v1/openapi.json'
      }
    },
    requiredBlockers: [
      'production-deployment-evidence-missing',
      'live-production-smoke-failing',
      'production-routing-mismatch'
    ]
  }
};

const requiredEvidenceFields = [
  'commit',
  'imageDigest',
  'deploymentId',
  'baseUrl',
  'smokeCommand',
  'smokePassedAt',
  'serviceInfo',
  'operator'
];

const requiredServiceInfoFields = [
  'serviceId',
  'ecosystem',
  'chainId',
  'network',
  'publicBaseUrl',
  'readOnly',
  'endpoints'
];

const allowedManifestFields = [
  'schemaVersion',
  'scope',
  'serviceId',
  'baseUrl',
  'status',
  'releaseEnabled',
  'lastReviewed',
  'blockers',
  'smokeCommand',
  'dockerBuildCommand',
  'readyVerificationCommands',
  'requiredEvidenceFields',
  'deploymentEvidence'
];

const requiredTonMainnetRegistryKeys = [
  'ClmmRouter',
  'ClmmPoolFactory',
  'FeeRouter',
  'Treasury',
  'ReferralRegistry',
  'T3Root',
  'TSRoot',
  'UsdtRoot',
  'UsdcRoot',
  'KusdRoot',
  'DlmmRegistry',
  'DlmmPoolFactory'
];

function fail(message) {
  errors.push(message);
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    fail(`production deployment evidence manifest missing: ${file}`);
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`production deployment evidence manifest must be valid JSON: ${error.message}`);
    return null;
  }
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    fail(`${name} must be an array`);
    return [];
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoUtcSecond(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(value || ''));
}

function isFutureTimestamp(value) {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis > Date.now() + MAX_CLOCK_SKEW_MS;
}

function isRepeatedHexPlaceholder(value) {
  const hex = String(value || '').replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]+$/.test(hex) && new Set(hex).size === 1;
}

function isTemplatePlaceholder(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return (
    normalized.length === 0 ||
    normalized.startsWith('TODO_') ||
    normalized.startsWith('REPLACE_WITH_') ||
    normalized.includes('PLACEHOLDER')
  );
}

function isLikelyTonAddress(value) {
  return /^([A-Za-z0-9_-]{48}|-?\d+:[0-9a-fA-F]{64})$/.test(String(value || '').trim());
}

function secretLikeKeyReason(value, path = '$') {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const reason = secretLikeKeyReason(value[index], `${path}[${index}]`);
      if (reason) {
        return reason;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes('privatekey') ||
      normalized.includes('mnemonic') ||
      normalized.includes('seed') ||
      normalized.includes('secret') ||
      normalized.includes('password') ||
      normalized.includes('authorization') ||
      normalized.includes('credential') ||
      normalized.includes('clientdatajson')
    ) {
      return `${path}.${key}`;
    }

    const reason = secretLikeKeyReason(child, `${path}.${key}`);
    if (reason) {
      return reason;
    }
  }

  return null;
}

function rejectUnsupportedKeys(value, allowedFields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key} is not supported in public deployment evidence`);
    }
  }
}

function validateServiceInfo(value, contract, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`);
    return;
  }

  rejectUnsupportedKeys(value, requiredServiceInfoFields, path);
  for (const field of ['serviceId', 'ecosystem', 'chainId', 'network', 'publicBaseUrl']) {
    if (value[field] !== contract.serviceInfo[field]) {
      fail(`${path}.${field} must be ${contract.serviceInfo[field]}`);
    }
  }

  if (value.readOnly !== contract.serviceInfo.readOnly) {
    fail(`${path}.readOnly must be ${contract.serviceInfo.readOnly}`);
  }

  if (!value.endpoints || typeof value.endpoints !== 'object' || Array.isArray(value.endpoints)) {
    fail(`${path}.endpoints must be an object`);
    return;
  }

  rejectUnsupportedKeys(value.endpoints, Object.keys(contract.serviceInfo.endpoints), `${path}.endpoints`);
  for (const [name, expected] of Object.entries(contract.serviceInfo.endpoints)) {
    if (value.endpoints[name] !== expected) {
      fail(`${path}.endpoints.${name} must be ${expected}`);
    }
  }
}

function inspectTonMainnetRegistry(file) {
  const result = {
    file,
    exists: false,
    placeholderKeys: [],
    missingKeys: [],
    invalidKeys: []
  };
  if (!file || !fs.existsSync(file)) {
    result.missingFile = true;
    return result;
  }
  result.exists = true;
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    result.parseError = error.message;
    return result;
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    result.notObject = true;
    return result;
  }
  for (const [key, value] of Object.entries(registry)) {
    if (typeof value === 'string' && value.trim().startsWith('REPLACE_WITH_MAINNET_')) {
      result.placeholderKeys.push(key);
    }
  }
  for (const key of requiredTonMainnetRegistryKeys) {
    const value = registry[key];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed.startsWith('REPLACE_WITH_MAINNET_')) {
      result.missingKeys.push(key);
      continue;
    }
    if (!isLikelyTonAddress(trimmed)) {
      result.invalidKeys.push(key);
    }
  }
  return result;
}

const manifest = readJson(evidenceFile);
let contract = null;
let registryInspection = null;

if (manifest) {
  const secretLikePath = secretLikeKeyReason(manifest);
  if (secretLikePath) {
    fail(`${secretLikePath} must not be included in public deployment evidence`);
  }
  rejectUnsupportedKeys(manifest, allowedManifestFields, 'deployment evidence');

  if (manifest.schemaVersion !== 1) {
    fail('schemaVersion must be 1');
  }

  contract = serviceContracts[manifest.serviceId];
  if (!contract) {
    fail('serviceId must be ti.soramitsu.io or si.soramitsu.io');
  } else {
    if (contract.mainnetRegistryFile) {
      registryInspection = inspectTonMainnetRegistry(contract.mainnetRegistryFile);
      if (registryInspection.missingFile) {
        fail(`mainnet registry file missing: ${contract.mainnetRegistryFile}`);
      } else if (registryInspection.parseError) {
        fail(`mainnet registry must be valid JSON: ${registryInspection.parseError}`);
      } else if (registryInspection.notObject) {
        fail('mainnet registry must be a JSON object');
      }
    }

    if (manifest.scope !== contract.scope) {
      fail(`scope must be ${contract.scope}`);
    }
    if (manifest.baseUrl !== contract.baseUrl) {
      fail(`baseUrl must be ${contract.baseUrl}`);
    }
    if (manifest.smokeCommand !== contract.smokeCommand) {
      fail(`smokeCommand must be ${contract.smokeCommand}`);
    }
    if (manifest.dockerBuildCommand !== contract.dockerBuildCommand) {
      fail(`dockerBuildCommand must be ${contract.dockerBuildCommand}`);
    }

    const commandList = requireArray(manifest.readyVerificationCommands, 'readyVerificationCommands');
    const commands = commandList.join('\n');
    if (new Set(commandList).size !== commandList.length) {
      fail('duplicate deployment evidence verification command');
    }
    for (const marker of [
      'npm run test:deployment-evidence-template',
      'npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json',
      'npm run test:deployment-evidence-audit',
      'npm run audit:deployment-evidence -- --require-ready',
      contract.dockerBuildCommand,
      contract.smokeCommand
    ]) {
      if (!commands.includes(marker)) {
        fail(`readyVerificationCommands missing ${marker}`);
      }
    }

    if (manifest.status === 'blocked') {
      const manifestBlockers = requireArray(manifest.blockers, 'blockers');
      const blockers = new Set(manifestBlockers);
      const allowedBlockers = new Set(contract.requiredBlockers);
      if (contract.registryPlaceholderBlocker) {
        allowedBlockers.add(contract.registryPlaceholderBlocker);
      }
      if (blockers.size !== manifestBlockers.length) {
        fail('duplicate deployment evidence blocker');
      }
      for (const blocker of contract.requiredBlockers) {
        if (!blockers.has(blocker)) {
          fail(`blocked deployment evidence missing blocker ${blocker}`);
        }
      }
      for (const blocker of manifestBlockers) {
        if (!allowedBlockers.has(blocker)) {
          fail(`unsupported deployment evidence blocker: ${blocker}`);
        }
      }
      if (contract.registryPlaceholderBlocker && registryInspection) {
        const hasRegistryPlaceholders =
          registryInspection.missingFile ||
          registryInspection.parseError ||
          registryInspection.notObject ||
          registryInspection.placeholderKeys.length > 0 ||
          registryInspection.missingKeys.length > 0 ||
          registryInspection.invalidKeys.length > 0;
        if (hasRegistryPlaceholders && !blockers.has(contract.registryPlaceholderBlocker)) {
          fail(`blocked deployment evidence missing blocker ${contract.registryPlaceholderBlocker}`);
        }
        if (!hasRegistryPlaceholders && blockers.has(contract.registryPlaceholderBlocker)) {
          fail(`blocked deployment evidence has stale blocker ${contract.registryPlaceholderBlocker}`);
        }
      }
    }
  }

  if (!['blocked', 'ready'].includes(manifest.status)) {
    fail('status must be blocked or ready');
  }

  if (typeof manifest.releaseEnabled !== 'boolean') {
    fail('releaseEnabled must be a boolean');
  }

  if (manifest.status === 'blocked' && manifest.releaseEnabled) {
    fail('releaseEnabled must remain false while deployment evidence is blocked');
  }

  if (requireReady && manifest.status !== 'ready') {
    fail('status must be ready when --require-ready is used');
  }

  const declaredFieldList = requireArray(manifest.requiredEvidenceFields, 'requiredEvidenceFields');
  const declaredFields = new Set(declaredFieldList);
  if (declaredFields.size !== declaredFieldList.length) {
    fail('duplicate deployment evidence required field');
  }
  for (const field of requiredEvidenceFields) {
    if (!declaredFields.has(field)) {
      fail(`requiredEvidenceFields missing ${field}`);
    }
  }
  for (const field of declaredFieldList) {
    if (!requiredEvidenceFields.includes(field)) {
      fail(`unsupported deployment evidence field in manifest: ${field}`);
    }
  }

  const evidence = requireArray(manifest.deploymentEvidence, 'deploymentEvidence');
  const readyClaimed = manifest.status === 'ready' || manifest.releaseEnabled || requireReady;
  if (readyClaimed && contract?.registryPlaceholderBlocker && registryInspection) {
    if (registryInspection.missingFile) {
      fail(`mainnet registry file missing: ${contract.mainnetRegistryFile}`);
    }
    if (registryInspection.parseError) {
      fail(`mainnet registry must be valid JSON: ${registryInspection.parseError}`);
    }
    if (registryInspection.notObject) {
      fail('mainnet registry must be a JSON object');
    }
    if (registryInspection.placeholderKeys.length > 0) {
      fail(`mainnet registry contains placeholder values: ${registryInspection.placeholderKeys.join(', ')}`);
    }
    if (registryInspection.missingKeys.length > 0) {
      fail(`mainnet registry missing required keys: ${registryInspection.missingKeys.join(', ')}`);
    }
    if (registryInspection.invalidKeys.length > 0) {
      fail(`mainnet registry contains invalid TON address values: ${registryInspection.invalidKeys.join(', ')}`);
    }
  }
  if (readyClaimed) {
    if (!manifest.releaseEnabled) {
      fail('releaseEnabled must be true when deployment evidence is ready');
    }
    if (Array.isArray(manifest.blockers) && manifest.blockers.length > 0) {
      fail('blockers must be empty when deployment evidence is ready');
    }
    if (evidence.length === 0) {
      fail('ready deployment evidence requires at least one successful live production smoke record');
    }
  }

  const seenDeployments = new Set();
  evidence.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`deploymentEvidence[${index}] must be an object`);
      return;
    }
    rejectUnsupportedKeys(entry, requiredEvidenceFields, `deploymentEvidence[${index}]`);

    for (const field of requiredEvidenceFields) {
      if (field === 'serviceInfo') {
        continue;
      }
      if (!nonEmptyString(entry[field])) {
        fail(`deploymentEvidence[${index}].${field} must not be blank`);
      }
    }

    if (!/^[0-9a-f]{40}$/i.test(String(entry.commit || ''))) {
      fail(`deploymentEvidence[${index}].commit must be a 40-character git commit`);
    }
    if (isRepeatedHexPlaceholder(entry.commit)) {
      fail(`deploymentEvidence[${index}].commit must not be a placeholder git commit`);
    }

    if (!/^sha256:[0-9a-f]{64}$/i.test(String(entry.imageDigest || ''))) {
      fail(`deploymentEvidence[${index}].imageDigest must be a sha256 image digest`);
    }
    if (isRepeatedHexPlaceholder(entry.imageDigest)) {
      fail(`deploymentEvidence[${index}].imageDigest must not be a placeholder image digest`);
    }

    if (contract && entry.baseUrl !== contract.baseUrl) {
      fail(`deploymentEvidence[${index}].baseUrl must be ${contract.baseUrl}`);
    }

    if (contract && entry.smokeCommand !== contract.smokeCommand) {
      fail(`deploymentEvidence[${index}].smokeCommand must be ${contract.smokeCommand}`);
    }

    if (contract) {
      validateServiceInfo(entry.serviceInfo, contract, `deploymentEvidence[${index}].serviceInfo`);
    }

    if (!isIsoUtcSecond(entry.smokePassedAt)) {
      fail(`deploymentEvidence[${index}].smokePassedAt must be an ISO-8601 UTC second timestamp`);
    } else if (isFutureTimestamp(entry.smokePassedAt)) {
      fail(`deploymentEvidence[${index}].smokePassedAt must not be in the future`);
    }

    const deploymentId = String(entry.deploymentId || '').trim();
    if (isTemplatePlaceholder(deploymentId)) {
      fail(`deploymentEvidence[${index}].deploymentId must not be a placeholder deployment id`);
    }
    if (isTemplatePlaceholder(entry.operator)) {
      fail(`deploymentEvidence[${index}].operator must not be a placeholder operator`);
    }
    if (seenDeployments.has(deploymentId)) {
      fail(`duplicate deployment evidence id: ${deploymentId}`);
    }
    seenDeployments.add(deploymentId);
  });
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[deployment-evidence][error] ${error}`);
  }
  process.exit(1);
}

console.log(`[deployment-evidence] serviceId=${manifest.serviceId} status=${manifest.status} releaseEnabled=${manifest.releaseEnabled} evidence=${manifest.deploymentEvidence.length}`);
NODE
