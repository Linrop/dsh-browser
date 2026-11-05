# @yuxianglin/dsh-bridge-browser

[English](README.md) | 中文

dsh 的**浏览器操作桥**：在宿主 webserver 上挂载一个 **token 认证的 WebSocket 通道**（`/ext/bridge`），供 Chrome 扩展连接；把扩展调用投影到 dsh 0.2.0 Typert Remotes、按连接跟随 Session 与 Remote Event 流，并注册**纯文本**的 `browser_*` 工具集——经扩展在真实浏览器中读取页面、点击元素、填写表单、滚动与导航，登录态保留。侧边栏是对话入口，工具才是产品本体。

**纯文本浏览器工具，多模态对话透传**：页面快照仍是结构化文本（标题、正文、带编号的交互清单、敏感值打码的表单字段），所有浏览器动作按稳定编号寻址。通用 RPC 通道也会透传 dsh 0.2.0 的图片消息和持久附件读取；延迟创建的新会话只在宿主确实挂载附件服务时声明图片限制。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `token` | `string` | 自动生成 | 固定 bearer token。缺省时首次启动生成，写入 `~/.dsh/ext-bridge-token`（0600）并打印在启动日志。 |
| `toolTimeoutMs` | `number` | 90000 | 单次工具调用预算，为扩展的 60 秒审批窗口预留时间。 |
| `snapshotMaxChars` | `number` | 32000 | 单次快照渲染字符上限，最小为 500（经 `hello.ok` caps 协商给扩展）。 |
| `maxInteractiveItems` | `number` | 60 | 单次快照交互清单条数上限。 |
| `sessionWorkspacePath` | `string` | `~/.dsh/browser-sessions` | 扩展创建的会话所用的专用 Host Workspace。插件会在首次调用未显式指定工作区的 `session.create` 时创建并幂等注册该目录；会话的 cwd 随之变为此路径，因此 GUI 会显示 `browser-sessions` 工作区分组。设为 `""` 可让会话继续显示在“未分组”中。 |
| `deferSessionCreate` | `boolean` | `true` | 会话只在第一条消息时才真正创建：`session.create` 先返回一个内存暂定 ID（不落库），历史读取为空，第一次 `session.prompt` 才创建真实会话（同一 ID、回放原始创建参数）。只打开面板不说话，会在会话库/GUI 里不留任何痕迹。 |
| `artifactMaxBytes` | `number` | 2147483648 | 产物清扫在会话工作区里保留的字节上限。 |
| `artifactMaxFiles` | `number` | 2000 | 产物清扫在会话工作区里保留的文件数上限。 |
| `artifactTtlMs` | `number` | 604800000 | 超过该年龄的产物无条件淘汰，不受另外两个预算影响。 |
| `artifactSweepIntervalMs` | `number` | 600000 | 两次产物清扫之间的间隔。 |
| `artifactRoot` | `string` | `""` | 清扫根。为空时退回 `sessionWorkspacePath`。删除边界优先取 `DSH_BROWSER_SESSION_WORKSPACE`，缺省即该根自身，因此把它设成 `~/Desktop` 时它自己就是边界、只剩 `$HOME`、文件系统根、Git 三道闸；请有意设置。两者都没有边界时一个文件也不删。 |

工作区分组采用尽力而为方式。如果组合没有 workspace 域、目录创建失败，或 `workspace.create` 拒绝该路径，插件会记录一条警告，并在不注入工作区的情况下发送所有会话创建请求，因此浏览器聊天仍可使用。

## 产物预算

会话工作区是缓存区，不是交付物目录。扩展写进去的截图、页面转储和另存的 HTML 会在启动时、每个 `artifactSweepIntervalMs`（默认 10 分钟）以及会话清除之后各清扫一次，因此长时间 QA 不会把磁盘写满。交付物请放项目目录；只留在工作区里的文件随时可能被淘汰。

保留策略有三个互相独立的限制，都通过上面四个键配置：总字节不超过 `artifactMaxBytes`、文件数不超过 `artifactMaxFiles`、且没有文件早于 `artifactTtlMs`。淘汰按修改时间从旧到新进行，直到三个条件同时满足；每条清扫日志都会写明 `root=<path>` 与 `skippedGit` 计数。只有图片受管理（大小写不敏感）：`.png`、`.jpg`、`.jpeg`、`.webp`、`.bmp`、`.ppm`、`.gif`；HTML 与页面转储一律不删，因为它们经常就是交付物。符号链接既不跟随也不删除，工作区里的其他文件一律不管。

