---
name: proxy-client-compat
description: 排查「AI 工具走不了代理」「换了代理客户端但流量没跟着换」「内网域名解析到公网」这类问题。在 macOS 上识别用户到底用的是哪个代理客户端（Clash Verge / mihomo-party / wmsxwd / Surge / sing-box 等）、判断某个端口是不是真的代理、判断 tunless 或类似工具的上游为什么选错、以及判断能不能改这个客户端的 DNS 分流。触发词：走代理、代理不生效、TUN、内核不可达、上游代理、system proxy、fake-ip、内网域名、Clash Verge、mihomo、wmsxwd、Surge、sing-box。
---

# 代理客户端兼容性排查

这套流程来自一次真实事故：用户把客户端从 Clash Verge 换成 wmsxwd，
工具表现为「配置了但没生效」「换了客户端流量还走旧的」。
根因有三个，且都不是表面症状能看出来的。

**核心纪律：一切结论必须有运行时证据。**
端口在监听 ≠ 它是代理；进程在跑 ≠ 它是你的客户端；配置写对了 ≠ 生效了。

## 一、先回答三个问题

按顺序问，每一步都要拿证据，不要靠猜：

1. **用户现在用的是哪个客户端？** → 第二节
2. **上游端口选对了吗？** → 第三节
3. **能不能改它的 DNS 分流？** → 第四节

## 二、识别当前在用的客户端

**判据只有一个：系统代理指向的那个端口，是哪个进程在监听。**
「装在机器上」不等于「正在用」——很多人同时留着好几个客户端，
只看安装目录会一直报旧的那个。

```bash
scutil --proxy | grep -E "HTTPEnable|HTTPPort|HTTPProxy|ExceptionsList"
lsof -nP -iTCP -sTCP:LISTEN          # 谁在监听那个端口
ps -Ao pid=,command= | grep -iE "mihomo|clash|atlas|sing-box|surge"
```

### 常见客户端的配置布局（决定你能改什么）

| 客户端 | 内核进程 | 配置来源 | 能不能改 DNS 分流 |
|---|---|---|---|
| Clash Verge Rev | `verge-mihomo`（root 服务） | `profiles.yaml` 里 `current` → 该 item 的 `merge:` 增强文件 | ✅ 写 merge 文件 + 重启 GUI（订阅更新后仍保留） |
| mihomo-party | `mihomo` | `mihomo.yaml` | ⚠️ 能读，但写 dns 段会破坏应用自身设置 |
| wmsxwd | `AtlasCore` | **GUI 通过 stdin 注入**（`-f -`），磁盘上只有状态缓存 | ❌ secret 在 Flutter 加密存储里，读不出来 |
| Surge / Stash | 自带 | 无 mihomo 配置 | ❌ 只能转发 |

### 关键坑

- **wmsxwd 这类客户端的 `config.yaml` 是「状态缓存」，不是运行时配置。**
  头部注释通常就写着 "do not edit manually"，里面写的
  `external-controller: 127.0.0.1:9090` 根本没在监听。判断依据是
  **实际监听端口**，不是配置文件里写的值。
- **wmsxwd 走通配绑定**：`TCP *:6478 (LISTEN)`。很多工具只认
  `127.0.0.1` / `::1`，把 `*` 当成「局域网端口」丢掉了 —— 结果就是
  用户一关系统代理，工具就再也认不出这个客户端。
- **root 常驻服务会「假活」**：Clash Verge 的 `verge-mihomo` 是 root 服务，
  客户端换了之后它还在后台跑、端口还在监听。普通用户的 `lsof` 看不到
  root 进程的监听行（只看到客户端连过去的 ESTABLISHED 行），
  于是「旧上游」看起来完全正常 —— 流量却悄悄走回了旧客户端。
- **运行时注入配置 + 加密 secret** ⇒ REST 接口拿不到，
  只能转发、不能改分流。这时候要**明说**，不要假装支持。

## 三、判断「这个端口是不是真的代理」

