#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${TODO_AUDIT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BASELINE_FILE="${TODO_AUDIT_BASELINE:-$ROOT_DIR/config/todo-debt-baseline.tsv}"

log() { echo "[todo-audit] $*"; }
fail() {
  echo "[todo-audit][error] $*" >&2
  exit 1
}

command -v rg >/dev/null 2>&1 || fail "ripgrep (rg) is required."
[[ -d "$ROOT_DIR" ]] || fail "Root directory does not exist: $ROOT_DIR"
[[ -f "$BASELINE_FILE" ]] || fail "Baseline file does not exist: $BASELINE_FILE"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

current="$tmp_dir/current.tsv"
baseline="$tmp_dir/baseline.tsv"
new_markers="$tmp_dir/new.tsv"
stale_markers="$tmp_dir/stale.tsv"
crashing_placeholders="$tmp_dir/crashing_placeholders.txt"

scan_marker_debt() {
  (
    cd "$ROOT_DIR"
    rg -n --no-heading -i '\b(todo|fixme|stopship)\b' \
      --glob '*.{js,jsx,ts,tsx,vue,mjs,cjs}' \
      --glob '!node_modules/**' \
      --glob '!dist/**' \
      --glob '!build/**' \
      --glob '!coverage/**' \
      --glob '!.nuxt/**' \
      --glob '!.output/**' \
      --glob '!**/.git/**' \
      . || true
  ) | awk -F: '
    {
      line = $0
      sub(/^[^:]+:[0-9]+:/, "", line)
      path = $1
      sub(/^\.\//, "", path)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      print path "\t" line
    }
  ' | LC_ALL=C sort
}

scan_crashing_placeholders() {
  (
    cd "$ROOT_DIR"
    rg -n --no-heading -i 'throw[[:space:]]+(new[[:space:]]+)?Error[[:space:]]*\([^)]*(TODO|FIXME|STOPSHIP)' \
      --glob '*.{js,jsx,ts,tsx,vue,mjs,cjs}' \
      --glob '!node_modules/**' \
      --glob '!dist/**' \
      --glob '!build/**' \
      --glob '!coverage/**' \
      --glob '!.nuxt/**' \
      --glob '!.output/**' \
      --glob '!**/.git/**' \
      . || true
  )
}

awk 'NF && $0 !~ /^#/' "$BASELINE_FILE" | LC_ALL=C sort > "$baseline"
scan_marker_debt > "$current"
scan_crashing_placeholders > "$crashing_placeholders"

if [[ -s "$crashing_placeholders" ]]; then
  echo "Crashing TODO/FIXME placeholders are forbidden:" >&2
  sed -n '1,40p' "$crashing_placeholders" >&2
  fail "Remove throw Error TODO placeholders instead of baselining them."
fi

comm -23 "$current" "$baseline" > "$new_markers"
comm -13 "$current" "$baseline" > "$stale_markers"

if [[ -s "$new_markers" ]]; then
  echo "New TODO/FIXME/STOPSHIP markers found outside the baseline:" >&2
  sed -n '1,80p' "$new_markers" >&2
  fail "Resolve the markers or intentionally update config/todo-debt-baseline.tsv."
fi

if [[ -s "$stale_markers" ]]; then
  echo "Baseline entries no longer exist in source:" >&2
  sed -n '1,80p' "$stale_markers" >&2
  fail "Remove stale entries from config/todo-debt-baseline.tsv."
fi

log "TODO/FIXME debt matches baseline."
