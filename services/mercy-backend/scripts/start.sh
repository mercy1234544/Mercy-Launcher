#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pm2 start ecosystem.config.js
