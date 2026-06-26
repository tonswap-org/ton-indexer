#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GENERATOR_SCRIPT="$SCRIPT_DIR/generate-deployment-evidence-template.sh"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-deployment-evidence.sh"
DEFAULT_MANIFEST="$SCRIPT_DIR/production-deployment-evidence.json"

fail() {
  echo "[deployment-evidence-template-test][error] $*" >&2
  exit 1
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

stdout_template="$tmp_dir/stdout-template.json"
output_template="$tmp_dir/output-template.json"
separator_template="$tmp_dir/separator-template.json"

bash "$GENERATOR_SCRIPT" --evidence "$DEFAULT_MANIFEST" >"$stdout_template"
bash "$GENERATOR_SCRIPT" --evidence "$DEFAULT_MANIFEST" --output "$output_template" >"$tmp_dir/output-stdout.json"
cmp "$output_template" "$tmp_dir/output-stdout.json" >/dev/null || fail "template output file must match stdout"
cmp "$stdout_template" "$output_template" >/dev/null || fail "template generation must be deterministic"

bash "$GENERATOR_SCRIPT" -- --evidence "$DEFAULT_MANIFEST" --output "$separator_template" >"$tmp_dir/separator-stdout.json"
cmp "$output_template" "$separator_template" >/dev/null || fail "template generation must accept a standalone argument separator"
cmp "$separator_template" "$tmp_dir/separator-stdout.json" >/dev/null || fail "separator template output file must match stdout"

node - "$output_template" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
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

check(manifest.schemaVersion === 1, 'schemaVersion must be 1');
check(manifest.status === 'ready', 'template must show the operator target status');
check(manifest.releaseEnabled === true, 'template must show the operator target releaseEnabled value');
check(Array.isArray(manifest.blockers) && manifest.blockers.length === 0, 'template blockers must be empty');
check(Array.isArray(manifest.deploymentEvidence) && manifest.deploymentEvidence.length === 1, 'template must contain one deployment evidence record');
check(secretLikeKeyReason(manifest) === null, 'template must not contain secret-like keys');

const evidence = manifest.deploymentEvidence[0] || {};
check(evidence.commit === 'TODO_40_HEX_GIT_COMMIT', 'commit placeholder mismatch');
check(evidence.imageDigest === 'sha256:TODO_64_HEX_IMAGE_DIGEST', 'image digest placeholder mismatch');
check(evidence.deploymentId === 'TODO_PRODUCTION_DEPLOYMENT_ID', 'deployment id placeholder mismatch');
check(evidence.baseUrl === manifest.baseUrl, 'baseUrl must be copied from manifest');
check(evidence.smokeCommand === manifest.smokeCommand, 'smokeCommand must be copied from manifest');
check(evidence.smokePassedAt === 'TODO_UTC_SMOKE_TIMESTAMP_SECONDS', 'smoke timestamp placeholder mismatch');
check(evidence.operator === 'TODO_RELEASE_OPERATOR', 'operator placeholder mismatch');

for (const field of manifest.requiredEvidenceFields || []) {
  check(Object.prototype.hasOwnProperty.call(evidence, field), `${field} missing from template evidence`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
NODE

expect_failure \
  "template cannot pass ready audit with TODO placeholders" \
  "commit must be a 40-character git commit" \
  bash "$AUDIT_SCRIPT" --evidence "$output_template" --require-ready

expect_failure "unknown generator argument" "Unknown argument" bash "$GENERATOR_SCRIPT" --nope
expect_failure "missing output argument" "--output requires a path" bash "$GENERATOR_SCRIPT" --output
expect_failure "missing manifest" "production deployment evidence manifest missing" bash "$GENERATOR_SCRIPT" --evidence "$tmp_dir/missing.json"

bad_json="$tmp_dir/bad-json.json"
printf '{' >"$bad_json"
expect_failure "invalid manifest JSON" "must be valid JSON" bash "$GENERATOR_SCRIPT" --evidence "$bad_json"

bad_scope="$tmp_dir/bad-scope.json"
cp "$DEFAULT_MANIFEST" "$bad_scope"
node - "$bad_scope" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.scope = 'wrong-production-deployment-readiness';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "wrong evidence scope" "scope must be" bash "$GENERATOR_SCRIPT" --evidence "$bad_scope"

missing_required_field="$tmp_dir/missing-required-field.json"
cp "$DEFAULT_MANIFEST" "$missing_required_field"
node - "$missing_required_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields = manifest.requiredEvidenceFields.filter((field) => field !== 'imageDigest');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing image digest field" "requiredEvidenceFields missing imageDigest" bash "$GENERATOR_SCRIPT" --evidence "$missing_required_field"

unsupported_field="$tmp_dir/unsupported-field.json"
cp "$DEFAULT_MANIFEST" "$unsupported_field"
node - "$unsupported_field" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.requiredEvidenceFields.push('region');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "unsupported evidence field" "unsupported deployment evidence field in manifest: region" bash "$GENERATOR_SCRIPT" --evidence "$unsupported_field"

secret_manifest="$tmp_dir/secret-manifest.json"
cp "$DEFAULT_MANIFEST" "$secret_manifest"
node - "$secret_manifest" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.authorization = 'Bearer do-not-commit';
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "secret-like manifest key" "must not be read from public deployment evidence manifest" bash "$GENERATOR_SCRIPT" --evidence "$secret_manifest"

missing_template_command="$tmp_dir/missing-template-command.json"
cp "$DEFAULT_MANIFEST" "$missing_template_command"
node - "$missing_template_command" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.readyVerificationCommands = manifest.readyVerificationCommands.filter((command) => !command.includes('generate:deployment-evidence-template'));
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure "missing template generator command" "readyVerificationCommands missing npm run generate:deployment-evidence-template" bash "$GENERATOR_SCRIPT" --evidence "$missing_template_command"

echo "[deployment-evidence-template-test] all assertions passed"
