# dsh 浏览器操作扩展（Chrome 与 Firefox MV3）

[English](README.md) | 中文

dsh 的**浏览器操作端**：让模型直接读取并操作你在浏览器里打开的页面——抓取内容、点击元素、填写表单、滚动与导航，全部在真实页面执行、登录态保留。侧边栏面板是与模型对话的入口。

**两条明确分离的通道**：浏览器页面仍以结构化文本呈现（带编号的交互元素清单），浏览器读取保持文本形态，只有模型显式调用 `browser_screenshot` 时才截图，并由宿主落盘为文件；另一方面，dsh 0.1.2 宿主可声明多模态图片限制，侧栏据此接收 PNG、JPEG、WebP 和 GIF，并渲染会话中的持久图片附件。

## 模型能做什么

| 能力 | 动作 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，省 token |
| 点击元素 | `browser_click` | 按编号点击（链接/按钮/复选框…），React/Vue 组件兼容 |
| 填写表单 | `browser_type` | 输入文本，`replace` 清空重填 |
| 按键 | `browser_press` | Enter/Tab/Escape/方向键等 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内跳转，或新开标签页并跟随 |
| 列出标签页 | `browser_list_tabs` | 列出可访问标签页的稳定 ID、标题、URL、归属/受控状态，以及 `origin`（`created` 表示本会话打开，`adopted` 表示不是本会话打开的） |
| 跟随标签页 | `browser_follow_tab` | 将后续浏览器工具绑定到已列出的标签页，而不激活该标签页 |
| 关闭标签页 | `browser_close_tab` | 关闭已列出的标签页 |
| 关闭本会话标签页 | `browser_close` | 不点名时关闭本会话打开的全部标签页；没有可关的也成功并返回空列表，点名不属于本会话的标签页会被拒绝 |
| 读区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 页面加载与渲染稳定检测 |
| 选择选项 | `browser_select` | 按 value、label 或序号选择；未命中会列出可用选项 |
| 检索清单 | `browser_find` | 用查询词给清单元素打分，返回最接近的编号 |
| 附件上传 | `browser_upload_file` | 用宿主发来的字节构造 `File` 并写入文件输入框 |
| 悬停 / 拖拽 | `browser_hover` / `browser_drag` | 对受控标签页持有调试会话时发送真实输入事件，附加失败时退化为合成 DOM 事件 |
| 点击变体 | 带 `button` / `count` / `modifiers` 的 `browser_click` | 右键/中键、双击/三击与修饰键组合，走调试会话 |
| 执行页面 JS | `browser_evaluate` | 需用户审批；结果脱敏并限制长度 |
| 截图 | `browser_screenshot` | 整视口或视口坐标系内的整数裁剪区，由宿主落盘并返回文件路径；`scale` 只接受 1/2/3，带裁剪区时默认为 2；负原点、零尺寸、裁剪区越出视口，或渲染后单边超过 8192 px、总像素超过 4,194,304 一律报错，错误里回显真实视口与被拒矩形，返回的宽高取自该计划值 |
| 实时画面 | 侧栏开关 | 可选显示受控标签页的 JPEG 实时画面，默认关闭：帧来自 CDP screencast，先 ack 再处理，旧帧按序号丢弃，切页或调试器断开即清图 |
| console 与 network | `browser_console` / `browser_network` | 首次调用起按标签页缓冲；请求头与 URL 凭据脱敏，请求正文只记字节数 |
| 调整窗口 | `browser_resize` | 调整承载受控标签页的窗口尺寸 |
| 模拟视口 | `browser_viewport` | 通过调试器模拟视口（`mobile` 默认 false）；与窗口缩放不同，随调试器断开（空闲 60 秒）失效，`reset: true` 立即撤销 |
| 打印 PDF | `browser_pdf` | 把受控标签页打印为 PDF，由宿主落盘并返回路径；需要调试器 |
| 批量 | `browser_batch` | 顺序执行工具调用，首个失败即停 |
| 图片对话 | `session.prompt` / `session.attachment` | 按宿主能力启用图片选择、纯图片发送和持久历史预览 |
| 引用你划选的内容 | 侧栏输入框 | 你在页面里选中的文字会变成输入框里的引用，随下一条消息一起发送 |
| 输入框加号菜单 | 侧栏输入框 | `+` 菜单与本体一致：**添加**区放图片，**指令**区列出宿主指令目录（本地化标签＋描述），选中即补全草稿 |
| 斜杠指令 | 侧栏输入框 | 输入 `/` 列出宿主指令目录（目标、计划、反馈、压缩等）并显示本地化标签；选中后补全草稿，回车经宿主指令服务执行（带图片或引用时改走普通消息）；失败的命令会回显错误文案，成功的命令不额外插入一行——其效果由会话本身反映 |

