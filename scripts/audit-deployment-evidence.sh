#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${DEPLOYMENT_EVIDENCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EVIDENCE_FILE="$ROOT_DIR/scripts/production-deployment-evidence.json"
REQUIRE_READY=false

usage() {
  cat <<'USAGE'
Usage: scripts/audit-deployment-evidence.sh [--evidence <path>] [--require-ready]

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

node - "$EVIDENCE_FILE" "$REQUIRE_READY" <<'NODE'
const fs = require('fs');

const [evidenceFile, requireReadyRaw] = process.argv.slice(2);
const requireReady = requireReadyRaw === 'true';
const errors = [];

const serviceContracts = {
  'ti.soramitsu.io': {
    scope: 'ton-indexer-production-deployment-readiness',
    baseUrl: 'https://ti.soramitsu.io',
    smokeCommand: 'TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production',
    dockerBuildCommand: 'docker build -t ton-indexer:release .',
    requiredBlockers: [
      'production-deployment-evidence-missing',
      'live-production-smoke-failing',
      'mainnet-registry-placeholders-remain'
    ]
  },
  'si.soramitsu.io': {
    scope: 'solswap-indexer-production-deployment-readiness',
    baseUrl: 'https://si.soramitsu.io',
    smokeCommand: 'SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production',
    dockerBuildCommand: 'docker build -t solswap-indexer:release .',
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
  'operator'
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

const manifest = readJson(evidenceFile);
let contract = null;

if (manifest) {
  if (manifest.schemaVersion !== 1) {
    fail('schemaVersion must be 1');
  }

  contract = serviceContracts[manifest.serviceId];
  if (!contract) {
    fail('serviceId must be ti.soramitsu.io or si.soramitsu.io');
  } else {
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

    const commands = requireArray(manifest.readyVerificationCommands, 'readyVerificationCommands').join('\n');
    for (const marker of [
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
      const blockers = new Set(requireArray(manifest.blockers, 'blockers'));
      for (const blocker of contract.requiredBlockers) {
        if (!blockers.has(blocker)) {
          fail(`blocked deployment evidence missing blocker ${blocker}`);
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

  const declaredFields = new Set(requireArray(manifest.requiredEvidenceFields, 'requiredEvidenceFields'));
  for (const field of requiredEvidenceFields) {
    if (!declaredFields.has(field)) {
      fail(`requiredEvidenceFields missing ${field}`);
    }
  }

  const evidence = requireArray(manifest.deploymentEvidence, 'deploymentEvidence');
  const readyClaimed = manifest.status === 'ready' || manifest.releaseEnabled || requireReady;
  if (readyClaimed) {
    if (!manifest.releaseEnabled) {
      fail('releaseEnabled must be true when deployment evidence is ready');
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

    for (const field of requiredEvidenceFields) {
      if (!nonEmptyString(entry[field])) {
        fail(`deploymentEvidence[${index}].${field} must not be blank`);
      }
    }

    if (!/^[0-9a-f]{40}$/i.test(String(entry.commit || ''))) {
      fail(`deploymentEvidence[${index}].commit must be a 40-character git commit`);
    }

    if (!/^sha256:[0-9a-f]{64}$/i.test(String(entry.imageDigest || ''))) {
      fail(`deploymentEvidence[${index}].imageDigest must be a sha256 image digest`);
    }

    if (contract && entry.baseUrl !== contract.baseUrl) {
      fail(`deploymentEvidence[${index}].baseUrl must be ${contract.baseUrl}`);
    }

    if (contract && entry.smokeCommand !== contract.smokeCommand) {
      fail(`deploymentEvidence[${index}].smokeCommand must be ${contract.smokeCommand}`);
    }

    if (!isIsoUtcSecond(entry.smokePassedAt)) {
      fail(`deploymentEvidence[${index}].smokePassedAt must be an ISO-8601 UTC second timestamp`);
    }

    const deploymentId = String(entry.deploymentId || '').trim();
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
