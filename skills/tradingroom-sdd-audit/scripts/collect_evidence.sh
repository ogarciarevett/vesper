#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="${1:-$ROOT_DIR/reports/tradingroom-sdd-audit-$STAMP.md}"

mkdir -p "$(dirname "$OUT_FILE")"

run_block() {
  local title="$1"
  shift

  {
    echo "## $title"
    echo
    echo '```bash'
    printf '%q ' "$@"
    echo
    echo '```'
    echo
  } >>"$OUT_FILE"

  local output
  local status=0
  if output="$("$@" 2>&1)"; then
    status=0
  else
    status=$?
  fi

  {
    echo '```text'
    printf '%s\n' "$output"
    echo
    echo "exit_code=$status"
    echo '```'
    echo
  } >>"$OUT_FILE"
}

{
  echo "# TradingRoom SDD Audit Evidence"
  echo
  echo "- generated_at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "- repo_root: $ROOT_DIR"
  echo
} >"$OUT_FILE"

run_block "Repository Status" bash -lc "cd '$ROOT_DIR' && git status --short"
run_block "Root Scripts" bash -lc "cd '$ROOT_DIR' && cat package.json"
run_block "Turbo Build Dry-Run" bash -lc "cd '$ROOT_DIR' && ./node_modules/.bin/turbo run build --dry"
run_block "Turbo Test Dry-Run" bash -lc "cd '$ROOT_DIR' && ./node_modules/.bin/turbo run test --dry"
run_block "Legacy Naming Drift Scan" bash -lc "cd '$ROOT_DIR' && rg -n 'mission-control|GameRoom|useGameSocket' README.md specs apps || true"
run_block "Realtime Contract Scan" bash -lc "cd '$ROOT_DIR' && rg -n 'ROOM_STATE|TRADE_EVENT|FULL_STATE|STATE_DELTA|agentId|doId' packages/types apps/engine-api apps/agent-dashboard || true"
run_block "Auth Coverage Scan" bash -lc "cd '$ROOT_DIR' && rg -n 'OPENCLAW_GATEWAY_PASSWORD|x-openclaw-gateway-password|gateway_password' apps/engine-api apps/agent-dashboard .dev.vars.example README.md || true"
run_block "Emergency Stop Coverage Scan" bash -lc "cd '$ROOT_DIR' && rg -n 'emergency-stop|performEmergencyStop|/stop' apps/engine-api/src || true"
run_block "Skill Checklist Snapshot" bash -lc "cd '$ROOT_DIR' && cat skills/tradingroom-sdd-audit/references/checklist.md"

echo "Evidence report generated at: $OUT_FILE"