## 架构

```
side panel (React) ◄─port─► background SW/事件页 ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

- **background**（`src/background/`）：桥连接（token 认证 + 指数退避重连 + 保活）、网关 RPC 客户端，以及**失败关闭地分发工具到用户受控标签页**。
- **content script**（`src/content/`）：纯文本快照（可读性主文 + 编号交互清单 + 表单字段）、**稳定编号**（`data-dsh-el`）、delta 变化、点击/输入/按键/滚动/导航动作、敏感字段掩码，以及带防抖的划选监听——只有侧栏打开且页面共享不是「关闭」时才会启用。
- **panel**（`src/panel/`）：React 对话界面（可续接会话/历史/实时事件/设置）；图片选择和预检由宿主声明的限制控制，持久图片通过会话授权读取；消息以已消毒的 Markdown 渲染，`ask_user_question` 请求会显示成可直接作答的卡片，手动切页时显示控制权交接条，运行中的回合提供标准停止按钮，页面划选的段落显示为可移除的引用卡片，并在下一条消息中包在不可信内容边界里发送。
- **协议**：`@yuxianglin/dsh-bridge-browser` workspace 包中的 `protocol.ts` 是两端共享的真源，具体通过该包的源码 export 共享。

## 构建

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

请在仓库根目录执行这些命令。Chrome 产物输出到 `extensions/dsh-browser/dist/`；Firefox 产物输出到 `extensions/dsh-browser/dist-firefox/`。

## 安装与使用

推荐的零配置命令无需安装 Git，也无需提前 clone：

1. **构建并安装扩展**：

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   Windows 请改在 PowerShell 中运行：

   ```powershell
   $s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
   ```

   脚本会把托管 workspace 下载到 `~/.dsh/dsh-browser`，构建桥插件，把它的官方 bundle 注册到本机 dsh 的 `web` profile，再构建扩展并把产物复制到稳定目录 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。开启开发者模式，选择「加载已解压的扩展程序」，加载扩展目录。再次运行该命令会更新托管安装。

   clone 得到的 checkout 也使用同一个安装器，而且不会下载或覆盖源码：

   ```sh
   git clone https://github.com/Lum1104/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

   Windows checkout 请运行 `.\scripts\install.ps1`。路径可以包含空格：安装器通过 profile 内的目录联接注册插件，不会把 checkout 的绝对路径写入 pnpm link 规格。

2. **启动 dsh 并挂载桥插件**。可以使用 workspace 固定的运行时：

   ```sh
   cd ~/.dsh/dsh-browser && pnpm start
   ```

   如果使用 clone，请改为在仓库根目录运行 `pnpm start`。

   或使用受支持的精确公开版本：

   ```sh
   npx @deepseek-ai/dsh@0.2.0-rc.2 web
   ```

   两种命令都会从本机 `web` profile 加载同一个 bundle。默认端口为 3080；如被占用，可追加 `--port <port>`。

   **DSH Desktop 用户**：桌面版默认让系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），自动探测无法预知随机端口。请在桌面版设置中把端口固定为 `43189`（见 [deepseek-harness-desktop 用户指南](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.md)），扩展的自动探测会覆盖该端口；或直接在侧栏设置中手动填写 `http://127.0.0.1:<端口>`。

   加载或重新加载扩展本身是被动的：只有打开侧栏后，扩展才会探测本机端口并创建 WebSocket。用户已建立的健康连接可在侧栏关闭后继续用于后台审批；但连接一旦掉线或被另一浏览器替换，没有打开侧栏时就不会重连。

3. **开始使用**：打开普通的 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标打开侧边栏。两个构建都会自动探测本机 dsh。Chrome 回环连接无需地址或 Token；Firefox 的 `moz-extension://` UUID 不能证明扩展身份，必须在设置中填入 `~/.dsh/ext-bridge-token`。可以直接对话，或先点「读取页面」。

