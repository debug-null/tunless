#!/bin/sh
# 从打包产物做隔离安装并跑验收。不改系统代理，不读凭据，不调用模型。
# 用法：scripts/recheck-install.sh tunless-0.12.0.tgz [日志目录]
set -eu
tgz=$1
log_dir=${2:-/tmp/tunless-recheck}
mkdir -p "$log_dir"
prefix=$(mktemp -d)
home=$(mktemp -d)
export HOME=$home
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy || true
npm install --prefix "$prefix" --force "$tgz" >"$log_dir/npm-install.log"
pkg=$prefix/node_modules/tunless
bin=$prefix/node_modules/.bin/tunless
node "$pkg/scripts/round1-accept.mjs" | tee "$log_dir/functional-accept.log"
python3 "$pkg/scripts/pty-smoke.py" "$bin" "$home" "$log_dir/tui-pty.log" | tee "$log_dir/tui-pty.txt"
echo "安装前缀 $prefix"
echo "临时 HOME $home"
echo "日志目录 $log_dir"
