#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-deployment-evidence.sh"

fail() {
  echo "[deployment-evidence-test][error] $*" >&2
  exit 1
}

write_blocked_manifest() {
  local file="$1"
  cat >"$file" <<'JSON'
{
  "schemaVersion": 1,
  "scope": "ton-indexer-production-deployment-readiness",
  "serviceId": "ti.soramitsu.io",
  "baseUrl": "https://ti.soramitsu.io",
  "status": "blocked",
  "releaseEnabled": false,
  "blockers": [
    "production-deployment-evidence-missing",
    "live-production-smoke-failing"
  ],
  "smokeCommand": "TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production",
  "dockerBuildCommand": "docker build -t ton-indexer:release .",
  "readyVerificationCommands": [
    "npm run test:deployment-evidence-template",
    "npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json",
    "npm run test:deployment-evidence-audit",
    "npm run audit:deployment-evidence -- --require-ready",
    "docker build -t ton-indexer:release .",
    "TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production"
  ],
  "requiredEvidenceFields": [
    "commit",
    "imageDigest",
    "deploymentId",
    "baseUrl",
    "smokeCommand",
    "deployedAt",
    "smokePassedAt",
    "serviceInfo",
    "healthInfo",
    "operator"
  ],
  "deploymentEvidence": []
}
JSON
}

