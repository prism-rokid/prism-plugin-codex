# codex

Codex desktop-automation plugin.

This release uses the public `@rokid-prism/pluginbridge-plugin-sdk` package and the
Hub-managed Node 22 runtime. It does not search for an SDK or a Node binary in
the Prism application tree.

Current behavior:

- reads `~/.codex/session_index.jsonl` to enumerate existing Codex threads
- controls Codex Desktop through a plugin-local Codex controller built on the SDK generic CDP runtime
- selects an existing thread by exact native identity, using the visible sidebar when available and the desktop route fallback with selection verification
- creates a new Codex thread from the actual desktop sidebar / project row instead of deep-linking a thread route
- sends text through the real Composer editable surface and its uniquely owned native submit action
- switches model / reasoning / permission from the actual desktop menus through CDP
- reads and controls Codex goal state (set, pause, resume, clear) from the actual desktop goal card through CDP; remote editing is explicitly unsupported
- reads and toggles plan mode from the actual desktop composer and `/` command panel through CDP
- resolves approval requests from the actual desktop approval UI through CDP
- interrupts the target Codex turn through its uniquely owned native Stop action
- waits for the Codex rollout file to produce an assistant summary after send
- verifies visibility by scanning `~/.codex/sessions/**/*.jsonl`

Current limits:

- full Codex Mini-style reliability is currently verified on macOS first
- Windows Store/MSIX Codex uses `%APPDATA%\\Codex\\web\\Codex`; the Plugin detects that profile when it exists so Hub and Plugin use the same CDP port file. Windows still needs full desktop-control regression.
- reverse sync includes plugin-wide directory events and foreground conversation snapshots; an unavailable foreground watcher is reported explicitly
- approval event delivery / mobile-side lifecycle still needs further regression, but desktop-side resolve is now CDP-driven
- if Codex is already running without a CDP port, the plugin will refuse to attach unless you close Codex and let Prism manage startup, configure `PRISM_CODEX_CDP_PORT` / `PRISM_CODEX_CDP_URL`, or enable managed relaunch
- `/` command panel automation is limited to the verified goal and plan-mode entries. Skill selection, context compact, MCP selection, target selection, and other entries remain unsupported until their real Codex Desktop UI can be verified and controlled through CDP without adding Prism-side shadow state or non-CDP fallback paths.

官方推荐配置入口是 Prism Desktop 的插件页：

- 普通用户优先使用“应用路径”“数据目录”“托管启动”这些明确字段
- 只有开发者模式才会显示原始 env 覆盖
- 不要再要求用户通过一次性的 shell `export` 来启动 daemon

Recent Codex desktop builds may be hosted by `ChatGPT.app` instead of a standalone
`Codex.app`. The plugin detects both `/Applications/Codex.app` and
`/Applications/ChatGPT.app` by default。只有非标准安装位置时，才需要在
Dashboard 插件页手动指定应用路径；原始 `PRISM_CODEX_APP_PATH` 仅保留给开发者模式。

开发者模式下可用的 env 覆盖：

- `PRISM_SQLITE3_BIN`
- `PRISM_CODEX_CDP_URL`
- `PRISM_CODEX_CDP_PORT`
- `PRISM_CODEX_DEVTOOLS_FILE`
- `PRISM_CODEX_APP_PATH`
- `PRISM_CODEX_USER_DATA_DIR`
- `PRISM_PLUGIN_MANAGED_LAUNCH`

Control-path notes:

- 桌面控制通过 CDP 执行；非侧栏可见线程允许使用宿主路由回退，并必须核对前台身份；不通过 app-server 或系统剪贴板执行会话写操作。
  - 例外：账号额度投影（`agent_usage`）是只读诊断通道，投影 5 小时（300 分钟）和每周（10080 分钟）两个窗口；仍走 App Server 的 `account/rateLimits/read`、`account/usage/read` 与 `account/rateLimits/updated`，不参与任何 thread 控制；可执行体按序解析桌面 app 内置二进制（`Contents/Resources/codex-cli/bin/codex`（2026-09 桌面版新布局）或旧布局 `Contents/Resources/codex`）以复用 `~/.codex/auth.json`，PATH/npm CLI `codex` 会因 `-32600 chatgpt authentication required` 失败
