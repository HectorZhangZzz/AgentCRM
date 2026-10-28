#!/usr/bin/env bash
set -euo pipefail
crm_open_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
"$crm_open_root/ops/crm" start
crm_node_path="$(command -v node || true)"
if [[ -z "$crm_node_path" && -x "$HOME/.local/bin/node" ]]; then
  crm_node_path="$HOME/.local/bin/node"
fi
if [[ -z "$crm_node_path" ]]; then
  printf '%s\n' 'Agent CRM 需要 Node.js 24，请按 docs/INSTALL.md 安装。' >&2
  exit 1
fi
exec "$crm_node_path" "$crm_open_root/src/cli.mjs" open
