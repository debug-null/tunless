#!/usr/bin/env bash
# 临时公钥部署服务：远端只需跑一句短命令即可安装本机 SSH 公钥。
# 解决「让用户粘贴长命令/长 URL 必被终端折行截断」的问题。
#
# 用法:  bash serve-pubkey.sh [端口]      默认 8877
# 输出:  一条发给远端用户执行的 curl|sh 短命令
# 停止:  Ctrl-C（用完必须关——公钥在整个 tailnet/局域网可见）
set -euo pipefail

PORT="${1:-8877}"
DIR="$(mktemp -d /tmp/sshpub.XXXXXX)"

# 1) 找本机公钥：优先 agent 里的，再退回文件
PUB="$(ssh-add -L 2>/dev/null | head -1 || true)"
if [ -z "$PUB" ]; then
  for f in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub ~/.ssh/id_ecdsa.pub; do
    [ -f "$f" ] && { PUB="$(cat "$f")"; break; }
  done
fi
[ -n "$PUB" ] || { echo "找不到本机公钥：先生成 ssh-keygen -t ed25519" >&2; exit 1; }
echo "$PUB" > "$DIR/tk-pubkey"

# 2) 远端执行脚本：装 key、清误粘贴垃圾行、回显结果
cat > "$DIR/s" << 'EOF'
#!/bin/sh
set -e
mkdir -p ~/.ssh && chmod 700 ~/.ssh
# 清掉之前粘贴翻车写进去的非 key 行（如 404 HTML）
if [ -f ~/.ssh/authorized_keys ]; then
  grep -E '^(ssh-|ecdsa-|sk-)' ~/.ssh/authorized_keys > ~/.ssh/ak.tmp 2>/dev/null || true
  mv ~/.ssh/ak.tmp ~/.ssh/authorized_keys
fi
KEY="$(curl -s http://__HOST__:__PORT__/tk-pubkey)"
[ -n "$KEY" ] || { echo "拉取公钥失败"; exit 1; }
grep -qF "$KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
echo "KEYS:$(grep -cE '^(ssh-|ecdsa-|sk-)' ~/.ssh/authorized_keys) USER:$(whoami)"
EOF

# 3) 探测对外地址：优先 Tailscale IPv4，退回局域网 IP
HOST="$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null | head -1 || true)"
HOST="${HOST:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
[ -n "$HOST" ] || { echo "拿不到本机对外 IP" >&2; exit 1; }
sed -i '' "s/__HOST__/$HOST/g; s/__PORT__/$PORT/g" "$DIR/s"

cat << BANNER

  在目标机器执行（很短，不怕换行）：

    curl -s http://$HOST:$PORT/s | sh

  成功会输出  KEYS:n USER:name —— 拿 USER 值 ssh 过去。
  用完回到这里按 Ctrl-C 关服务。

BANNER

cd "$DIR" && exec python3 -m http.server "$PORT" --bind 0.0.0.0