端口在监听不等于它是代理。**必须按协议实测**：真的发 SOCKS5 握手、
真的发 CONNECT。

### SOCKS5

连上后发 `[5,1,0]`（或 `[5,2,0,2]`），回的第 1 字节必须是 `5`。
回的不是 `5`（比如 ssh 的 `SSH-2.0-...` banner）就是别的服务。

### HTTP

发 `CONNECT 127.0.0.1:9 HTTP/1.1`，看状态码：

| 状态码 | 判定 |
|---|---|
| `200 Connection established` | 是代理 ✅ |
| `407 Proxy Authentication Required` | 是代理 ✅ |
| `502 / 503 / 504` | 是代理（目标连不上）✅ |
| `403` | **不算** ⚠️ macOS AirPlay 接收端（`*:7000` / `*:5000`）对任何 CONNECT 都回 `403 Forbidden` |
| `400 / 404 / 405 / 501` | 不是代理 ❌ |

### 必须有硬超时

有些服务（ssh 端口、colima）先吐一段自己的 banner，然后一直安静地挂着。
这时 socket 并不「空闲」，socket 的空闲超时收不了尾，**探测会永远挂着**，
拖死整个发现流程。用独立的 `setTimeout` 做硬超时。

```js
const timer = setTimeout(() => done(false), timeoutMs);   // 硬超时
const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); ... };
```

### 判断「上游选错了」

典型症状：用户换了客户端，工具却还连着旧端口。

1. 看工具钉住的上游端口（比如 `~/.tunless/upstream.json`）。
2. 看系统代理当前指向哪个端口。
3. 两者不一致 + 系统代理那个端口确实是代理 ⇒ **上游过期了**。
4. 修法：钉住时同时记下「当时的系统代理端口」，
   之后系统代理变了才判定为过期并自动改用当前端口。
   这样用户**故意**钉一个跟系统代理不一样的端口（比如公司专线）时不会被误伤。

常驻服务（launchd）还要**定期重解析上游**：客户端随时可能换，
抱着旧端口不放就是「配置了 ≠ 生效了」。

## 四、判断能不能改 DNS 分流

先确认两件事：

1. **客户端开 TUN 了吗？**
   ```bash
   ifconfig | grep -A2 utun; netstat -rn -f inet | head -8
   ```
   没有 utun 默认路由 ⇒ 没开 TUN ⇒ 系统 DNS 没被劫持 ⇒
   内网域名本来就解析正常，**不需要改 DNS 分流**。

2. **内网域名现在解析到什么？**
   ```bash
   dscacheutil -q host -a name matrix.17usoft.com
   scutil --dns | grep nameserver
   ```
   解析到 RFC1918 私网段（`10./127./192.168./172.16-31.`）⇒ 正常。
   解析到 `198.18.` ⇒ fake-ip 段，必须加进 `fake-ip-filter`。

能改的前提：能拿到内核 REST 接口（有 secret 或 unix socket）
**并且**有可持续写入的配置文件。
两个都不满足时，正确做法是**如实说明「能转发、不能改分流」**，
并告诉用户去客户端里手动加内网域名。

## 五、验证

改完必须跑真实链路，不能只看代码：

```bash
# 上游能出网
printf 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n' | nc -w 3 127.0.0.1 <上游端口> | head -1

# 经本地转发也能出网
curl -s -o /dev/null -w "%{http_code}\n" -x http://127.0.0.1:8899 https://oauth2.googleapis.com/

# 内网域名仍走直连
curl -s -o /dev/null -w "%{http_code}\n" -x http://127.0.0.1:8899 https://matrix.17usoft.com/
```

判定标准：**收到 HTTP 响应就算通**，不要求 200
（很多接口对 GET 只回 4xx，但说明请求到了对端）。

## 汇报口径

- 说「已生效」就要给出上面命令的真实输出。
- 区分三件事：**能转发** / **能改配置** / **能改 DNS 分流** ——
  不支持的要明说，不能含糊。
- 端口号、进程名、路径要写具体，用户要能自己复核。
