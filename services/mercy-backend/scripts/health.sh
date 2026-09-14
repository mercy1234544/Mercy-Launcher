#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="$(node -e "console.log(require('./shared/env').PORT)" 2>/dev/null || echo 4200)"
curl -fsS "http://127.0.0.1:${PORT}/health" | (command -v jq >/dev/null && jq . || cat)
