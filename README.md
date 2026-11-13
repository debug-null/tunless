# tunless

**让 AI Agent 不用开 TUN 也能联网。**

不少 Agent 工具（Antigravity、Cursor、各类 CLI Agent）只认 `HTTPS_PROXY` 环境变量，
不读 macOS 系统代理。于是「Clash Verge 明明开着，它就是连不上」，很多人只能去开 TUN 模式。
而 TUN 一开，内网域名也会被代理内核接管，公司内网反而连不上了。

tunless 把这两件事分开：

1. 起一个本地转发代理（HTTP `127.0.0.1:8899` / SOCKS5 `127.0.0.1:8898`），
   把请求交给已运行的 Clash／mihomo 内核 —— Agent 只要认 `HTTPS_PROXY` 就能用，**不需要 TUN**；
2. 让内网域名（如 `matrix.17usoft.com`）走直连，不被代理发假 IP 或公网地址。

与具体客户端无关：tunless 通过 REST 接口跟任何运行中的 [mihomo](https://github.com/MetaCubeX/mihomo)
内核通信，并为 Clash Verge Rev 提供适配器，配置写进订阅更新后仍保留的 merge 增强层。

核心逻辑零运行时依赖 —— 诊断、DNS 探测、配置读写全部只用 Node 内置模块。
图形界面基于 [ink](https://github.com/vadimdemedes/ink) + React 构建（唯一的两个依赖），
源码即运行，不需要编译步骤。

## 这是什么，给谁用

一句话：**让那些「不读系统代理、只能靠 TUN 才能联网」的 Agent 工具，不用开 TUN 也能联网。**

典型例子是 **Cursor**、**Antigravity**（VS Code 系 AI 编辑器）和各类 CLI Agent。它们要么只认 `HTTPS_PROXY`，
要么像 Cursor 这样把网络拆成好几条互不相通的路，过去只能靠 TUN；但 TUN 会把内网域名也劫持走。

打开 tunless，它只告诉你**现在该按哪一个键**，不列一堆指标。

> 为什么不开 TUN、为什么必须按应用逐个适配，以及市面上同类方案都是怎么做的：
> 见 [竞品调研](docs/竞品调研.md)。

## 30 秒上手

```bash
tunless                    # 打开界面，上面就写着下一步按什么键
```

界面上是四步向导，一次只做一件事：

| 步骤 | 作用 |
|---|---|
| 1 | 选工具（Antigravity / Cursor / Codex 客户端与命令行） |
| 2 | 让它走 tunless 的代理（服务没跑会先让你启动服务） |
| 3 | 实测连通性：真的发一个请求走一遍代理 |
| 4 | 内网域名，也可以手写一条扫不到的 |

命令行等价物：

```bash
tunless doctor             # 诊断，不改任何东西
tunless service install    # 安装并启动转发服务（开机自启，监听 127.0.0.1:8899）
tunless launch Cursor      # 带代理重启 Cursor
tunless launch Codex --write-settings   # 把代理写进 ~/.codex/.env
tunless cursor             # Cursor 专用：写好 http.proxy 再重启（推荐）
tunless rules add 10.0.0.0/8   # 手动补内网网段
```

`tunless launch` 等价于给应用加上这两个环境变量后再启动它：

```bash
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 Cursor
```

不想用它的话，在应用自己的代理设置里填 **协议 HTTP、地址 127.0.0.1、端口 8899** 即可。

## Antigravity 和 Cursor 的区别

两个都是 VS Code 系的 Electron 应用，但网络通路不一样：

| 应用 | 模型请求走哪 | 需要做什么 |
|---|---|---|
| Antigravity | `language_server`（Go 程序，认 `HTTPS_PROXY`） | 环境变量 + `http.proxy` |
| Cursor | Agent 自己的 Node 传输层 + Chromium | 环境变量 + `http.proxy` +（3.28 前）关 HTTP/2 |

按 `l` 会先选应用，再选**怎么处理** —— 写不写你的配置文件由你决定：

```
要带代理启动哪个应用？
  › Antigravity    模型走 language_server（认 HTTPS_PROXY）
    Cursor    Agent 有独立传输层，3.28 前会绕过代理

Antigravity 要怎么处理？
  › 只注入代理环境变量后启动        不改任何配置文件，随时可以撤销
    注入环境变量 + 写入代理配置后启动  会改 settings.json（自动备份）
    只写入代理配置，不启动           你自己决定什么时候重启应用
```

命令行等价物：

```bash
tunless launch Antigravity                    # 只注入环境变量，不改配置
tunless launch Antigravity --write-settings   # 同时写 settings.json
```

## Cursor 为什么会「连不上模型」

Cursor 不是一个程序，是好几条互不相通的网络通路（这一点 Cursor 官方论坛有明确回复）：

- **Chromium 部分**读 `http.proxy` 设置
- **Agent 部分**走自己的 Node 传输层，读的是环境变量
- **3.28 之前**，Agent 的 HTTP/2 连接**完全绕过**代理，只能靠 TUN；
  3.28 起才改成「在代理里开 CONNECT 隧道，隧道内继续用 HTTP/2」

所以只设环境变量、或者只改设置，都会只通一半。`tunless cursor` 三件事一起做：

```bash
tunless cursor
```

1. 往 `~/Library/Application Support/Cursor/User/settings.json` 写
   `http.proxy` = `http://127.0.0.1:8899`、`http.proxySupport` = `override`
2. 按版本决定要不要加 `cursor.general.disableHttp2`（3.28+ 不需要，更早的必须关）
3. **完全退出** Cursor 再带代理环境重启 —— Cursor 经常忽略 AppleScript 的退出请求，
   tunless 会逐级升级到 SIGTERM/SIGKILL，否则 `open` 会变成「应用已在运行，环境变量没生效」

写入前会自动备份到 `~/.tunless/backups/`，写坏会中止而不是硬写。

## 内网域名扫不到？自己写一条

自动扫描只看本机历史记录，还要读 Chrome 历史（需要「完全磁盘访问权限」）。
很多人不愿意给这个权限，所以 tunless 提供了一条完全不需要授权的路：

```bash
tunless rules add 17usoft.com      # 域名后缀，子域名自动覆盖
tunless rules add jira --keyword   # 域名里含这个词就走直连
tunless rules add 10.0.0.0/8       # 解析到这个网段就走直连
tunless rules list                 # 看当前所有规则
tunless rules remove 17usoft.com   # 删掉
```

界面里按 `a` 就能直接输入，`Tab` 在「域名 / 关键词 / IP 段」之间切换，`d` 删除选中的规则。

规则存在 `~/.tunless/rules.json`，转发服务每次启动时读取 —— 改完重启服务生效：

```bash
tunless service uninstall && tunless service install
```

停止转发服务用 `tunless service stop`，查看状态用 `tunless service status`，看日志用 `tunless service logs`。

**内网域名解析不对时**（比如 `matrix.17usoft.com` 变成了公网 IP）：

```bash
tunless fix             # 生成方案 → 预览差异 → 确认 → 应用 → 校验，失败自动回滚
```

### 什么时候才需要开 TUN

只有某个工具**完全忽略**代理设置、必须访问公网时才开。开了 TUN 之后内网域名也会经过代理内核，反而更容易连错内网服务器，所以默认建议关闭。

### Chrome 历史记录读不到

macOS 会保护 `~/Library/Application Support/Google/Chrome/.../History`。想让它参与域名扫描：

**系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 添加你正在用的终端（终端 / iTerm / Warp）→ 打开开关 → 重启该终端。**

不做这一步也能用，只是扫到的域名会少一些。

## 安装

从 npm 安装（推荐）：

```bash
npm install -g tunless
tunless
```

从源码运行：

```bash
git clone https://github.com/debug-null/tunless.git ~/github/tunless
cd ~/github/tunless && npm install      # 只装 ink 与 react
mkdir -p ~/.local/bin
ln -sf ~/github/tunless/bin/tunless.js ~/.local/bin/tunless
chmod +x ~/github/tunless/bin/tunless.js
```

`~/.local/bin` 需在 `PATH` 中。

## 用法

直接运行 `tunless` 会打开图形界面：

```bash
tunless                 # 图形界面（TUI）
tunless doctor          # 只诊断，不修改任何东西
tunless scan            # 列出候选域名及其解析结果
tunless fix             # 方案 → 预览差异 → 确认 → 应用 → 校验 → 失败自动回滚
tunless proxy           # 启动本地转发代理，把代理能力交给工具
tunless launch <应用>    # 带代理环境重启某个应用
tunless service <操作>   # install | uninstall | status | logs
tunless restore [序号]   # 列出 / 还原 tunless 改过的配置文件
tunless env              # 查看写进登录会话的代理变量（clear 撤销）
```

### 图形界面

界面是**向导式**的：一次只做一件事，回车走完这一步，再进下一步。

```
 tunless                给连不上外网的 agent 一个本地代理口，不用开 TUN
  第 1 步 / 共 4 步

╭──────────────────────────────────────────────────────────────────────────────╮
│ 选一个要联网的工具                                                          │
│   ❯ Antigravity   2.31.2 · 正在运行                                         │
│     Cursor         3.28.7 · 正在运行                                         │
╰──────────────────────────────────────────────────────────────────────────────╯

  ↑↓ 选择 · 回车下一步 · q 退出
```

四步依次是：

| 步骤 | 做什么 | 回车会发生什么 |
| --- | --- | --- |
| 1 | 选工具（Antigravity / Cursor / Codex 客户端与命令行） | 记住选中的应用，进入第 2 步 |
| 2 | 让它走 tunless 的代理 | 只列出对这个工具**真正有用**的方式，执行它 |
| 3 | 实测外网通不通 | 真的发一个请求走一遍代理，看结果 |
| 4 | 看内网域名 | 列出已自动分流的内网域名，写一条手写规则也可以 |

第 4 步之后是收尾页，回车可以重新从头走一遍。

任务状态显示在**界面底部**：用户自己触发的动作（重启应用、实测外网）是高亮的 `⟳ …`；
开��自动采集是灰色的「正在…（后台自动进行）」，不会让你误以为是自己点出来的。

第 2 步的选项会按工具过滤：

- **Antigravity**：只注入环境变量就够用（它的模型服务 `language_server` 是 Go 程序，会读 `HTTPS_PROXY`），所以三项都在，默认选第一项。
- **Cursor**：模型请求走独立传输层，**不认环境变量代理**，只注入环境变量是连不上模型的，所以这一项根本不列出来，只剩「写配置」相关的两项。
- **Codex**：有**两副面孔，共用一份配置** —— 终端里的 `codex` 命令，和桌面客户端 `ChatGPT.app`
  （客户端内部跑的是同一个 codex 二进制）。代理写在 `~/.codex/.env`，
  而且**这个文件的优先级高于进程环境变量**，只 `export HTTPS_PROXY` 会被它盖掉
  （表现为「明明设了代理，日志里却还在连系统代理」）。

  客户端还有个坑：它在启动时就把 `.env` 读进内存，**改完必须重启客户端**才生效。

  这也是第 2 步必看「实际连接」的原因 —— **配置写对了不等于生效了**。
  tunless 不看文件写了什么，而是看进程此刻真的连在哪个本地端口上：

  ```
  配置 .env   http://127.0.0.1:8899
  实际连接    还连着 127.0.0.1:7897，需要重启
  ```

  四种结果：`已走 127.0.0.1:8899`（真的生效）、`还连着 …，需要重启`、
  `应用没在运行`、`此刻没有代理连接（可能还没发请求）`。
  如果新代理已经生效、但还有重启前留下的子进程连着旧代理，会写成
  `已走 127.0.0.1:8899，但还有旧连接 127.0.0.1:7897` —— 这种情况照样能上网，
  但彻底重启一次才会干净。

  判定看的是**整个应用进程树**，不只是主进程：Antigravity 真正联网的是
  `language_server`，Cursor 是 Plugin Helper。只看主进程会误判成
  「没走代理」。应用自己监听的端口（内部 IPC）和临时端口上的回环连接会被排除，
  所以显示的端口就是真正的代理端口。

  第 2 步执行完会**去进程表里确认应用真的起来了**，并把 pid 显示出来
  （`已带代理启动（pid 58202）`）。启动失败不会打勾，而是提示你手动打开或
  用 `tunless launch <应用>` 看详细报错 —— 不再有「命令跑完就当成功」。

  再往下还有一行 `进程代理`，看的是**真正联网那个子进程有没有在用代理**：

  ```
  进程代理    ✔ 正在使用 http://127.0.0.1:8899
  进程代理    此刻没有代理连接（可能还没发请求）
  ```

  它只报能确凿观察到的事实。**不会读环境变量来判断** —— macOS 上
  `ps -E` 对 GUI 应用基本读不到东西，用它推「没有代理」会造成大量误报，
  而误报比不判断更糟。

  这一行专治一种情况：登录报
  `dial tcp 172.253.117.95:443: i/o timeout`。那是 Go 程序在直连谷歌
  真实 IP，跟代理有没有开无关。

| 按键 | 作用 |
| --- | --- |
| `↑` / `↓` | 在当前步骤里选择 |
| `回车` | 走完当前这一步 |
| `Esc` | 回到上一步 |
| `a` | **手写一条内网域名 / 关键词 / IP 段**，不需要任何系统授权 |
| `r` | 第 3 步重测；其它步骤重新采集状态 |
| `Esc` | 回到上一步 |
| `f` | 一键修复内网 DNS 解析 |
| `S` | 启停转发服务 |
| `h` | 看用法（Esc 返回） |
| `q` | 退出 |

界面基于 ink 的备用屏幕渲染（退出后恢复原终端内容），按显示宽度排版，中文不会错位；窄终端（50 列以上）也不会溢出。

几个细节：

- **亮暗自适应**：启动时用 OSC 11 问一次终端背景色，亮底用深色字，暗底用浅色字。`TUNLESS_THEME=light|dark` 可以强制指定。
- **ASCII 降级**：终端不是 UTF-8 时（`LC_ALL=C`）符号与边框自动换成 `+ - |`，不会出现方块。`TUNLESS_ASCII=1` 可强制降级。
- **非交互环境**：输出重定向到管道时不会报错，而是打印一份纯文本总览。

### 选项

| 参数 | 含义 |
| --- | --- |
| `--internal-dns <ip>` | 内网 DNs 服务器（默认 `10.249.150.130`） |
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

改动前会备份到 `~/.tunless/backups/<时间戳>/`。

### 后缀安全

归并不会越过公网父域。若 `elong.com` 解析到公网、但 `ai.corp.elong.com` 解析到私网，生成的后缀是 `corp.elong.com` 而不是 `elong.com` —— 否则该公网域下的所有主机都会被送进直连，正常上网就断了。

反之，父域本身没有 A 记录（内网区的常见形态）时，归并是安全的。

## `tunless proxy` —— 给不认系统代理的工具发代理

很多工具（Electron 应用、部分 CLI、IDE 插件）从不读取 macOS 系统代理，常见做法是「开 TUN」。TUN 会接管整台机器，笨重且容易搞坏内网。

`tunless proxy` 是更轻的替代：一个本地正向代理，坐在工具和运行中的 mihomo 内核之间。

```bash
tunless proxy
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

内网后缀表来自正在使用的客户端配置（`nameserver-policy` 的键）加上实时扫描，因此 `tunless proxy` 会自动继承 `tunless fix` 已经配好的结果——代理信息从运行中的内核读取，不写死。

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
tunless service install     # 开机自启，崩溃自动拉起
tunless service status
tunless service logs
tunless service uninstall
```

`service install` 装的是 launchd 用户代理（`~/Library/LaunchAgents/dev.tunless.proxy.plist`），
带 `KeepAlive` 与 `RunAtLoad`，进程的父进程是 launchd 而不是你的终端 ——
**关掉终端、退出 SSH 都不影响**。plist 里还写了 `PATH`（含安装时的 node 目录、
Homebrew 与系统路径），并设了 `ThrottleInterval`，避免 node 升级后出现
`env: node: No such file or directory` 那种反复崩溃。

同时它会把代理写进 **launchd 登录会话**（`launchctl setenv`）。这一步很关键：
`open --env` 只对「由 tunless 启动的那一次」有效，用户从 Dock / Finder /
Spotlight 点开应用时环境是空的。实测过一个最小 .app 探针：

- 清空 shell 的代理变量后启动 → 应用里没有任何代理变量
- `launchctl setenv` 之后同样方式启动 → 应用里就有

所以装上服务后，**从 Dock 打开 Antigravity 也会自动走 8899**，不必每次
`tunless launch`。

升级 tunless 或换了 node 版本后，建议重装一次，让 plist 里的路径跟上：

```bash
tunless service uninstall && tunless service install
```

查看和撤销这个会话变量：

```bash
tunless env          # 看当前写入了什么
tunless env clear    # 撤销（已打开的应用要重启才回到直连）
```

`service uninstall` 会自动撤销，避免应用指向一个已经不存在的端口 ——
那会让所有外网都连不上，比不设更难排查。

### 改过的配置怎么还原

`tunless` 在写任何应用配置前都会先备份（`~/.tunless/backups/`）：

```bash
tunless restore          # 列出所有备份
tunless restore 2        # 还原第 2 个（还原前会把当前内容再备份一次）
tunless restore 2 --yes  # 脚本里用，跳过确认
```

### 用代理重启某个工具

```bash
tunless launch Antigravity
tunless launch Cursor --print-env     # 只看会注入什么
```

先退出旧实例（否则旧环境会存活），再通过 `open --env` 重新拉起。

`open --env` 是 macOS 13 起才有的参数。更老的系统上 tunless 会自动退回普通启动，
并明确告诉你「没带上代理环境变量」——那种情况需要在应用自己的设置里配代理。

注意：部分应用会通过登录 shell 拉起子进程，从而重新读取 `~/.zshrc`。若你的 shell 自己导出了 `NO_PROXY`，子进程可能拿到 shell 里的那份列表而非注入的那份。只要 shell 的列表也包含内网域名就无害；即使内网域名真的走到 tunless，分流判定也依然正确。

## 程序代理能力

`tunless doctor` 会检查运行中的程序是否认可 `HTTPS_PROXY`。Go 的 `net/http` 通过 `golang.org/x/net/http/httpproxy` 读取环境变量，因此二进制中存在该符号即可判定支持。不支持的程序需要 TUN 模式（或单独配置 SOCKS 代理）才能访问代理网络。

## 开发

```bash
npm test        # node --test，无需网络
```

## 限制

- 仅支持 macOS（依赖 `scutil`、`osascript`、`strings`、`pkill`）。
- Chrome 历史需要「完全磁盘访问权限」，未授权时自动降级。
- tunless 不会修改你的 shell 配置文件 —— 代理提示只打印出来，由你决定是否采用。