write_ready_manifest() {
  local file="$1"
  cat >"$file" <<'JSON'
{
  "schemaVersion": 1,
  "scope": "ton-indexer-production-deployment-readiness",
  "serviceId": "ti.soramitsu.io",
  "baseUrl": "https://ti.soramitsu.io",
  "status": "ready",
  "releaseEnabled": true,
  "blockers": [],
  "smokeCommand": "TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production",
  "dockerBuildCommand": "docker build -t ton-indexer:release .",
  "readyVerificationCommands": [
    "npm run test:deployment-evidence-template",
    "npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json",
    "npm run test:deployment-evidence-audit",
    "npm run audit:deployment-evidence -- --require-ready",
    "docker build -t ton-indexer:release .",
    "TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production"
  ],
  "requiredEvidenceFields": [
    "commit",
    "imageDigest",
    "deploymentId",
    "baseUrl",
    "smokeCommand",
    "deployedAt",
    "smokePassedAt",
    "serviceInfo",
    "healthInfo",
    "operator"
  ],
  "deploymentEvidence": [
    {
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "imageDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "deploymentId": "ti-release-20260626",
      "baseUrl": "https://ti.soramitsu.io",
      "smokeCommand": "TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production",
      "deployedAt": "2026-06-26T00:00:00Z",
      "smokePassedAt": "2026-06-26T00:00:00Z",
      "serviceInfo": {
        "schemaVersion": 1,
        "serviceId": "ti.soramitsu.io",
        "ecosystem": "ton",
        "chainId": "ton:mainnet",
        "network": "mainnet",
        "publicBaseUrl": "https://ti.soramitsu.io",
        "readOnly": true,
        "release": {
          "releaseId": "test-release-20260626",
          "manifestHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        },
        "endpoints": {
          "openapi": "/api/indexer/v1/openapi.json"
        }
      },
      "healthInfo": {
        "serviceId": "ti.soramitsu.io",
        "ecosystem": "ton",
        "chainId": "ton:mainnet",
        "network": "mainnet",
        "lastMasterSeqno": 123456
      },
      "operator": "release"
    }
  ]
}
JSON
}

run_audit() {
  local manifest="$1"
  shift
  bash "$AUDIT_SCRIPT" --evidence "$manifest" "$@"
}

expect_failure() {
  local name="$1"
  local expected="$2"
  shift 2
  local output

  set +e
  output="$("$@" 2>&1)"
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    echo "$output" >&2
    fail "$name unexpectedly passed"
  fi

  if [[ "$output" != *"$expected"* ]]; then
    echo "$output" >&2
    fail "$name did not report expected text: $expected"
  fi
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

blocked="$tmp_dir/blocked.json"
ready="$tmp_dir/ready.json"
write_blocked_manifest "$blocked"
write_ready_manifest "$ready"

run_audit "$blocked" >/dev/null
run_audit "$ready" --require-ready >/dev/null

historical_blocker="$tmp_dir/historical-blocker.json"
cp "$blocked" "$historical_blocker"
node - "$historical_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers.push('mainnet-registry-placeholders-remain');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
run_audit "$historical_blocker" >/dev/null
expect_failure "removed static registry CLI" "Unknown argument: --mainnet-registry" run_audit "$ready" --mainnet-registry "$tmp_dir/absent-registry.json" --require-ready

expect_failure "missing deployment evidence manifest" "production deployment evidence manifest missing" run_audit "$tmp_dir/missing.json"

bad_json="$tmp_dir/bad-json.json"
printf '{' >"$bad_json"
expect_failure "invalid deployment evidence JSON" "must be valid JSON" run_audit "$bad_json"

bad_schema="$tmp_dir/bad-schema.json"
cp "$blocked" "$bad_schema"
perl -0pi -e 's/"schemaVersion": 1/"schemaVersion": 2/' "$bad_schema"
expect_failure "bad schema" "schemaVersion must be 1" run_audit "$bad_schema"

release_enabled_blocked="$tmp_dir/release-enabled-blocked.json"
cp "$blocked" "$release_enabled_blocked"
perl -0pi -e 's/"releaseEnabled": false/"releaseEnabled": true/' "$release_enabled_blocked"
expect_failure "release enabled while blocked" "releaseEnabled must remain false while deployment evidence is blocked" run_audit "$release_enabled_blocked"

missing_blocker="$tmp_dir/missing-blocker.json"
cp "$blocked" "$missing_blocker"
perl -0pi -e 's/,\n    "live-production-smoke-failing"//' "$missing_blocker"
expect_failure "blocked evidence missing live smoke blocker" "blocked deployment evidence missing blocker live-production-smoke-failing" run_audit "$missing_blocker"

unsupported_blocker="$tmp_dir/unsupported-blocker.json"
cp "$blocked" "$unsupported_blocker"
node - "$unsupported_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers.push('manual-approval-pending');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported deployment evidence blocker" "unsupported deployment evidence blocker: manual-approval-pending" run_audit "$unsupported_blocker"

duplicate_blocker="$tmp_dir/duplicate-blocker.json"
cp "$blocked" "$duplicate_blocker"
node - "$duplicate_blocker" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.blockers.push('live-production-smoke-failing');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "duplicate deployment evidence blocker" "duplicate deployment evidence blocker" run_audit "$duplicate_blocker"

missing_ready_command="$tmp_dir/missing-ready-command.json"
cp "$blocked" "$missing_ready_command"
perl -0pi -e 's/npm run audit:deployment-evidence -- --require-ready/npm run audit:deployment-evidence/' "$missing_ready_command"
expect_failure "missing require-ready command" "readyVerificationCommands missing npm run audit:deployment-evidence -- --require-ready" run_audit "$missing_ready_command"

missing_template_test_command="$tmp_dir/missing-template-test-command.json"
cp "$blocked" "$missing_template_test_command"
perl -0pi -e 's/"npm run test:deployment-evidence-template",\n//' "$missing_template_test_command"
expect_failure "missing template self-test command" "readyVerificationCommands missing npm run test:deployment-evidence-template" run_audit "$missing_template_test_command"

missing_template_generator_command="$tmp_dir/missing-template-generator-command.json"
cp "$blocked" "$missing_template_generator_command"
perl -0pi -e 's/"npm run generate:deployment-evidence-template -- --output build\/reports\/production-deployment-evidence-template.json",\n//' "$missing_template_generator_command"
expect_failure "missing template generator command" "readyVerificationCommands missing npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json" run_audit "$missing_template_generator_command"

duplicate_verification_command="$tmp_dir/duplicate-verification-command.json"
cp "$blocked" "$duplicate_verification_command"
node - "$duplicate_verification_command" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.readyVerificationCommands.push('npm run test:deployment-evidence-audit');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "duplicate deployment evidence verification command" "duplicate deployment evidence verification command" run_audit "$duplicate_verification_command"

missing_field="$tmp_dir/missing-field.json"
cp "$blocked" "$missing_field"
perl -0pi -e 's/"imageDigest",\n//' "$missing_field"
expect_failure "missing image digest field" "requiredEvidenceFields missing imageDigest" run_audit "$missing_field"

missing_health_info_field="$tmp_dir/missing-health-info-field.json"
cp "$blocked" "$missing_health_info_field"
node - "$missing_health_info_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields = manifest.requiredEvidenceFields.filter((field) => field !== 'healthInfo');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing health info field" "requiredEvidenceFields missing healthInfo" run_audit "$missing_health_info_field"

duplicate_required_field="$tmp_dir/duplicate-required-field.json"
cp "$blocked" "$duplicate_required_field"
node - "$duplicate_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields.push('imageDigest');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "duplicate deployment evidence required field" "duplicate deployment evidence required field" run_audit "$duplicate_required_field"

unsupported_required_field="$tmp_dir/unsupported-required-field.json"
cp "$blocked" "$unsupported_required_field"
node - "$unsupported_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields.push('region');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported required evidence field" "unsupported deployment evidence field in manifest: region" run_audit "$unsupported_required_field"

ready_no_evidence="$tmp_dir/ready-no-evidence.json"
cp "$ready" "$ready_no_evidence"
perl -0pi -e 's/"deploymentEvidence": \[[\s\S]*?\n  \]/"deploymentEvidence": []/' "$ready_no_evidence"
expect_failure "ready evidence without live smoke" "ready deployment evidence requires at least one successful live production smoke record" run_audit "$ready_no_evidence" --require-ready

ready_with_blocker="$tmp_dir/ready-with-blocker.json"
cp "$ready" "$ready_with_blocker"
perl -0pi -e 's/"blockers": \[\]/"blockers": ["live-production-smoke-failing"]/' "$ready_with_blocker"
expect_failure "ready evidence carries blockers" "blockers must be empty when deployment evidence is ready" run_audit "$ready_with_blocker" --require-ready

bad_commit="$tmp_dir/bad-commit.json"
cp "$ready" "$bad_commit"
perl -0pi -e 's/0123456789abcdef0123456789abcdef01234567/1111/' "$bad_commit"
expect_failure "bad commit evidence" "commit must be a 40-character git commit" run_audit "$bad_commit" --require-ready

bad_digest="$tmp_dir/bad-digest.json"
cp "$ready" "$bad_digest"
perl -0pi -e 's/sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/2222/' "$bad_digest"
expect_failure "bad image digest evidence" "imageDigest must be a sha256 image digest" run_audit "$bad_digest" --require-ready

placeholder_commit="$tmp_dir/placeholder-commit.json"
cp "$ready" "$placeholder_commit"
perl -0pi -e 's/0123456789abcdef0123456789abcdef01234567/1111111111111111111111111111111111111111/' "$placeholder_commit"
expect_failure "placeholder commit evidence" "commit must not be a placeholder git commit" run_audit "$placeholder_commit" --require-ready

placeholder_digest="$tmp_dir/placeholder-digest.json"
cp "$ready" "$placeholder_digest"
perl -0pi -e 's/sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/sha256:2222222222222222222222222222222222222222222222222222222222222222/' "$placeholder_digest"
expect_failure "placeholder image digest evidence" "imageDigest must not be a placeholder image digest" run_audit "$placeholder_digest" --require-ready

placeholder_deployment_id="$tmp_dir/placeholder-deployment-id.json"
cp "$ready" "$placeholder_deployment_id"
perl -0pi -e 's/ti-release-20260626/TODO_PRODUCTION_DEPLOYMENT_ID/' "$placeholder_deployment_id"
expect_failure "placeholder deployment id evidence" "deploymentId must not be a placeholder deployment id" run_audit "$placeholder_deployment_id" --require-ready

sample_deployment_id="$tmp_dir/sample-deployment-id.json"
cp "$ready" "$sample_deployment_id"
perl -0pi -e 's/ti-release-20260626/sample-deployment/' "$sample_deployment_id"
expect_failure "sample deployment id evidence" "deploymentId must not be a placeholder deployment id" run_audit "$sample_deployment_id" --require-ready

placeholder_operator="$tmp_dir/placeholder-operator.json"
cp "$ready" "$placeholder_operator"
perl -0pi -e 's/"operator": "release"/"operator": "TODO_RELEASE_OPERATOR"/' "$placeholder_operator"
expect_failure "placeholder operator evidence" "operator must not be a placeholder operator" run_audit "$placeholder_operator" --require-ready

dummy_operator="$tmp_dir/dummy-operator.json"
cp "$ready" "$dummy_operator"
perl -0pi -e 's/"operator": "release"/"operator": "dummy operator"/' "$dummy_operator"
expect_failure "dummy operator evidence" "operator must not be a placeholder operator" run_audit "$dummy_operator" --require-ready

duplicate_deployment="$tmp_dir/duplicate-deployment.json"
cp "$ready" "$duplicate_deployment"
node - "$duplicate_deployment" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence.push({
  ...manifest.deploymentEvidence[0],
  commit: 'fedcba9876543210fedcba9876543210fedcba98',
  imageDigest: 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  smokePassedAt: '2026-06-26T00:05:00Z',
});
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "duplicate deployment id evidence" "duplicate deployment evidence id: ti-release-20260626" run_audit "$duplicate_deployment" --require-ready

wrong_base="$tmp_dir/wrong-base.json"
cp "$ready" "$wrong_base"
perl -0pi -e 's#https://ti.soramitsu.io#https://wrong.example#g' "$wrong_base"
expect_failure "wrong production base URL evidence" "baseUrl must be https://ti.soramitsu.io" run_audit "$wrong_base" --require-ready

unsupported_top_level="$tmp_dir/unsupported-top-level.json"
cp "$ready" "$unsupported_top_level"
node - "$unsupported_top_level" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.region = 'eu-central-1';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported top-level deployment evidence field" "deployment evidence.region is not supported in public deployment evidence" run_audit "$unsupported_top_level" --require-ready

unsupported_record_field="$tmp_dir/unsupported-record-field.json"
cp "$ready" "$unsupported_record_field"
node - "$unsupported_record_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].region = 'eu-central-1';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported deployment evidence record field" "deploymentEvidence[0].region is not supported in public deployment evidence" run_audit "$unsupported_record_field" --require-ready

wrong_smoke="$tmp_dir/wrong-smoke.json"
cp "$ready" "$wrong_smoke"
perl -0pi -e 's/TON_INDEXER_BASE_URL=https:\/\/ti\.soramitsu\.io npm run smoke:production/npm run smoke:production/g' "$wrong_smoke"
expect_failure "wrong production smoke command evidence" "smokeCommand must be TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production" run_audit "$wrong_smoke" --require-ready

missing_service_info="$tmp_dir/missing-service-info.json"
cp "$ready" "$missing_service_info"
node - "$missing_service_info" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
delete manifest.deploymentEvidence[0].serviceInfo;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing service info evidence" "serviceInfo must be an object" run_audit "$missing_service_info" --require-ready

wrong_service_info_schema_version="$tmp_dir/wrong-service-info-schema-version.json"
cp "$ready" "$wrong_service_info_schema_version"
node - "$wrong_service_info_schema_version" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.schemaVersion = 2;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong service info schema version evidence" "serviceInfo.schemaVersion must be 1" run_audit "$wrong_service_info_schema_version" --require-ready

wrong_service_info_id="$tmp_dir/wrong-service-info-id.json"
cp "$ready" "$wrong_service_info_id"
node - "$wrong_service_info_id" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.serviceId = 'si.soramitsu.io';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong service info service id evidence" "serviceInfo.serviceId must be ti.soramitsu.io" run_audit "$wrong_service_info_id" --require-ready

wrong_service_info_network="$tmp_dir/wrong-service-info-network.json"
cp "$ready" "$wrong_service_info_network"
node - "$wrong_service_info_network" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.network = 'testnet';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong service info network evidence" "serviceInfo.network must be mainnet" run_audit "$wrong_service_info_network" --require-ready

wrong_service_info_endpoint="$tmp_dir/wrong-service-info-endpoint.json"
cp "$ready" "$wrong_service_info_endpoint"
node - "$wrong_service_info_endpoint" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.endpoints.openapi = '/openapi.json';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong service info endpoint evidence" "serviceInfo.endpoints.openapi must be /api/indexer/v1/openapi.json" run_audit "$wrong_service_info_endpoint" --require-ready

unsupported_service_info_field="$tmp_dir/unsupported-service-info-field.json"
cp "$ready" "$unsupported_service_info_field"
node - "$unsupported_service_info_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.adminUrl = 'https://internal.example';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported service info evidence field" "deploymentEvidence[0].serviceInfo.adminUrl is not supported in public deployment evidence" run_audit "$unsupported_service_info_field" --require-ready

invalid_release="$tmp_dir/invalid-release.json"
cp "$ready" "$invalid_release"
node - "$invalid_release" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.release = [];
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "invalid release identity" "serviceInfo.release must be an object" run_audit "$invalid_release" --require-ready

bad_release_hash="$tmp_dir/bad-release-hash.json"
cp "$ready" "$bad_release_hash"
node - "$bad_release_hash" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.release.manifestHash = 'bad';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "malformed release hash" "serviceInfo.release.manifestHash must be a lowercase SHA-256 digest" run_audit "$bad_release_hash" --require-ready

removed_release_alias="$tmp_dir/removed-release-alias.json"
cp "$ready" "$removed_release_alias"
node - "$removed_release_alias" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].serviceInfo.registry_hash = manifest.deploymentEvidence[0].serviceInfo.release.manifestHash;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "removed release alias" "serviceInfo.registry_hash is not supported" run_audit "$removed_release_alias" --require-ready

missing_health_info="$tmp_dir/missing-health-info.json"
cp "$ready" "$missing_health_info"
node - "$missing_health_info" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
delete manifest.deploymentEvidence[0].healthInfo;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing health info evidence" "healthInfo must be an object" run_audit "$missing_health_info" --require-ready

wrong_health_info_id="$tmp_dir/wrong-health-info-id.json"
cp "$ready" "$wrong_health_info_id"
node - "$wrong_health_info_id" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].healthInfo.serviceId = 'si.soramitsu.io';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong health info service id evidence" "healthInfo.serviceId must be ti.soramitsu.io" run_audit "$wrong_health_info_id" --require-ready

