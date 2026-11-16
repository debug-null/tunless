---
name: remote-mac-debug
description: 通过 Tailscale + SSH 连接并调试另一台 Mac（或局域网/内网主机）的完整 playbook——从建立连接、开远程登录、免密公钥部署，到非交互 SSH 的 PATH 坑、版本漂移排查、mihomo/Clash 上游 API 操作、出口地区检测、收尾清场。只要用户说「另一台电脑」「远程连一下」「用 Tailscale 连」「帮我到 xx 机器上看看」「那台 Mac 上不行」或给出另一台主机的 IP/主机名要求排查问题，就用本 skill。也适用于任何需要 SSH 到远端 macOS 做服务/代理/网络诊断的任务。
---

# 远程 Mac 调试 Playbook

把「在另一台电脑上调试」拆成四个阶段：**连通 → 开门 → 诊断 → 清场**。每个阶段都有已知坑，照单子走别跳步。

## 阶段 0：先问清楚两件事

动手前从用户处确认（对话里已有就别再问）：

1. **目标是谁**：Tailscale 主机名 / IP / Tailscale 100.x 地址
2. **远端用户名**：让用户在目标机跑 `whoami`——别猜，家目录名和用户名常常对不上（本次实测：家目录 `/Users/user`，用户名 `user`，而不是猜测的 `pseudo`）

## 阶段 1：连通（先局域网，不行再 Tailscale）

**别假设「同一内网 = 互可路由」**。公司内网常按楼层/SSID 划 VLAN，
`10.161.118.x` 和 `10.161.116.x` 看着像一家人，实测 `No route to host`。
真实案例：用户坚称两台 Mac 同网段，ping 全丢——VLAN 隔离，最后靠 Tailscale 打通。

```bash
# 第一步：拿目标局域网 IP（用户在那台机器跑 ipconfig getifaddr en0）
# 或直接 ping 主机名：  ping -c1 <hostname>.local
nc -z -w 3 <lan-ip> 22        # 通了 → 直接用 LAN IP，跳过后续
ping -c1 -t2 <lan-ip>         # No route to host / 全丢 → VLAN 隔离，走 Tailscale
```

LAN 不通时上 Tailscale：

```bash
# 本机 tailnet 状态 + 设备列表
/Applications/Tailscale.app/Contents/MacOS/Tailscale status

# 本机没上线
open -a Tailscale   # 或 tailscale up

# 目标在线性验证
tailscale ping <host-or-ip>   # direct = P2P 直连；via DERP = 中继（慢但能用）
nc -z -w 3 <100.x ip> 22      # SSH 门开没开
```

目标显示 `offline` → 让用户在那台机器上打开 Tailscale（菜单栏图标 → Connect）。

**架构认知**：Tailscale 只负责「送到门口」（NAT/VLAN 穿透的虚拟网线），
SSH 认证仍是 macOS sshd 的公钥——两层别混。同 LAN 时不用它，
跨 VLAN/跨网络时它是免配置的直达通路。

## 阶段 2：开门（SSH 访问）

### 2a. 22 端口关着 → 开远程登录

macOS 上**优先远程登录**，不要先推 Tailscale SSH——App Store 版 Tailscale 不能当 SSH 服务端，要走 `brew tailscaled` + ACL，步骤翻倍。

让用户操作：**系统设置 → 通用 → 共享 → 远程登录 → 开**（弹窗选「仅这些用户」保持管理员即可）。

### 2b. 端口开了但 pubkey 被拒 → 部署公钥

`Permission denied (publickey)` 说明本机密钥不在远端 `authorized_keys`。把公钥发过去——

**大坑：让用户粘贴长命令必翻车**。终端粘贴会把 `&&` 长链在任意位置折行，出现 `chmod: a: No such file`、`command not found: uthorized_keys` 这种灵异错误；长 URL 也一样会断成 404。

**解法：本机起个临时 HTTP 服务，让远端跑一句 40 字符内的短命令**。用本 skill 附带的 `scripts/serve-pubkey.sh`（相对本文件所在目录）：

```bash
bash scripts/serve-pubkey.sh
# 输出形如：  curl -s http://100.x.x.x:8877/s | sh
```

把这一行发给用户在远端跑。脚本做三件事：建 `~/.ssh` 并修权限、写入本机公钥（幂等，去重）、清掉之前误粘贴进来的垃圾行，最后回显 `KEYS:n USER:name` 方便确认。

服务用完**必须关掉**（Ctrl-C 或 kill），它把整个公钥暴露在 tailnet 上。

验证连通：`ssh -o BatchMode=yes -o ConnectTimeout=5 user@<ip> whoami`

## 阶段 3：诊断（非交互 SSH 的活儿）

### 必记坑位

- **永远带 `-o BatchMode=yes`**：防止卡在密码/确认提示上把会话挂死
- **非交互 SSH 不加载 nvm/fnm 的 PATH**：`node`/`npm` 直接 `command not found`。先找绝对路径：
  ```bash
  ssh user@ip 'ls ~/.nvm/versions/node/'     # 找到 v24.14.0 之类
  N=~/.nvm/versions/node/v24.14.0/bin; ssh user@ip "$N/node -v; $N/node $N/../lib/node_modules/npm/bin/npm-cli.js ls -g --depth=0"
  ```
  或者直接跑 `find /usr/local /opt/homebrew ~/.nvm ~/.volta -name node -type f 2>/dev/null`