- 模型 / 推理 / 权限优先走桌面 live 菜单索引点击，减少对中英文文案匹配的依赖
- manifest 将 Desktop 的模型、推理、权限声明为 `runtime_controls.*=interactive`；组合 intelligence 控件携带 `semantic_kinds: [model, reasoning]`，权限控件携带 `[permission]`。Plugin 不再同时对外发布稳定 `current_*` 控件，也不发布 `codex.intelligence.effort` 这种内部 slider ID；它只能作为组合 intelligence 菜单内部的 CDP 执行路由。
- manifest 将重命名、置顶、归档、删除声明为 `runtime_operations.*=menu`；这些操作只从当前真实 Header menu-session 暴露，不再与 direct `actions[]` 重复。
- 附件通过当前 ComposerController 注册的文件处理器注入；同时兼容旧 File[] 与新 {files, dataTransfer} 包装契约，每个处理器仅调用一次；TXT/PNG 通过 CDP 文件输入传输取得真正由磁盘支持的 File，并保留本地路径；临时输入在调用结束后回收。
- `/` 命令面板能力后续也必须按 CDP-only 原则补齐；在未验证桌面真实 UI 前，不把这些能力暴露成正式手机端操作。

0.1.32 回归修复：

- 适配无图标的 Plan/Goal slash rows、新 Plan 标志和 Goal 摘要布局；Goal 提交使用精确 DOM 事件，后台宿主也能生效；超时包含等待阶段且读回一次晚到状态，不重复点击。
- 历史投影排除完整 AGENTS 指令与 external_codex_apps_open_page 内部信封，保留普通业务正文。
- 完成事件以 native task/turn ID 标识；设置和额度记录追加不再重发完成事件；正向等待与桌面监听共享事件 ID。Hub 侧同步去重与绑定验证修复需使用对应的 Hub 修复构建。

### 0.1.33 桌面深层 Composer 状态修复

桌面布局可将发送状态 owner 放到按钮第 26 层 Fiber 祖先；原 16 层查找会错误报告 `queue_unavailable`。现在发送、排队、引导、停止与运行态统一采用有界 64 层查找，继续校验完整按钮契约、唯一 owner 与当前可见输入框。超时诊断保留具体 `reason`，不包含用户正文。

### 0.1.34 Header 菜单身份修复

Header 菜单项可能共享相同的 React `onSelect` handler 源码。菜单行身份现结合 handler 指纹与 React key / DOM 稳定标识；菜单应用前仍重新读取并核对完整身份快照，无法区分的项目继续安全拒绝。组合模型与推理控件保持唯一公开 owner，`codex.intelligence.effort` 仅作为菜单会话内部滑杆路由。

### 0.1.44 项目新建草稿修复

项目身份查找只遍历有界的普通数据属性，跳过 getter、DOM/Window 等宿主对象和循环引用，避免跨域 `SecurityError`。新建按钮限定在请求的项目行内，并继续要求精确 cwd、project ID 和唯一原生操作 owner；不回退到其他项目或当前会话。

匿名草稿指纹使用相同的安全数据遍历，并在有界 64 层 Composer Fiber 中读取原生 clientThreadId，避免旧遍历异常或较深布局造成草稿身份不可读。

### 0.1.46 问题交互与审批推送修复

- 支持原生问题卡片与异步问题卡片，转发题目、选项和自由回答能力，并按原生请求身份提交或跳过。
- 适配异步问题的原生草稿更新和发送回调；提交前重新校验请求，避免向已变更的问题发送答案。
- 识别使用外层表单提交的审批按钮，并兼容审批结构标记与对话框布局。
- 包含 0.1.44 的项目新建和匿名草稿身份安全遍历修复。