wrong_health_info_network="$tmp_dir/wrong-health-info-network.json"
cp "$ready" "$wrong_health_info_network"
node - "$wrong_health_info_network" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].healthInfo.network = 'testnet';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong health info network evidence" "healthInfo.network must be mainnet" run_audit "$wrong_health_info_network" --require-ready

missing_last_master_seqno="$tmp_dir/missing-last-master-seqno.json"
cp "$ready" "$missing_last_master_seqno"
node - "$missing_last_master_seqno" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
delete manifest.deploymentEvidence[0].healthInfo.lastMasterSeqno;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing health last master seqno evidence" "healthInfo.lastMasterSeqno must be a non-negative integer" run_audit "$missing_last_master_seqno" --require-ready

bad_last_master_seqno="$tmp_dir/bad-last-master-seqno.json"
cp "$ready" "$bad_last_master_seqno"
node - "$bad_last_master_seqno" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].healthInfo.lastMasterSeqno = -1;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "bad health last master seqno evidence" "healthInfo.lastMasterSeqno must be a non-negative integer" run_audit "$bad_last_master_seqno" --require-ready

solana_health_field="$tmp_dir/solana-health-field.json"
cp "$ready" "$solana_health_field"
node - "$solana_health_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].healthInfo.ok = true;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "solana health field in ton evidence" "healthInfo.ok is not supported in public deployment evidence" run_audit "$solana_health_field" --require-ready

