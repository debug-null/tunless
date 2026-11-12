# netfix

诊断并修复 macOS 上两类代理问题：

1. **工具连不上代理网络** —— 程序不读系统代理，也没有 `HTTPS_PROXY` 支持，只能开 TUN。
2. **内网域名解析到公网 IP** —— 代理内核给内网域名发了假 IP 或公网答案，工具连错服务器。

netfix 与具体客户端无关：它通过 REST 接口跟任何运行中的 [mihomo](https://github.com/MetaCubeX/mihomo) 内核通信，并为 Clash Verge Rev 提供适配器，把配置写进订阅更新后仍保留的 merge 增强层。

核心逻辑零运行时依赖 —— 诊断、DNS 探测、配置读写全部只用 Node 内置模块。
图形界面基于 [ink](https://github.com/vadimdemedes/ink) + React 构建（唯一的两个依赖），源码即运行，不需要编译步骤。

## 这是什么，给谁用

一句话：**给「只认 `HTTPS_PROXY`、不读 macOS 系统代理」的工具准备一个能用的代理，并保证公司内网域名不走代理。**

典型例子是 **Antigravity**（VS Code 系 AI 编辑器）。它的进程不读系统代理，也不认 `HTTPS_PROXY` 环境变量，所以「Clash Verge 明明开着，它就是连不上」。netfix 做两件事：

1. 起一个本地转发代理（HTTP `127.0.0.1:8899`、SOCKS5 `127.0.0.1:8898`），把请求交给 Clash 内核；
2. 让内网域名（如 `matrix.17usoft.com`）走直连，不被代理内核发假 IP 或公网地址。

## 30 秒上手

界面里按 `2` 或 `h` 可以随时看到这一页。命令行等价物：

```bash
netfix doctor             # 1. 先诊断，看当前有什么问题
netfix service install    # 2. 安装并启动转发服务（开机自启，监听 127.0.0.1:8899）
netfix launch Antigravity # 3. 用这个代理重启 Antigravity
```

第 3 步等价于给应用加上这两个环境变量后再启动它：

```bash
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 Antigravity
```

不想用 `netfix launch` 的话，在应用自己的代理设置里填 **协议 HTTP、地址 127.0.0.1、端口 8899** 即可。

停止转发服务用 `netfix service stop`，查看状态用 `netfix service status`，看日志用 `netfix service logs`。

**内网域名解析不对时**（比如 `matrix.17usoft.com` 变成了公网 IP）：

```bash
netfix fix             # 生成方案 → 预览差异 → 确认 → 应用 → 校验，失败自动回滚
```

### 什么时候才需要开 TUN

只有某个工具**完全忽略**代理设置、必须访问公网时才开。开了 TUN 之后内网域名也会经过代理内核，反而更容易连错内网服务器，所以默认建议关闭。

### Chrome 历史记录读不到

macOS 会保护 `~/Library/Application Support/Google/Chrome/.../History`。想让它参与域名扫描：

**系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 添加你正在用的终端（终端 / iTerm / Warp）→ 打开开关 → 重启该终端。**

不做这一步也能用，只是扫到的域名会少一些。

## 安装

```bash
git clone <本仓库> ~/github/netfix
cd ~/github/netfix && npm install      # 只装 ink 与 react
mkdir -p ~/.local/bin
ln -sf ~/github/netfix/bin/netfix.js ~/.local/bin/netfix
chmod +x ~/github/netfix/bin/netfix.js
```

`~/.local/bin` 需在 `PATH` 中。

## 用法

直接运行 `netfix` 会打开图形界面：

```bash
netfix                 # 图形界面（TUI）
netfix doctor          # 只诊断，不修改任何东西
netfix scan            # 列出候选域名及其解析结果
netfix fix             # 方案 → 预览差异 → 确认 → 应用 → 校验 → 失败自动回滚
netfix proxy           # 启动本地转发代理，把代理能力交给工具
netfix launch <应用>    # 带代理环境重启某个应用
netfix service <操作>   # install | uninstall | status | logs
```

### 图形界面

```
 netfix      代理与内网诊断工具                 更新于 20:51:55
 1 总览  2 怎么用  3 内网域名  4 程序代理能力  5 分流规则  6 操作日志

╭────────────────────────────────────────────────────────────╮
│ 下一步做什么                                                 │
│   按 l  转发服务已在运行，用它重启 Antigravity，应用就会走代理 │
╰────────────────────────────────────────────────────────────╯
╭──────────────────────────────╮ ╭──────────────────────────╮
│ 代理内核                     │ │ 转发服务                 │
│   客户端      Clash Verge Rev│ │   转发服务  ✔ 运行中      │
│   TUN 模式    ▲ 已关闭       │ │     HTTP    ✔ :8899      │
╰──────────────────────────────╯ ╰──────────────────────────╯
╭────────────────────────────────────────────────────────────╮
│ 内网概况                                                       │
│   内网域名    16 个解析到私网地址                              │
│   归并后缀    17u.cn、17usoft.com、corp.elong.com             │
╰────────────────────────────────────────────────────────────╯

← → 切换面板 · r 刷新 · f 修复 · p 转发 · S 服务 · l 重启应用 · q 退出
```

| 按键 | 作用 |
| --- | --- |
| `←` / `→`、`Tab` | 切换面板（首尾循环） |
| `1`–`6` | 直接跳到某个面板 |
| `r` | 重新采集状态 |
| `f` | 一键修复（写入配置并校验） |
| `p` | 启动转发服务 |
| `S` | 启停转发服务 |
| `l` | 用 netfix 代理重启应用 |
| `j` / `k`、↑ / ↓ | 列表上下滚动 |
| `PgUp` / `PgDn` | 列表翻页 |
| `/` | 在内网域名面板里按名字过滤（回车确认，Esc 取消） |
| `q` | 退出 |

界面基于 ink 的备用屏幕渲染（退出后恢复原终端内容），按显示宽度排版，中文不会错位；窄终端（50 列以上）也不会溢出。

几个细节：

- **亮暗自适应**：启动时用 OSC 11 问一次终端背景色，亮底用深色字，暗底用浅色字。`NETFIX_THEME=light|dark` 可以强制指定。
- **ASCII 降级**：终端不是 UTF-8 时（`LC_ALL=C`）符号与边框自动换成 `+ - |`，不会出现方块。`NETFIX_ASCII=1` 可强制降级。
- **非交互环境**：输出重定向到管道时不会报错，而是打印一份纯文本总览。

### 选项

| 参数 | 含义 |
| --- | --- |
| `--internal-dns <ip>` | 内网 DNS 服务器（默认 `10.249.150.130`） |
| `--repos <路径>` | 逗号分隔的仓库根目录，用于扫描域名 |
| `--no-chrome` | 跳过 Chrome 历史记录（需要完全磁盘访问权限） |
| `--frontend <id>` | 指定前端：`clash-verge-rev` / `generic-mihomo` |
| `--config <路径>` | 指定配置文件（通用前端） |
| `--yes`, `-y` | 跳过确认提示 |

## 判定内网域名的依据

域名解析到 **RFC1918 私网地址**（`10./127./192.168./172.16-31.`）即判定为内网。不使用「双 DNS 对比」：在分离解析（split-horizon）网络里两个解析器可能给出完全相同的答案，只有地址类别是可靠信号。

DNS 查询是手写的 UDP 报文（`node:dgram`）——TUN 开启时 `dns.Resolver.setServers()` 会被内核劫持，根本到不了内网解析器。

`198.18.0.0/16` 段的地址意味着域名仍解析为**假 IP**，需要加入 `fake-ip-filter`。

## 修复做了什么

1. 扫描候选域名（shell 历史、Clash 日志、仓库、Chrome 历史）。
2. 逐个用内网 DNS 解析并分类。
3. 把内网域名归并成后缀通配（`matrix.17usoft.com` + `git.17usoft.com` → `17usoft.com`）。
4. 写入 `nameserver-policy` 与 `fake-ip-filter`：
   - **Clash Verge Rev** → 当前订阅的 merge 增强文件，然后重启 GUI（运行时配置位于 root 权限目录，内核接口拒绝从外部路径加载）。
   - **通用 mihomo** → 直接改配置文件，再用 `PUT /configs?force=true` 热重载。
5. 校验：重新解析每个内网域名，确认仍落在私网地址；失败自动从备份恢复。

改动前会备份到 `~/.netfix/backups/<时间戳>/`。

### 后缀安全

归并不会越过公网父域。若 `elong.com` 解析到公网、但 `ai.corp.elong.com` 解析到私网，生成的后缀是 `corp.elong.com` 而不是 `elong.com` —— 否则该公网域下的所有主机都会被送进直连，正常上网就断了。

反之，父域本身没有 A 记录（内网区的常见形态）时，归并是安全的。

## `netfix proxy` —— 给不认系统代理的工具发代理

很多工具（Electron 应用、部分 CLI、IDE 插件）从不读取 macOS 系统代理，常见做法是「开 TUN」。TUN 会接管整台机器，笨重且容易搞坏内网。

`netfix proxy` 是更轻的替代：一个本地正向代理，坐在工具和运行中的 mihomo 内核之间。

```bash
netfix proxy
#   HTTP 代理 ：http://127.0.0.1:8899
#   SOCKS5 代理：socks5://127.0.0.1:8898

export HTTPS_PROXY=http://127.0.0.1:8899
export HTTP_PROXY=http://127.0.0.1:8899
export ALL_PROXY=socks5://127.0.0.1:8898
export NO_PROXY=17usoft.com,17u.cn
```

分流规则：

| 目标 | 行为 |
| --- | --- |
| 内网域名（命中内网后缀表） | 走内网 DNS 解析，直连私网地址，**不经过代理** |
| 其他所有域名 | 隧道给内核的混合端口 |

内网后缀表来自正在使用的客户端配置（`nameserver-policy` 的键）加上实时扫描，因此 `netfix proxy` 会自动继承 `netfix fix` 已经配好的结果——代理信息从运行中的内核读取，不写死。

### 常用参数

| 参数 | 含义 |
| --- | --- |
| `--port <n>` | HTTP 代理端口（默认 `8899`） |
| `--socks-port <n>` | SOCKS5 端口（默认 `8898`，`0` 表示禁用） |
| `--print-env` | 只打印环境变量后退出，不监听 |
| `--no-scan` | 只用客户端配置，跳过实时扫描 |
| `--upstream <host:port>` | 手动指定上游内核地址 |

### 常驻运行

```bash
netfix service install     # 开机自启，崩溃自动拉起
netfix service status
netfix service logs
netfix service uninstall
```

### 用代理重启某个工具

```bash
netfix launch Antigravity
netfix launch Cursor --print-env     # 只看会注入什么
```

先退出旧实例（否则旧环境会存活），再通过 `open --env` 重新拉起。

注意：部分应用会通过登录 shell 拉起子进程，从而重新读取 `~/.zshrc`。若你的 shell 自己导出了 `NO_PROXY`，子进程可能拿到 shell 里的那份列表而非注入的那份。只要 shell 的列表也包含内网域名就无害；即使内网域名真的走到 netfix，分流判定也依然正确。

## 程序代理能力

`netfix doctor` 会检查运行中的程序是否认可 `HTTPS_PROXY`。Go 的 `net/http` 通过 `golang.org/x/net/http/httpproxy` 读取环境变量，因此二进制中存在该符号即可判定支持。不支持的程序需要 TUN 模式（或单独配置 SOCKS 代理）才能访问代理网络。

## 开发

```bash
npm test        # node --test，无需网络
```

## 限制

- 仅支持 macOS（依赖 `scutil`、`osascript`、`strings`、`pkill`）。
- Chrome 历史需要「完全磁盘访问权限」，未授权时自动降级。
- netfix 不会修改你的 shell 配置文件 —— 代理提示只打印出来，由你决定是否采用。
