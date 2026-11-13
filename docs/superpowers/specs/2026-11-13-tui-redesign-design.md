# tunless UI/交互整体升级 — 设计稿

日期：2026-11-13
状态：待评审

## 背景与目标

tunless 的 TUI 是一个 ink+React 五步向导。经过前几轮修复，它现在「说真话」且「够快」，但交互模型仍是线性的：打开 → 逐步回车 → 收尾页。用户三类使用场景频率相当：

1. **排查**：agent 连不上网，进来看哪坏了、怎么修
2. **配置**：新机器/换网络/换客户端，走一遍设置
3. **监控**：打开确认服务在跑、域名在分流、上游没漂

线性向导只服务好第 2 类。目标：打开一眼看清健康度，坏了的行直接给操作键；需要引导时向导仍可用。范围覆盖交互 TUI、非 TTY 静态总览、以及全部 CLI 文本输出（doctor/status/rules/env/targets/fix）。

约束与决定：

- 刷新策略：**按需刷新**——启动采集一次、每次操作后刷、按 r 手动刷；不做定时轮询
- 依赖：不设硬限制，但当前方案零新增依赖即可实现（Node 22 `util.styleText` + 已有 ink/react）
- 「未知」必须显示为未知，不得隐藏或美化成成功/失败（延续 truthfulness 纪律）

## 交互模型：仪表盘为家

### 屏幕地图

```
仪表盘（家，默认落地，Esc 永远回这）
 ├─ Enter 钻取选中行 ─→ 服务与日志屏（服务状态/启停 + 可滚动事件流；Enter 或 l 进入）
 │                    上游屏（u：候选列表 + 手动填写）
 │                    工具屏（回车：每应用连接真相 + 启动/写配置）
 │                    域名屏（d：生效中/待生效/手写规则增删）
 ├─ g → 引导向导（现五步流程原样保留）
 └─ f → 修复流程（走 cmdFix）
```

### 导航规则

- `↑↓`（及 `j`/`k`）在仪表盘四行子系统间移动；`回车` = 钻进去看；字母键 = 直接动手
- `s`（大小写均可）= 仪表盘上直接停/启服务——故障态「按 s 启动」承诺的一键动作；`l` = 进服务与日志屏（里面也能启停）
- 全局键：`q` 退出、`r` 刷新、`a` 加规则、`h`/`?` 帮助、`f` 修复
- `Esc` 从任何钻取屏/向导返回仪表盘

### 仪表盘布局（健康态）

```
 tunless  agent 本地代理口 · 不用开 TUN                    18:38
● 一切正常 · 服务、上游、工具、内网分流都健康

 ✔ 服务   运行中 pid 43831 · HTTP :8899 · SOCKS :8898
 ✔ 上游   127.0.0.1:6478 · wmsxwd · 出网 212ms
 ✔ 工具   Antigravity 代理中 · Cursor 代理中 · Codex —
 ✔ 内网   4 后缀分流中 · 16 域名 · DNS ✔

 最近  18:38 连通性 4/4 · 18:37 服务重启

 s 服务 u 上游 d 域名 l 日志 g 向导 r 刷新 q 退出
```

### 故障态（核心排查路径）

- 顶部总判决变为 `● N 处需要注意`（黄）或 `● N 处故障`（红）
- 坏行变 ⚠/✖ 并在行尾写下一步动作：`✖ 服务 已停止 · 按 s 启动`
- 多故障时按严重度排序不改变行序（行序固定便于形成肌肉记忆）

### 自动进向导的条件（收窄）

- 检测到从未配置过：无 pinned 上游 且 服务从未安装
- 用户按 `f` 进入修复流程
- 其余所有情况（含「已就绪」）永远落仪表盘；现有的「就绪自动跳结果页」逻辑由仪表盘取代，即仪表盘本身就是结果页

## 代码结构