unsupported_health_info_field="$tmp_dir/unsupported-health-info-field.json"
cp "$ready" "$unsupported_health_info_field"
node - "$unsupported_health_info_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.deploymentEvidence[0].healthInfo.adminUrl = 'https://internal.example';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported health info evidence field" "deploymentEvidence[0].healthInfo.adminUrl is not supported in public deployment evidence" run_audit "$unsupported_health_info_field" --require-ready

bad_timestamp="$tmp_dir/bad-timestamp.json"
cp "$ready" "$bad_timestamp"
perl -0pi -e 's/"smokePassedAt": "2026-06-26T00:00:00Z"/"smokePassedAt": "2026-06-26"/' "$bad_timestamp"
expect_failure "bad smoke timestamp evidence" "smokePassedAt must be an ISO-8601 UTC second timestamp" run_audit "$bad_timestamp" --require-ready

bad_deployed_timestamp="$tmp_dir/bad-deployed-timestamp.json"
cp "$ready" "$bad_deployed_timestamp"
perl -0pi -e 's/"deployedAt": "2026-06-26T00:00:00Z"/"deployedAt": "2026-06-26"/' "$bad_deployed_timestamp"
expect_failure "bad deployed timestamp evidence" "deployedAt must be an ISO-8601 UTC second timestamp" run_audit "$bad_deployed_timestamp" --require-ready