删除之前，清扫会解析真实路径并要求边界来自 `DSH_BROWSER_SESSION_WORKSPACE`（优先）或非空的 `artifactRoot`；两者都没有时一个文件也不删，并按根只记一条 `no artifact boundary configured` 日志。清扫根必须等于该边界或位于其下——当边界就是 `artifactRoot` 本身时，这个包含校验必然成立，所以该路径必须有意指定；此外 `$HOME`、文件系统根、以及本身就是 Git 仓库的根都会被拒绝。根内更深处的 `.git` 目录会被跳过（不进入、不触碰），并在首次发现时记一次 `skippedGit=1`，因此在 workspace 里 `git init` 不会让预算失效。可选环境变量 `DSH_BROWSER_ARTIFACT_MAX_BYTES`、`DSH_BROWSER_ARTIFACT_MAX_FILES`、`DSH_BROWSER_ARTIFACT_TTL_MS`、`DSH_BROWSER_ARTIFACT_SWEEP_INTERVAL_MS` 未设置或不是数字时回退到 schema 默认值。

## 使用

远程安装器会下载一个由脚本托管的 workspace，构建插件，并将它的官方 bundle 注册到本机 dsh 的 `web` profile。该方式无需 Git，也无需提前 clone：

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
cd ~/.dsh/dsh-browser && pnpm start
```

Windows 请改用 PowerShell 安装器：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
cd $HOME\.dsh\dsh-browser; pnpm start
```

开发者也可以 clone 仓库，在 checkout 中依次运行 `./scripts/install.sh` 和 `pnpm start`。本地模式直接使用当前分支，不会下载或覆盖源码。两种安装模式都会注册同一个 profile bundle；构建工具只从选定的 workspace 解析，绝不读取父 checkout 或父目录的 `node_modules`。

当前工作区固定使用 dsh 0.2.0-rc.2，也是最低支持版本；不再支持旧版 DSH：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

安装器会把已解压扩展复制到 `~/.dsh/browser-extension` 并打开 `chrome://extensions`。在 Chrome 中加载这个稳定目录，然后使用侧边栏。扩展会自动发现回环连接，无需输入 token；非回环部署仍需要配置的 bearer token。

## 安全模型

- 桥路径在 `/api` 信任栅栏**之外**（栅栏只罩 client-connection 注册的路由），因此自带 bearer token 认证：首帧必须是 `hello`（5 秒内），常量时间比对，失败即断开。
- `/api` 载体钉在回环上的方法（`settings.*`、`credentials.*`、`host.pickDirectory`、`host.openPath`）对非回环来源**即使 token 正确也拒绝**——对 `--host 0.0.0.0` 部署的纵深防御。
- 同一时刻仅一个活动连接，新认证连接顶替旧连接。
- 桥是 confused-deputy 边界而非通用认证层：不要把 `dsh web --host 0.0.0.0` 暴露在不信任的网络上。
- 抽取的页面文字会标记为模型的不可信输入。页面读取遵循扩展的询问/自动/关闭策略；状态变更工具必须经过按 origin 的侧边栏决策，没有侧边栏时失败关闭。同源后续操作可只在当前侧栏会话中临时信任，永久信任仍需显式设置。

## 线协议

帧为按 `t` 判别的 JSON 对象，定义在 [`protocol.ts`](src/protocol.ts)，是通过 workspace 包的 `./src/*` export 与扩展共享的真源。构建后的包还会发布 `@yuxianglin/dsh-bridge-browser/protocol`，供外部消费方使用。

- 客户端 → 服务端：`hello`（认证+caps）、`rpc`（网关方法透传）、`respond`（按 RPC id 结算宿主交互）、`tool.result`、`pong`。
- 服务端 → 客户端：`hello.ok`（回显协商后的 caps）、`rpc.result`、`respond.result`（相关联的受理结果或错误）、`event`（由 dsh Remote 流与 waterfall 投影而来的 bridge 内部事件）、`tool.call`、`ping`、`error`。

每个 `respond` 同时携带全局唯一的传输 id 与宿主交互的 `rpcId`。扩展只把回执路由给发起操作的面板，并在超时、面板关闭或桥断线时拒绝尚未完成的响应。

## 工具