```
src/tui/
  app.js              — 壳：屏幕路由 + 全局键 + 状态行 + 事件条（~300 行）
  screens/
    dashboard.js      — 家：子系统行 + 最近事件 + 操作键
    service.js        — 服务详情：状态/启停 + 可滚动事件流
    upstream.js       — 上游候选 + 手动填写（现第 2 步内容平移）
    apps.js           — 工具列表 → 单应用详情（进程真相 + 动作）
    domains.js        — 域名三态列表 + 规则增删
    wizard.js         — 现 steps.js 五步包一层
  components/
    status-row.js     — ✔/⚠/✖/未知 + 标签 + 详情 + 行内动作提示
    key-bar.js        — 底部按键条（按屏幕给上下文提示）
    event-feed.js     — 最近 N 条事件（仪表盘 3 条 / 服务屏滚动全量）
    frame.js          — StepFrame 泛化为 ScreenFrame
  state.js            — collectState 不变（唯一数据源）
src/cli/report.js     — 零依赖文本渲染器
src/core/status-rows.js — rowsFor(state)：每行判词的纯函数
```

复用：`steps.js` 五屏几乎原样进 wizard；`OverviewPanel` 判定逻辑溶入 `rowsFor`；`collectState`/`refreshLive`/200 条事件环不变。`app.js` 中按屏幕把现有 `useInput` 大 if 链拆成各屏自己的 handler（每屏导出 `handleKey(input, key, ctx)` 或经 React 组件内 useInput 处理——实现期定，约束是全局键集中在壳里，屏内键归屏）。

## 数据流

- `collectState` 仍是唯一全量采集；`onProgress` 部分更新让仪表盘行边到边出
- 按需刷新：启动一次 + 每个动作完成后 + `r`；无定时器
- `refreshLive(appId)` 仍负责「选中工具的真实连接」局部刷新
- `rowsFor(state)` 纯函数输出 `[{key, icon, label, detail, hintAction, severity}]`，TUI 与 CLI 共用

## CLI 输出统一

`src/cli/report.js`（stdlib only）：

```js
rep.section("环境")
rep.row("ok", "服务", "运行中 pid 43831 · HTTP :8899 · SOCKS :8898")
rep.row("warn", "工具", "Cursor 还连着旧代理")
rep.row("bad", "内核", "接口不可达")
rep.row("unknown", "TUN", "读不到（wmsxwd 不给看）")
rep.suggest("tunless service start 启动转发服务")
```

迁移命令：`doctor`（先改）、`service status`、`upstream status`、`rules list`、`env`、`targets`、`fix` 方案展示、非 TTY `renderStaticSummary`（弃用 ink renderToString 走 reporter，消掉 TUI 库渲染文本的路径）。

## 边界与降级

- 窄终端（<70 列）：行尾详情截断，按键提示保留；ink 自动折行不破坏框线
- ASCII 降级：`✔→OK`、`⚠→!`、`✖→X`、`●→*`（复用 theme.js unicode 探测；report.js 走 `NO_COLOR`/isTTY 判断）
- 非 TTY：自动关色；管道输出即 `renderStaticSummary` 的 reporter 版本

## 错误处理

- 三态纪律：ok / warn / bad / unknown 四值，`unknown` 显式显示「未知/读不到」
- 采集局部失败只影响对应行，不拖垮整屏；errors 数组汇入事件环
- 每个用户动作的失败都落事件环带原因（现有 log() 机制不变）

## 测试

- `rowsFor`：按状态组合断言每行 icon/detail/hintAction（覆盖：服务停、上游漂移、DNS 死、stale 代理、全健康）
- `renderToString`：仪表盘健康/故障/空三态断言关键子串；窄宽度不崩
- `report.js`：剥 ANSI 后断言子串；`NO_COLOR` 下无转义序列
- 屏间导航：路由器 keymap 的单测（模拟 useInput 派发或抽出纯函数 reducer）
- 现有 162 个测试保持全绿；steps.js 平移需保证 wizard 屏行为回归

## 落地顺序（每步独立可测）

1. `status-rows.js` + `report.js` + 单测
2. 仪表盘屏 + app.js 瘦身成路由器（home 换掉；向导包进 screens/wizard.js）
3. 四个钻取屏（service / upstream / apps / domains）
4. doctor → reporter；其余 CLI 命令跟进
5. renderStaticSummary 切 reporter；删 ink-for-text 路径
6. 全量测试 + 本机 PTY 实测（TUNLESS_TUI_DEBUG=1）

## 不做（YAGNI）

- 不做定时轮询/live tail（按需刷新已定）
- 不加 --json 输出（本轮不承诺；reporter 的 row 结构是将来加 JSON 的自然切入点）
- 不改 launchd/relay/核心逻辑——本次纯表现层与信息架构
