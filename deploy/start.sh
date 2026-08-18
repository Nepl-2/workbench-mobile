#!/usr/bin/env bash
# 手机工作媒介 · 桥接服务 启动脚本
set -euo pipefail
cd "$(dirname "$0")/../bridge"

# —— 部署配置（按需修改）——
export WORKBENCH_PORT="${WORKBENCH_PORT:-8090}"
export WORKBENCH_HOST="${WORKBENCH_HOST:-127.0.0.1}"   # 内外网用 0.0.0.0 或 Zerotier 网卡 IP
export WORKBENCH_DSH_BASE="${WORKBENCH_DSH_BASE:-http://127.0.0.1:3080}"
export WORKBENCH_WORK_DIRS="${WORKBENCH_WORK_DIRS:-/path/to/工作目录}"
export WORKBENCH_ACCESS_TOKEN="${WORKBENCH_ACCESS_TOKEN:-$(cat "$(dirname "$0")/.access_token")}"

exec /usr/local/bin/node --max-old-space-size=512 server.mjs