页面即使在扩展安装或重载之前已经打开，也会在第一次操作时自动补加载内容脚本，无需手动刷新。`chrome://`、Chrome Web Store 等浏览器内置或受保护页面只提供标签页元数据，以及浏览器级 HTTP(S) 导航、后退、前进和刷新；不能读取或操作其 DOM。

如果只开发扩展，Chrome 从 `chrome://extensions` 加载 `extensions/dsh-browser/dist/`；Firefox 运行 `build:firefox` 后，从 `about:debugging#/runtime/this-firefox` 加载 `extensions/dsh-browser/dist-firefox/manifest.json`。代码更新后需重新构建并重新加载。

## 为什么浏览器操作仍采用纯文本

- **快照即视图**：模型对页面的全部认知 = 结构化文本（标题/URL/正文/编号元素/表单），默认预算 32k 字符（插件可配，经 `hello.ok` 协商给扩展）。
- **页面文字是不可信输入**：快照和局部文本读取会放进带随机 nonce 的信任边界，并明确要求模型不得把网页中的命令当成指令。这只是纵深防御；扩展侧的操作审批才是强制安全边界。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。每个编号同时记录稳定的 CSS selector，页面重渲染后动作会按 selector 重新定位并在结果里说明；0 命中或多命中会带 selector 与命中计数报错。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号，省 token。
- **隐私**：密码/卡号字段的值永远以 `••••` 呈现，绝不回传；可访问名称从不使用敏感字段的当前值。
- **标签页绑定**：提交提示时会在模型开始工作前绑定活动标签页；如果直接调用浏览器工具，也会在需要时完成首次绑定。手动切换标签页或窗口后，后续工具会暂停，并询问助手继续原页面还是跟随当前页。选择原页面后允许后台操作，但不会改变用户正在看的页面；选择跟随后会重置页面引用状态。受控页关闭后失败关闭，直到用户选择当前页；切页还会撤销尚未完成的操作审批。
- **分级审批**：默认「自动共享」允许模型按需读取受控标签页而不额外弹窗；「每次询问」可恢复逐次读取确认，「关闭」会阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取，之后仍可在设置中关闭。状态变更工具仍然失败关闭，并显示实际 origin 和脱敏动作摘要；用户可拒绝、仅允许一次，或只在当前侧栏会话中信任单个 origin。最后一个侧栏关闭或 Service Worker 重启会清空临时信任；永久信任需在设置中显式管理。侧栏关闭时，审批最多保留 60 秒；启用通知后，系统通知可把用户带回侧栏。会话级审批只会在其所属会话恢复完成后显示。调用方取消或桥接超时时，会先撤销尚未完成的审批，过期动作不会继续执行。
- **完全控制需显式开启**：**允许模型完全控制浏览器**只有设置保存成功后才会生效，启用后页面读取、页面操作以及标签页列出/跟随/关闭均无需确认。调用在收到时固定其访问模式，因此开启完全控制不会追溯提升已经开始的受限调用。关闭会立即生效：取消尚未下发操作的调用，等待已经下发到浏览器的操作完成，再保存限制设置。快速重新开启也会在旧权限撤销完成前保持受限，并发保存会按请求顺序落盘。受保护页面的 DOM 内容始终不可访问。
- **会话续接**：重新打开侧栏时默认恢复最近活跃的浏览器会话；若该会话不可用，则恢复最新的非空持久会话，最后才创建新会话。可在设置中关闭。

## 权限说明

Chrome 使用 `sidePanel`，Firefox 使用 `sidebar_action`。两者都申请 `storage`（设置与最近会话续接）、`notifications`（侧栏关闭时可选的审批提醒）、`tabs` + `activeTab` + `scripting`（观察切页，并向用户显式选择的受控标签页注入/发消息；安装前已打开的页面也会按需补注入）、`webNavigation`（枚举该标签页中的 frame，并把消息绑定到具体文档）、`alarms`（后台保活）和 `http/https`（内容脚本注入普通网页）。两者也申请 `debugger`，但只用于受控标签页：真实指针输入、页面 JavaScript 执行、带裁剪/缩放的截图，以及 console/network 缓冲。附加调试会话期间 Chrome 会显示「正在调试此浏览器」信息栏；点掉该信息栏会 detach 会话，需要它的工具随即回退到纯 DOM 实现并在结果中说明。Firefox 不提供 `chrome.debugger`：扩展探测到 API 缺失后，把所有依赖调试器的工具降级到纯 DOM 实现，不会抛崩。Firefox AMO manifest 如实声明扩展会把浏览活动、网页内容/操作和对话内容发送给用户配置的 dsh/模型服务。扩展绝不改变用户正在看的标签页，也不会静默跟随手动切页；只有用户选择继续原页面后，助手才会在后台操作。

