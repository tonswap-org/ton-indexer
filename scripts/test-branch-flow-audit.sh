#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit-branch-flow.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

write_valid_repo() {
  local repo="$1"
  mkdir -p "$repo/.github/workflows"

  cat > "$repo/.github/workflows/ci.yml" <<'EOF'
name: CI
on:
  push:
    branches:
      - develop
      - master
  pull_request:
    branches:
      - develop
      - master
EOF

  cat > "$repo/.github/workflows/branch-flow.yml" <<'EOF'
name: Branch Flow
on:
  pull_request:
jobs:
  validate:
    steps:
      - name: Validate PR target
        env:
          BASE_BRANCH: ${{ github.base_ref }}
          HEAD_BRANCH: ${{ github.head_ref }}
        run: |
          if [[ "$BASE_BRANCH" == "master" ]]; then
            if [[ "$HEAD_BRANCH" == "develop" || "$HEAD_BRANCH" == release/* || "$HEAD_BRANCH" == hotfix/* ]]; then
              exit 0
            fi
            echo "master is releasable"
          fi
EOF

  cat > "$repo/.github/pull_request_template.md" <<'EOF'
## Target Branch

- [ ] This PR targets `develop`
- [ ] This PR targets `master` and is a release or hotfix PR

## Checklist

- [ ] No direct-to-`master` workflow is introduced
EOF

  cat > "$repo/CONTRIBUTING.md" <<'EOF'
# Contributing

## Git Flow

All normal work starts from `develop` and is submitted back to `develop`.
Use `release/*` and `hotfix/*` branches only for promotion to `master`.
`master` is the releasable branch.
EOF
}

expect_pass() {
  local repo="$1"
  bash "$AUDIT_SCRIPT" "$repo" >/dev/null
}

expect_fail() {
  local repo="$1"
  local label="$2"
  local output="$TMP_DIR/$label.out"

  if bash "$AUDIT_SCRIPT" "$repo" >"$output" 2>&1; then
    echo "[branch-flow-audit-test] ERROR: expected failure for $label" >&2
    exit 1
  fi

  if ! grep -q "ERROR" "$output"; then
    echo "[branch-flow-audit-test] ERROR: $label failed without an audit error" >&2
    cat "$output" >&2
    exit 1
  fi
}

VALID_REPO="$TMP_DIR/valid"
write_valid_repo "$VALID_REPO"
expect_pass "$VALID_REPO"

STAGING_WORKFLOW_REPO="$TMP_DIR/staging-workflow"
write_valid_repo "$STAGING_WORKFLOW_REPO"
cat > "$STAGING_WORKFLOW_REPO/.github/workflows/ci.yml" <<'EOF'
name: CI
on:
  push:
    branches: [ develop, master, staging ]
EOF
expect_fail "$STAGING_WORKFLOW_REPO" "staging-workflow"

MISSING_BRANCH_FLOW_REPO="$TMP_DIR/missing-branch-flow"
write_valid_repo "$MISSING_BRANCH_FLOW_REPO"
rm "$MISSING_BRANCH_FLOW_REPO/.github/workflows/branch-flow.yml"
expect_fail "$MISSING_BRANCH_FLOW_REPO" "missing-branch-flow"

MISSING_CI_TARGET_REPO="$TMP_DIR/missing-ci-target"
write_valid_repo "$MISSING_CI_TARGET_REPO"
cat > "$MISSING_CI_TARGET_REPO/.github/workflows/ci.yml" <<'EOF'
name: CI
on:
  pull_request:
    branches:
      - master
EOF
expect_fail "$MISSING_CI_TARGET_REPO" "missing-ci-target"

UNRESTRICTED_MASTER_TEMPLATE_REPO="$TMP_DIR/unrestricted-master-template"
write_valid_repo "$UNRESTRICTED_MASTER_TEMPLATE_REPO"
cat > "$UNRESTRICTED_MASTER_TEMPLATE_REPO/.github/pull_request_template.md" <<'EOF'
## Target Branch

- [ ] This PR targets `develop`
- [ ] This PR targets `master`
EOF
expect_fail "$UNRESTRICTED_MASTER_TEMPLATE_REPO" "unrestricted-master-template"

echo "[branch-flow-audit-test] Branch flow audit self-test passed."
