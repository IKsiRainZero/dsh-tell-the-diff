# v0.1 最小闭环 · 实现记录

> 2026-11-16 · 从 α0 可行性直接跳到可安装的闭环

## 一句话

把「这个会话现在做到哪」从主对话里搬到右栏：会话事件流 → 确定性状态 → 一张人话卡片；模型用 `tell_the_diff` 工具补上「为什么/还差什么」；全程不额外调用模型。

## 闭环的四个构件（原设想 → 落地）

| 原设想 | v0.1 落地 | 状态 |
|---|---|---|
| 承载实体 | `plugin/core/store.js`：每会话一份派生状态，内存 Map，40 会话上限，空闲 30 分钟回收 | ✅ |
| 监视工具 | `tell_the_diff`：模型写 `plain/steps/questions/risks` | ✅ |
| 呈现视图 | 右栏 tab（`sidebarRightTabs` + `sidebar.right.pane.tab`），1.5s 轮询一次只读路由 | ✅ |
| 介入时机函数 | `shouldSurface()` → `silent` / `card`；长任务 ≥90s 或 120s 内 ≥2 次失败才升到 `card` | ✅（只到 card） |
| 异步模型调用 | 未做。α2 才有，且必须先证明确定性面板不够用 | ❌ 有意留空 |

## 关键取舍

1. **传输用 HTTP 轮询，不用 wire projection。**
   wire.view 更"框架正确"，但需要客户端 selector hook 与 projection 注册两套未验证的接口；`webServer.register` 在本 profile 里有 `dsh-pray` 作为活证据。先跑通，再谈优化。
2. **状态放内存，不落盘。**
   会话日志才是真相源；派生状态重启即丢、可由日志重建。这样"删得干净"才成立。
3. **人话分两层。**
   工具名 → 动词的映射是确定的（`read`→读取文件、`grep`→搜索内容），由代码保证；"为什么做、还差什么"只能由模型写，所以做成工具参数，而不是让插件去猜。
4. **不抢 attention。**
   没有弹窗、没有 steering、没有通知。`card` 只意味着"值得看一眼"，且 v0.1 连高亮都还没做。

## 验证方式

- `node --test`：28 个用例，覆盖事件归约、人话映射、快照、介入判定、store 生命周期、Host 插件装配、Client 注册形状。
- 安装后用 `plugin_manager` 观察 `application`，再看真实页面（见下）。

## 未验证 / 待办

- [x] 重启后 Host 路由 200，`tell_the_diff` 真调用一次，状态进了视图
- [x] `sidebar.right.pane.tab` 里 `dsh-tell-the-diff` 占位 active
- [ ] 真实 GUI 里的渲染（等用户硬刷新后确认）
- [ ] 右栏 `+` 菜单里的入口（better-sidebar 用自家 registry 渲染，已补桥接）
- [ ] 中英文文案走 `ctx.locale`（现在只有浏览器语言二选一的本地字典）
- [ ] `alert` 档与用户可调阈值（v0.3）
- [ ] 预算：目前模型调用恒为 0；异步摘要接入时必须带硬上限

## 重启后第一次实测（2026-11-16 19:55）

- `GET /dsh-tell-the-diff/list` → 200，返回当前会话的 headline。
- `GET /dsh-tell-the-diff/state?session=…` → 200，`running: true`，工具/轮次正确。
- `tell_the_diff` 调用成功，`plain` 与 4 步计划进入视图，`surface: silent`。
- 客户端 `sidebar.right.pane.tab` 占用表出现 `dsh-tell-the-diff`，active。

**发现的关键事实**：`dsh-better-sidebar` 0.32.1 不用原生 tab 注册表渲染右栏——`sidebar/TabContent.tsx` 只认 `ctx.get('betterSidebar').getTab(tab.type)` 返回的 descriptor 的 `component`，找不到就画 `OrphanedTab`；`+` 菜单也来自 `service.getTabs()`。所以只注册原生 `sidebarRightTabs` 在装了 better-sidebar 的机器上不可达。已补：存在该服务时额外 `registerTab({ component })`，与原生共用同一个组件。

（注：`TabContent.tsx:52` 证明 `TabDescriptor.component` 存在；先前从 `service.ts` 截取的接口片段没覆盖到该字段。）

## 入口不可达的第二次修正

用户反馈：右栏上方只有 dsh-context 的标签与全屏/收起两个按钮，没有 `+`。

查 `shell/SidebarRight.tsx` 得事实：右栏标签条的「加页」控件由 `DockLayout` 的 `canAddTab` 控制，而 `canAddTab = paneId => guideIn(layout, paneId) === undefined` —— **该 pane 里已经有起始页时，加号直接不画**。所以"看不到 +"不是缺陷，是当前 pane 已经有一张起始页。

结论：把入口全部押在起始页/标签条上太脆。新增第三个、不依赖右栏状态的入口——`conversation.composer.dock`（输入框下方）的一行状态：`● 任务状态 · <headline> · 打开`。它只读同一条路由，点击走 `ctx.sidebarRight.openTab('tell-the-diff')`。

三个面（composer 条 / 右栏标签 / 起始页卡片）共用同一个 `StatusCard` 与同一个 `useStatus` 轮询，不会漂移。

## 人工确认（2026-11-16 20:10）

用户看过实际界面后的原话：**「漂亮，放的位置感觉恰到好处。」**——指的是输入框下方那一行。

这是一个比"功能可用"更有价值的信号：α 的赌注是"状态应该常驻但不抢位置"，而右栏标签/起始页都是"要用户主动去找"的形态。composer 条被一眼接受，说明**低带宽的常驻比高带宽的按需**更接近需求。下一轮如果要加东西，优先加厚这一行（而不是把用户往右栏拉）。

仍未人工确认：右栏那张完整卡片本身的排版与文案。