future_timestamp="$tmp_dir/future-timestamp.json"
cp "$ready" "$future_timestamp"
perl -0pi -e 's/"smokePassedAt": "2026-06-26T00:00:00Z"/"smokePassedAt": "2999-01-01T00:00:00Z"/' "$future_timestamp"
expect_failure "future smoke timestamp evidence" "smokePassedAt must not be in the future" run_audit "$future_timestamp" --require-ready

future_deployed_timestamp="$tmp_dir/future-deployed-timestamp.json"
cp "$ready" "$future_deployed_timestamp"
perl -0pi -e 's/"deployedAt": "2026-06-26T00:00:00Z"/"deployedAt": "2999-01-01T00:00:00Z"/' "$future_deployed_timestamp"
expect_failure "future deployed timestamp evidence" "deployedAt must not be in the future" run_audit "$future_deployed_timestamp" --require-ready

smoke_before_deployment="$tmp_dir/smoke-before-deployment.json"
cp "$ready" "$smoke_before_deployment"
perl -0pi -e 's/"deployedAt": "2026-06-26T00:00:00Z"/"deployedAt": "2026-06-26T00:05:00Z"/' "$smoke_before_deployment"
expect_failure "smoke before deployment evidence" "smokePassedAt must be at or after deployedAt" run_audit "$smoke_before_deployment" --require-ready

secret_top_level="$tmp_dir/secret-top-level.json"
cp "$ready" "$secret_top_level"
perl -0pi -e 's/"deploymentEvidence": \[/"privateKey": "do-not-commit",\n  "deploymentEvidence": [/' "$secret_top_level"
expect_failure "secret-like deployment evidence key" "must not be included in public deployment evidence" run_audit "$secret_top_level" --require-ready

secret_nested="$tmp_dir/secret-nested.json"
cp "$ready" "$secret_nested"
perl -0pi -e 's/"operator": "release"/"operator": "release",\n      "authorization": "Bearer do-not-commit"/' "$secret_nested"
expect_failure "nested secret-like deployment evidence key" "must not be included in public deployment evidence" run_audit "$secret_nested" --require-ready

echo "[deployment-evidence-test] all assertions passed"