| 工具 | 用途 |
|---|---|
| `browser_snapshot` | 结构化文本快照（标题/URL/正文/清单/表单）；`delta: true` 只返回变化。 |
| `browser_click` / `browser_type` / `browser_press` | 按稳定编号操作清单元素。`browser_click` 另支持 `button`、`count`（双击/三击）与 `modifiers`（`ctrl+shift`），需要扩展 0.3.0。 |
| `browser_select` / `browser_upload_file` | 选择 `<select>` 选项；把本地文件挂到文件输入框。`{ path }` 形式的条目只在会话工作区或该会话的 artifact 根内读取，内联 `{ name, base64 }` 条目单次上限 10 MB。 |
| `browser_hover` / `browser_drag` | 按清单编号或视口坐标悬停、拖拽；扩展能附加调试器时发送真实输入事件，否则退化为合成 DOM 事件并在结果里说明。 |
| `browser_find` | 用查询词对快照清单打分，返回最接近的编号。 |
| `browser_list_tabs` / `browser_close` | 列出可访问标签页的稳定 ID、窗口/顺序、归属/受控状态与 `origin`（`created` 表示本会话打开，`adopted` 表示早已存在或被跟随）；不带 `tabId` 时，`browser_close` 关闭本会话打开的全部标签页并返回 id 列表，没有可关的也成功并返回空列表，点名不属于本会话的标签页会被拒绝。 |
| `browser_evaluate` | 在用户批准后执行页面 JavaScript；结果会脱敏并限制长度。 |
| `browser_screenshot` | 把受控标签页截图写入工作区文件，返回路径供 `read_image` 读取。`scale` 只接受 1/2/3（带裁剪区时默认 2）；裁剪区取整到整视口像素，负原点、零尺寸、越出视口、单边超过 8192 px 或总像素超过 4,194,304 一律拒绝并回显真实视口与被拒矩形，不再静默夹取，返回的宽高取自该计划值。 |
| `browser_console` / `browser_network` | 读取受控标签页的 console 消息与网络请求缓冲。 |
| `browser_batch` | 顺序执行最多 25 个工具调用，首个失败即停。 |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 页面移动。 |
| `browser_resize` | 调整承载受控标签页的窗口尺寸。 |
| `browser_get_text` / `browser_wait` | 读区域文本 / 稳定检测。 |

0.1.0 新增的工具需要扩展 0.3.0：对旧扩展调用时会返回明确的「请 reload 或更新扩展」结果，而不是原始 `Unknown action` 错误；原有 15 个工具行为保持不变。

## 模型体验

- **Token 影响**：一次 `browser_snapshot`（默认 32k 字符）对常见英文文本约为 8–10k token，具体取决于语言和分词器；delta 快照只需零头。系统提示段落引导模型按需快照而非囤积页面文本。
- **KV 缓存影响**：无（快照不做服务端缓存）。
- **延迟**：每次动作等待扩展在真实页面执行 + 稳定检测（通常 0.2–2s；导航最长 5s）。
- **失败模式**：`bridge-closed`（扩展未连接）、`timeout`、`no-active-tab`、`content-unavailable`（页面需刷新）、`action-failed`（编号过期且按选择器重新定位也未成功——模型应重新快照；重新定位成功会在结果里说明，0 命中或多命中则回报选择器与命中计数）。

## 扩展点

- 工具集是消费面；seam 是桥接线（`protocol.ts`）。在 `ctx.tools` 注册新工具并经由桥分发即可，扩展的 content script 按动作名分发。
- 协商 caps（`hello.ok`）让插件无需共享配置文件即可向扩展下达快照预算。

## 已知限制与后续工作

- 仅一个活动扩展连接（第二个窗口顶替第一个）。
- `browser_screenshot` 把文件写到 `<artifactRoot>/<sessionId>/screenshots/`；没有配置 artifact 根时工具会明确报告没有可用目录。图像以路径返回、不返回内联图片块，模型需用 `read_image` 读回。`scale` 只接受 1/2/3；小于 1 的取值（此前 0.1–1 区间）会作为非法参数报错。
- `browser_console` 与 `browser_network` 只从首次在某个标签页调用时开始采集；缓冲只在内存，主框架文档被替换（刷新或跨文档导航）时清空，同一文档内的 hash、query 与 SPA 变化则保留，标签页关闭即丢弃。
- `browser_evaluate` 与 `browser_upload_file` 属状态变更类工具，走扩展的审批流程；`browser_evaluate` 在页面主世界执行，受保护页面不可用。
- `browser_hover`、`browser_drag` 以及带 `button`/`count`/`modifiers` 的 `browser_click`，在扩展对受控标签页持有调试会话时发送真实输入事件，否则退化为合成 DOM 事件并在结果中说明。
- 侧栏可选的实时画面（默认关闭）把受控标签页的 `Page.startScreencast` JPEG 帧送到面板：帧先 ack 再处理，旧帧按序号丢弃，切换受控标签页或调试器断开即清图。后台标签页、无 debugger 与 Firefox 上的实际停帧时序尚未真机验证。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。快照始终覆盖全部可访问 frame；其余按编号寻址的工具接受该地址里的可选 `frame`——find、get_text、click、type、press、hover、select、drag、upload_file、scroll 与 wait——缺省作用于顶层页面。
- token 手动轮换（改 `~/.dsh/ext-bridge-token` 或配置 `token`），无过期。
- Playwright 驱动的扩展 e2e 会在缺少可用的 Chromium 可执行文件或构建完成的扩展包时自行跳过。
- 审批由扩展 service worker 强制执行，而不是依赖模型自觉。未来接入 dsh 工具管线时可以把同一策略暴露给其它客户端。