- **引号地狱**：远端命令里嵌引号用单引号包外层、`\"` 转义内层；复杂脚本直接 `cat > /tmp/x.sh << 'EOF' ... EOF` 再执行（heredoc 用引号 EOF 防止本地展开 `$`）

### 通用诊断清单（按序打）

```bash
ssh user@ip 'sw_vers; uname -m; uptime'                    # 系统基本面
ssh user@ip 'ps aux | grep -i <name> | grep -v grep'       # 进程在不在
ssh user@ip 'lsof -nP -iTCP -sTCP:LISTEN | grep <name>'    # 在听什么端口
ssh user@ip 'lsof -nP -iTCP | grep <pid>'                  # 实际连去哪（真相在连接不在配置）
ssh user@ip 'tail -50 <log>'                               # 日志时间线
```

**金标准**：配置说「走代理」不算数，`lsof` 里到代理端口的 `ESTABLISHED` 连接才算数；同理「装了这个版本」不等于「跑的是这个版本」——看进程启动时间 vs 包安装时间。

### 版本漂移（本次踩中的头号坑）

`npm i -g` 升级包 ≠ 守护进程加载新代码。检查法：

```bash
ssh user@ip 'ps -o lstart= -p <daemon-pid>'   # 进程启动时间
# vs 包 mtime / npm ls -g 的版本时间
```

进程比包装得早就说明在跑旧代码 → 重启服务。LaunchAgent 守护的用 `launchctl kickstart -k gui/$UID/<label>` 或应用自己的 `service restart`。

### Electron 应用进程树陷阱

Electron 的 utility/helper 子进程 argv0 会被重写（`XXX Helper: mcp-process`），**命令行里不含 `.app` 路径**——按路径匹配收集 PID 会漏掉真正持网的进程，报出「没走代理」的假阴性。

正确姿势：先 `ps -Ao pid=,ppid=,command=` 找含 `/App.app/` 的种子进程，再按 ppid BFS 收全部子孙，最后 `lsof` 按 PID 集合过滤。

### mihomo / Clash Verge 上游 API

远端跑 Clash Verge Rev / mihomo 时，REST API 通常在 `127.0.0.1:9097`（Verge）或 `9090`：

```bash
# 分组与当前选中
curl -s 127.0.0.1:9097/proxies | jq '.proxies | to_entries[] | select(.value.type=="Selector" or .value.type=="URLTest") | {name, now: .value.now}'

# 列出某组可选项
curl -s 127.0.0.1:9097/proxies | jq '.proxies["🚀 节点选择"].all'

# 切换选择器（名字要 URL-encode）
curl -s -X PUT 'http://127.0.0.1:9097/proxies/%F0%9F%9A%80%20%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9' -d '{"name":"日本04-×1"}'

# 节点活性——别信名字，先测延迟
curl -s 'http://127.0.0.1:9097/proxies/<urlencoded-name>/delay?url=http://www.gstatic.com/generate_204&timeout=3000'
# 返回数字=活；{"message":"..."}=死节点
```

**注意**：`URLTest` 组（如「♻️ 自动选择」）会按延迟自动挑节点——它常选中最快的**香港**节点，而香港不在 Google/OpenAI/Anthropic 服务区。AI 模型目录缺失时先查这条链：`Selector → URLTest → 实际落地节点`。

### 出口地区检测（代理通了但功能不全的根因）

「能出网」≠「功能完整」。Cursor 等按出口 IP 地区下发模型目录，HK/CN 出口会被裁掉 Gemini/Claude/GPT。实测出口：

```bash
ssh user@ip 'curl -s --proxy http://127.0.0.1:<local-proxy-port> --max-time 10 https://ipinfo.io/json'
# 看 country：JP/US/DE/SG 安全；HK/CN/MO/RU → 换节点
```

测完别只信一次——有的客户端测的是直连出口，要走**应用实际用的那个代理端口**测。

## 阶段 4：清场（别留尾巴）

- [ ] 杀掉临时公钥 HTTP 服务
- [ ] 提醒用户关**远程登录**（系统设置 → 共享 → 远程登录）——开口时间越短越好
- [ ] `/tmp` 里你写的脚本文件无害（重启自清），但放敏感内容的要 `rm`
- [ ] 汇报时给「当前时刻」证据（版本/端口/连接数），别给历史猜测

## 汇报模板

诊断完用证据表收尾，而不是感觉：

```
| 层 | 证据 | 状态 |
| 装的版本 | npm ls 输出 | ✔/✖ |
| 跑的版本 | ps 进程时间 vs 包时间 | ✔/✖ |
| 监听端口 | lsof LISTEN | ✔/✖ |
| 真实连接 | lsof ESTABLISHED → 目标端口 | ✔/✖ |
| 端到端 | curl 经实际代理路径到目标域 | ✔/✖ |
| 出口地区 | ipinfo country | ✔/✖ |
```