## 已知限制

- 同时只有一个扩展连接桥。未打开侧栏的浏览器 Profile 不会抢占连接；另一个已打开的侧栏顶替连接后，被替换的一端会主动让权，不再反复重连互踢。
- 标签页绑定属于整个扩展连接，而不是单个对话会话。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。快照始终覆盖全部可访问 frame；其余按编号寻址的工具接受该地址里的可选 `frame`——find、get_text、click、type、press、hover、select、drag、upload_file、scroll 与 wait——缺省作用于顶层页面。
- 历史前进/后退恢复的页面仍保留 iframe：当 Chrome 的 frame 枚举漏掉 bfcache 文档的子 frame 时，按 frame id 复用该文档上一次的 frame 树。
- 验证码/纯图片按钮无法处理——工具结果会标注"存在无文本可访问名的元素"，提示用户手动完成该步。
- 令牌无自动轮换。
- `browser_press` 在受控标签页位于前台、窗口聚焦且调试器已附加时通过浏览器输入管线发送真实按键，因此 Tab 焦点移动、方向键滚动与 Enter 提交都遵循浏览器默认行为。真实输入不可用时改为合成 `KeyboardEvent`，并在结果里说明降级及原因；合成事件不触发浏览器原生默认行为。
- `browser_wait` 以加载完成 + 固定静默窗口为准，不观察持续 DOM 更新（连续刷新的 SPA 可能被报为稳定）。
- 真实指针输入、裁剪/缩放截图、页面 JavaScript 执行与 console/network 缓冲都依赖绑定在受控标签页上的调试会话：按需 attach，空闲 60 秒或标签页移出本会话归属即 detach，绝不附加用户未交给本会话的标签页。用户点掉 Chrome 的调试信息栏后，这些工具回退到纯 DOM 行为并在结果里说明。
- 真实输入只在标签页位于前台且窗口聚焦时才会到达页面；不满足时指针工具改为合成 DOM 事件，在结果里说明原因，并保留请求的按键、连击次数与修饰键语义（浏览器级默认行为如导航与原生右键菜单不会发生）。
- 带原生拖放语义的目标会收到 `Input.dispatchDragEvent` 的 enter/over/drop（带 `text/plain` 载荷）；没有该语义的目标仍用普通鼠标拖拽序列，浏览器拒绝该协议时回退合成拖拽事件。
- 原生拖放识别只读取隔离世界可观测的信号：端点自身或祖先的 `draggable` 属性，以及元素、document（`ondrop`）、documentElement 或 window 上的内联拖放处理器。仅用 `addEventListener` 注册拖放监听的页面无法识别，会继续走普通鼠标拖拽路径，其 drop 处理器可能不会执行。
- console/network 缓冲在调试会话空闲 detach 后仍然保留：直到主框架文档被替换（刷新或跨文档导航）、标签页关闭或会话结束才清空，同一文档内的 hash、query 与 SPA 变化则保留。重新 attach 时 Chrome 会重放日志历史，这些重放会与已有缓冲去重。
- 降级截图走 `captureVisibleTab`，只能截当前活动标签页的可见区域，且忽略 `scale`；调试器路径才支持对受控标签页裁剪与缩放。支持的缩放只有 1/2/3；小于 1 的取值（此前 0.1–1 区间）会作为非法参数报错。
- 实时画面在后台标签页、无 debugger 与 Firefox 上的实际停帧时序尚未真机验证；这些状态下侧栏会显示具体原因，而不是残留旧帧。
- `browser_console` 与 `browser_network` 从首次在某个标签页调用时开始采集。没有调试会话时在页面主世界 hook `console`、`fetch` 与 `XMLHttpRequest`，会漏掉 hook 之前的请求、文档/资源请求与 Service Worker 流量；结果里会说明数据来自哪条路径。
