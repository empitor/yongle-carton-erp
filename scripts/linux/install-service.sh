#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo '请由服务器管理员用 sudo 安装。' >&2; exit 1; }
APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
[ "$APP_ROOT" = /opt/yongle-carton-erp ] || { echo '请先将安装包放到 /opt/yongle-carton-erp。' >&2; exit 1; }
[ -f "$APP_ROOT/.release-package" ] || { echo '请使用通过验收的发布包。' >&2; exit 1; }
# 不自动安装软件、不改防火墙；首次启动前先编辑真实域名。
id yongle-erp >/dev/null 2>&1 || useradd --system --home-dir /var/lib/yongle-carton-erp --shell /usr/sbin/nologin yongle-erp
install -d -o yongle-erp -g yongle-erp -m 0700 /var/lib/yongle-carton-erp /var/lib/yongle-carton-erp/data /var/lib/yongle-carton-erp/backups /var/lib/yongle-carton-erp/config
install -d -o root -g yongle-erp -m 0750 /etc/yongle-carton-erp
if [ ! -e /etc/yongle-carton-erp/erp.env ]; then
    install -o root -g yongle-erp -m 0640 "$APP_ROOT/scripts/linux/erp.env.example" /etc/yongle-carton-erp/erp.env
fi
install -o root -g root -m 0644 "$APP_ROOT/scripts/linux/yongle-carton-erp.service" /etc/systemd/system/yongle-carton-erp.service
chmod 0755 "$APP_ROOT/scripts/linux/erp.sh"
systemctl daemon-reload
systemctl enable yongle-carton-erp.service
echo '已安装并设置开机自启，尚未启动。编辑 /etc/yongle-carton-erp/erp.env，安装字体并核对 Caddy 后运行：sudo systemctl start yongle-carton-erp'
