#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYMENT_EVIDENCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EVIDENCE_FILE="$ROOT_DIR/scripts/production-deployment-evidence.json"
OUTPUT_FILE=""

usage() {
  cat <<'USAGE'
Usage: scripts/generate-deployment-evidence-template.sh [--evidence <path>] [--output <path>]

Generates a fill-in-ready production deployment evidence manifest from the
committed evidence schema. The generated template intentionally contains TODO
placeholders and must fail the release-ready audit until a real deployment and
live smoke result are recorded.
USAGE
}

while (($#)); do
  case "$1" in
    --evidence)
      [[ $# -ge 2 ]] || { echo "[deployment-evidence-template][error] --evidence requires a path" >&2; exit 2; }
      EVIDENCE_FILE="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "[deployment-evidence-template][error] --output requires a path" >&2; exit 2; }
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[deployment-evidence-template][error] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[deployment-evidence-template][error] node is required for structured JSON generation" >&2
  exit 1
fi

node - "$EVIDENCE_FILE" "$OUTPUT_FILE" <<'NODE'
const fs = require('fs');
const path = require('path');

const [evidenceFile, outputFile] = process.argv.slice(2);
const errors = [];

const serviceContracts = {
  'ti.soramitsu.io': {
    scope: 'ton-indexer-production-deployment-readiness',
    baseUrl: 'https://ti.soramitsu.io',
    smokeCommand: 'TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production',
    dockerBuildCommand: 'docker build -t ton-indexer:release .',
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
    }
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
    }
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
const placeholders = {
  commit: 'TODO_40_HEX_GIT_COMMIT',
  imageDigest: 'sha256:TODO_64_HEX_IMAGE_DIGEST',
  deploymentId: 'TODO_PRODUCTION_DEPLOYMENT_ID',
  baseUrl: null,
  smokeCommand: null,
  smokePassedAt: 'TODO_UTC_SMOKE_TIMESTAMP_SECONDS',
  serviceInfo: null,
  operator: 'TODO_RELEASE_OPERATOR'
};
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

function secretLikeKeyReason(value, currentPath = '$') {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const reason = secretLikeKeyReason(value[index], `${currentPath}[${index}]`);
      if (reason) return reason;
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
      return `${currentPath}.${key}`;
    }

    const reason = secretLikeKeyReason(child, `${currentPath}.${key}`);
    if (reason) return reason;
  }

  return null;
}

function rejectUnsupportedKeys(value, allowedFields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${path}.${field} is not supported in public deployment evidence manifest`);
    }
  }
}

function validateServiceInfo(value, contract, currentPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${currentPath} must be an object`);
    return;
  }

  rejectUnsupportedKeys(value, requiredServiceInfoFields, currentPath);
  for (const field of ['serviceId', 'ecosystem', 'chainId', 'network', 'publicBaseUrl']) {
    if (value[field] !== contract.serviceInfo[field]) {
      fail(`${currentPath}.${field} must be ${contract.serviceInfo[field]}`);
    }
  }
  if (value.readOnly !== contract.serviceInfo.readOnly) {
    fail(`${currentPath}.readOnly must be ${contract.serviceInfo.readOnly}`);
  }
  if (!value.endpoints || typeof value.endpoints !== 'object' || Array.isArray(value.endpoints)) {
    fail(`${currentPath}.endpoints must be an object`);
    return;
  }
  rejectUnsupportedKeys(value.endpoints, Object.keys(contract.serviceInfo.endpoints), `${currentPath}.endpoints`);
  for (const [name, expected] of Object.entries(contract.serviceInfo.endpoints)) {
    if (value.endpoints[name] !== expected) {
      fail(`${currentPath}.endpoints.${name} must be ${expected}`);
    }
  }
}

function validateCommittedDeploymentEvidence(value, contract) {
  const evidence = requireArray(value, 'deploymentEvidence');
  evidence.forEach((record, index) => {
    const path = `deploymentEvidence[${index}]`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail(`${path} must be an object`);
      return;
    }
    rejectUnsupportedKeys(record, requiredEvidenceFields, path);
    if (Object.prototype.hasOwnProperty.call(record, 'serviceInfo') && contract) {
      validateServiceInfo(record.serviceInfo, contract, `${path}.serviceInfo`);
    }
  });

  if (evidence.length > 0) {
    fail('committed deployment evidence manifest must not prefill deploymentEvidence');
  }
}

const manifest = readJson(evidenceFile);
let contract = null;

if (manifest) {
  const secretPath = secretLikeKeyReason(manifest);
  if (secretPath) {
    fail(`${secretPath} must not be read from public deployment evidence manifest`);
  }
  rejectUnsupportedKeys(manifest, allowedManifestFields, 'deployment evidence');

  if (manifest.schemaVersion !== 1) {
    fail('schemaVersion must be 1');
  }

  contract = serviceContracts[manifest.serviceId];
  if (!contract) {
    fail('serviceId must be ti.soramitsu.io or si.soramitsu.io');
  } else {
    if (manifest.scope !== contract.scope) fail(`scope must be ${contract.scope}`);
    if (manifest.baseUrl !== contract.baseUrl) fail(`baseUrl must be ${contract.baseUrl}`);
    if (manifest.smokeCommand !== contract.smokeCommand) fail(`smokeCommand must be ${contract.smokeCommand}`);
    if (manifest.dockerBuildCommand !== contract.dockerBuildCommand) fail(`dockerBuildCommand must be ${contract.dockerBuildCommand}`);

    const commands = requireArray(manifest.readyVerificationCommands, 'readyVerificationCommands').join('\n');
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
  }

  const declaredFields = requireArray(manifest.requiredEvidenceFields, 'requiredEvidenceFields');
  const declaredFieldSet = new Set(declaredFields);
  for (const field of requiredEvidenceFields) {
    if (!declaredFieldSet.has(field)) {
      fail(`requiredEvidenceFields missing ${field}`);
    }
  }
  for (const field of declaredFields) {
    if (!Object.prototype.hasOwnProperty.call(placeholders, field)) {
      fail(`unsupported deployment evidence field in manifest: ${field}`);
    }
  }
  validateCommittedDeploymentEvidence(manifest.deploymentEvidence, contract);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[deployment-evidence-template][error] ${error}`);
  }
  process.exit(1);
}

const evidence = {};
for (const field of manifest.requiredEvidenceFields) {
  if (field === 'baseUrl') evidence[field] = contract.baseUrl;
  else if (field === 'smokeCommand') evidence[field] = contract.smokeCommand;
  else if (field === 'serviceInfo') evidence[field] = contract.serviceInfo;
  else evidence[field] = placeholders[field];
}

const template = {
  schemaVersion: manifest.schemaVersion,
  scope: manifest.scope,
  serviceId: manifest.serviceId,
  baseUrl: manifest.baseUrl,
  status: 'ready',
  releaseEnabled: true,
  lastReviewed: 'TODO_YYYY_MM_DD',
  blockers: [],
  smokeCommand: manifest.smokeCommand,
  dockerBuildCommand: manifest.dockerBuildCommand,
  readyVerificationCommands: manifest.readyVerificationCommands,
  requiredEvidenceFields: manifest.requiredEvidenceFields,
  deploymentEvidence: [evidence]
};

const output = `${JSON.stringify(template, null, 2)}\n`;
if (outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output);
}
process.stdout.write(output);
NODE
