#!/bin/sh
set -eu
APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
NODE="$APP_ROOT/runtime/node/bin/node"
if [ ! -x "$NODE" ]; then NODE=$(command -v node); fi
cd "$APP_ROOT"
ENV_FILE=${ERP_ENV_FILE:-/etc/yongle-carton-erp/erp.env}
action=${1:-start}
if [ "$#" -gt 0 ]; then shift; fi
case "$action" in
  start) entry=server/index.ts ;;
  stop) entry=server/stop.ts ;;
  backup|restore|reset-password) entry=server/maintenance.ts; set -- "$action" "$@" ;;
  *) echo '用法：erp.sh start|stop|backup|restore 备份目录|reset-password 用户名' >&2; exit 2 ;;
esac
exec "$NODE" --env-file-if-exists="$ENV_FILE" --import "$APP_ROOT/node_modules/tsx/dist/loader.mjs" "$APP_ROOT/$entry" "$@"
