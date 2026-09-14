#!/usr/bin/env bash
set -euo pipefail
pm2 logs mercy-relay --lines "${1:-100}"
