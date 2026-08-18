# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

## 2026-08-18 — feat: 分享上传/部署进度条（SSE 广播 + COS 真实百分比）

- shared 新增 `ShareProgressEvent`（`share:progress`：packing → uploading（0-100 真实百分比）→ deploying → done/error）；kernel `deployWorkspace` 接 COS `onProgress`，share 路由经 SSE 全程广播（含 error 阶段）。
- 前端新增 `store/share-progress.ts`（订阅广播）与 `components/ui/ProgressBar.tsx`（determinate/indeterminate）；ShareResultModal 生成中与「我的分享」立即部署均显示进度条（部署阶段 EdgeOne 无百分比，用 indeterminate 动画）。
- 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/share/edgeone-client.ts`、`routes/share.ts`、`ws-server.ts`；`packages/frontend/src/store/share-progress.ts`、`components/ui/ProgressBar.tsx`、`ShareButton.tsx`、`settings/ShareSection.tsx`、i18n zh/en；测试同步新增（路由广播序列/错误阶段、ProgressBar、两处 UI 进度用例）。

## 2026-08-18 — fix(kernel): 分享部署必现超时/失败修复（项目名长度 + Zip 部署路径）

- 固定项目名 `wapi` 仅 4 字符被 EdgeOne 项目名 5-63 长度校验拒绝，错误嵌套在 `Data.Response.Error`（顶层 Code=0）未识别 → ProjectId undefined → 轮询永不命中 → 恒报「部署超时」。修为 `wapi-shares`；apiCall 识别嵌套错误；getOrCreateProject 拿不到 ProjectId 显式抛错。
- DistType=Zip 时 TempBucketPath 必须指向 zip 文件本身（只给目录 → Failed Code 26）。已用真实账号端到端验证部署 Success。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`；测试 `tests/edgeone-client.test.ts`（嵌套错误回归用例）、`tests/share-routes.test.ts`。

## 2026-08-18 — test(kernel): 修复套件互染与 6 个真失败，test 脚本加 --isolate

- 排查 kernel 全量测试 38 fail（单文件跑全过）：32 个为跨文件互染 + 6 个为 HEAD 真失败。
- 互染根因：`tests/edgeone-client.test.ts` 模块顶层即执行 `globalThis.fetch = fetchMock`，且"原始 fetch"捕获在劫持之后、afterEach 恢复无效——非 isolate 同进程下劫持所有并发文件的 HTTP 请求。修复：真实 fetch 在劫持前捕获，劫持挪入 `beforeEach`、afterEach 正确恢复。
- 真失败根因：`a2fa15b9`（发送前自动压缩防护）在 `_sendPromptNow` 的 `client.prompt` 前插入 `await _autoCompactIfNeeded`，drain 变异步；`tests/steer-queue-poc.test.ts` 6 个用例仍在 `fake.emit(agent_settled)` 后同步断言 `fake.prompted`，永远缺最后一条。修复：新增 `flushDrain()`（让出一个宏任务），emit 后、断言前等待。
- 预防复发：`packages/kernel/package.json` test 脚本改为 `bun test --isolate`（对齐 frontend）。
- 影响范围：`packages/kernel/tests/edgeone-client.test.ts`、`packages/kernel/tests/steer-queue-poc.test.ts`、`packages/kernel/package.json`。

## 2026-08-18 — feat(frontend): 分享面板 tab 拆分 + 打开分享文件夹；fix: 多选分享超时

- 设置-分享拆为「分享设置 / 我的分享」两个 tab；「我的分享」存储用量旁新增文件夹 icon（`window.waPiApp.showItemInFolder` 打开工作区目录，kernel `GET /api/share/list` 响应新增 `workspaceDir`）。
- fix(frontend)：多文件分享报 "signal timed out"——api-client 默认 30s 超时远低于 COS 上传 + 部署轮询耗时；`api.post` 增加可选 timeoutMs，`shareUpload`/`shareDeploy` 用 10 分钟长超时。
- 影响范围：`packages/frontend/src/api-client.ts`、`share-client.ts`、`components/settings/ShareSection.tsx`、i18n zh/en；`packages/kernel/src/routes/share.ts`（list 加 workspaceDir）；测试 `ShareSection.test.tsx`（tab 切换/文件夹入口 2 新用例）、`share-client.test.ts`（长超时断言）、`e2e/share-management.spec.ts`（tab 适配）。

## 2026-08-18 — feat: 产物分享改为固定项目 wapi + 分享管理（spec: docs/superpowers/specs/2026-08-17-share-project-management-design.md）

- kernel 新增 share/workspace.ts（state.json 事实源 + 读时对账 + 部署快照 diff）；edgeone-client 部署入口改为 deployWorkspace（固定项目 wapi、自定义域名优先、itemShareUrl 子路径链接）；分享路由六端点（upload/list/delete/clear/deploy/refresh-link）；share-store/share-history 模型下线。
- 分享设置增加 customDomain（token 空串保留语义，改域名不冲 token）。
- 前端设置-分享 tab：注册入口链接（zh/en 分流）、自定义域名输入、「我的分享」列表（复制链接/删除/清空/立即部署 + 未部署变更提示 + 存储用量）。
- 影响范围：`packages/kernel/src/share/`、`packages/kernel/src/routes/share.ts`、`settings.ts`、`settings-store.ts`、`ws-server.ts`；`packages/frontend/src/share-client.ts`、`components/settings/ShareSection.tsx`、i18n；测试同步更新 + e2e/share-management.spec.ts。

## 2026-08-18 — fix(frontend): transient 网络错误状态条显示具体原因（不再只有通用文案）

- 问题：模型调用被网关断流/限流（socket closed、429 等）时，kernel `classifySdkError` 已把错误清洗成具体文案并随 `net:status` 广播，但前端 `App.tsx` 收到后丢弃 `e.message`，顶部红条只显示通用文案「模型连接异常，请检查网络或 Provider 配置后重试」——用户分不清是网络抖动还是限额打满，表现为"突然断掉，没有任何提示"。
- 修复：session store 新增 `netMessageBySession` 保存具体原因（与 `netStatusBySession` 同生命周期：setNetStatus/clearNetStatus/agent_start/正常 message_end/removeSession/clear 同步清理）；`net:status` 事件把 `e.message` 传入 `setNetStatus`；红条优先显示具体原因，无原因时回落通用文案。
- 影响范围：`packages/frontend/src/store/session.ts`、`packages/frontend/src/App.tsx`；测试 `tests/App.test.tsx`（红条显示具体原因 + 无原因回落通用文案 2 用例，TDD 先红后绿）、`tests/store-session.test.ts`（message 存取/清除/联动 4 用例）、`src/store/session-memory-leak.test.ts`（per-session key 补 netMessageBySession）。

## 2026-08-18 — chore(env): 开发环境独立数据目录（隔离 start.bat/start.command 与打包版）

- start.bat/start.command（浏览器版 dev，kernel 9776 + Vite 5180）与打包版桌面（Electron 9778）默认共用 `~/.pi/agent` 数据目录，两个独立 kernel 并发读写同一批 JSON 文件（projects/providers/settings/会话/记忆/日志/进程登记簿），互相覆盖、日志交错、登记簿互清。端口本就错开（9776 vs 9778），隔离数据目录才是根治。
- 修复：`.env` 增加 `WA_PI_DIR=${HOME}/.pi/agent-dev`，dev 的所有数据落到独立目录，与打包版 `~/.pi/agent` 完全隔离；打包版不带 `.env` 不受影响。`.env.example` 同步补充说明（支持 `${HOME}` 插值，勿写 `~`，Node 不展开 tilde；用真实数据调试时注释本行即可）。
- 影响范围：`/.env`（已被 gitignore，仅本地生效）、`.env.example`（模板）
- 全量核查（覆盖 kernel/shared/desktop/frontend/scripts 所有 WA_PI_DIR 消费点与硬编码路径）：生产代码无可执行路径绕过 WA_PI_DIR——所有 `~/.pi/agent` 字面量均为「先读 env/waPiDir 的默认值兜底」（constants.ts:25、port.cjs:56、node-runtime.cjs:169、main.cjs:33）；E2E 硬编码的 `~/.pi/agent/auth.json`（chat-blocks/chat-export/rpc-session/file-change-summary）为刻意读真实 LLM 凭证（只读不落盘），非数据目录写入，属有意例外。无绝对路径硬编码、无对新隔离目录 `agent-dev` 的代码误引用。

## 2026-08-18 — fix(frontend): 自动重试的新回答替换 error 消息而非拼接

- 排查「重试时把做到一半的内容重新发送、任务快结束又重来」：根因链为上游网关抖动（503/断流）→ pi auto-retry → pi 将含部分文本的失败消息移出上下文让模型重写整段（LLM API 无状态，重试必发全量历史，不可避免）→ 前端 message_end 合并逻辑把重试新回答 concat 在 error 消息残留的部分文本后，同一内容在气泡里出现两遍。本次修显示层：上一条是同 agent 的 error 消息时，新回答整体替换而非合并。
- 影响范围：`packages/frontend/src/store/session.ts`（message_end 合并分支）；测试 `tests/store-session.test.ts` 新增回归用例（替换不拼接），79 例全过。

## 2026-08-17 — fix(kernel,frontend): 产物分享最终审查修复（token 脱敏 + 死循环防护 + 域名兜底 + 路径规范化）

- I1 安全（合并前必改）：GET/PUT `/api/settings/share` 不再下发 token 明文，share 字段改为 `{ hasToken, channel }`（PUT 仍接收明文输入、回包同样脱敏）；前端 `shareSettings()` 返回结构同步改为 `{ hasToken, channel }`，调用方 ShareButton/ShareSection 用 `hasToken` 判断是否已配置。
- I2（合并前必改）：`commonRoot` 循环加护栏 `if (parent === root) break`，防 Windows 跨盘时盘符根处 `dirname` 恒等导致死循环。
- I3（强烈建议）：`getPresetDomain` 在 PresetDomain 为空时抛错「无法获取项目域名」，不再静默降级返回项目名（Name 不是域名，会拼出打不开的链接）。
- I4（强烈建议）：`hashPaths` 输入路径先统一分隔符（反斜杠 `\` → `/`）再排序拼接，避免 Windows 上同一文件正/反斜杠入口 hash 不同被当作不同项目。
- 影响范围：`packages/kernel/src/routes/{settings,share}.ts`、`packages/kernel/src/share/{edgeone-client,pack}.ts`、`packages/frontend/src/{share-client.ts,components/ui/ShareButton.tsx,components/settings/ShareSection.tsx}` 及对应测试（settings-share-route / share-routes / edgeone-client / share-pack / share-client / ShareButton / ShareSection）。

## 2026-08-17 — feat(frontend): 文件树多选 + 右键分态 + 分享所选（产物分享任务 11）

- ExplorerPanel 自研文件树从单路径选中升级为多选：`selectedPath` → `selectedPaths: Set<string>`；Ctrl/Cmd+点击 toggle 进出选中集、Shift+点击按 flatList 索引区间连选；节点 `data-selected` 改用 `selectedPaths.has(path)`。目录普通点击仍走展开/折叠，拖拽/双击/5s 轮询不受影响。
- 右键菜单分态：多选（>1）时只显示「分享所选」（`ep-ctx-share-multi`，paths=选中项列表，含文件夹）；单选时保留复制路径/默认应用打开/在访达显示并新增「分享」（`ep-ctx-share`）。
- 分享弹层：ExplorerPanel 新增 `sharePaths` state，右键「分享 / 分享所选」置位后直接渲染 `ShareResultModal`（从 `ui/ShareButton` 导出复用，share-client 走注入 transport）。
- 影响范围：`packages/frontend/src/components/ExplorerPanel.tsx`、`ui/ShareButton.tsx`（导出 ShareResultModal）、i18n zh/en（`explorer.ctxShare` / `ctxShareMulti`）、`ExplorerPanel.test.tsx`（新增 5 用例：Ctrl/Cmd 多选、Shift 连选、多选右键分态、单选含分享、分享 paths 正确）。
- 审查修复：右键分态增加归属校验（右键节点必须在选中集内才走「分享所选」，否则单选该节点弹单文件菜单）；workspaceDir 切换时重置选中集与 Shift 锚点；分享弹层关闭即清空 sharePaths；测试补「文件+目录混合多选分享」「弹层关闭卸载」2 用例。

## 2026-08-17 — fix(kernel): 用户自定义 baseUrl 不再被内置模型目录覆盖（tokenhub 401）

- 用户把预设 provider（如 DeepSeek，模型 deepseek-v4-flash 在 pi 目录中存在）的 baseUrl 改成自建网关（tokenhub.tencentmaas.com）后，`resolveProviderBaseUrl`（连通测试）与 `generateProviderExtension`（真实聊天）都无条件用目录值 `https://api.deepseek.com` 覆盖，导致网关 key 被发到 DeepSeek 官网 → 401 "Authentication Fails, Your api key: ****xxxx is invalid"。
- 新增 `resolveEffectiveBaseUrl`：用户显式配置优先；仅当用户未配置、或与目录值同源（相等/互为前缀，仅差 /v1 等后缀）时才采用目录值，保留「纠正缺 /v1 旧数据」的原有能力。
- 影响范围：`packages/kernel/src/provider-extension.ts`；测试 `packages/kernel/tests/provider-extension.test.ts`（新增 tokenhub 回归 3 用例，调整 api 分节 1 用例预期）。
- 顺带：连通测试报错不再附加「【直连：未检测到 HTTP(S)_PROXY 环境变量】」噪音文案，仅在检测到代理时附加【代理: xxx】；`packages/kernel/src/provider-test.ts`。
- 后续：自建网关端点的 reasoning 模型在生成的 extension 里显式写 `compat: { supportsDeveloperRole: false }`——pi 的 detectCompat 识别不了 tokenhub 等未知网关，会按标准 OpenAI 端点把 system prompt 以 developer role 发送，网关 400（developer is not one of [system, ...]）。判定规则：生效 baseUrl 与目录值不同即为自建端点。

## 2026-08-17 — fix(shared): 纯中文名 provider 的 slug fallback 改为确定性哈希（发送按钮置灰）

- `slugifyProviderName` 对纯中文名（如「腾讯云」）派生不出 slug 时原用 `Math.random()` 生成 `provider-xxxxxx`，每次调用结果不同：选中模型标识（slug/id）下一刻即失配，`isModelAvailable` 恒为 false → 聊天界面发送按钮永远置灰；kernel 侧 extension 注册 slug 同样不稳定。
- 改为 djb2 名字哈希（base36 取 6 位），同一名字跨调用/跨进程产出一致 slug；冲突加后缀逻辑不变。
- 影响范围：`packages/shared/src/providers.ts`；测试 `packages/shared/tests/providers.test.ts`（新增确定性回归 2 用例，调整中文 fallback 注释）。注意：修复前用随机 slug 选中过模型的会话需重新选择一次模型。

## 2026-08-17 — feat(frontend): 文件预览面板头部分享按钮（产物分享任务 10）

- FileViewer 的 Markdown 预览头部与代码预览头部（fv-btn 关闭按钮左侧）新增 ShareButton：`paths=[当前文件 path]`、透传 sessionId、testId `share-file-btn`，class 复用 `fv-btn` 与关闭按钮风格一致。图片预览（ImageViewer 头部结构不同）不在此列。
- 影响范围：`packages/frontend/src/components/blocks/FileViewer.tsx`；测试 `tests/FileViewer.test.tsx`（新增：md 预览头部出现 share-file-btn / 代码预览头部出现 share-file-btn / 点击打开分享弹层 3 用例，mock share-client）。

## 2026-08-17 — feat(frontend): 文件修改清单每项分享按钮（产物分享任务 9）

- FileChangeSummary 的 FileChangeItem 右侧按钮区（原仅 canDiff 时渲染的 ml-auto 区域）改为对 `!file.error && !file.oversized` 渲染：预览/展开按钮保持仅 canDiff（修改态），新增 ShareButton（`paths=[resolveAbsolutePath(file.path, sessionId)]`，testid `file-change-share-<path>`）——新增（added）与修改（modified）文件都可分享，error/oversized 不显示。i18n 复用已有 `share.share` 文案（任务 8 已加），无新增文案。
- 影响范围：`packages/frontend/src/components/blocks/FileChangeSummary.tsx`；测试 `src/components/blocks/FileChangeSummary.test.tsx`（新增：正常文件显示分享按钮 + error/oversized 不显示、点击渲染分享弹层 2 用例，mock share-client）。

## 2026-08-17 — feat(frontend): share-client + 分享按钮与结果弹层（产物分享任务 8）

- 新增 `share-client.ts`（照 fs-client 的 transport 注入模式，`_setShareTransport` 测试注入）：`shareUpload(paths, sessionId?)` → POST /api/share/upload（返回 { url, expiresAt, projectName, channel }）、`shareSettings()` → GET /api/settings/share、`saveShareSettings(share)` → PUT /api/settings/share。
- 新增 `ShareButton`（`paths: string[]` + 可选 sessionId/className/testId）：点击打开 `ShareResultModal`（同文件内）——挂载时检查分享 token（shareSettings），未配置显示「请先在 设置 → 分享 配置 Token」引导；已配置显示待分享文件列表（文件数 + 首 3 个 basename）+「生成分享链接」→ shareUpload → 成功展示分享 URL + 复制按钮（copyToClipboard）+「链接 N 小时内有效」（由 expiresAt 计算）。testid：share-btn / share-result-modal / share-generate-btn / share-copy-btn / share-url / share-no-token / share-files。
- i18n 补顶层 `share.*`（zh + en）：share/share/title/files/generate/generating/link/copyLink/copied/expiresIn/noToken。
- 测试：`share-client.test.ts`（upload 成功/400 抛错/settings 读写 4 用例）、`ShareButton.test.tsx`（打开弹层/生成显示 URL/未配置 token 引导/复制调用 4 用例，mock share-client + clipboard）。
- 影响范围：`packages/frontend/src/share-client.ts`（新增）、`packages/frontend/src/components/ui/ShareButton.tsx`（新增）、`src/i18n/locales/zh.ts`、`en.ts`；测试 `src/share-client.test.ts`、`src/components/ui/ShareButton.test.tsx`（新增）。

## 2026-08-17 — feat(frontend): 设置页「分享」Tab（产物分享任务 7）

- 设置页新增「分享」Tab：设置 store 的 SettingsSection 联合类型增加 `"share"`；SettingsModal 导航区加「分享」入口与渲染分支；新增 ShareSection 面板（挂载时 GET /api/settings/share 回填，保存 PUT /api/settings/share，渠道「腾讯 EdgeOne」只读展示，API Token 用 password 输入且已保存时脱敏展示「•••」+「修改」切换），i18n 补 settings.share.* / nav.share（zh + en）。
- 影响范围：`packages/frontend/src/store/settings.ts`、`packages/frontend/src/components/settings/ShareSection.tsx`（新增）、`packages/frontend/src/components/SettingsModal.tsx`、`packages/frontend/src/i18n/locales/zh.ts`、`en.ts`；测试 `src/components/settings/ShareSection.test.tsx`（默认渲染/保存 PUT/脱敏展示 3 用例）。

## 2026-08-17 — fix(kernel): 发送前自动压缩预留改为固定 33K（社区做法）

- `_autoCompactIfNeeded` 原按「占用 + 模型 catalog maxTokens > 窗口」触发压缩，deepseek-v4（maxTokens=384K）在 1M 窗口下 61.6% 占用就被提前压缩，浪费长上下文。经查证 pi 自身（reserveTokens 固定 16384）与 Claude Code（固定 33K autocompact buffer）均为固定小预留，且 pi-ai 请求层已把 max_tokens clamp 到「窗口 − 占用 − 4096」，输出空间无需 kernel 按上限预留。改为固定预留 33K，判断逻辑抽为纯函数 `shouldCompactBeforeSend`；缓存简化为 modelId → contextWindow。
- 影响范围：`packages/kernel/src/auto-compact.ts`（新增）、`packages/kernel/src/agent-manager.ts`；测试 `src/__tests__/auto-compact.test.ts`（新增 5 用例，含「不再按 maxTokens 预留」回归）。

## 2026-08-17 — feat(kernel): /api/settings/share 读写路由（产物分享任务 6）

- kernel settings 路由新增 GET/PUT `/api/settings/share`：GET 返回 `{ share }`（未配置时回退默认 `token:""`、`channel:"edgeone"`），PUT 读 `body.share` 经 `saveShareSettings` 写盘（read-modify-write 保留其他字段）。复用既有 `loadShareSettings`/`saveShareSettings`；RouteContext 新增可选 `settingsFile` 供测试注入 tmpdir 隔离真实 settings.json（生产缺省仍走真实文件）。
- 影响范围：`packages/kernel/src/routes/settings.ts`、`packages/kernel/src/routes/types.ts`；测试 `tests/settings-share-route.test.ts`（GET 默认值、PUT 往返、PUT 后 loadShareSettings 生效）。

## 2026-08-17 — fix(frontend): 发送消息/收到回复后 lastActivity 未刷新（回归）

- 上一条「点击查看不再更新 lastActivity」仅删除了前端 `selectSession` 乐观更新，但未补上「发消息/收回复时同步」的机制：kernel 始终正确 touch 磁盘（agent:prompt 与 message_end），但 `touchSession` 只落盘不广播，前端 store 收不到新值，界面时间/排序停滞。修复：新增 `useProjectsStore.touchSession(id)`（置 Date.now()），在 `Composer.doSend`（发送 agent:prompt）与 `session.ts` 的 `message_end` 分支（收到回复结束）调用。
- 影响范围：`packages/frontend/src/store/projects.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/Composer.tsx`；测试 `tests/store-projects.test.ts`（touchSession 更新/不存在 id 安全 2 用例）、`tests/session-message-update-batcher.test.ts`（message_end 触发 lastActivity 更新）。

## 2026-08-17 — fix(kernel): 分享部署失败感知 + 轮询间隔注入 + upload 错误处理

- 产物分享任务 5 修复：deployShare 轮询改为轮询至终态后校验最终 Status 必须为 Success，Failed/Error 等失败终态抛错（`EdgeOne 部署失败: <Status>`），不再返回失败链接；新增可选 `pollIntervalMs`（缺省 5000ms）注入轮询间隔，测试传 1 让单测毫秒级完成；POST /api/share/upload handler 包 try/catch 兜底返回结构化 `{ error }` + 500（避免裸 500）。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`、`packages/kernel/src/routes/share.ts`；测试 `tests/share-routes.test.ts`（新增 delete、zip 多选 2 用例，各用例注入 pollIntervalMs=1）。

## 2026-08-17 — feat(kernel+frontend): 点击查看会话不再更新最后激活时间（只有发消息/收回复才算活跃）

- 需求：查看会话不应把「最后激活时间」顶到当前。移除两处「点击/打开即 touch lastActivity」的逻辑：前端 `selectSession` 的乐观更新（projects.ts，仅保留选中切换）、kernel `session:messages` 里的 `touchSession`（ws-server.ts）。发消息 `agent:prompt` 与收回复 `message_end` 的 touch 更新保留。`session:messages` 的 `isDeleted`/`isScheduler` 守卫仍用于 `prewarm`（拉起 pi 进程），未删。
- 影响范围：`packages/frontend/src/store/projects.ts`、`packages/kernel/src/ws-server.ts`；测试 `tests/store-projects.test.ts`（selectSession 断言改为不更新）、`tests/session-messages.test.ts`（普通会话查看也不再 touch）。

## 2026-08-17 — fix(kernel): 发送前自动压缩预留改为固定 33K（社区做法）

- `_autoCompactIfNeeded` 原按「占用 + 模型 catalog maxTokens > 窗口」触发压缩，deepseek-v4（maxTokens=384K）在 1M 窗口下 61.6% 占用就被提前压缩，浪费长上下文。经查证 pi 自身（reserveTokens 固定 16384）与 Claude Code（固定 33K autocompact buffer）均为固定小预留，且 pi-ai 请求层已把 max_tokens clamp 到「窗口 − 占用 − 4096」，输出空间无需 kernel 按上限预留。改为固定预留 33K，判断逻辑抽为纯函数 `shouldCompactBeforeSend`；缓存简化为 modelId → contextWindow。
- 影响范围：`packages/kernel/src/auto-compact.ts`（新增）、`packages/kernel/src/agent-manager.ts`；测试 `src/__tests__/auto-compact.test.ts`（新增 5 用例，含「不再按 maxTokens 预留」回归）。

## 2026-08-17 — feat(kernel): 分享上传编排（deployShare）+ /api/share/* 路由

- 产物分享功能：补全 share/edgeone-client.ts 的 deployShare 总入口（探测端点 → 建/取项目 → DescribePagesCosTempToken 拿 COS 临时凭证 → 上传 zip（多选）或单文件 → CreatePagesDeployment（DistType Zip|Folder）→ DescribePagesDeployments 轮询至非 Process（每 5s，最多 40 次）→ getPresetDomain + encipherUrl 拼分享链接，返回 { url, projectName, projectId, expiresAt: now+3h }）。COS 客户端经 cosFactory 注入（测试传 fake），否则 new cos-nodejs-sdk-v5 实构；新增 cos-nodejs-sdk-v5 依赖。
- 新增 routes/share.ts：createShareRoutes 工厂（POST /api/share/upload 校验 paths/token 非空、多选 buildZip、调 deployShare、appendShare 写 history；GET /api/share/list；POST /api/share/delete；导出 commonRoot）。handler 内每次请求 loadShareSettings 读最新 token/channel（保存后无需重启），cfg 作 fallback/测试注入，并支持 cosFactory/settingsFile 注入。ws-server registerRoutes 注册分享路由（share-history.json 落 WA_PI_DIR）。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`、`packages/kernel/src/routes/share.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/package.json`（新增 cos-nodejs-sdk-v5）；测试 `tests/share-routes.test.ts`（mock 全局 fetch + cosFactory fake，上传全链路/空 paths/token 空/list 4 用例）。

## 2026-08-17 — feat(kernel): EdgeOne REST 客户端（探测/项目/encipher）

- 产物分享功能：新增 share/edgeone-client.ts（从 POC 移植的可单测纯函数）——detectBaseUrl 遍历 china/global 端点取首个 Code===0 的可用地址；apiCall 统一 POST + Bearer token 校验 HTTP 状态与业务 Code；getOrCreateProject 按名查询、存在即返回、否则 CreatePagesProject 后返回 ProjectId（重查兑底）；getPresetDomain 取项目的预设域名；encipherUrl 用 DescribePagesEncipherToken 拼 eo_token/eo_time 分享链接。分享总入口 deployShare（上传/部署/轮询）留待任务 5。
- 影响范围：`packages/kernel/src/share/edgeone-client.ts`、`packages/kernel/tests/edgeone-client.test.ts`（mock 全局 fetch，3 用例）。

## 2026-08-17 — feat(kernel): 多选路径 zip 打包 + path hash

- 产物分享功能：新增 share/pack.ts（多选路径用 fflate 打包 zip、文件夹递归展开、路径相对 root 保持；hashPaths 生成 sha256 hex 前 12 位作为项目名后缀）；引入 fflate 依赖。
- 影响范围：`packages/kernel/src/share/pack.ts`、`packages/kernel/tests/share-pack.test.ts`、`packages/kernel/package.json`（新增 fflate）。

## 2026-08-17 — feat(kernel): 子代理委托超时 30→60 分钟，工具执行看门狗 5→10 分钟

- 超长子代理委托场景：将子代理委托整体硬上限（RPC 命令超时 + settle 兜底超时）由 30 分钟调至 60 分钟，支持特别久的子代理任务；并把重复的字面量 `1_800_000` 抽成命名常量 `COMMAND_TIMEOUT_MS = 60 * 60_000`（与 `LIVENESS_IDLE_MS`/`ABORT_GRACE_MS` 风格一致，避免将来两处漏改）。
- 工具执行看门狗（无进展探活）默认超时由 5 分钟调至 10 分钟（`LIVENESS_IDLE_MS = 10 * 60_000`），降低长工具静默等待（如等外部 API / 长编译）被误判卡死的概率；工具执行中仍不豁免，持续流式输出刷新计时逻辑不变。
- 影响范围：`packages/kernel/src/subagent-runner.ts`（`COMMAND_TIMEOUT_MS` 常量 + `LIVENESS_IDLE_MS` 值 + 接口/注释同步）；测试 `tests/subagent-runner.test.ts`、`tests/delegate-tool.test.ts` 全部通过（57 例，行为测试均注入短超时值驱动，不受默认值影响）。

## 2026-08-17 — feat(kernel): settings 支持 shareToken/shareChannel

- 产物分享功能的基础配置：settings-store 新增 share 配置段的读写（token + channel，默认 channel=edgeone，token 为空），read-modify-write 保留 settings.json 内其他字段；补 writeSettingsJson helper（带 mkdir recursive）。
- 影响范围：`packages/kernel/src/settings-store.ts`；测试 `tests/settings-share.test.ts`（默认值 + save/load 往返一致 2 用例）。

## 2026-08-17 — fix(kernel): 重名 slug provider 模型窗口落默认值导致 ~122K 误触发自动压缩

- providers.json 中两个 provider 解析为同一 slug（如两个 opencode-go）时，`ensureProviderExtensionRegistered` 构建目录查询 map 用未去重的 `resolveProviderSlug(p, [])`，与 `generateProviderExtension` 内部的 `slugifyProviders`（去重为 opencode-go-2）不一致，第二个 provider 的模型查询全部落空；且 `generateProviderExtension` 的 fallback 是写死的 DEFAULT_SDK_MODEL（128000/16384）而非用户配置——注释宣称"找不到则 fallback 到用户配置"，代码从未如此。结果：用户配置 1M 窗口的模型（OpenCode Go 1 / deepseek-v4-flash）在生成的 extension 里落成 128000，pi 按 `128000 − 16384` 阈值在 ~122K 提前自动压缩（线上证据：会话 s-b99bc7fa 于 121972 tokens 触发）。
- 修复：`ensureProviderExtensionRegistered` 改用 `slugifyProviders` 的去重 slug 构建 map；`lookupSdkModel` provider 过滤未命中时回退裸 id 匹配（派生 slug 在目录中不存在）；`generateProviderExtension` 的 contextWindow/maxTokens 回退链改为 目录 → 用户配置 → 默认值。修复后 opencode-go-2 正确生成 1000000/384000/reasoning: true（此前 128000/16384/false，cost 也全 0）。
- 影响范围：`packages/kernel/src/provider-extension.ts`；测试 `tests/provider-extension.test.ts`（更新"SDK 查找不到"断言为用户配置兜底，新增重名 slug 单元回归 + 真实目录集成回归 2 用例）。

## 2026-08-17 — refactor(frontend): 附件/录音按钮 emoji 改为 SVG 图标

- 输入框底部的附件按钮 📎 与录音按钮 🎙 由 emoji 文本改为统一 SVG 图标（复用 Icon 库已有 `paperclip` / `mic` 图形），视觉与全局图标体系对齐、避免 emoji 跨平台渲染差异。颜色/hover/disabled 态仍由外层 className 控制（Icon 继承 currentColor）。
- 影响范围：`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/src/components/ui/RecordButton.tsx`；测试 `ComposerInput.test.tsx`、`tests/RecordButton.test.tsx`（新增 SVG 图标渲染断言）。

## 2026-08-17 — chore(release): 发布版本 0.2.5

- 打包发布 0.2.5（mac + win）：原生系统对话框（附件选文件/技能目录/打开文件夹）、任务模型与超时改进、IM 推送重连等待、文件树默认打开、设置弹窗关闭按钮等。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-17 — feat(kernel): 自动化任务执行超时 5 分钟 → 30 分钟

- 定时任务单次执行最长等待由 5 分钟调至 30 分钟（index.ts executeTask 的 MAX_WAIT_MS），超时仍 abort 会话进程并记录「任务执行超时（30 分钟）」。
- 影响范围：`packages/kernel/src/index.ts`（MAX_WAIT_MS + 错误文案）、`packages/kernel/src/routes/scheduler.ts`（立即执行接口注释同步）。

## 2026-08-17 — feat(frontend): 项目文件树右键文件增加「默认方式打开」

- 项目文件树（ExplorerPanel）右键文件弹出的菜单新增「默认方式打开」项，用系统默认应用打开该文件（macOS open / Windows start / Linux xdg-open），仅对文件显示、目录不显示。能力复用已有的 fs-client `openFileWithDefaultApp`（POST `/api/fs/open-with-default-app`），无需改 kernel/desktop。
- 影响范围：`packages/frontend/src/components/ExplorerPanel.tsx`；新增测试 `ExplorerPanel.test.tsx`（右键文件点击调用 + 目录不显示两项断言）。

## 2026-08-17 — fix(kernel): IM 推送前校验连接状态，断线时等待重连

- 定时任务 @im-push-to 主动推送此前只校验 adapter 对象是否存在，不校验实时连接状态；IM 掉线时推送照发，SDK 因 ws.readyState !== OPEN 直接抛错导致推送失败。现推送前校验 `statuses` 实时状态，非 connected 则等待 SDK 自动重连（默认 60s 超时，超时判失败并回填执行记录）。
- 影响范围：`packages/kernel/src/channel-manager.ts`（新增 statusWaiters/waitForConnected/notifyStatusWaiters，pushToContact 加校验）、`packages/kernel/src/channels/mock-adapter.ts`（setStatus 改 public 供测试模拟断线）；测试 `channel-manager.test.ts`（新增断线等待重连、超时抛错 2 用例）。

## 2026-08-17 — feat: 自动化任务新增「使用的模型」配置项

- 新建/编辑自动化任务时可指定运行时模型（下拉：首项「跟随默认」+ 具体 providerSlug/modelId），参考 IM 渠道机器人设置的模型下拉。留空（null/undefined）= 跟随默认（第一个 provider 的第一个模型）。
- 数据链路：`ScheduledTask.model?: string | null`（shared/types.ts）→ 路由校验/透传（routes/scheduler.ts，model 非字符串→400，null 归一为 undefined 存储）→ 执行时 `resolveTaskModel(task.model, providers)` 优先用任务模型（scheduler.ts 新纯函数，index.ts executeTask 调用）。
- 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/routes/scheduler.ts`、`packages/kernel/src/scheduler.ts`、`packages/kernel/src/index.ts`、`packages/frontend/src/components/automation/TaskEditForm.tsx`；测试 `routes-scheduler.test.ts`、`scheduler.test.ts`、`TaskEditForm.test.tsx`。

## 2026-08-17 — fix(frontend): 设置弹框补充显式关闭按钮

- 设置弹框（SettingsModal）标题栏此前只有标题文字，关闭只能靠点击遮罩或 ESC，不符合用户常识。在标题栏右侧补一个 X 关闭按钮（`<Icon name="x">`，`aria-label` 走 `common.close`，`data-testid="settings-close"`），与回收站弹框（RecycleBinModal）标题栏风格一致。
- 影响范围：`packages/frontend/src/components/SettingsModal.tsx`；新增测试 `packages/frontend/src/components/SettingsModal.test.tsx`（断言关闭按钮渲染 + 点击触发 onClose）。

## 2026-08-17 — feat(desktop+frontend): 附件/技能目录/新建项目改用系统原生对话框

- 三处目录/文件选择在 Electron 下改用系统原生对话框：① 附件「选择要发送的文件」（`dialog.showOpenDialog` 多选文件）；② 技能「添加目录」（选目录）；③ 新建项目选工作目录（选目录，两入口 ProjectList/EmptyState 均生效）。浏览器环境全部回退到内置文件/目录树。另：技能目录新增「打开技能文件夹」按钮（`shell.showItemInFolder` 在系统文件管理器定位）。此前 Electron 层完全未封装 `dialog`/`shell`，文件选择走 web 控件、定位走 kernel spawn 系统命令。
- 影响范围：新增 `packages/desktop/src/util/native-dialogs.cjs`（依赖注入封装，注册 `dialog:open-files`/`dialog:open-directory`/`shell:show-item-in-folder` 三个 IPC）；`packages/desktop/src/main.cjs`（require dialog/shell 并调用）、`packages/desktop/src/preload.cjs`（暴露 `waPiApp.showOpenFileDialog`/`showOpenDirectoryDialog`/`showItemInFolder`）；`packages/frontend/src/util/clipboard.ts`（waPiApp 类型声明）；`packages/frontend/src/components/ui/ComposerInput.tsx`（📎 原生优先回退）、`packages/frontend/src/components/settings/SkillSection.tsx`（添加目录原生优先回退 + 打开文件夹按钮）、`packages/frontend/src/store/projects.ts`（createProjectFromDir 原生优先回退）、`packages/frontend/src/i18n/locales/zh.ts`/`en.ts`（新增 skill.openDir）。测试：`native-dialogs.test.ts`、`SkillSection.test.tsx`、`ComposerInput.test.tsx`（新增）；`store-projects.test.ts`（新增 createProjectFromDir 原生/回退/取消三用例）。

## 2026-08-17 — feat(frontend): 自动化任务新建弹窗 @IM联系人 支持群

- 「自动化 → 任务 → 新建任务弹窗」的 @联系人选择器此前只展示 person（`TaskPromptComposer.tsx` 中 `if (c.kind !== "person") continue` 过滤掉了群），现放开为 person + group 均可 @；群名取 chatId 前 8 位展示（对齐通讯录面板 ContactsPanel 的 label）。后端推送链路（pushToContact / im_push_to）本就支持群，无需改动。
- 联系人/群图标统一改 SVG：弹窗列表用 `<Icon name="user|users">`（Icon 库新增 `user` / `users` 两个图形），输入框内已插入的联系人 chip 也从硬编码的「人形剪影」改为 `iconSvg("user"|`users`)` 区分人/群（`prompt-tokens.ts` 的 `ContactChipMeta` 新增 `kind` 字段，删除 `PERSON_ICON_SVG`）。
- 影响范围：`packages/frontend/src/components/automation/TaskPromptComposer.tsx`、`packages/frontend/src/components/automation/prompt-tokens.ts`、`packages/frontend/src/components/ui/Icon.tsx`；测试 `TaskPromptComposer.test.tsx`、`prompt-tokens.test.ts`（新增群展示/选中/群 chip 名/图标 SVG 断言）。

## 2026-08-17 — chore(release): 发布版本 0.2.4

- 打包发布 0.2.4（mac + win 完整覆盖 OSS）：修复模型不可用（404）baseUrl 匹配（Provider 缺 /v1 + 同名模型污染，含测试连接）+ 新建会话页默认工作区隐藏文件浏览按钮。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-17 — fix(frontend): 新建会话页默认工作区隐藏文件浏览按钮

- 修正 2026-08-16 的空态方案：默认工作区（__system__）的 cwd 是 workdir 父目录（内部会话目录，非项目文件），原「走空态」仍保留右上角可点击的文件夹按钮，点击后展开空态反而误导用户。改为对默认工作区直接隐藏入口按钮（而非禁用），与「无项目」场景区分。
- 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`；测试 `new-session-explorer.test.tsx`（默认工作区用例由「空态」改为「隐藏按钮」）。

## 2026-08-17 — test(frontend): VersionTimeline maxEntries 断言跟随 version-history 推进

- 发版 0.2.3 时 version-history.json 已推进到 0.2.3，但 maxEntries 截断测试仍硬编码旧版本号（0.2.1 + 0.1.26），导致前端全量测试 1 例失败。更新断言为当前最新 2 条（0.2.3 + 0.2.2），第 3 条（0.2.1）不渲染。
- 影响范围：`packages/frontend/src/components/settings/VersionTimeline.test.tsx`。

## 2026-08-16 — fix(frontend): 新建会话页文件侧栏对默认工作区不再列出 workdir 内部目录

- 根因：默认工作区（__system__）项目的 cwd 是 `~/.pi/agent/workdir` 父目录（存放每个会话的独立内部目录，可积累数千个子目录）。新建页点右上角「项目文件」开关展开侧栏时，ExplorerPanel 一次性 listDir + 排序 + 渲染全部子目录，主线程长时间阻塞、界面卡死空白（用户感知为「窗口消失」），5 秒轮询反复触发。会话页（SessionView）不受影响——其文件树根目录是 `workdir/<会话时间戳>` 具体会话目录。
- 修复：NewSessionPane 对默认工作区项目返回空 workspaceDir，让侧栏走空态（文案按 projectId 有无区分：默认工作区显示「未设置工作目录」，真正无项目显示「无项目，请先新建」）。
- 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`；测试 `new-session-explorer.test.tsx`（新增默认工作区空态用例）。

## 2026-08-16 — chore(release): 发布版本 0.2.3

- 打包发布 0.2.3：文件修改清单新功能 + 文件预览路径解析修复。产物 `WaPi-Setup-0.2.3.exe` 已上传 OSS（latest.yml 注入 releaseNotes）。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-16 — fix(desktop): publish-oss 注明 --no-proxy 在 Bun 下不生效

- ali-oss 静态 import 早于清代理执行，脚本内 delete 对已缓存代理配置不生效；动态 import 在 Bun 顶层 await 下分片上传会超时。保留静态 import + --no-proxy（尽力而为），注释说明推荐命令行清代理（HTTPS_PROXY= HTTP_PROXY= ... bun run ...）。
- 影响范围：`scripts/publish-oss.ts`。

## 2026-08-16 — chore(release): 发布版本 0.2.2

- 打包发布 0.2.2：ask bridge 偶发断开重试修复 + 发送前自动压缩防护。产物 `WaPi-Setup-0.2.2.exe` 已上传 OSS（latest.yml 注入 releaseNotes）。
- 影响范围：版本号（`packages/desktop/package.json`、`packages/frontend/package.json`、`version-history.json`）、`RELEASE_NOTES.md`。

## 2026-08-16 — fix(kernel): ask bridge 偶发断开后自动重试（最多 5 次、间隔 1 秒）

- pi 侧 fetch 的 socket 可能被 Bun 非确定性清理（GC/keep-alive），导致 ask 的 bridge 长连接偶发断开（报 "socket connection was closed unexpectedly" 或 "连接中断（未收到 final 帧）"），提问提前失败——此问题自 ask 功能引入起一直存在。修复：callBridge 对可重试的断开（socket closed / socket hang up / 连接中断）自动重试，最多 5 次、间隔 1 秒；重试前校验 signal 未 abort（ask 仍有效），用户取消/工具中止时不无谓重试。
- 配套：ask 断开后条目保留（disconnected 标记）供重试复用，避免重试时重复弹卡片；用户回答/取消才真正移除条目；一轮对话结束（agent_settled）清空会话 ask 条目防泄漏。`pendingToolCallIds` 只返回真实 pending（过滤 disconnected），前端 double-check 不看到失效卡片。
- 影响范围：`packages/kernel/src/wa-pi-bridge.extension.ts`（callBridge 加重试 + isRetryableDisconnect + 常量）、`ask-registry.ts`（断开保留 + 复用 + clearSession + pendingToolCallIds 过滤）、`agent-manager.ts`（agent_settled 清空会话 ask）；测试 `bridge-extension.test.ts`（3 个用例）、`ask-registry.test.ts`（3 个用例）。

## 2026-08-16 — feat(kernel): 发送前自动压缩防护 POC（超限自动 compact 后继续发送）

- DeepSeek 等「输入+输出共用上下文窗口」的模型，maxTokens（如 deepseek-v4-flash 的 384000）会作为每次请求的输出预留，与输入 token 叠加超过窗口时（如 748k + 384k > 1M）触发 400。而 pi 的 auto-compaction 用 reserveTokens=16384 判断，触发太晚，中间存在「压缩不触发但已超限」的危险区间。
- POC：`_sendPromptNow` 发送 prompt 前，查当前模型 contextWindow/maxTokens（进程内缓存）+ get_session_stats.contextUsage，若 `used + maxTokens > contextWindow` 先自动 `compact()` 再继续发送。压缩失败不阻断发送（退回现状，让原消息走正常错误渲染）。
- 影响范围：`packages/kernel/src/agent-manager.ts`（新增 `_autoCompactIfNeeded` + 模块级 modelMetaCache，`_sendPromptNow` 插入调用）；测试 `agent-manager.test.ts`（drain 用例改异步等待）+ `fixtures/fake-session-client.ts`（补 getSessionStats）。

## 2026-08-16 — feat: 回复底部新增文件修改清单

- 每轮对话结束后，assistant 回复底部追加「文件修改清单」：按文件去重、标注新增/修改、点击文件名打开内置预览、展开显示本轮「首次编辑前 → 末次编辑后」的整文件行级 diff（同一行多次修改自动合并为一次净变化）。新增/过大/失败三种情况降级为只显示文件名 + 点击预览。
- 实现：pi 扩展经 tool_call/tool_execution_end/agent_end 钩子采集文件前后快照 → POST /bridge/file-changes → kernel 广播 file_changes 事件 → 前端 FileChangeSummary 组件（react-diff-viewer-continued 渲染 diff）。仅最后一条消息渲染，避免多轮重复错位。
- 影响范围：shared/types.ts、kernel wa-pi-bridge.extension.ts + file-snapshot.ts + bridge-extension.ts + agent-manager.ts + ws-server.ts、desktop build-kernel-sidecar.ts、前端 session.ts + FileChangeSummary.tsx + MessageList.tsx + i18n/locales。

## 2026-08-15 — fix(desktop): publish-oss 清代理改为 --no-proxy 参数（默认保留代理）

- 上一条无条件清代理会让想走代理的环境也用不了；改为加 `--no-proxy` 参数时才清代理（默认保留代理，向后兼容）。OSS 国内节点直连、走代理分片上传会 socket 关闭。
- 影响范围：`scripts/publish-oss.ts`。

## 2026-08-15 — fix(desktop): publish-oss 上传前清除代理（OSS 直连）

- 系统代理（Clash 等）会拦截 ali-oss 上传，大文件分片上传时 socket 被意外关闭。OSS 是国内节点（oss-cn-heyuan），直连即可；脚本上传前清除 HTTP(S)_PROXY 环境变量。
- 影响范围：`scripts/publish-oss.ts`。

## 2026-08-15 — fix(desktop): linux AppImage 可执行文件名修复

- desktop 包名 `@wa-pi/desktop` 归一化成 `@wa-pidesktop`，AppImage 可执行文件名含 `@`/`-` 不合法；显式指定 `linux.executableName=wa-pi-desktop`。
- 注：Windows 上打 AppImage 仍缺 mksquashfs（appimage 工具仅 Linux 版），全平台需在对应平台打包。
- 影响范围：`packages/desktop/electron-builder.yml`。

## 2026-08-15 — fix(desktop): 打包修复 registry-js 原生模块导致 sidecar 构建失败

- bun build 把读注册表的原生 addon `registry-js`（`os-proxy-config → windows-system-proxy → registry-js`）当 asset 输出，`--outfile` 报「多个输出文件」导致打包失败。
- 修复：kernel.js 构建加 `--external=registry-js`（不内联）；依赖清单加 `registry-js`（首启动态安装 .node）。
- 影响范围：`packages/desktop/scripts/build-kernel-sidecar.ts`。

## 2026-08-15 — revert(kernel/frontend): 撤销「网页端读注册表系统主题」实现

- 读 Windows 注册表（SystemUsesLightTheme）的方案被否决，撤销 kernel `readSystemTheme` + `GET /api/system-theme` + 前端轮询，回到浏览器原生 `prefers-color-scheme`（跟随应用主题）。
- Electron 端的 nativeTheme 修复保留（桌面版生效）。
- 影响范围：`kernel/src/{settings-store.ts,routes/settings.ts}`、`frontend/src/store/ui-prefs.ts`。

## 2026-08-15 — fix(kernel): readSystemTheme 跨平台——仅 Windows 读注册表，macOS/Linux 返回 null

- 上一条 `readSystemTheme` 非 Windows 兑底 light，会导致 macOS/Linux 系统深色时被错误覆盖成浅色。改为：仅 Windows 读 `SystemUsesLightTheme`；macOS/Linux 无「系统/应用」分离（prefers-color-scheme 即系统主题）返回 null，前端保持 prefers-color-scheme 不覆盖。
- 影响范围：`kernel/src/settings-store.ts`。

## 2026-08-15 — fix(kernel/frontend): 网页端「跟随系统」主题读系统主题（SystemUsesLightTheme）

- 上一条只修了 Electron 端（nativeTheme），但网页端（浏览器）prefers-color-scheme 同样只跟随「应用主题」，需 kernel 读 Windows 系统主题注册表键 SystemUsesLightTheme 通过 API 给前端。
- kernel 新增 `readSystemTheme`（reg 读 SystemUsesLightTheme）+ `GET /api/system-theme`；前端 `applyThemeMode(system)` 异步问 kernel 覆盖 prefers-color-scheme，并定时轮询跟随系统主题变化。
- 影响范围：`kernel/src/{settings-store.ts,routes/settings.ts}`、`frontend/src/store/ui-prefs.ts`。

## 2026-08-15 — fix(desktop): 「跟随系统」主题在 Windows 上跟随系统主题（而非应用主题）

- 前端 `prefers-color-scheme` 在 Windows 上跟随「应用主题」（AppsUseLightTheme），用户「跟随系统」实际跟随了应用主题（深色），而非系统主题（浅色）→ 点跟随基本都是暗色。
- 修复：Electron 主进程用 `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`（Windows 上区分系统/应用主题）同步 `themeSource`，使 prefers-color-scheme 对齐系统主题；监听 `updated` 持续同步。
- 影响范围：`packages/desktop/src/main.cjs`。

## 2026-08-15 — fix(frontend): 列表「测试连接」补传 slug（此前只修了弹窗入口）

- 76231a03 的 baseUrl 解析修复只改了编辑弹窗（ProviderForm）传 slug，漏了列表入口（ProviderSection.handleTest）→ 列表测试连接拿不到 slug，按 model id 匹配跨 provider 污染 baseUrl，仍 401/404。
- 修复：`ProviderSection.handleTest` 也传 `p.slug`；新增 `ProviderSection.test.tsx` 锁定两个入口一致。
- 影响范围：`frontend/src/components/settings/ProviderSection.tsx`、`ProviderSection.test.tsx(新)`。

## 2026-08-15 — fix(frontend): 长任务完成整轮折叠时滚动位置跳动（看到的内容不在底部）

- __根因__：长任务执行中，进行中的轮（`isActiveTurnRow`=true，status=thinking 的末行 assistant）过程卡片展开，用户贴底看实时过程。agent_end 到达、status 归 idle → `isActiveTurnRow` 变 false → `canCollapse` 变 true → 过程卡片（thinking/toolCalls/delegate/fleet）折叠成 `TurnSummary`，末行高度骤减；Virtuoso 虚拟化行高测量有延迟，折叠瞬间 scrollTop 停在旧位置，且此时 `autoScrollActive` 已 false、200ms interval 停止兑底 → 用户看到的内容不在底部。
- __修复__：`MessageList` 在 `isActiveTurnRow` true→false（整轮折叠时刻）时，若用户贴底（`stickBottom`）则主动 `scrollToEnd()` 一次，抵消高度骤减、保持贴底。
- __测试（TDD）__：`MessageList.subagent-scroll.test.tsx` 新增 1 用例（整轮结束主动滚动到底部），先写失败测试（修复 stash 后 1 fail）、修复后 12/12 过；frontend 全量 1581/1581 过、typecheck 过。
- 影响范围：`frontend/src/components/MessageList.tsx`、`frontend/tests/MessageList.subagent-scroll.test.tsx`。

## 2026-08-15 — fix(kernel/frontend): opencode-go 测试连接 404（测试连接未用内置目录 baseUrl）

- e1e20c2b 只修了 extension 的 baseUrl（内置目录带 /v1），但「测试连接」仍用 providers.json 里不带 /v1 的旧值 → openai-completions 的 `GET {baseUrl}/models` 打 404。
- 修复：`provider:test` 对 openai-completions 用内置目录解析 baseUrl（新增 `resolveProviderBaseUrl` 纯函数，按 slug 过滤避免同名模型跨 provider 污染）；前端测试连接时传 slug。
- anthropic-messages 保持原样（baseUrl 不带 /v1，`testProviderConnection` 自己拼 /v1/messages）。
- 测试：`provider-extension.test.ts` 新增 `resolveProviderBaseUrl` 3 用例，33 过。
- 影响范围：`kernel/src/{provider-extension,routes/providers,ws-server}.ts`、`shared/src/providers.ts`、`frontend/src/{store/providers.ts,components/settings/ProviderForm.tsx}`。

## 2026-08-15 — chore(release): 发布版本号 0.1.27 → 0.2.1

- desktop 0.1.27 → 0.2.1，frontend 0.1.26 → 0.2.1（统一「关于」页与自动更新版本）
- version-history.json 时间线最新条目 0.1.27 → 0.2.1（latest.yml releaseNotes 实际注入源）
- RELEASE_NOTES.md 与 version-history.json 补全 0.2.1 完整发布说明（定时任务/通讯录/IM 推送/扩展修复/代理设置等 08-14~08-15 全部变更）
- VersionTimeline.test.tsx 断言同步 v0.2.1
- 影响范围：desktop/package.json、frontend/package.json、frontend/src/data/version-history.json、desktop/RELEASE_NOTES.md、VersionTimeline.test.tsx

## 2026-08-15 — chore(kernel): 升级 pi 0.84.2 + 启用 PI_EXPERIMENTAL

- __变更__：①`@earendil-works/pi-*` 全系升级 0.84.1 → 0.84.2（kernel/package.json + sidecar 打包脚本 build-kernel-sidecar.ts，消除 sidecar `^0.83.0` 滞后债）；kernel 显式声明 `pi-agent-core` 修复顶层版本分裂（此前 pi-memory 的 peer 解析到顶层 0.84.1，而 pi-coding-agent 嵌套 0.84.2）。②启用 pi 0.84.2 实验性严格 JSON-schema 约束采样（`process.env.PI_EXPERIMENTAL="1"`，index.ts 注入，经 rpc-client 的 process.env 展开自动覆盖主会话 + 子代理）。③sdk-errors.ts 同步 pi-ai 0.84.2 新增 retryable 文案 `exceeded request buffer limit`。
- __收益__：JSON/RPC message_update 流式 usage 累积修复、DeepSeek max_tokens 字段修复（v4-flash 新增 low 思考档）、Kimi 请求 UA 行为对齐、扩展工具结果长输出折叠、nanoid DoS 安全修复。
- __验证__：0.84.1 vs 0.84.2 双版本对比——kernel 全量测试失败数随机漂移（10→1，失败文件单跑全过，为既有并发 flaky）；frontend 1580/1580 全过；kernel typecheck 通过；E2E channels.spec 两版本结果一致（mock 全链路为既有失败，非回归）；E2E settings-provider 首用例为 onboarding 遮挡既有问题。
- 影响范围：`packages/kernel/package.json`、`packages/desktop/scripts/build-kernel-sidecar.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/sdk-errors.ts`。

## 2026-08-15 — fix(frontend): 修复 5 个既有测试失败（项目折叠断言 + font-scale 行尾 + maxEntries 版本号）

- __根因__：①「项目折叠」3 个失败——产品用 CSS `gridTemplateRows:0fr` 做折叠动画（DOM 始终存在），但测试用 `queryByText("会话1").toBeNull()` 断言「折叠不可见」，happy-dom 不做 CSS 布局、`0fr` 不隐藏 DOM → 断言失败；motion 动画 250ms transition/rAF 在 happy-dom 下 pending，掩盖为 timeout。②`styles-font-scale`——`styles.css` 是 CRLF 行尾，测试断言硬编码 LF，`toContain` 不匹配。③`maxEntries`——数据已推进到 0.1.27，测试写死旧版本号 0.1.24。
- __修复__：①`ProjectItem` 折叠容器加 `aria-expanded={expanded}` + `data-testid="project-sessions-{id}"`（同时改善可访问性），测试改断言该属性而非查 DOM 内容。②`styles-font-scale.test.ts` 读 CSS 后 `.replace(/\r\n/g,"\n")` 归一化行尾。③`VersionTimeline.test.tsx` 断言版本号对齐当前数据（0.1.27 + 0.1.26）。
- __验证__：frontend 全量 1580/1580 通过（0 失败）、typecheck 通过。
- 影响范围：`frontend/src/components/ProjectItem.tsx`、`frontend/tests/{ProjectList,ProjectItem.sort-menu,styles-font-scale}.test.tsx`、`frontend/src/components/settings/VersionTimeline.test.tsx`。

## 2026-08-15 — fix(kernel): provider extension 用内置目录 baseUrl（修 opencode-go 缺 /v1 且同名模型互相污染）

- __根因__：①opencode-go 的 `openai-completions` 模型（deepseek-v4-flash/pro 等）正确 baseUrl 是 `https://opencode.ai/zen/go/v1`（带 /v1），但 providers.json 里存的是不带 /v1 的 `https://opencode.ai/zen/go`（那是 anthropic-messages 模型的 baseUrl，被套用了）→ OpenAI SDK 拼 /chat/completions 后打 404；②`sdkModelMap` 原按 model id 建键，`deepseek-v4-flash` 同时存在于 deepseek 和 opencode-go，会匹配到错误 provider 的 baseUrl（opencode-go 被污染成 api.deepseek.com）。
- __修复__：`provider-extension.ts` extension 生成时优先用内置目录（按 provider slug 精确匹配）的 baseUrl，纠正 providers.json 里缺后缀的旧值；`sdkModelMap` 改用 `${slug}/${modelId}` 复合键避免同名模型跨 provider 冲突。
- __测试（TDD）__：`provider-extension.test.ts` 新增 2 用例（内置 baseUrl 优先纠正 /1v1、同名模型跨 provider 不污染），19/19 过；typecheck 通过；实测生成 opencode-go baseUrl = `https://opencode.ai/zen/go/v1`。
- 影响范围：`packages/kernel/src/provider-extension.ts`、`packages/kernel/tests/provider-extension.test.ts`。

## 2026-08-15 — fix(kernel): 修复 pi 子进程拿不到系统代理（Bun process.env 展开丢失代理变量）

- __根因__：Bun 的 `process.env` 对代理变量（`HTTP_PROXY`/`HTTPS_PROXY` 等）是 getter/setter，不在 `Object.keys(process.env)` 里，导致 `rpc-client` spawn pi 子进程时用 `{ ...process.env }` 展开丢掉了代理变量 → pi 引擎 `EnvHttpProxyAgent` 读不到 `HTTP_PROXY` → LLM 请求直连超时（被墙时）。
- __修复__：`rpc-client.ts` 新增 `collectProxyEnv()`，显式从 `process.env` 读取 8 个代理变量（大小写各 4 个）补进 spawn 的 `env`。
- __测试__：`tests/rpc-client.test.ts` 新增 3 用例（显式收集/未设置/大小写）；agent-manager/bridge/idle-reap 125 用例全过；typecheck 通过。
- 影响范围：`packages/kernel/src/rpc-client.ts`、`packages/kernel/tests/rpc-client.test.ts`。

## 2026-08-15 — feat(settings): 新增「使用系统代理」开关，全软件请求统一走系统代理

- 系统设置 > 通用 > 请求超时下新增「使用系统代理」开关：开启后 kernel 用 `os-proxy-config` 跨平台读系统代理（Windows 注册表 / macOS scutil / Linux 环境变量），设置大小写 `HTTP_PROXY/HTTPS_PROXY` 环境变量；关闭则清空恢复直连；读不到代理（DIRECT）静默直连。
- 覆盖所有请求无例外：pi 引擎 undici `EnvHttpProxyAgent`（LLM 请求）、kernel 的 Bun `fetch`（读大写环境变量）、`curl/wget`（读小写环境变量）均走代理。
- 后端：`settings-store` 加 `loadProxySettings/saveProxySettings/applySystemProxy/readSystemProxy`（基于 `os-proxy-config`）；`routes/settings` 加 `GET/PUT /api/settings/proxy`（保存即 `applySystemProxy` + `markAllDirty` 重建 pi 进程）；`index.ts` 启动时 `applySystemProxy`。
- 网页端兼容：读系统代理在 kernel 端完成（`os-proxy-config` 是纯 Node API + native addon，实测 Bun 可加载），不再依赖 Electron IPC——前端只传开关 `useSystemProxy`，`httpProxy` 由 kernel 兑底读系统代理。
- 依赖：kernel 新增 `os-proxy-config@^1.1.2`（HTTP Toolkit 出品，跨平台读系统代理）。
- 测试（TDD）：`settings-proxy.test.ts` 7 用例（默认/持久化/保留字段/大小写设置/清空/DIRECT/readProxy 兑底）；`GeneralSection.test.tsx` 新增 2 用例。kernel + frontend typecheck 均过。
- 影响范围：`shared/types.ts`、`kernel/settings-store.ts`、`kernel/routes/settings.ts`、`kernel/routes/types.ts`、`kernel/ws-server.ts`、`kernel/index.ts`、`kernel/package.json`、`frontend/GeneralSection.tsx`、`i18n/zh.ts`、`i18n/en.ts` 及对应测试。

## 2026-08-15 — fix(frontend): IM 会话顶部回填修复备注空字符串时不回退的 bug

- 回填用 `??`（nullish），备注为空字符串 `""`（清空过备注）时不会回退到联系人标识，导致回填空；改为 `||`（truthy），与顶部 display 判断一致（空字符串视为无备注）。
- 测试：新增「备注空字符串回填联系人标识」用例（15/15 过）；e2e 铅笔编辑用例加断言「点铅笔回填原始标识（chatId）」，单聊回填验证通过。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`、`e2e/channels.spec.ts`。

## 2026-08-15 — fix(frontend): 项目列表展开改用 grid 高度动画（平滑展开，不再瞬间插入）

- 上一条 fix 去掉会话 opacity + 根节点 layout，但「项目名瞬间出现」未解决（会话列表仍瞬间插入占据高度）。改为给会话列表容器加 `grid-template-rows` 0fr→1fr 高度展开动画（250ms），展开/折叠时高度渐变、下方项目随之逐渐位移，消除「瞬间插入」。
- 去掉 `AnimatePresence`（grid 动画替代 enter/exit）；会话项保留 `layout` FLIP 重排动画；根节点恢复普通 div。
- 影响范围：`packages/frontend/src/components/ProjectItem.tsx`。

## 2026-08-15 — fix(frontend): IM 会话顶部铅笔回填与顶部标题同源（单聊用 chatId）

- 顶部标题（title）单聊用 `chatId`（`IM · ${chatId.slice(0,12)}`），但回填之前用 `fromUserId`，两者在 fromUserId 为空（如 mock 注入未传 fromUserId）时不一致，导致标题显示 xiaoxiaolu 但回填空。改为回填与 title 同源：单聊兑底 `contact.userId ?? imConv.chatId ?? fromUserId`，群聊 `chatId 前 8`。
- 测试：新增「联系人 userId 为空时兑底回填 chatId」用例，14/14 过。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`。

## 2026-08-15 — feat(frontend): 任务详情「最近执行」列表整行可点进详情 + 详情按钮移到最后

- `RecordRow` 整行加 `onClick` 进详情（`cursor-pointer` + `data-testid`），「详情」按钮从内容区移到行末（最右），点击时 `stopPropagation` 避免重复触发。
- 测试（TDD）：`TaskDetailView.test.tsx` 新增 1 用例（点击整行触发 openRecordDetail），13/13 过。
- 影响范围：`packages/frontend/src/components/automation/TaskDetailView.tsx`、`__tests__/TaskDetailView.test.tsx`。

## 2026-08-15 — feat(automation): 执行详情显示执行角色与使用模型

- 执行记录（`ExecutionRecord`）新增 `agentId`（执行角色/智能体）与 `model`（实际使用模型 provider/modelId）字段；`executeTask` 落盘时写入两者。
- 执行详情页 header 元信息展示 🤖 角色 + 🧠 模型（旧记录无该字段则不显示）。
- 测试（TDD）：`ExecutionDetailView.test.tsx` 新增 1 用例（显示角色+模型），5/5 过；后端 scheduler 33/33 过；frontend/kernel typecheck 均过。
- 影响范围：`shared/src/types.ts`、`kernel/src/index.ts`、`frontend/src/components/automation/ExecutionDetailView.tsx`、`__tests__/ExecutionDetailView.test.tsx`。

## 2026-08-15 — fix(frontend): IM 会话顶部铅笔无联系人记录时也回填原始标识

- 上一条 fix 仅在联系人已存在时回填 userId/chatId，首次对话（无联系人记录）时仍回填空。改为无联系人时也从 imConv 兑底回填（person=fromUserId / group=chatId 前 8），与顶部显示的技术标题一致。
- 测试：新增 2 用例（无联系人单聊回填 fromUserId / 群聊回填 chatId 前 8）；「清空输入后失焦不创建联系人」用例同步调整。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`。

## 2026-08-15 — fix(frontend): 项目列表展开时消除项目名与会话动画不一致导致的短暂重叠

- 会话列表原叠加 opacity 淡入（initial/animate/exit），展开时半透明会话项与实色项目名叠透，配合下方项目瞬时跳位，产生短暂重叠。改为与「最近」视图一致：会话项只保留 layout FLIP 位移动画，去掉 opacity 淡入淡出。
- 项目项根节点（含项目名）改 `motion.div layout="position"`，展开/折叠时下方项目 FLIP 平滑位移，消除「瞬时跳位」的突兀。
- 影响范围：`packages/frontend/src/components/ProjectItem.tsx`。

## 2026-08-15 — fix(frontend): 点击「立即执行」后执行记录列表/状态点不即时刷新

- __根因__：点「立即执行」后，kernel `executeTask` 一开始就写入 running 态执行记录并广播 `scheduled-tasks:changed`，但前端该事件只刷新任务列表（loadTasks），不刷新执行记录（loadRecords）——只有执行完成广播 `scheduled-task:completed` 时才刷新。导致 running 态记录、侧边栏状态点（⟳）都不即时显示。
- __修复__：`scheduled-tasks:changed` 事件处理补上 `loadRecords()`，与 `scheduled-task:completed` 一致，执行开始即可见 running 态。
- 影响范围：`packages/frontend/src/App.tsx`。

## 2026-08-15 — fix(frontend): IM 会话顶部铅笔编辑无备注时回填联系人标识

- 点铅笔进入行内编辑时，联系人存在但无备注名的情况下，输入框原回填为空，改为回填联系人标识（person=userId / group=chatId 前 8 位），与通讯录面板 `ContactsPanel` 的回填逻辑一致。
- 影响范围：`packages/frontend/src/components/ImSessionTitle.tsx`、`__tests__/ImSessionTitle.test.tsx`。

## 2026-08-15 — refactor(kernel): 定时任务推送引导改注入 system prompt（不拼进任务指令）

- __引导位置迁移__：`@im-push-to` 标记的语义澄清（非智能体引用勿 delegate + 用 im_push_to 工具推送）原由 `buildSchedulerPrompt` 拼进任务指令（prompt）末尾，现改为在 agent 启动时注入 __system prompt 的 im-push 段__。
- __新段机制__：`system-prompt.ts` 新增 `im-push` 动态段（模仿 im-channel 段：运行时注入、不落盘、savePromptSegments 剔除、ensureImPushSegment 运行时补回、位置在 im-channel 之后 / memory-policy 之前）；`PROMPTS_SCHEMA_VERSION` 25→26。
- __接线__：`agent-manager._createSession` 当 `imPush.targets` 非空时用 `buildImPushSystemPrompt(targets)` 填充 `imPushContext` 注入 composePrompt；`index.ts` executeTask 不再拼 prompt，直接发 `task.prompt`（技能展开逻辑保留）。`buildSchedulerPrompt` 更名 `buildImPushSystemPrompt`（返回系统提示文本，空目标返回空串）。
- 影响范围：`kernel/src/{system-prompt,agent-manager,tools/robot-push,index}.ts`；测试 `robot-push.test.ts`（buildImPushSystemPrompt 新契约）、`system-prompt-im-push.test.ts`（新段 5 用例）、`system-prompt.test.ts`（落盘过滤加 im-push）、`system-prompt-im-channel.test.ts`（schema 26）。

## 2026-08-15 — feat(kernel/frontend): IM 会话顶部铅笔编辑通讯录备注名

### 变更

- __交互__：IM 会话聊天顶部标题（原为「IM · u1」技术标题）右侧新增铅笔图标，点击进入行内编辑通讯录备注名；默认显示技术标题，编辑后显示「IM · 备注名」（清空备注则回退技术标题）。
- __自动补建__：当前正在聊的联系人若尚未进通讯录，点铅笔保存时自动 `ensureContact` 补建后再 `renameContact`；无联系人且输入为空则不创建（避免点开又关产生空条目）。
- __kernel 链路__：`contact-store.ts` 新增 `ensureContact`（按 `channelId+kind+匹配键` 命中返回/未命中创建含 id，并发同键只建一条）；`channel-manager` 暴露 `ensureContact`；`ws-server` 新增 `contacts:ensure` 事件（空 channelManager→400、抛错→500、成功→reply `contacts:ensured`）；`routes/contacts.ts` 新增 `POST /api/contacts/ensure`；`shared/types.ts` 新增 `ContactsEnsureRequest`/`ContactsEnsureResult`。
- __前端 store__：`contacts.ts` 新增 `ensureContact` 方法 + `contactOf` 纯函数（按 channelId+kind+key 查完整联系人），`remarkOf` 改为复用 `contactOf`。
- __SessionView 集成__：`SessionView` 新增 `imConv` prop（IM 会话传入 `ChannelConversationInfo`），顶部标题 IM 会话时改用新 `ImSessionTitle` 组件；`App.tsx` 把 `imConv` 传入。
- 测试：kernel `contact-store` 3 用例 + `ws-server-contacts` 3 用例 + `routes-contacts` 1 用例；frontend `ImSessionTitle` 组件 10 用例；e2e `channels.spec.ts` 新增「铅笔编辑备注名（自动补建+持久化）」用例，并给首用例补 `saveProvider` 规避 onboarding 向导遮挡（既有 flaky）。
- 影响范围：`kernel/src/{contact-store,channel-manager,routes/contacts,ws-server}.ts`、`shared/src/types.ts`、`frontend/src/{store/contacts.ts,components/ImSessionTitle.tsx(新),components/SessionView.tsx,App.tsx}`、`frontend/e2e/channels.spec.ts`。

## 2026-08-15 — feat(kernel/frontend): 定时任务执行记录详情页（执行过程回放）

### 变更

- __kernel 只读回放__：`ws-server.ts` `session:messages` 处理器对 `source === "scheduler"` 的会话跳过 `touchSession` 与 `prewarm()`（事后回放不再拉起 pi 进程、不污染最近会话排序），jsonl 文件直读链路不变。
- __store 导航__：`scheduler.ts` `AutoView` 加 `"record-detail"`；新增 `selectedRecordId`/`recordDetailBackTo` 与 `openRecordDetail(id, from)`/`closeRecordDetail()`（来源快照回退：从执行记录页打开返回执行记录页，从任务详情打开返回详情）；`selectTask`/`startCreate`/`startEdit` 均重置 `selectedRecordId`。
- __ExecutionDetailView 组件__：拉取 `GET /api/sessions/:id/messages` 写入 session store，复用聊天 `MessageList` 同款渲染回放；边界态：无 sessionId「该记录无执行过程」（附执行错误）、会话不存在同文案、加载失败错误提示+重试。
- __两处入口__：`ExecutionRecords` 记录行整行可点+行尾「详情」按钮；`TaskDetailView` 最近执行 `RecordRow` 加「详情」按钮。`AutomationMain` 主区路由 `record-detail`（不套 overflow 容器，MessageList 自带虚拟滚动）。
- 测试：kernel `session-messages.test.ts` 新增 scheduler 会话只读 3 用例；frontend store 导航 6 用例 + 组件 4 用例；e2e automation 用例 5（REST 造任务+run 触发、写会话 jsonl、点详情断言回放与返回）。E2E 5/5 过（偏移端口 9796/5190）。
- 影响范围：`kernel/src/ws-server.ts`、`frontend/src/store/scheduler.ts`、`frontend/src/components/automation/{ExecutionDetailView(新),AutomationMain,ExecutionRecords,TaskDetailView}.tsx`、`frontend/e2e/automation.spec.ts`。

## 2026-08-15 — fix/feat(automation): 上述重构的验收反馈修复批次 + 计划类型扩展

- __标记前缀修正（解析全链路失效根因）__：标记第一段用真实渠道前缀 `ch_`（原实现误写 `bot_`，与 channel-manager 生成的 `ch_xxx` 不符，插入端与解析端前缀不一致导致 chip 原文直出、联系人卡恒显「无」）；kernel `robot-push.ts`、前端 `prompt-tokens.ts` 及全部 fixture 同步。
- __联系人 chip 视觉__：人形 SVG 图标 + 人名（Icon 表无人形图标，模块私有自造，currentColor 继承），不再显示原文标记/emoji；详情页 prompt 渲染改复用 `toPromptHtml`（与输入框 chip 一致）。
- __技能弹窗通用化__：列表体换聊天通用 `QuickInvokeMenu`（新增 `positionClassName` 定位覆写 prop，聊天侧零影响），补 ↑↓/Enter 键盘导航。
- __弹窗定位修复__：portal 容器显式宽度解除 fixed+w-full 循环依赖（宽度约束失效导致横向撑满屏幕）；锚点收窄到输入框（弹窗紧贴光标下方）；e2e 加宽度/位置断言锁回归。
- __表单可用性__：指令输入框补边框（裸 contenteditable 浅色下与背景融合看不出可输入）；时间输入框点击任意位置 `showPicker()` 弹选择器；AgentDropdown pill ▾ 图标 `ml-auto` 右对齐。
- __计划类型扩展（feat）__：`TaskSchedule.type` 新增 `minute`（`* * * * *`）/`hourly`（`m * * * *` 每小时第 m 分钟，复用 time 分钟段）；表单下拉/分钟选择器、详情页与侧边栏 formatSchedule 同步；周几/日期选择器 `w-full` 与上方同宽。

## 2026-08-15 — refactor(kernel/frontend)!: 自动化任务 @im-push-to 标记与技能 chip 重构

### 变更

- __联系人标记函数式化（功能未发布，无兼容负担）__：任务指令中 IM 推送标记由裸 `@ct_xxx`/`@bot_xxx` 改为 `@im-push-to(ch_xxx,ct_xxx)`（第一段为联系人所属渠道 id，信息性保留，路由以联系人自身 channelId 为准）。带 `@` 前缀与 `@agentName`（delegate 智能体引用）区分，工具描述与系统提示文案均含「不要对其调用 delegate」澄清。
- __kernel 链路__：`robot-push.ts` 重写（`parseImPushMentions` 只认函数式标记；`buildSchedulerPrompt(prompt, contactIds)` 新签名；`createImPushTool` 工具名 `im_push_to`、参数 `contact`、仅走 `pushToContact`）；`agent-manager.ts` `RobotPushInjection`→`ImPushInjection`（`channels`→`targets`）、env `WA_PI_ROBOT_PUSH_CHANNELS`→`WA_PI_IM_PUSH_TARGETS`、handleTool 分发/受限白名单同步；`wa-pi-bridge.extension.ts` 注册段同步；__移除渠道绑定链路__（`pushToChannel`、`parseChannelMentions`、`pushMessage` 外旧分支）；`PushResult.channelId/channelName`→`targetId/targetName`。
- __技能标记 kernel 侧展开__：executeTask 对含 `$` 的提示词调 `channelManager.loadSkillContents()`（改 public）+ `expandSkillTokens`，`$[技能名]` 任意位置生效（SDK 只展开消息开头的 `/skill:`，定时任务不受限）。
- __前端 chip 化（复用聊天 chip 机制）__：新建 `automation/prompt-tokens.ts`（标记解析 + `toPromptHtml` chip 渲染，联系人 chip = 人形图标 + 人名（Icon 表无人形图标，模块私有 SVG 自造），失效联系人灰化显示 id 不报错）；`ComposerTextarea` 加 `toHtml`/`testId` 可选 prop 零侵入复用；`TaskPromptComposer` 重写为 contenteditable（联系人/技能双 chip + 双弹窗 `contact-picker`/`skill-picker`，__技能弹窗列表体复用聊天通用 `QuickInvokeMenu`__（新增 `positionClassName` 定位覆写 prop，键盘 ↑↓/Enter 导航与聊天输入框一致），插入走末尾替换模式，存储形态 `@im-push-to(...)`/`$[名]`）；`TaskDetailView` 四宫格「推送渠道」→「推送联系人」（人名解析），prompt 渲染改用 `toPromptHtml`（chip 与输入框一致，不再手写原文高亮）；`AutomationSidebar.hasIM` 改 `HAS_IM_PUSH_RE`；删除 `utils/channel-mentions.ts`。tokens.ts 新增 `.chip-im`/`.chip-im-invalid` 样式。
- 测试：kernel robot-push 重写至新契约（parseImPushMentions 6 + 工具定义/execute 5 + 会话注入 5 + buildSchedulerPrompt 2）、bridge.test im_push_to 注册断言；frontend 新增 prompt-tokens 9 + TaskPromptComposer 重写 10 + TaskDetailView 新契约 + TaskEditForm 适配 contenteditable 交互；e2e automation.spec testid 同步。
- 影响范围：`kernel/src/{tools/robot-push,agent-manager,channel-manager,index,wa-pi-bridge.extension}.ts`、`shared/src/types.ts`、`frontend/src/components/automation/{prompt-tokens(新),TaskPromptComposer,TaskDetailView,AutomationSidebar}.tsx`、`frontend/src/quick-invoke/tokens.ts`、`frontend/src/components/ui/ComposerTextarea.tsx`、删除 `frontend/src/utils/channel-mentions{,.test}.ts`。
- 附带格式重排（纯格式无逻辑变化，`git diff -w` 已核验）：涉及上述文件的 formatter 重排 + `QuickInvokeMenu.tsx`/`AgentDropdown.tsx`/`i18n/locales/{zh,en}.ts`/`TaskEditForm.test.tsx`/`ComposerTextarea.test.tsx`；typecheck 0 错、相关测试 25/25 过。

## 2026-08-15 — feat(kernel): extension:repair 事件链路（ws + HTTP 路由 + 广播）

### 变更

- __shared 事件类型__：`packages/shared/src/extensions.ts` 新增 `ExtensionRepairEvent`（前端→kernel，全量重建依赖目录）、`ExtensionRepairProgressEvent`（修复日志行）、`ExtensionRepairDoneEvent`（成功终态），并同步补入 `types.ts` 的 import 区、`WSClientEvent` 与 `WSServerEvent` 两个 union。
- __ExtensionManager.repair()__：封装任务 1 的 `NpmPackageService.repair(onProgress?)`，签名与 install/upgrade 的进度回调一致。
- __ws-server case "extension:repair"__：progress 经 reply（callApi 自动 SSE 广播）、成功后广播 `extension:changed` → `extension:repair:done` → `skill:changed`（含 markAllDirty + 重扫技能），失败广播 `extension:error`（name=repair，fire-and-forget 语义）。
- __HTTP 路由__：`POST /api/extensions/repair` → `callApi({ type: "extension:repair" })`，前端将来可直接触发。
- 测试：新建 `ws-extension-repair.test.ts`（真实服务模式，2 用例：成功帧序列/失败 error 广播）；修复参考 helper `readSseFrame` 的残留帧缺陷（buffer 提为 WeakMap 跨调用共享 + 先解析残留帧再 read，否则密集帧场景挂死超时）；补齐 `extension-manager.test.ts` 两处 pkgService stub 缺失的 `repair`（任务 1 遗留的类型破坏）。
- 影响范围：`packages/shared/src/extensions.ts`、`types.ts`，`packages/kernel/src/extension-manager.ts`、`ws-server.ts`、`routes/extensions.ts`，`packages/kernel/tests/ws-extension-repair.test.ts`（新）、`extension-manager.test.ts`；kernel 全量 1020 测试全过、shared 97 全过、四包 typecheck 0 错。

---

### 扩展区「修复依赖」一键自愈 + E2E

- __UI 调整__：修复依赖按钮从安装区下方独立行移至底部提示条（「安装、卸载、升级操作在当前对话立即生效…」）右侧右对齐；进度文案独立显示在按钮正下方（右对齐）——按钮「修复中…」与进度行「正在修复依赖…」拆分 i18n key（repairingBtn/repairing），消除修复中双「正在修复依赖…」重复显示；真实修复流程 22s 复现验证设置窗口全程存活（无代码路径关闭）；组件测试 5/5 + E2E 2/2 回归通过。
- __新增功能__：设置面板扩展区新增「修复依赖」动作（extension:repair）——全量重建扩展依赖目录（删 node_modules + bun.lock 后按 package.json 重装），为版本漂移/半安装导致的扩展硬崩溃提供一键自愈。背景：pi-tui 0.82.1 与其余 @earendil-works 包 0.84.1 错配导致 /goal 崩溃，且现有链路无任何依赖树检查。涉及 kernel（NpmPackageService.repair + ws 事件 + HTTP 路由）、shared（3 个事件类型）、frontend（store 修复态 + ExtensionSection 按钮/确认弹窗/进度 + i18n）。
- __E2E 测试__：新增 `packages/frontend/e2e/extension-repair.spec.ts`（2 用例：确认弹窗流程——取消不发请求/确认后发出 POST /api/extensions/repair（route 拦截，SSE 终态由组件/单测层覆盖）；按钮存在且可见）。导航照抄 plugin-command-toggles 既有路径（假 provider 规避 onboarding 弹窗 + 按钮文本「插件」精确匹配），语言用 addInitScript 预置 wa-pi-ui-prefs 锁定中文（language-switch.spec.ts 同款，规避 E2E chromium 默认 en-US 导致的文案断言漂移）。本机真实 kernel 占用 9776 时用 WA_PI_E2E_WS_PORT/WA_PI_E2E_WEB_PORT/WA_PI_WEB_PORT 偏移端口运行。

---

## 2026-08-15 — feat(kernel/frontend): 任务指令 @ 改为选联系人 + kernel 主动推送能力

### 变更

- __业务修正__：任务指令 `@` 原来选 IM 渠道本身（`@bot_xxx`）——但渠道是被动回复（`sendText(null)` 需要进站帧），且无法指定接收人，任务结果根本推不到具体的人（用户反馈）。改为 `@` 选__渠道通讯录里的人__（`@ct_xxx` 联系人 id），任务执行时主动推送到该联系人。
- __kernel 主动推送能力（新）__：`ChannelAdapter` 新增 `pushMessage?(chatId, markdown)`（主动发送，无需进站 replyFrame）；wecom-adapter 用 SDK `client.sendMessage(chatId, {msgtype:'markdown', markdown:{content}})`（aibot_send_msg 主动通道），mock-adapter 记录 outbox（含 chatId）。`ChannelManager.pushToContact(contactId, message)`：按联系人 id 查通讯录 → person 用 userId（单聊）/group 用 chatId（群）→ 经所属渠道 adapter 主动推送；联系人/渠道不存在、adapter 不支持主动推送均抛错。
- __@ 解析扩展__：`robot-push.ts` 新增 `parseContactMentions`（解析 `@ct_xxx`）；`createRobotPushTool` 支持联系人目标（`ct_` 前缀走 pushToContact，`bot_` 走 pushToChannel），deps 增加 `availableContactIds`；`index.ts` executeTask 同时解析渠道+联系人注入 robot_push。
- __前端选择器改为联系人__：TaskPromptComposer `@` 数据源从 `useChannelsStore().bots`（渠道）换成 `useContactsStore().contacts`（通讯录），弹窗按渠道分组展示 person 联系人（渠道名 + remark||userId），选中插入 `@ct_xxx`；群聊联系人（kind=group）不展示；空态提示「暂无联系人（先在 IM 里发起会话后自动收录）」；打开时主动 `loadContacts()`（新联系人采集无广播兜底）。触发改为派生状态（value 末尾 `@` 时显示，Escape/外点/滚动 dismiss，继续输入自动收起），修复旧实现 fill 后不关闭的问题。文案同步：「@ 关联 IM 渠道」→「@ 选择联系人」。
- 测试：kernel robot-push 26 例（parseContactMentions 3 + execute ct_ 2）、channel-manager 31 例（pushToContact 2）、mock-adapter 2 例（pushMessage）全绿；kernel 全量 1023 pass；frontend TaskPromptComposer 6 例全绿、全量 1519 pass（2 fail 既有）；E2E automation 4/4（test2 真实浏览器验证 @ 联系人选择器弹出/自动收起）。
- 影响范围：`kernel/src/channels/{types,wecom-adapter,mock-adapter}.ts`、`channel-manager.ts`、`tools/robot-push.ts`、`index.ts`、`frontend/src/components/automation/{TaskPromptComposer,TaskEditForm}.tsx`、对应测试、`e2e/automation.spec.ts`。

---

## 2026-08-15 — feat/fix(frontend): 新建文案改自动化 + 表单居中 + 任务指令 $ 技能窗口

### 变更

- __文案统一「自动化」__：新建/编辑弹窗标题 `新建定时任务`→`新建自动化`、`编辑定时任务`→`编辑自动化`；侧边栏与空态引导页的「+ 新建」按钮 →「+ 新建自动化」。分组名「定时任务」保留。
- __新建弹窗表单居中__：TaskEditForm 顶层 `max-w-[560px]` 加 `mx-auto`——在 Modal 内容区（640 宽 − 32 padding = 608px）里由靠左改水平居中，左右留白对称。
- **任务指令输入框 $ 技能窗口（复用公共组件）**：初版手搓技能弹窗（absolute 定位被 Modal 裁剪、portal 化后仍自维护）→ 用户反馈「太大、透明背景、参考机器设置用公用组件」→ 改为直接复用公共组件 `SkillSuggestTextarea`（设置页 BotsSection 同款）：输入框本体 + $ 技能弹窗全部内建（portal 挂 body、fixed 定位、`background: var(--surface)` 不透明、宽度=输入框宽、maxHeight 240、方向键导航、token 替换）。TaskPromptComposer 只保留 @ 渠道职责（keyup 冒泡到容器 div 检测 @，渠道弹窗 portal 挂 body 锚定容器矩形，背景补齐 `var(--surface)` + `boxShadow`）。行为差异：公共组件用 `s.skills`（仅启用技能）、技能为空不渲染弹窗——比初版更合理。
- __E2E 预置技能__：公共组件仅技能非空时渲染弹窗，E2E 独立 WA_PI_DIR 无技能 → global-setup 预置 `skills/e2e-skill/SKILL.md`（frontmatter 格式匹配 kernel skill-utils 扫描），真实浏览器验证 $ 弹窗（`skill-suggest-list`）。
- __新建/编辑弹窗仅取消/保存可关__：Modal 默认点阴影关闭，新建自动化表单误点阴影会丢输入 → AutomationMain 传 `closeOnOverlayClick={false}`，点阴影不再关闭（ESC 仍可关），只有「取消/保存」按钮关闭。测试：AutomationMain 用例改为「点遮罩不关闭」；取消按钮关闭由 TaskEditForm 既有用例覆盖。
- 测试/已知：前端全量 1518 pass（2 fail 既有：maxEntries/项目名折叠）；automation 组件 50 例全绿（TaskPromptComposer 保留 5 例 @渠道职责，$ 由 SkillSuggestTextarea 自带测试覆盖）；typecheck 0 错；E2E automation+agents 12/12（automation test2 真实浏览器验证公共组件 $ 技能弹窗 `skill-suggest-list`：fill "整理一下 $" → 可见 → fill 正式指令 → 收起）。
- 影响范围：`automation/{AutomationMain,AutomationSidebar,TaskEditForm,TaskPromptComposer}.tsx`、`e2e/automation.spec.ts`、对应测试。

---

## 2026-08-15 — fix(frontend): 原生控件（时间选择/滚动条）跟随深浅主题

### 变更

- __根因__：styles.css 从未设置 `color-scheme`。应用用 `<html data-theme>` 切深浅主题，但由 UA 绘制的原生控件（`<input type="time">` 的时钟图标、日期/时间选择器、滚动条、select 箭头等）默认跟随 OS `prefers-color-scheme`，不跟随应用 `data-theme`——应用手动切深色（或 OS 与 app 不一致）时，深色背景上是浅色 UA 的深色图标，看不见。
- __修复__：浅色 `:root` 补 `color-scheme: light`，深色 `:root[data-theme="dark"]` 补 `color-scheme: dark`。UA 用与 `data-theme` 一致的颜色方案渲染所有原生控件，时间 icon 等自动跟随主题。TaskEditForm 新建自动化表单的时间输入即受益。仓库内无内联 `colorScheme` 与此冲突；表单输入均已显式覆盖背景/文字色，不受 UA 默认色影响。
- 影响范围：仅 `src/styles.css`（两个根块加声明）。验证：前端全量 1517 pass（3 fail 既有）、E2E automation+agents 12/12 无回归。

---

## 2026-08-15 — fix(frontend): 任务卡右键菜单 + 最近执行状态点 + AgentDropdown 弹窗内裁剪

### 变更

- __右键菜单（对齐会话列表模式）__：任务卡右键不再直接弹删除确认，改弹上下文菜单（createPortal + fixed z-50 + useClampMenu 视口钳制，复用 ProjectItem 导出 hook）：菜单项「▶ 立即执行」「🗑 删除」，点删除才弹 ConfirmDialog 二次确认；点外部/ESC 关菜单（setTimeout(0) 延迟注册防误关）；project-menu-close 跨组件菜单互斥。
- __最近执行状态点__：任务卡右上角显示该任务最近一次执行结果（✓ 绿成功 / ✕ 红 / ⟳ 蓝执行中，颜色映射与执行记录页一致），由 records 按 startedAt 取每任务最新一条推导；侧栏挂载时同步 loadRecords()。执行记录页/详情页原有状态展示不变。
- __AgentDropdown 弹窗内裁剪__：菜单从组件内 absolute 改 createPortal 挂 body（fixed z-50）——逃逸新建任务弹窗内容区（overflow-y-auto + maxHeight 70vh）的 overflow 裁剪；按 pill 矩形定位（左对齐/顶部+4px），底部溢出向上翻转，右溢出左移钳制（取代原 translateX 方案）；外点关闭补 menuRef 判定（portal 后菜单不在 rootRef 子树）。NewSessionPane/AgentSwitcher/TaskEditForm 三个使用方同时受益。
- __AgentDropdown 滚动收起修复__：初版「捕获阶段监听任意 scroll 即关菜单」误伤菜单自身列表滚动（智能体多时一滚就收起）；改为 scroll target 在 menuRef 内部不关闭、仅外部容器滚动关闭（防 fixed 脱锚）。补 2 用例（内滚不关/外滚关闭）。
- 测试：AutomationSidebar 重写 9 用例（右键菜单/立即执行/删除确认链/外点关闭/状态点推导）；AgentDropdown 定位 3 用例重写到 fixed 定位契约（含新增向上翻转用例，mock 需同时覆盖 button+div 两类原型）；E2E automation test4 改右键菜单流程。⚠️ automation.spec 中途被并行格式化改过，edit 工具 oldText 匹配失败 → python 字节级替换完成。
- 影响范围：`automation/AutomationSidebar.tsx`、`ui/AgentDropdown.tsx`、对应测试、`e2e/automation.spec.ts`。验证：AgentDropdown 14 例 + Sidebar 9 例全绿、前端全量 1515 pass（3 fail 既有）、typecheck 0 错、E2E automation+agents 12/12（真实浏览器验证菜单/下拉/翻转）。

---

## 2026-08-15 — fix(kernel/frontend): 定时任务执行会话隔离，不进侧栏会话列表

### 变更

- __根因__：executeTask 创建的 sched 会话直接写入 projects.json，无任何隔离标记，loadActive 不过滤、前端只排 im- 前缀 → 出现在项目列表与最近会话列表（本机实测存有 1 条泄漏会话）。
- __shared__：`SessionEntity` 新增可选 `source?: "im" | "scheduler"` 字段，显式化会话来源（原靠 id 前缀隐式约定）；`createSession` 入参透传。
- __kernel__：① executeTask 传 `source: "scheduler"`，IM ensureSession 传 `source: "im"`（收编前缀约定）；② `loadActive` 过滤 `source === "scheduler"` + 存量 `sched-` 前缀兑底；③ IM 会话列表数据源（channel-sessions mapping）经查与 projects.json 独立，sched 会话不会写入，无需防御。
- __前端防御__：`ProjectItem` / `recentSessions` 过滤条件补 `!startsWith("sched-")`（kernel 未升级/事件竞态时自洽）。
- 执行记录独立性：`ExecutionRecord.sessionId` 已回填，会话查看走 `load()` 不受 loadActive 过滤影响，TaskDetailView 执行记录仍可正常查看。
- 测试：project-store 新增 3 用例（scheduler 过滤+存量兑底、load 全量保留、IM source=im 不过滤）；真实数据实证（本机 projects.json 存量 sched 会话 loadActive 过滤为 0）；kernel channel-manager/routes 45 例回归全过；前端 16 例 + E2E recent-sessions 过；三包 typecheck 0 错。
- 影响范围：`shared/src/types.ts`、`kernel/src/{project-store,index,channel-manager}.ts`、`frontend/src/{components/ProjectItem,util/recentSessions}.ts`。

---

## 2026-08-15 — feat(frontend): 自动化默认页规则 + 点选切换 + 通用智能体选择器 + 右键删除

### 变更

- __默认页规则__（AutomationMain store 驱动化，props 全部内化）：选中任务→详情；有任务未选中→默认执行记录页；无任务→新建引导页（⚡ + 暂无文案 + 「+ 新建」直达按钮）。App.tsx 调用简化为 `<AutomationMain />`，删除四个孤立 store 订阅。
- __点选切换__：`selectTask` 改 toggle——再点同一张卡片取消选中（selectedTaskId 回 null，主区回默认页），点不同卡片切换。新增 `tests/scheduler-store.test.ts` 3 用例。
- __通用智能体选择器__：TaskEditForm 执行角色从自研按钮组换成 `ui/AgentDropdown`（AgentSwitcher/NewSessionPane 同款：搜索 + 头像 + 描述 + 视口钳制），pill/列表 testid 前缀 task-agent。
- __右键删除__：TaskCard onContextMenu 弹 `ui/ConfirmDialog`（danger 红色确认，任务名回显），确认调 deleteTask，SSE 驱动列表刷新。
- 测试：AutomationMain.test 重写为 7 用例（引导页/默认记录页/详情/弹窗/遮罩关闭）；AutomationSidebar 补右键删除确认+取消 2 用例；TaskEditForm 4 用例适配 AgentDropdown 交互；E2E automation.spec 重构——test1 引导页断言、test2 AgentDropdown 交互+保存后默认记录页、test3 详情后再点取消、test4 右键删除 UI 流程（替代 REST 删除，SSE 链路同验）。
- 影响范围：`automation/{AutomationMain,AutomationSidebar,TaskEditForm}.tsx`、`store/scheduler.ts`、`App.tsx`、`tests/scheduler-store.test.ts`（新）、e2e/automation.spec.ts。验证：automation 组件 44 例 + store 3 例全绿、前端全量 1511 pass（3 fail 既有）、typecheck 0 错、E2E 4/4（偏移端口 9876/5280）。

---

## 2026-08-15 — refactor(frontend): 新建/编辑任务弹窗化 + 侧栏去「执行记录」按钮

### 变更

- __新建任务弹窗化__：`AutomationMain` 从 App.tsx 移入 `automation/AutomationMain.tsx` 并弹窗化——edit 态不再整页替换主区，改用 `ui/Modal`（width 640，内容区 maxHeight 70vh 滚动）叠加表单，主区始终保持任务详情。关闭路径统一：ESC/遮罩/取消/保存均走 `setView("detail")`（取消与保存已有行为不变，ESC/遮罩免费获得）。弹窗标题区分新建/编辑。App.tsx 同步清理三个孤立 import。
- __侧栏去「执行记录」按钮__：工具栏只留「+ 新建」。执行记录仍可从任务详情页查看（每任务最近 3 条）；ExecutionRecords 全量视图暂无 UI 入口（按需求移除，后续如需可从详情页加链接）。
- __测试__：新增 `AutomationMain.test.tsx`（5 用例：弹窗呈现/主区不被替换、编辑标题、detail 无弹窗、records 视图、遮罩关闭回 detail）；AutomationSidebar 补「无执行记录按钮」断言；E2E automation.spec 适配——test2 改弹窗断言（弹窗标题+主区 header 保持），删除引用已删按钮的执行记录用例（4 用例 serial 连贯流）。⚠️ 仓库裸跑 `bun test` 有 mock.module 跨文件串扰（automation 目录 26 fail 系既有现象，与本次无关），须用官方 `bun --env-file=.env.test test --isolate`。
- 影响范围：`App.tsx`、`automation/AutomationMain.tsx`（新）、`AutomationSidebar.tsx`、`__tests__/AutomationMain.test.tsx`（新）、`__tests__/AutomationSidebar.test.tsx`、`e2e/automation.spec.ts`。验证：automation 40 例全绿、前端全量 1504 pass（3 fail 为既有）、typecheck 0 错、E2E 4/4（偏移端口 9876/5280）。

---

## 2026-08-15 — fix(frontend): 通讯录侧滑面板覆盖式定位 + 行内编辑回填/按钮溢出修复

### 变更

- __覆盖式定位__：原 `ContactsPanel` 根节点是普通文档流元素（`w-64` 无定位），作为 `BotsSection` 横向 flex 行的第三个子项参与空间分配，打开后把右侧编辑表单挤窄 256px。改为全仓库浮层范式（Modal/FilePicker 均 fixed/absolute + z-index）——根改 `absolute inset-y-0 right-0 z-40`（低于 Modal 的 z-50，不遮删除确认弹窗）+ 不透明背景 `var(--surface)` + `var(--shadow-lg)`；`BotsSection` 根容器补 `relative` 作定位上下文。
- __行内编辑回填与替换__：点击人/群名展开编辑时，原为 `setValue(c.remark ?? "")`，remark 为空时输入框空白且名字行仍占位（叠加两行）。改为：① 回填当前显示名 `label(c)`（人→userId，群→chatId 前 8 位）；② 编辑态用输入框行__替换__名字行（三元切换，非叠加），取消/保存后名字行恢复；③ `label` 返回类型收紧为 `string`（`userId` 可选字段 `?? ""`）。
- __保存/取消按钮溢出__：行内编辑 input 为 `flex-1` 但无 `min-w-0`，flex item 默认 `min-width:auto` 使 input 固有宽度（~200px）不可收缩，256px 面板内 input+两按钮总宽溢出~50px，按钮被外层 `overflow-auto` 裁剪不可见。input 补 `min-w-0` 允许收缩，按钮恒在视口内。
- 测试：新增 5 个契约/行为用例（覆盖定位、人名回填、编辑态行内替换+取消恢复、群名回填、input 可收缩），既有用例 + BotsSection 12 例回归全过。
- 影响范围：`packages/frontend/src/components/settings/ContactsPanel.tsx`、`BotsSection.tsx`、`ContactsPanel.test.tsx`。

---

## 2026-08-15 — fix(scheduler): 审查终修复——robot_push 真实注入 + 触发即返回 + 入口校验 + 原子读改写

### 变更

- __C1 robot_push 工具真实注入（不再 TODO）__：复用 bridge 扩展机制——`wa-pi-bridge.extension.ts` 读 `WA_PI_ROBOT_PUSH_CHANNELS` env 条件注册第 8 个工具（普通会话不设 env 不注册，零污染）；`agent-manager.ensureStarted` 新增 `robotPush` opts（spawn 注入 env + 受限 agent 白名单并入 robot_push + `bridgeCtx.handleTool` 分发）；`index.ts executeTask` 解析到 @bot_xxx 时用 `createRobotPushTool` 构造执行体，pushResults 回填执行记录，prompt 追加推送引导。
- __I1 run 触发即返回__：POST /:id/run 不再 await 执行链（旧实现最长挂 5 分钟被 idleTimeout 255s 掐断），改 fire-and-forget + catch 记错；前端「立即执行」成功后 toast「已触发执行」（失败弹错误提示）。
- __I2 入口校验 + 容错__：POST/PUT 校验 name/agentId/prompt 非空、schedule.type 限 5 合法值、time 限 HH:MM（含 00-23/00-59 范围）、custom 必填 cronExpression，不合法 400；ws-server 的 onTaskChanged 调度注册失败 try-catch（不再假 500，记日志 + 广播）；`scheduled-task:error` 事件补入 WSServerEvent 联合类型，App.tsx 处理（toast + 刷新列表）。
- __I4/M14 原子读改写__：`scheduler-store.mutateScheduledTasks(fn)` 把 load→改→save 整体入写队列，routes 的 POST/PUT/DELETE 全部改走；`saveExecutionRecords` 同模式入队。
- __M2/M5 顺手修__：store/scheduler.ts 恒等三元删除；两处 formatSchedule monthly 分支 `dayOfMonth ?? 1`。
- 影响范围：kernel（agent-manager/index/ws-server/routes/scheduler-store/bridge 扩展）、shared types、前端（App/TaskDetailView/AutomationSidebar/store）；kernel 全量 994 测试全过、前端 automation 35 例全过、三包 typecheck 0 错。

---

## 2026-08-15 — test(scheduler): 定时任务 E2E 完整流程测试 + 补执行记录 UI 入口

### 变更

- __E2E 测试__：新增 `packages/frontend/e2e/automation.spec.ts`（5 用例 serial 连贯流）——切 automation 页签验证列表/空态、新建完整流程（填表单+选每周计划+选「研发」角色+保存→列表展示）、任务卡片→详情四宫格与指令、「执行记录」入口→空态渲染→点卡片回详情、REST 删除→SSE 驱动列表恢复空态（顺带验证 scheduled-tasks:changed 刷新链路）。环境前置：假 provider 规避首启 onboarding 弹窗；本机真实 kernel/dev 占用 9776/5180 时用 WA_PI_E2E_WS_PORT/WA_PI_E2E_WEB_PORT/WA_PI_WEB_PORT 偏移端口；npx 会解析到全局 1.59.1 与项目 1.62.1 混载报错，须用 `./node_modules/.bin/playwright`。
- __补 UI 缺口（TDD 驱动）__：E2E 发现 ExecutionRecords 视图无任何 UI 入口（store 的 view=records 无组件可达，死代码）。`AutomationSidebar` 工具栏补「执行记录」按钮（`automation-records-btn`，setView("records")），点任务卡片自然回 detail（selectTask 已置 view）。组件测试补「点击执行记录按钮调用 setView(records)」用例。
- 影响范围：`packages/frontend/e2e/automation.spec.ts`（新增）、`AutomationSidebar.tsx`、`AutomationSidebar.test.tsx`；四层验证全过——kernel scheduler 相关 30 例（scheduler-store/scheduler/routes-scheduler）、automation 组件 33 例、typecheck 三包 0 错、E2E 5/5。

---

## 2026-08-15 — feat(scheduler): 主内容区视图路由 + SSE 事件 + kernel 调度集成

### 变更

- __主内容区自动化路由__：`Sidebar.tsx` 的 tab（tasks/im/automation）由内部 state 改为受控 props（`SidebarTab` 类型导出），状态提升到 `App.tsx`；`App.tsx` 在 `sidebarTab === "automation"` 时渲染 `AutomationMain`（新增内联组件），按 `useSchedulerStore.view` 切换 TaskEditForm / ExecutionRecords / TaskDetailView，header 显示对应标题。
- __SSE 事件监听__：`App.tsx` 新增 `scheduled-tasks:changed`（重拉任务列表）与 `scheduled-task:completed`（重拉任务 + 记录）处理；初始连接回调中同步 `loadTasks` + `loadRecords`。
- __SSE 事件类型__：`packages/shared/src/types.ts` 新增 `ScheduledTasksChangedEvent` / `ScheduledTaskCompletedEvent` 并挂入 `WSServerEvent` 联合类型。
- __kernel 调度集成__：`index.ts` 创建 `TaskScheduler` 实例并 `server.setScheduler()` 注入；`executeTask` 实现：写 running 态执行记录 → 创建会话（默认工作区先 mkdir workdir 子目录，与 agent:prompt 行为一致）→ `ensureStarted` → 解析默认模型（取首个供应商首模型，缺失则 fail）→ `prompt` → 轮询 `isSessionBusy`（500ms 间隔，5 分钟超时 abort）→ 收集末条 assistant 文本为摘要（截 500 字）→ `updateExecutionRecord` 回写终态；shutdown 时 `scheduler.stopAll()`。
- __scheduler 扩展__：`TaskScheduler.runTaskNow()` 手动立即执行（REST run 端点委托）；`scheduler-store.updateExecutionRecord()` 按 id 回写记录（不存在退化追加）。
- __ws-server 路由回调接通__：scheduler 路由的 onSchedule/onCancel 回调现在同时广播 `scheduled-tasks:changed`；onRunNow 委托 `scheduler.runTaskNow`（原占位）。
- __附带修复（agent-manager）__：`switchAgent` 中把 `setSessionAgent` 持久化移到 `_teardownSession` 之前，消除「teardown 后、starting.set 前」异步竞态窗口——否则切换角色后立即发消息会触发并发 `ensureStarted` 二次创建 pi 进程导致 jsonl 冲突。新增专项测试覆盖（挂起 setSessionAgent 期间 sessions 不为空）。
- 与简报的关键偏差：① 主内容区路由在 `App.tsx` 而非 `Sidebar.tsx`（架构上主内容区本就由 App 渲染，Sidebar 仅侧栏）；② 简报的 `scheduled-task:started` 事件未实现，running 态记录创建时广播 `scheduled-tasks:changed` 替代（shared types 未定义 started 事件，保持类型自洽）；③ robot_push 工具注入仍为 TODO（简报即标注 TODO，待 bridge 扩展机制实现）。
- 影响范围：前端 App/Sidebar/store、kernel index/scheduler/scheduler-store/ws-server/routes、shared types、agent-manager 竞态修复；kernel 977 测试全过、前端相关组件测试全过（2 个预先存在的失败与本次无关，基线复现）。

---

## 2026-08-15 — feat(kernel): 记忆字符上限放宽 user 1800 / memory 3200

### 变更

- amaster-memory 的 `createStore` 构造 `MemoryStore` 时覆盖默认上限（user 1375 / memory 2200）→ __user 1800 / memory 3200__：实际使用常触顶导致 `memory_add` 被拒，放宽后全局与项目 store 统一生效。
- 影响范围：amaster-memory.ts（createStore 传 userCharLimit/memoryCharLimit）、amaster-memory.test.ts（+1 用例：1400 字符 user / 2300 字符 memory 写入成功验证覆盖生效）。

---

## 2026-08-15 — feat(scheduler): TaskDetailView 任务详情视图 + ExecutionRecords 执行记录列表

### 变更

- 新建 `packages/frontend/src/components/automation/TaskDetailView.tsx`：任务详情视图。选中任务时渲染四宫格信息（计划时间/执行角色/推送渠道/工作目录）+ 任务指令（`$/skill` 渲染为紫色标签、`@bot_xxx` 渲染为绿色标签）+ 最近执行记录（该任务前 3 条）；未选中时显示空态提示；含「立即执行」「编辑」操作按钮，分别调用 `runTaskNow`/`startEdit`；选中任务变化时 `useEffect` 拉取该任务的 `loadRecords(taskId)`。
- 新建 `packages/frontend/src/components/automation/ExecutionRecords.tsx`：执行记录列表。顶部筛选栏（按天/周/月时间筛选 + 任务下拉 + 状态下拉），记录卡片显示状态图标（✓/✕/⟳）、taskName、耗时、推送标记、错误信息；空态友好提示；挂载时 `loadRecords()` 拉取全部记录。
- 新建 `packages/frontend/src/utils/channel-mentions.ts`：前端版 `parseChannelMentions` 纯函数，从 prompt 提取 `@bot_xxx` 并去重返回 bot ID 列表，与后端 `packages/kernel/src/tools/robot-push.ts` 保持相同契约。
- 新增测试：`channel-mentions.test.ts`（7 例单元测试，镜像后端用例）、`TaskDetailView.test.tsx`（8 例组件测试）、`ExecutionRecords.test.tsx`（8 例组件测试），均用 bun:test + @testing-library/react，mock 全部 store。
- 与简报的关键偏差（均已校正）：① CSS 变量 `--border-color` 在 styles.css 中不存在，项目用 `--hairline`，按钮/下拉框边框已替换；② `React.ReactNode` 在 `jsx: react-jsx` 下需显式导入，改用 `import type { ReactNode }`；③ 移除未使用的 `setView` 解构；④ `RecordRow` 的 `record` 参数用 `ExecutionRecord` 类型替代 `any`。
- 影响范围：纯新增 3 个源文件 + 3 个测试文件，不改已有业务逻辑；组件尚未挂载到父视图（挂载属后续任务）。

## 2026-08-15 — fix(scheduler): TaskEditForm + TaskPromptComposer 审查修复 3 项

### 变更

- __渠道选择器可关闭__：`TaskPromptComposer.tsx` 增加 `onKeyDown` 处理 Escape 关闭 + `useEffect` + `document.mousedown` 监听点击外部关闭（containerRef 判断），新增 `containerRef`。原先用户误按 @ 后唯一关闭方式是选中渠道，现支持 Escape 和点击外部。
- __handleSave 错误处理__：`TaskEditForm.tsx` 的 `handleSave` 包 try-catch，网络失败时调用 `useToastStore.getState().add("保存任务失败，请稍后重试", "error")` 提示用户，避免 unhandled promise rejection。
- __custom cron 校验__：`canSave` 增加条件 `scheduleType !== "custom" || cronExpression.trim() !== ""`，选「自定义 Cron」但未填表达式时保存按钮禁用。
- 测试新增 4 例：Escape 关闭渠道选择器、点击外部关闭、custom 未填 cron 禁用/填写启用、保存失败弹出错误 toast。
- 影响范围：仅修改 2 个组件文件 + 2 个测试文件，不改已有业务逻辑。

## 2026-08-15 — feat(scheduler): TaskPromptComposer + TaskEditForm 任务编辑表单

### 变更

- 新建 `packages/frontend/src/components/automation/TaskPromptComposer.tsx`：任务指令富文本输入框。按下 `@` 键弹出已连接 IM 渠道列表（从 `useChannelsStore` 的 bots 按 status=="connected" 过滤），选中后把光标前最近一个 `@` 替换为 `@botId`（与后端 `@bot_xxx` 解析约定一致）；`$ 插入技能` / `@ 关联 IM 渠道` 提示行。
- 新建 `packages/frontend/src/components/automation/TaskEditForm.tsx`：定时任务新建/编辑完整表单。editingTask===null 为新建、否则回填字段；含任务名、计划时间（daily/weekdays/weekly/monthly/custom 五种调度 + 对应 time/dayOfWeek/dayOfMonth/cron 控件）、执行角色（智能体，从 `useAgentsStore.list` 渲染，选中态高亮）、任务指令（内嵌 TaskPromptComposer）、工作目录（从 `useProjectsStore.projects` 渲染）；必填项（名称/智能体/指令）齐全后保存按钮才启用；保存调用 store 的 createTask/updateTask，取消调用 setView("detail")。
- 新建测试 `TaskPromptComposer.test.tsx`（3 例）、`TaskEditForm.test.tsx`（6 例）：bun:test + @testing-library/react，mock 全部 store，覆盖渲染、@ 弹渠道、选中插入、新建/编辑保存、禁用态、取消。
- 与简报的关键偏差（均已校正）：① 简报用 `useAgentsStore().agents` + `agent.id`，实际 store 字段为 `list` 且 `AgentConfig` 以 `displayName` 为唯一标识（无 id），故 agentId 取 `agent.displayName`；② CSS 变量 `--border-color`/`--accent-bg` 在 styles.css 中不存在，项目用 `--hairline`/`--accent-soft`，已替换；③ 简报测试用 vitest+jest-dom，本仓库统一 bun:test，沿用 AutomationSidebar.test.tsx 约定；④ 工作目录 select 简报为占位，实际接入 `useProjectsStore`。
- 影响范围：纯新增两个组件 + 测试，不改已有业务逻辑；组件尚未挂载到父视图（挂载属后续任务）。

## 2026-08-14 — fix(kernel): 切换智能体后立即发消息报「会话未启动」

### 变更

- 根因：`switchAgent` 里 `_teardownSession`（删除 sessions 条目）之后、`starting.set`（并发创建锁）之前，夹着 `await setSessionAgent` 的异步文件 I/O。该窗口内 sessions/starting 均为空，用户切换角色后立即发消息会触发 `ensureStarted` 启动第二个 `_createSession`，两个 pi 进程并发创建同一 jsonl 冲突失败，最终 `prompt` 报「会话未启动」。
- 修复：把 `setSessionAgent` 移到 `_teardownSession` 之前，使 teardown → `_createSession` → `starting.set` 成为连续同步段（原子），并发 `ensureStarted` 命中 `starting` 复用同一创建 promise。
- 影响范围：`agent-manager.ts`（switchAgent 顺序调整）、`agent-manager.test.ts`（+1 竞态回归用例）。

---

## 2026-08-14 — feat(scheduler): 侧边栏自动化 Tab + AutomationSidebar 任务列表组件

### 变更

- 修改 `packages/frontend/src/components/Sidebar.tsx`：tab 类型从 `"tasks" | "im"` 扩展为 `"tasks" | "im" | "automation"`；分段控件由 2 个按钮改为遍历 3 个 tabKey 渲染（testid 统一为 `sidebar-tab-${tabKey}`）；条件渲染新增 `tab === "automation"` 分支挂载 `<AutomationSidebar />`。
- 新建 `packages/frontend/src/components/automation/AutomationSidebar.tsx`：紧凑任务卡片列表组件。useEffect 调用 `loadTasks` 拉取任务；工具栏显示任务数 + 「+ 新建」按钮（startCreate）；列表项为 TaskCard（选中态高亮、启用/禁用圆点、调度文案、含 @bot_ 的任务显示 📨 角标）；空态「暂无定时任务」；`formatSchedule` 支持 daily/weekdays/weekly/monthly/custom 五种调度文案。全部走项目既有 CSS 变量设计 token。
- 新建 `packages/frontend/src/components/automation/__tests__/AutomationSidebar.test.tsx`：3 个组件测试（渲染任务列表、点击卡片调用 selectTask、点击新建调用 startCreate）。注：简报原文用 vitest + jest-dom，本仓库统一用 bun:test（14 个既有组件测试约定）且未装 jest-dom，故断言改用 `toBeTruthy()`。
- 修改 `packages/frontend/src/i18n/locales/{zh,en}.ts`：新增 `sidebar.tabAutomation`（中文「自动化」/ 英文「Automation」），与既有 tabTasks/tabIm 结构一致。
- 修复 `AutomationSidebar.tsx` CSS 变量名（代码审查反馈）：`--accent-bg` → `--accent-soft`、`--success-bg` → `--success-soft`，与项目设计 token 一致（styles.css 定义的是 `*-soft` 后缀，`*-bg` 不存在会导致选中态高亮与 IM 角标背景回退 transparent）。
- 影响范围：定时任务系统的前端入口；纯新增组件 + Sidebar 加一个 tab + 两条 i18n key，不改已有业务逻辑。

## 2026-08-14 — feat(scheduler): robot_push 工具 + @channel 解析 + ChannelManager.pushToChannel

### 变更

- 新建 `packages/kernel/src/tools/robot-push.ts`：`parseChannelMentions(prompt)` 纯函数（正则 `/@bot_[a-zA-Z0-9_-]+/g` 提取 @bot_xxx 渠道 ID、去重、不误匹配邮箱）+ `createRobotPushTool(deps)` 工厂（构建 robot_push 工具定义，动态填充 channel enum；execute 校验渠道、调用 pushToChannel、经 onPushResult 回调上报结果）。
- 修改 `packages/kernel/src/channel-manager.ts`：新增 `pushToChannel(botId, message)` 方法——按 credentials.botId 反查 channelId 再取 adapter，主动推送 sendText 的 replyFrame 传 null。
- 新建 `packages/kernel/tests/robot-push.test.ts`：16 个测试覆盖 parseChannelMentions（单/多/去重/邮箱/连字符下划线）、工具定义（name/description/enum/required）、execute（成功/渠道不存在/推送失败）、pushToChannel 集成（replyFrame=null/botId 不存在/渠道未连接）。
- 影响范围：定时任务系统的主动推送能力；纯新增工具 + ChannelManager 新增方法，不改已有业务逻辑。

## 2026-08-14 — feat(scheduler): REST API 路由（CRUD + 立即执行 + 执行记录查询）

### 变更

- 新建 `packages/kernel/src/routes/scheduler.ts`：闭包工厂 `createSchedulerRoutes(tasksFile, recordsFile, onTaskChanged, onTaskDeleted, onRunNow)` 返回 `RouteRegistrar`，注册 6 个端点（GET/POST/PUT/DELETE `/api/scheduled-tasks`、POST `/:id/run`、GET `/api/execution-records`）。直接读写 scheduler-store JSON 文件，不走 callApi 适配器（scheduler 域无 WSClientEvent）。GET records 支持 taskId/status 筛选、startedAt 倒序、最多 200 条。
- 修改 `packages/kernel/src/ws-server.ts`：导入常量与 createSchedulerRoutes；新增 `scheduler: TaskScheduler | null` 属性（后续任务注入实例）；在 `registerRoutes()` 中注册路由，回调使用可选链（`this.scheduler?.`），scheduler 为 null 时 CRUD 仍正常（数据持久化不受影响），仅跳过 cron 同步。清理两个预存未使用导入（AgentName / WA_PI_DIR）。
- 新建 `packages/kernel/tests/routes-scheduler.test.ts`：7 个测试覆盖空列表、完整 CRUD、404、三个回调触发、执行记录筛选/倒序/200 上限。
- 影响范围：定时任务 REST API 层；纯新增路由 + ws-server 注册，不改已有业务逻辑。

## 2026-08-14 — feat(scheduler): 定时任务类型定义 + 数据持久化层 + Bun.cron 调度引擎

### 变更

- 新增定时任务核心类型（ScheduledTask / TaskSchedule / ExecutionRecord / ExecutionStatus / PushResult）于 `packages/shared/src/types.ts`。
- 新增路径常量 `SCHEDULED_TASKS_FILE` / `EXECUTION_RECORDS_FILE` 于 `packages/shared/src/constants.ts`（参照 CHANNELS_FILE 模式，带 WA_PI_DIR 前缀）。
- 新建 `packages/kernel/src/scheduler-store.ts`：JSON 文件读写持久化层（load/save scheduledTasks + executionRecords，appendExecutionRecord），参照 channel-store.ts 的 readJson/writeJson 模式，文件缺失/损坏回退空值不抛错。
- 新建 `packages/kernel/tests/scheduler-store.test.ts`：6 个测试覆盖空文件回退、往返一致、追加记录。
- 新建 `packages/kernel/src/scheduler.ts`：调度引擎。`toCronExpression` 将 TaskSchedule 转标准 5 字段 cron 表达式（`.map(Number)` 归一化前导零）；`TaskScheduler` 类封装 Bun.cron 任务的注册/取消/停止，handler 内捕获执行异常并广播 `scheduled-task:completed` 事件。
- 新建 `packages/kernel/tests/scheduler.test.ts`：14 个测试覆盖 toCronExpression 五种类型 + TaskScheduler 注册/取消/重新调度/批量停止/启动加载/disabled 跳过/执行成功与失败广播。
- 影响范围：定时任务系统基础层与调度引擎（后续任务的地基）；纯新增，不改已有业务逻辑。

## 2026-08-14 — fix(frontend): 任务 7 审查修复（onReconnect 补 loadContacts + titleOf 复用 remarkOf + 补测试）

### 变更

- `App.tsx` 的 `onReconnect` 回调补 `useContactsStore.getState().loadContacts()`，对齐「mount 加载集 == 重连刷新集」不变量，避免 SSE 断线期间 contacts:changed 丢失导致重连后备注名陈旧。
- `ImConversationList.titleOf` 复用 `store/contacts` 的 `remarkOf` 纯函数，删除内联重复的 `.find(...)`。
- 新增 `ImConversationList.test.tsx`，覆盖单聊命中 remark / 群聊命中 remark / 未命中回退三场景。
- 影响范围：App.tsx、ImConversationList.tsx、ImConversationList.test.tsx（新增）。

---

## 2026-08-14 — feat(frontend): IM 会话列表备注名回显 + contacts:changed SSE 刷新

### 变更

- `ImConversationList` 的 `titleOf` 改为备注名优先：单聊按 person(userId=fromUserId)、群聊按 group(chatId=chatId) 查找对应 `ContactEntity` 的 remark，命中则显示备注名，否则回退原逻辑（群聊「群聊(chatId前8)·发送者」/ 单聊 userid）。
- `App.tsx` 启动加载 effect 补 `loadContacts()`（供会话列表回显）；`onMessage` switch 在 `channel-conversations:changed` 后新增 `contacts:changed` case，触发重拉通讯录。
- 影响范围：ImConversationList.tsx（titleOf + import useContactsStore）、App.tsx（启动加载 + SSE case）。

---

## 2026-08-14 — fix(frontend): ContactsPanel 打开时加载通讯录 + 补充备注名优先/失败 toast 测试

### 变更

- `ContactsPanel` 新增 `useEffect`，打开面板（或 channelId 变化）时调用 `loadContacts()`，修复 store 初始为空导致面板恒显示「暂无对话过的人/群」的问题（此前 `loadContacts` 解构后从未调用）。
- `ContactsPanel.test.tsx` 补两个用例：「备注名优先显示（remark 覆盖原始 userId）」与「重命名失败 toast 收到 error 消息」；新增 `useToastStore` 的 `mock.module` 以便断言失败 toast。
- 影响范围：ContactsPanel.tsx（+useEffect）、ContactsPanel.test.tsx（+2 用例 + toast mock）。

---

## 2026-08-14 — feat(frontend): 通讯录滑出面板 + 行内展开重命名 + BotsSection 入口

### 变更

- 新增 `ContactsPanel` 组件：通讯录滑出面板，按 channelId 过滤当前机器人的联系人，分「人/群」两类展示；点击行内展开输入框，保存调用 `renameContact(id, remark)`，失败用 toast 提示。
- `BotsSection` 集成：编辑表单顶部新增「通讯录」按钮（`contactsOpen` state），选中机器人时打开对应面板。
- 新增组件测试 `ContactsPanel.test.tsx`（mock `useContactsStore`，覆盖渲染人/群两类 + 行内展开重命名保存）。
- 影响范围：ContactsPanel.tsx（新增）、BotsSection.tsx（+4 处）、ContactsPanel.test.tsx（新增）。

---

## 2026-08-14 — fix(kernel): contacts:rename 空值保护 + 事件级测试

### 变更

- ws-server `contacts:rename` 去除 `channelManager!` 非空断言：channelManager 为 null 时返回 error + 400「通讯录未启用」，对齐 channels 写操作的空值兜底，避免 `PUT /api/contacts/:id` 在通讯录未启用时 500。
- 新增 ws-server 事件级测试 `ws-server-contacts.test.ts`：覆盖 rename 空值 400 / id 不存在 404 / 成功广播 `contacts:changed` + reply `contacts:current`（且只含该机器人的 contacts）三条路径。
- 影响范围：ws-server.ts（contacts:rename case）、ws-server-contacts.test.ts（新增）。

---

## 2026-08-14 — feat(kernel): 进站采集通讯录 + ChannelManager 暴露 listContacts/renameContact

### 变更

- ChannelManager 进站（handleInbound）采集通讯录：单聊记 person（fromUserId）、群聊记 group（chatId），失败仅 warn 不阻断消息处理。
- deps 新增 `contactsFile` 字段 + `contactsFile` getter（缺省回落 CONTACTS_FILE）。
- 新增公开方法 `listContacts(channelId?)` / `renameContact(id, remark)`，代理 contact-store 的 list/rename。
- 影响范围：channel-manager.ts（+5 处）、channel-manager.test.ts（+1 采集用例，复用 mock deps 构造）。

---

## 2026-08-14 — fix(desktop): 外链子窗口移除 parent，修复 macOS 多屏拖动消失

### 变更

- 外链子窗口（openInChildWindow）创建时移除 `parent: mainWindow`：macOS 上带 parent 的 child window 拖到不同缩放的扩展显示器会消失（Electron #31815，官方 workaround 即移除 parent）。
- 补偿移除 parent 后缺失的 owned-window 跟随行为：新增 `childWindows` 集合追踪所有子窗口，主窗口收起（关闭→隐藏到托盘）时同步隐藏所有子窗口，子窗口关闭时从集合移除。
- 影响范围：main.cjs（openInChildWindow + close 处理器）、web-preferences.test.ts（+2 防回归用例：不再出现 parent、主窗口收起时同步隐藏子窗口）。

---

## 2026-08-14 — feat(frontend): 新建会话页新增右侧文件浏览侧栏

### 变更

- 新建会话页（NewSessionPane）新增右侧文件树侧栏：复用 ExplorerPanel（文件浏览/双击预览/拖拽 @提及），右侧可拖拽宽度（SidebarResizer），主列居中内容与侧栏并排。
- 双入口 toggle：主列右上角 folder 图标开关（未选项目时禁用）+ 侧栏标题栏 › 折叠按钮，与会话页文件树开关行为一致；状态独立持久化（localStorage `wa-pi:new-session-explorer-open/width`），默认收起。
- 侧栏根目录跟随当前选中项目 cwd；未选项目时入口禁用 + 空态兜底。
- 影响范围：NewSessionPane.tsx（布局改造 + 开关/侧栏）、新增 store/new-session-explorer.ts、新增 new-session-explorer.test.tsx（4 用例）。

---

## 2026-08-13 — feat(frontend): 文件预览底部地址栏增加复制按钮

### 变更

- 新增 `PathBar` 组件：文件预览底部地址栏（完整路径 + 复制 icon）。点击复制路径到剪贴板，复用 `copyToClipboard` + toast 反馈（与 CodeBlockCard 一致）。
- 三处接入：代码预览、markdown 预览、unsupported 不支持预览页。unsupported 分支结构调整（外层 flex-col h-full + 内层居中内容 + 底部贴 PathBar），使地址栏贴底全宽。
- unsupported 页操作按钮顺序调整：「关闭」移到最右（用默认应用打开 → 在访达中显示 → 关闭）。
- 影响范围：FileViewer.tsx（新增 PathBar + 三处接入 + unsupported 结构 + 按钮顺序）、FileViewer.test.tsx（+2 复制用例：代码预览复制路径、unsupported 也有复制按钮）。

---

## 2026-08-13 — style(frontend): 「不支持预览/读取失败」空状态页按钮改为无边框幽灵风格

### 变更

- FileViewer 的 unsupported / error 空状态页操作按钮原复用顶栏紧凑 `fv-btn`（24px 工具按钮、细灰边框），在空状态页显丑。新增 `fv-empty-btn` 类：32px 高、圆角 8px、无边框透明底，hover 显浅灰底；三按钮统一无主次（方案 B，用户选定）。
- 顶栏工具栏、会话视图等处的 `fv-btn` 不受影响（仍为紧凑工具按钮）。
- 影响范围：styles.css（新增 `.fv-empty-btn`）、FileViewer.tsx（unsupported 3 按钮 + error 1 按钮换 class）、FileViewer.test.tsx（2 处 className 断言同步更新）。

---

## 2026-08-13 — feat(frontend): 最近视图补齐会话右键菜单（重命名/删除/打开目录）

### 变更

- 「最近」视图的会话行补上与项目视图一致的右键菜单：重命名、删除、打开目录（所有会话均可「在访达/文件管理器中打开」，非系统项目打开项目根目录、系统项目打开会话子目录）。
- 复用 ProjectItem 的 `useClampMenu`（由私有改为导出）做菜单坐标钳制，复用 `project-menu-close` 事件做跨组件菜单互斥。
- RecentSessionsList 增加重命名弹窗（Modal）与删除确认框（ConfirmDialog），删除时同步清理 composer 草稿与会话内存态（removeSessionPrefs + removeSession）。
- 影响范围：RecentSessionsList.tsx、ProjectItem.tsx（导出 useClampMenu），及 RecentSessionsList.test.tsx（新增 5 个右键菜单用例，含 api mock）。

---

## 2026-08-13 — feat(frontend): 侧边栏重构——智能体置顶、最近视图新建入口、项目/最近虚线分段

### 变更

- __布局重排__：侧边栏顶部顺序调整为「智能体折叠项 → 任务|IM 页签」，将智能体折叠项移出页签分支、置于页签控件之上（跨任务/IM 两页签始终可见）。
- __移除独立新建会话按钮__：删除 `NewSessionButton` 组件（含测试），新建会话入口迁入「最近」视图。
- __「最近」视图新建入口__：时间线顶部「今天」刻度改为__始终显示__（即使当天无会话），右侧放「＋ 新建会话」文字入口（右对齐），点击触发 `onNewSession`，与原按钮行为一致。
- __项目/最近虚线分段__：「项目 | 最近」次级分段控件由实心灰底改为虚线边框（`1px dashed var(--hairline-strong)`），中间虚线竖线分割，选中态用文字加粗（无底色），与「任务 | IM」实心分段形成视觉层级区分。
- __i18n__：`recentSessions` 新增 `newSession` 键、精简 `empty` 文案（中英）。
- 影响范围：Sidebar.tsx、RecentSessionsList.tsx、src/util/recentSessions.ts（导出 startOfDay）、i18n locales，删除 NewSessionButton.tsx / NewSessionButton.test.tsx，及对应测试。

---

## 2026-08-13 — feat(frontend): 侧边栏会话列表位置动画（最近视图 + 项目视图）

### 变更

- 引入 `@formkit/auto-animate`：侧边栏会话重排时播放位置过渡动画（250ms ease-out），替代 DOM 瞬间换位的「闪一下」。默认禁用，仅在用户点击触发的重排时启用（后台 SSE 推送不动画）。
- __「最近」时间线__：点击会话触发重排时动画；日期刻度提升为动画容器直接子元素（稳定 key），避免刻度在重排时瞬移闪烁。
- __项目视图__：重排时机从「折叠→展开」改为「点击项目名」（含折叠时点击展开、已展开时点击选中），点击会话仍保持稳定顺序不重排；提取 `orderSessions` 纯函数（稳定顺序 + 新会话插入 + 强制重排）。
- 清理 `agentList` 死 i18n 键（折叠后仅保留 sectionTitle）。
- 影响范围：RecentSessionsList.tsx、ProjectItem.tsx、src/util/projectOrder.ts、SessionRow.tsx、i18n locales，及对应测试。

---

## 2026-08-13 — fix(frontend): 新建页选模型发送后会话界面显示旧模型（existed 分支模型丢失）

### 变更

- __问题__：在新建会话界面选了模型 A，发送消息跳转到会话界面后，会话界面的模型选择器显示的是上一次使用的模型 B（而非 A），但实际发送请求用的却是 A。
- __根因__：`NewSessionPane` 选模型时通过 `setSessionPrefs(草稿id, { model })` 把模型写入草稿 sessionId。发送时若草稿 id 残留了一个已发送过的会话 id（`existed` 分支触发），`finalId` 会分叉成全新随机 id，模型 A 留在 `bySession[草稿id]` 下；而详情页 `Composer` 读的是 `bySession[finalId]`（为空），只能回退到全局 `defaults.model`——一旦 defaults 是上一次的模型 B，就会显示 B。
- __修复__：`handleSend` 发送时在 `setDefaults` 之后，把用户选的模型显式落到 `finalId` 的会话级 prefs（`setSessionPrefs(finalId, { model })`），消除对 defaults 回退的依赖，确保详情页直接读到 A。
- __影响范围__：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`（新增 existed 分支回归测试）。

---

## 2026-08-13 — fix(desktop): 换端口启动按钮两个 bug——端口未切换 + 按钮并排

### 变更

- __Bug 1（换端口未生效）__：`app.relaunch({ env })` 在 Windows 上环境变量替换不可靠，新进程仍读到旧端口。修复：改用命令行参数 `--wa-pi-port=<port>` 传递新端口（env 双保险），`FIXED_PORT` 解析优先级改为 `--wa-pi-port 参数 > WA_PI_WS_PORT env > 默认 9778`；重复 relaunch 时先过滤旧参数避免残留旧值。
- __Bug 2（按钮并排）__：错误态两个按钮在 flex column 容器里仍可能横向排列。修复：包 `.actions` flex column 容器 + `gap:10px` 明确上下排列。
- __测试__：port-switch.test.ts 新增 4 个（resolveFixedPort 参数/env/默认/重复过滤），splash-html 回归通过；全套 146 pass（2 fail 为预先存在的打包签名测试）。

## 2026-08-13 — feat(desktop): 端口自愈失败时提供「换端口启动」+「退出」选项

### 变更

- __问题__：启动时固定端口 9778 被占用且自动清理失效时，splash 错误态只有「重启应用」按钮；若清理后仍被占用（幽灵句柄），用户无任何操作途径（splash 无边框、无标题栏，只能任务管理器强杀）。
- __方案__：把「重启应用」替换为「换端口启动」（从 9778 下一个端口找可用端口，relaunch 带 WA_PI_WS_PORT 环境变量），并新增「退出」按钮。
- __改动__：
  - 新增 `util/splash-html.cjs`：启动页 HTML 生成提取为纯函数（buildSplashHTML），错误态按钮改为 switch-port-btn + quit-btn，__showRestart 替换为__showActions({switchPort, quit})
  - 新增 `util/port-switch.cjs`：pickSwitchPort（从 basePort+1 找可用端口，纯函数）
  - `main.cjs`：buildSplashURL 改用 buildSplashHTML；新增 ipc handler `app:switch-port-start`（findAvailablePort + relaunch 带 env）与 `app:quit`；selfHealFailed 与 restart-after-port-kill 清理后仍占用分支均显示换端口/退出按钮
  - `preload.cjs`：waPiApp 新增 switchPortStart / quit
  - 前端零改动（同源相对路径，换端口后 loadURL 指向新端口即可）
- __注意__：换端口后 IndexedDB origin 改变，跨 origin 数据不可见（沿用原有固定端口注释的说明）。
- __测试__：splash-html.test.ts 6 个（按钮存在性/替换语义/__showActions/点击绑定）+ port-switch.test.ts 2 个（从 basePort+1 找端口/找不到返回 null），全通过；startup-heal / port.cjs 回归 18 个通过。

## 2026-08-13 — feat(desktop): 首启按需下载 Node.js 运行时，解决无 node 环境 MCP npx 报错

### 变更

- __问题__：打包版只捆绑 bun（wa-pi-kernel.exe），从不捆绑 node。用户未安装 node 时，MCP 服务器通过 `npx -y <package>` 启动会报错（`"node" is not recognized` / npx-resolver 30s 卡顿 / POSIX shim 无法执行等）——MCP 服务器是第三方进程，其内部对 node 运行时的依赖无法通过 bun 兼容性兜底解决。
- __方案__：首启时检测系统 node，无系统 node 则自动下载 Node.js LTS（v22.23.2）到 `~/.pi/agent/node/`。通过 IP 地理位置检测（api.country.is）自动选择下载源：国内用户优先 npmmirror，国外用户优先 nodejs.org。下载的 node 自带完整 npm/npx。
- __改动__：
  - 新增 `packages/desktop/src/util/node-runtime.cjs`：IP 检测（detectIsCN）+ 下载源选择 + node LTS 下载/解压/版本管理（ensureNodeRuntime）
  - `main.cjs` 启动流程新增 2b+) 步骤：在首启依赖安装（2c）前检测/下载 node，splash 显示进度
  - `ensureRuntimeBinLinks` 改造：有真实 node 时 binDir 只生成 bun.cmd（避免 bun x 包装脚本遮蔽 node 自带的 npm/npx），node/npm/npx 由下载的 node 目录自带，PATH 追加 binDir + nodeDir
  - 无 node（下载失败）时保持现有 bun fallback 行为不变
- __影响范围__：`packages/desktop/src/util/node-runtime.cjs`（新增）、`packages/desktop/src/main.cjs`（ensureRuntimeBinLinks + 启动流程）
- __验证__：单元测试 21/21 + E2E 2/2 全通过——IP 检测 CN → npmmirror 下载 34MB → 解压 → node v22.23.2 / npm 10.9.8 / npx 10.9.8 全部可用；端到端 `npx -y @modelcontextprotocol/server-filesystem` 成功启动

## 2026-08-13 — fix(kernel): RPC 模式 custom() 挂根治——bridge 扩展 session_start patch

### 变更

- __问题__：输入 `/mcp`（或任何调用 `ctx.ui.custom()` 的扩展命令）后 pi 进程永久挂起——不回 response、不发事件，wa-pi 无限等待直到 60s RPC 超时。此问题影响所有用 custom() 全屏面板的插件，非 pi-mcp-adapter 个例。
- __根因__：pi RPC 模式的 `ctx.ui.custom()` 原生实现返回 `undefined` 且不调用 factory 回调。扩展命令 handler（如 openMcpPanel）在 `await new Promise(resolve => ctx.ui.custom(factory))` 中永久挂起。
- __修复__：wa-pi-bridge 扩展在 `session_start`（bindExtensions 设好共享 uiContext 之后触发）时，将 `uiContext.custom()` 替换为__先 notify 再同步抛出__。效果链：
  - `custom()` 调用时先 `ui.notify(msg, "warning")` → 前端 extension_notify 已对接：__聊天窗口中间居中显示，30s 后自动消失__
  - 再同步 `throw` → handler throws → `_tryExecuteExtensionCommand` catch → `extension_error` 事件（补充提示）
  - 同时 `preflightResult(true)` 正常触发 → prompt 成功返回
  - `session_start` 在每次 bindExtensions（启动/new_session/switch_session/reload）后都触发，patch 自动重应用
- __设计原则__：零超时（同步 throw，ms 级反馈）、零白名单（覆盖所有插件的 custom() 调用）、零第三方源码修改（仅 wa-pi 自有 bridge 扩展运行时 patch）。
- 影响范围：packages/kernel/src/wa-pi-bridge.extension.ts、packages/kernel/tests/bridge-extension.test.ts。

## 2026-08-12 — fix(frontend): 文件浏览器暗色模式适配

### 变更

- __ExplorerPanel / 公共按钮 fv-btn / token 胶囊__：迁移悬空 CSS 变量（`--bg-secondary`/`--bg-tertiary`/`--border` → `--surface-hover`/`--surface-elevated`/`--hairline`/`--accent`）。此前这些变量从未定义，hover 背景、按钮边框在浅色和暗色下都实际失效；迁移后恢复生效并跟随主题。
- __DirTreePicker（选目录弹窗）__：移除硬编码颜色（面板 `#FFFFFF`、按钮 `#1D1D1F` → `bg-surface`/`bg-brand text-white` 主按钮范式）；清理旧 Tailwind 死类（`text-text`/`bg-surface0`/`border-surface0`/`text-subtext`/`text-blue`/`border-blue`/`border-t-blue` → `text-primary`/`bg-surface-elevated`/`border-hairline`/`text-secondary`/`text-brand`）；第三方树组件 react-complex-tree 的选中/悬停/选中竖条改用项目 token（自动跟随深浅色与 6 色主题），并覆盖库内层 button 背景为透明，暗色下选中态统一为品牌软背景。
- __FilePicker（附件文件选择器，对话界面 📎）__：同 DirTreePicker 修复集——移除硬编码颜色（面板/确定按钮）、清理死类、TREE_STYLES 改用项目 token + 覆盖库选中 button 层（修复暗色下选中目录「亮灰底 + 白字不可读」）、复选框 `accent-blue` → `accent-brand` 跟随主题色。
- __验证__：新增 DirTreePicker（6 用例）与 ExplorerPanel（3 用例）组件测试；单测全量回归 927 pass；typecheck 通过；E2E 60 pass（15 个既有失败与本次改动无关）；dev 环境浅色/暗色 computed style 逐项验证 token 生效。
- 影响范围：packages/frontend/src/styles.css、packages/frontend/src/components/DirTreePicker.tsx、packages/frontend/src/components/DirTreePicker.test.tsx、packages/frontend/src/components/ExplorerPanel.test.tsx、packages/frontend/src/components/ui/FilePicker.tsx。

## 2026-08-12 — feat(frontend/kernel): 文件不支持预览时新增「默认方式打开」按钮（系统默认应用打开文件）

### 变更

- __需求__：文件预览器不支持预览时，在「在访达中打开」旁新增「默认方式打开」按钮，点击后用系统默认应用打开文件本身（等同双击）。
- __实现__：
  - kernel `routes/fs.ts` 新增 `POST /api/fs/open-with-default-app`（expandTilde + ENOENT 回退搜索，与 reveal-file 一致；打开文件本身而非目录）；提取 `defaultOpenCommand`（mac open / win start / linux xdg-open）。
  - 安全修复：`spawnOpen` 替代 `spawn(..., { shell: true })`——参数数组传递不经 shell（用户路径含特殊字符无注入风险），Windows `start` 经 `cmd /c` 调用；reveal-file 同步收敛。
  - 前端 `fs-client.ts` 新增 `openFileWithDefaultApp`；`FileViewer.tsx` unsupported 分支新增按钮（testid `fv-open-default`）；i18n `common.openWithDefaultApp`（zh 默认方式打开 / en Open with Default App）。
- __验证__：TDD 三红灯（kernel defaultOpenCommand、fs-client 请求、FileViewer 按钮）→ 绿灯；真实 HTTP 路由验证（缺 path 400、不存在 ENOENT，不触发真实 open）；typecheck 通过；前端全量 1415 测试（顺带修复 VersionTimeline 测试断言数据过期，pre-existing）。
- 影响范围：packages/kernel/src/routes/fs.ts、packages/frontend/src/{fs-client.ts,components/blocks/FileViewer.tsx,i18n/locales/{zh,en}.ts} 及对应测试。

## 2026-08-12 — fix(frontend): 系统设置>文字大小不生效于聊天窗口 markdown 正文（.prose-sm 固定字号覆盖）

### 变更

- __根因__：设置值写入 localStorage（wa-pi-ui-prefs）与 CSS 变量 `--font-scale` 更新均正常，但聊天窗口 assistant 消息正文走 `@tailwindcss/typography` 的 `.prose-sm`，插件声明固定 `font-size: .875rem`（不引用 `--font-scale`），覆盖了外层气泡的缩放字号。用户消息气泡/输入框均正常，唯独 markdown 正文不跟随。
- __修复__：styles.css「文字大小缩放」区新增 `.prose-sm { font-size: calc(0.875rem * var(--font-scale)); }`（layer 外、后出现，覆盖插件规则）。只覆盖 `.prose-sm` 不动 `.prose` 基类——TextBlock（ask 预览，prose 无 prose-sm）靠 `.text-sm` 覆盖缩放，避免字号从 14px 变 16px。
- __影响面__：聊天窗口 markdown 正文、文件预览器、回收站查看器、导出图片（prose-sm 均跟随）；TextBlock/输入框不受影响。
- __验证__：TDD——新增 styles-font-scale.test.ts 字符串断言（修复前红）；前端全量 1328 pass / 0 fail；vite build 产物确认覆盖规则位于插件规则之后（层叠胜出）；happy-dom 层叠验证 `--font-scale=1.25` 时字号计算为 `calc(.875rem * 1.25)`。
- 影响范围：packages/frontend/src/styles.css、tests/styles-font-scale.test.ts。

## 2026-08-12 — feat(desktop): 外链子窗口加地址栏（显示/复制/修改地址后导航）

### 变更

- __背景__：外链在应用内新窗口打开后，用户无法看到当前地址、无法复制或修改跳转。
- __实现__（packages/desktop）：
  - 新增 `src/assets/link-window.html` 地址栏壳页面：地址输入框（回车/前往导航）、复制按钮（waPiClipboard）、导航结果回显；用户编辑过地址后不再被导航覆盖（edited 标记）。
  - `main.cjs` 的 `openInChildWindow` 改为 BrowserWindow 壳（加载地址栏 HTML，挂 preload）+ `WebContentsView` 承载网页内容（sandbox 开启、不挂 preload，外部内容保持隔离）；resize 时同步内容区 bounds；`did-navigate`/`did-navigate-in-page` → 地址栏回显；IPC `linkwin:load/ready/url-changed`，多子窗口并发按 sender 隔离；`normalizeUrl` 补协议并只放行 http/https（防 javascript:/file: 注入）。
  - `preload.cjs` 新增 `waPiLinkWin`（load/ready/onUrlChanged）。
- __验证__：桌面测试 116 pass（新增 3 个字符串断言：WebContentsView 隔离、壳+view 结构、地址栏页面交互；剩余 1 个 mac-sign 失败为既有问题）；Electron 冒烟实测全链路——初始加载同步地址、地址栏输入 → IPC → 内容导航 → 地址回显。
- 影响范围：packages/desktop/src/{main.cjs,preload.cjs,assets/link-window.html}、tests/web-preferences.test.ts。

## 2026-08-12 — fix(desktop): 外链在应用内新窗口打开；localhost 服务链接不再被拦截；子窗口统一安全配置

### 变更

- __根因__：Electron 主进程 `setWindowOpenHandler` 用 `isSelfUrl` 拦截了所有 localhost 链接，用户/agent 提供的本地服务链接（如视觉伴侣页面 `http://localhost:53213/...`）点击后被 deny、无反应；外链打开方式与产品预期不符。
- __修复__（packages/desktop/src/main.cjs）：
  - `target=_blank` / `window.open` 不再按 isSelfUrl 拦截，一律在应用内新窗口（BrowserWindow 子窗口）打开；`will-navigate` 保留 isSelfUrl 防御（无 target 导航被应用自身地址劫持时阻止，FileViewer 相对路径仍由前端拦截）。
  - 子窗口 webPreferences 补齐 `sandbox: false` + `preload`（与 splash/main 统一，修复 web-preferences 既有断言失败）。
  - 顺带清理 `ensureRuntimeBinLinks` 未使用的 runtimeDir/seedDir 参数。
- __验证__：桌面测试 114 pass（剩余 1 个 mac-sign 失败为既有问题，原实现即失败）；前端 tests/blocks + FileViewer 66 pass / 0 fail；main.cjs `node --check` 通过。
- 影响范围：packages/desktop/src/main.cjs、packages/desktop/tests/web-preferences.test.ts、packages/frontend/src/components/blocks/FileViewer.tsx（注释）。

## 2026-08-12 — fix(frontend): 主回复中反引号包裹的裸 URL 渲染为可点击链接；顺带统一 agent 消息纯文本位置的 URL 链接化

### 变更

- __根因__：主回复走 ReactMarkdown + remark-gfm，autolink 不解析行内代码（code 构造）内的文本；而 `createMarkdownComponents` 的 code 分支只处理 FilePill、其余原样渲染 `<code>`。AI 习惯用反引号包裹 URL（如 `` `http://localhost:53213/?key=...` ``），导致这类链接不可点击。
- __修复__：markdown-components.tsx 的 code 分支新增 `isLinkText`（trim 后整体匹配 `^https?://\S+$`，协议白名单防 javascript: 注入），行内代码内容是裸 http/https URL 时渲染为 MarkdownLink（新标签页 + 蓝色下划线）。
- __顺带__：新建 `blocks/linkify.tsx`（轻量 URL 链接化，不跑完整 markdown 管线），应用于 agent 消息中不走 ReactMarkdown 的纯文本位置——StreamingOutput 流式预览、ThinkingCard、ToolCallCard 工具结果；AskFormCard 选项 preview 补 remarkGfm（裸 URL 自动链接）。
- __验证__：TDD——新增 markdown-links 反引号 URL 用例（修复前失败）、linkify 8 用例、StreamingOutput 流式 URL 用例、AskFormCard 裸 URL 用例；tests/blocks 56 pass / 0 fail。
- 影响范围：packages/frontend/src/components/blocks/{markdown-components,linkify,StreamingOutput,ThinkingCard,ToolCallCard}.tsx、components/ask/AskFormCard.tsx，及对应测试。

## 2026-08-12

### 新增

- 侧边栏「任务」视图内新增「项目 | 最近」分段切换：「最近」按时间线汇总全部项目会话（按天刻度分组、标注项目名、上限 100 条、点击后停留在最近视图）
- 智能体列表折叠为一行「智能体 n ›」，点击打开智能体宫格弹窗
- `SessionRow` 支持可选 `subtitle` 次级标注

## 2026-08-12 — fix(frontend): AskQuickBar 滚轮横向滚动改用原生 passive:false 绑定，消除 preventDefault 警告

### 变更

- __根因__：AskQuickBar 选项区用 React 合成 `onWheel` 调 `e.preventDefault()` 阻止页面纵向滚动。React 的 wheel 监听器注册为 passive，preventDefault 无效且控制台报 `Unable to preventDefault inside passive event listener invocation`——实际拦不住页面滚动。
- __修复__：改为 `useEffect` 中原生 `addEventListener("wheel", handler, { passive: false })`（与 MermaidBlock/FileViewer 滚轮缩放一致），preventDefault 生效，页面纵向滚动被拦截、选项区横向滚动。
- __验证__：TDD——新增测试验证 wheel 用原生绑定且非 passive（happy-dom 把 `{passive:false}` 规范化为布尔 false，断言兼容）；AskQuickBar 15 pass / AskDock+AskFormCard 25 pass / typecheck 无错误。
- 影响范围：packages/frontend/src/components/ask/AskQuickBar.tsx。

## 2026-08-12 — feat(ask): 便签选项区支持鼠标滚轮横向滚动

### 变更

- __新增__：单行便签（AskQuickBar）选项区监听滚轮——纵向 `deltaY` 转换为横向滚动（向下滚向右、向上滚向左），并阻止页面纵向滚动；无溢出时不拦截。
- 影响范围：packages/frontend（AskQuickBar / 对应测试）。

## 2026-08-12 — fix(ask): 便签左右滚动按钮边界置灰（到最左「<」灰、到最右「>」灰）

### 变更

- __改进__：单行便签（AskQuickBar）左右「<」「>」滚动按钮——仅选项溢出时显示；滚动到最左时「<」置灰、最右时「>」置灰（`disabled` + 降透明度），边界不可继续滚动。
- 影响范围：packages/frontend（AskQuickBar / 对应测试）。

## 2026-08-12 — feat(ask): 便签改「左右 < > 滚动按钮」+ 文案简化为「需要回答：」

### 变更

- __改进__：单行便签（AskQuickBar）去掉 overlay 滚动条指示器；选项溢出时左右显示「<」「>」按钮，点击向左/向右滚动。
- __简化__：便签提示从「徽标数字 + Agent 有 N 个问题待回答」简化为「需要回答：」直接跟选项（i18n `ask.stickyShort`）。
- 影响范围：packages/frontend（AskQuickBar / i18n zh-en / 对应测试）。

## 2026-08-12 — fix(ask): 便签横向滚动条改为隐藏式（不占空间，chip 不被顶起）

### 变更

- __修复__：单行便签（AskQuickBar）选项区改用 `scrollbar-none` 隐藏原生滚动条（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`）——不占布局空间、chip 完全垂直居中，滚动能力保留（触摸板/滚轮/拖拽）。便签高度 42px。
- 影响范围：packages/frontend（AskQuickBar / styles.css / 对应测试）。

## 2026-08-12 — fix(ask): 便签态横向滚动条不再挤压 chip（增高 + 自定义细滚动条）

### 变更

- __修复__：单行便签（AskQuickBar）高度从 34px 增至 42px，容纳横向滚动条；选项区增加 `scrollbar-thin` 自定义细滚动条样式（4px 胶囊 + 底部留白），chip 垂直居中不被顶起。
- 影响范围：packages/frontend（AskQuickBar / styles.css / 对应测试）。

## 2026-08-12 — fix(ask): Ask 弹窗收起入口移入卡片 footer + 弹窗限高防顶部溢出

### 变更

- __修复__：收起弹窗回便签的入口从弹窗底部独立小按钮移到 AskFormCard footer「取消 / 提交」行最左侧（语义清晰、不易漏）。
- __移除__：AskFormCard 右上角 ✕（终止提问）按钮——取消统一走 footer「取消」，避免误触把提问终止掉。
- __修复__：展开弹窗限高 `max-h-[calc(100vh-160px)]` + 内部滚动，底边紧贴输入框上方（间距 0）；多 ask/多问题堆叠时顶部不再超出视口（此前双 ask 顶部溢出 57px），聊天上部历史消息始终可见。
- 影响范围：packages/frontend（AskDock / AskFormCard / 对应测试）。

## 2026-08-12 — feat(ask): Ask 弹窗改「折叠便签 + 悬浮展开」+ 侧边栏 pending ask 问号

### 变更

- __新增__：Ask 弹窗（AskDock）改为双态——首次默认展开为悬浮弹窗（absolute 浮层，不再挤压消息列表/聊天输出）；可收起为单行便签（AskQuickBar，内嵌全部问题的快捷选项 + 提交 icon，选项多时横向滚动）。展开/折叠状态全局持久化到 localStorage（`wa-pi:ask-dock-expanded`），重进会话恢复上次状态。
- __新增__：`buildQuickReply` 纯函数（store/ask.ts）——便签快捷选择 → 完整 AskReply（后端契约：一次提交整个 toolCallId 的全部问题）。
- __新增__：`AskFormCard` 支持 `initialSelected` 预选 prop（便签选中的选项展开后自动带过去）。
- __改进__：侧边栏会话行（SessionRow）pending ask 时显示问号 icon（替代误导的「运行中」spinner）；真正 thinking 仍显示 spinner。
- 影响范围：packages/frontend（AskDock / AskQuickBar / AskFormCard / SessionRow / Icon / store/ask / i18n）。

## 2026-08-12 — fix(frontend): thinking 生命周期职责分离——SessionView mount 不清除 thinking，回退 optimisticEcho/force 补丁

### 变更

- __根因__：`setActiveStatus(sessionId, false)` 被 SessionView mount 和 onReconnect 两个调用点共用，但语义完全不同——mount 是「查询」（isActive=false 不该清除乐观 thinking），reconnect 是「权威对齐」（isActive=false 该清除残留）。之前用 optimisticEcho 保护 + force 参数区分，本质是在错误层面打补丁。
- __修复__：SessionView useEffect 中 isActive=false 时不调 setActiveStatus（不干预 thinking）。thinking 的清除完全由 SDK 事件（agent_end / failTurn / agent_settled）驱动；onReconnect 的 setActiveStatus(false) 负责重连/重启的权威复位。职责分离，不再需要 optimisticEcho 保护 / force 参数。
- __回退__：撤回 fc7b1498 对 session.ts（optimisticEcho 保护 + force + auto_retry_end/agent_settled 清标记）和 App.tsx（force=true）的改动，恢复到 78d76310 的 setActiveStatus 原始逻辑。
- __验证__：TDD——先写 3 个失败的测试（isActive=false 不清除乐观 thinking / isActive=true 补设 / 打开历史会话不新增状态），改 SessionView.tsx 后全部通过。SessionView 34 pass / store-session 78 pass / typecheck 无错误。kernel 侧 isSessionActive 收窄（78d76310）保持不变。
- 影响范围：packages/frontend/src/components/SessionView.tsx。

## 2026-08-12 — fix(kernel+frontend): 右上角 token 统计口径修复——累计含缓存与压缩前历史，进度条改当前上下文占用

### 变更

- __背景__：右上角「累计 xxx k」本应统计整个会话累计消耗，实际只累加可见消息的 input+output：漏掉 cacheRead/cacheWrite（长会话缓存命中占大头）、compaction 压缩后丢失压缩前历史，且进度条误用「累计值 / 模型 contextWindow」当窗口占用。
- __修复__：引入 pi 官方 `get_session_stats`（全会话累计 tokens + 当前上下文占用 contextUsage），进程存活时优先；无进程降级本地全量扫 jsonl（不做压缩过滤/分支过滤，含缓存与压缩前历史）。前端分三态展示：累计胶囊 = 全量 total（含主/子代理拆分）、进度条 = contextUsage.used/total、进度条旁新增「占用 xxx k」当前窗口数值。
- __链路__：kernel `session-history.ts` 新增 `computeSessionUsage` + agent-manager `getSessionStats` + ws-server `session:stats` case + REST `GET /api/sessions/:id/stats`；前端 store `tokenTotals` 扩展 cacheRead/cacheWrite/total/main/subagent + `contextUsageBySession`，`seedTokenTotal` 优先 stats；SessionView 渲染更新。
- __验证__：session-history 29 pass（含 computeSessionUsage 3 测试）、store-session 81 pass、SessionView 31 pass。
- 影响范围：packages/kernel/src/session-history.ts、agent-manager.ts、ws-server.ts、routes/projects-sessions.ts、packages/shared/src/types.ts、packages/frontend/src/store/session.ts、components/SessionView.tsx。

## 2026-08-12 — fix(frontend): 新建会话发送后「正在思考」闪退回归——乐观回显窗口内 isActive=false 不复位 thinking

### 变更

- __背景__：上一提交把 `GET /messages` 的 `isActive` 收窄为「handle.busy 或冷启动+prompt 排队」，修复了打开历史会话误标 thinking 转圈；但新建会话发送消息时出现新回归：发送后 thinking 先出现又消失，直到 agent 开始输出才恢复。根因：新建会话时前端 ComposerInput mount 发 `GET /commands` 与 `POST /prompt` 并发，若 commands 先到 kernel 触发冷启动（`starting.has(sid)=true`）而 `_promptLocks` 尚未命中（prompt 还在路上），随后 GET /messages 返回 `isActive=false`；而 SSE 通道的 echo_user 已先到前端设置乐观 thinking + `optimisticEcho=true`。setActiveStatus(false) 照常复位，把乐观 thinking 清掉。
- __修复__：`session.ts` 的 `setActiveStatus` 增加保护——`optimisticEchoBySession[sessionId]` 为 true（用户刚发消息、等待 SDK 回显）时，`isActive=false` 不清除 thinking。回显到达（message_start user 回显 / agent_end / failTurn）清除标记后，复位逻辑恢复。kernel 侧与前端信号各司其职：kernel 判断会话是否真在处理，前端判断自己是否刚发消息。
- __验证__：store-session.test.ts 新增 2 个回归测试（乐观回显窗口内不清除 / 历史会话无标记仍正常复位）；store-session 80 pass / SessionView 13 pass / kernel 107 pass。
- 影响范围：packages/frontend/src/store/session.ts。

## 2026-08-12 — fix(kernel): 修复打开历史会话误标「正在思考」一直转圈（isSessionBusy 冷启动一刀切回归）

### 变更

- __背景__：08-11 提交 da7acb15 为修复新建会话「正在思考」闪退，把 `isSessionBusy` 改为冷启动期间（`starting.has(sessionId)`）返回 true。但 `starting` 集合被多种场景共用：打开历史会话时前端 ComposerInput 自动拉 `/commands`（getCommands）与 `session:messages` 的 prewarm 也会触发 `ensureStarted` 冷启动。冷启动期间到达的 GET /messages 因此返回 `isActive=true`，前端 `setActiveStatus(true)` 把 idle 历史会话误标 thinking；冷启动完成后仅广播 `session:activated`（只刷 token 统计），无 agent 事件复位 → 会话列表项永久转圈。
- __修复__：`GET /messages` 的 `isActive` 判定收窄为「真正在处理中（handle.busy）或冷启动中且 prompt 排队（`agent:prompt` 的 `_promptLocks` 命中）」：
  - `agent-manager.ts`：`isSessionBusy` 恢复只查 `handle.busy`；新增 `isSessionActive(sessionId, promptQueued)` 组合判定
  - `ws-server.ts`：`session:messages` 改用 `isSessionActive(sessionId, this._promptLocks.has(sessionId))`——`_promptLocks` 在 agent:prompt 处理时同步 set、冷启动在锁内执行，天然是「prompt 排队中」的精确信号
- __验证__：agent-manager.test.ts 新增/更新 2 个测试（prompt 冷启动 true / 预热冷启动 false）+ ws-server 集成测试验证 `_promptLocks` → `isActive` 传递链路；相关测试文件 60 pass / agent-manager 100 pass / 前端 store 78 pass。
- 影响范围：packages/kernel/src/agent-manager.ts、packages/kernel/src/ws-server.ts。

## 2026-08-11 — fix(kernel): pi rpc 子进程改用 Bun.spawn，避免 Windows 上子进程继承 kernel 监听端口句柄

### 变更

- __背景__：Windows 上 kernel（wa-pi-kernel.exe）被强杀/退出后，9778 端口仍以「死 PID 占 LISTENING」的幽灵形态残留，新实例自动清理失败（taskkill 退出码 128「找不到进程」）。根因：`rpc-client.ts` 用 `node:child_process.spawn`（CreateProcess bInheritHandles=TRUE）启动 pi rpc 子进程，Bun.serve 的监听 socket 句柄可继承（见 port.cjs 幽灵占用注释）——kernel 被杀后，仍存活的 pi 子进程/孙进程（bash 等）继续持有 9778 句柄，netstat 却显示已死的创建者 PID。
- __修改__：`packages/kernel/src/rpc-client.ts` 默认 spawn 实现从 `node:child_process.spawn` 改为 `Bun.spawn`（Windows 上只经 HANDLE_LIST 传递 stdio 句柄）：
  - 移除 spawn/exit/error 事件监听，改用 `Subprocess.exited` Promise + 同步 `signalCode`/`exitCode`
  - stdout/stderr 用 `Readable.fromWeb` 转回 Node 流，复用既有 strict JSONL 切分逻辑
  - spawn 同步失败（ENOENT）直接 throw，语义与旧 error 事件一致
  - stdin 写入适配 FileSink（pipe 时即时送达，无需显式 flush）
- __验证__：rpc-client.test.ts 17/17 pass（含真实 pi --mode rpc 集成）；kernel 全量 411 pass/0 fail。
- 影响范围：packages/kernel/src/rpc-client.ts。

## 2026-08-11 — revert(frontend): 移除 llm-ui 流式渲染回退自实现 MarkdownBlock，彻底解决内存溢出

### 变更

- __根因__：`@llm-ui/react` 0.13.3 的 `useLLMOutput` 有 rAF 渲染循环 cleanup bug——useEffect 返回的箭头函数缺 `return`，`cancelAnimationFrame` 从不执行，组件卸载后循环继续运行。长 AI 回复流式渲染期间，每帧 `matchesToOutput().join("")` 创建完整文本副本，被 V8 Context/scope 持久持有。内存快照实测：同一 15.7KB 回复文本被复制 41,276 份，744MB 字符串无法 GC，堆在 7.7 分钟内线性增长到 1426MB。
- __回退__：移除 llm-ui 流式渲染，流式 text 段恒走自实现 `MarkdownBlock`（ReactMarkdown 直接渲染，与定稿同路径）：
  - 删除 `StreamingMarkdown.tsx`、`streaming-code-block.tsx`、`streaming-visible-cache.ts` 及其测试（6 个）
  - `MessageList.tsx` renderSeg text 分支不再按 segIsStreaming 分发
  - `session.ts` 移除 `clearStreamingVisibleCache` 调用
  - package.json 移除 `@llm-ui/react|markdown|code` 依赖与 patch
  - 保留此前 4 项低成本优化（batcher 合帧 / kernel 节流 / 子代理卡片降级 / virtuoso 虚拟化）与 messagesBySession 内存修复（removeSession）
- __验证__：全量前端测试 1368 pass/0 fail；Node 内存压力测试（真实 ReactMarkdown 渲染 150 次、文本增长模拟流式）末轮堆增量仅 1.18MB，无线性泄漏；真实 Chromium 浏览器基线测试应用加载后空闲 6 秒 JS 堆零增长（40.1→40.1MB）——llm-ui 时代同类场景会出现 GB 级累积。
- 影响范围：packages/frontend/src/components/MessageList.tsx、src/components/blocks/（删 StreamingMarkdown/streaming-code-block）、src/store/session.ts、package.json、patches/（移除 @llm-ui patch）。

## 2026-08-11 — fix(frontend): 导出/复制图片时部分 mermaid UML 图文字变白（SVG <style> 颜色导出丢失）

### 变更

- __根因__：html-to-image 对 SVG 直接 cloneNode、不内联样式。mermaid label 文字颜色由 SVG 内 `<style>`（`.label{color:#333}`）提供，SVG-as-image 渲染时该颜色丢失 → 下载/复制的 PNG 里 foreignObject label 文字变白（界面 DOM 渲染正常显黑）。部分图正常是因 label 用 SVG `text` 元素（fill 由 style 继承仍生效），用 foreignObject div 的图（flowchart/class/state/er 等）白字。
- __修复__：`renderTurnsToPngBlob` 导出前对 mermaid svg（`[data-testid="mermaid-svg"] svg`）做字符串层颜色内联——给 foreignObject 内 div/span/p 加十六进制 `color:#333333;fill:#333333`，DOMParser 解析 + 节点替换（避免 innerHTML/outerHTML 写入）。真实浏览器验证：字符串解析路径内联的颜色才会被 SVG-as-image 渲染尊重，DOM API 写同样值无效（Chromium 对 foreignObject 内 HTML 样式快照行为）。
- 验证：TDD 先写失败测试（fixMermaidLabelColors 未实现）→ 修复后 13 pass；相关套件（ExportButton/ExportImageCard/MermaidBlock/markdown-mermaid/旧 collectTurns）共 42 pass；`tsc --noEmit` 通过；真实 Chromium + 真实 mermaid + html-to-image 像素分析：修复后深色文字像素 0.4%→2.2%，节点填充色保留。
- 影响范围：packages/frontend/src/util/export-chat-image.ts（新增 fixMermaidLabelColors + inlineMermaidLabelColors，toBlob 前调用）、export-chat-image.test.ts（新增白字回归测试 + mermaid mock 含 foreignObject）。

## 2026-08-11 — fix(frontend): 导出/复制图片时 mermaid UML 图未渲染完成（截到 loading 占位）

### 变更

- __根因__：`renderTurnsToPngBlob`（export-chat-image.ts）屏外渲染 ExportImageCard 后只等 React 提交 + 字体加载，未等待 mermaid 异步渲染（MermaidBlock 有 1000ms 防抖 + render Promise）。`toBlob` 截屏时 UML 图还是 `mermaid-loading` 占位，下载/复制的 PNG 里图是「渲染中」。
- __修复__：toBlob 前轮询等待卡片内 `mermaid-loading` 占位消失（成功→mermaid-svg / 失败→mermaid-error，均离开占位），10s 超时兑底防死等；无 mermaid 时零额外延迟。
- 验证：TDD 先写失败测试复现（toBlob 时 DOM 仍是 mermaid-loading）→ 修复后 12 pass；相关套件（ExportButton/ExportImageCard/MermaidBlock/markdown-mermaid/旧 collectTurns）共 37 pass；`tsc --noEmit` 通过；真实 Chromium + 真实 mermaid + html-to-image 验证导出 PNG 含渲染完整的 UML 图（像素分析：非白 7.65%、含彩色节点与文字，非 loading 占位）。
- 影响范围：packages/frontend/src/util/export-chat-image.ts（修复）、export-chat-image.test.ts（新增含 mermaid 的导出时序测试 + mermaid mock）。

## 2026-08-12 — feat(frontend): 版本更新历史时间线

### 变更

- __version-history.json 版本历史数据__：新建 `packages/frontend/src/data/version-history.json`，结构化存储所有版本的更新内容（版本号 + 日期 + 新增/改进/修复分类），时间倒序。打包进应用静态资源，前端 import 读取，离线可用。初始数据从 git 历史 RELEASE_NOTES.md 恢复（0.1.18–0.1.21）。
- __VersionTimeline 时间线组件__：垂直时间线展示历史版本，最新版本默认展开、旧版本点击展开/收起，最多显示 100 条。分类标签颜色区分（新增=success 绿、改进=accent 蓝、修复=warning 橙）。
- __AboutSection 嵌入时间线__：设置 → 关于页面新增「更新历史」区域。新版本提示的 releaseNotes 加 whitespace-pre-wrap 修复换行丢失。
- __publish-oss.ts 适配__：从 version-history.json 第一条提取内容注入 latest.yml 的 releaseNotes（替代读取 RELEASE_NOTES.md）。
- 验证：version-history 格式校验 2 pass；VersionTimeline 组件测试 3 pass（渲染/展开收起/100条截断）；AboutSection 测试 7 pass；前端全量 `--isolate` 84 pass；`tsc --noEmit` 通过。
- 影响范围：`packages/frontend/src/data/version-history.json`（新建）、`VersionTimeline.tsx`（新建）、`AboutSection.tsx`（修改）、`scripts/publish-oss.ts`（修改）、i18n 文案。

## 2026-08-12 — fix(frontend): 会话内存泄露——删除会话不清理 store 数据 + message_end 不清流式缓存

### 变更

- __根因__：内存快照分析（heaptimeline）显示 JS 堆持续单调增长无回落。删除会话时仅清理 composer 草稿，messagesBySession 等 19 个 per-session Record + 子代理进度数据全部残留；clear() 遗漏 8 个字段；_streamingVisibleCache 流式结束后不清理。
- __修复__：session store 新增 removeSession(sessionId) 方法（19 个 Record + 子代理进度 + streamingBatcher.drop）；clear() 补全遗漏字段；ProjectItem/ImConversationList 删除会话时调用 removeSession；缓存逻辑提取为独立 streaming-visible-cache.ts 纯模块，message_end 时调 clearStreamingVisibleCache()。
- 验证：TDD 3 红→3 绿；前端 store 测试 5/5 pass。
- 影响范围：packages/frontend/src/store/{session,streaming-visible-cache}.ts、packages/frontend/src/components/{MessageList,ProjectItem,ImConversationList}.tsx。

## 2026-08-12 — 修复新建会话「正在思考」闪退

### 变更

- __修复(kernel)__：新建会话冷启动期间 `isSessionBusy` 返回 false 导致前端清除乐观思考状态；新增 `starting` 检查，冷启动期返回 true，`GET /messages` 正确返回 isActive=true。

## 2026-08-11 — 暗色主题修复 / 流式渲染与滚动交互 / kernel 探活与看门狗治理 / 桌面打包与 OTA

### 变更

- __frontend·暗色模式__：导出图片黑底黑字修复（ExportImageCard 应用主题化 prose 变量）；代码块暗色高亮不可读修复（新增 `useIsDarkMode` hook，按明暗切换 Prism 主题，system 模式跟随系统实时切换）；markdown 渲染启用 typography 对齐网页排版 + 文件预览底色改白；md 预览渲染原始 HTML（rehype-raw）+ 内嵌相对路径图片加载（仅文件预览器，聊天区保持安全不渲染 HTML）。
- __frontend·流式/滚动__：新会话发送后显示「会话新建中」加载页（消除白屏，时间戳窗口 + 事件响应退出 + 20s 兜底）；新建会话 api.post 错误不再被吞——创建失败显示「发送失败」提示（promptErrorBySession，显示条件不依赖加载页窗口，收到服务器事件自动清除）；触摸惯性滚动不再被误判「被动离底」拉回；贴底时折叠/展开不再反复出现「滚动到底部」浮钮（用户主动滚动输入检测）；发送消息后自动滚动到底修复（发送恢复贴底 + 进入会话定位收敛）。
- __frontend·卡片/布局__：FleetCard / DelegateCard 状态摘要行移到卡片底部；统一 thinking/tool/text block 间距（父容器 gap 替代单边 margin）；左上角 logo 放大 1.5 倍；系统设置新增图片导出范围选项（仅 agent 回复 / 双方）+ 通用设置项顺序调整；缓存命中率改为向下取整（避免 99.95% 误显示 100%）。
- __kernel·探活与看门狗__：子代理无进展探活——5 分钟无业务事件判死强杀、不杀主代理；探活移除「工具执行中豁免」、`tool_execution_update` 计入进展；回合看门狗终止后自动重试 1 次；移除主会话回合看门狗（不再杀主代理，子代理独立治理兜底）；子代理执行期间不再误杀主代理；hard-cap 在 ask 豁免后重新武装；看门狗报错文案简化；用户主动停止不再误报「The operation was aborted.」红色错误。
- __kernel·进程治理__：spawn pi 子进程传 `--offline`（主会话 + 子代理）——关闭子进程启动时模型目录网络刷新与共享 models-store.json 锁竞争（同时新建两个会话时第二个不再被 withLockAsync 异步锁拖长、超过前端 30s 硬超时表现为「卡住/无响应」）；offline 无功能副作用（kernel 模型目录由 pi-catalog + providerStore 自管理，扩展/技能走本地路径不受 PI_OFFLINE 门控）。
- __kernel·流式/IM__：SdkEventThrottle 不再丢弃 message_update 增量（流式丢帧修复）；IM 渠道流式 delta 按 contentIndex 分块累积（并发竞态修复）；bridge 心跳探针测试 flaky 治理（重试消除 CI 抖动）。
- __desktop__：ditto 重打包后 blockmap 重新生成（修复增量更新退化为全量下载）；打包版启动卡死修复（trayInstance 被 biome 误改为 const）；macOS OTA 更新无效修复（销毁 Tray 替代 app.exit(0) 兜底，让 ShipIt 正常走完安装）。
- __其他__：记忆 tab 徽标计数按作用域统计，不再混入项目记忆。

## 2026-08-10 — 看门狗与子进程治理 / 主题外观系统 / 桌面端口与 OTA / 发版 v0.1.13–v0.1.20

### 变更

- __kernel·看门狗/超时治理__：主会话回合看门狗（pi 假死自动恢复，修复永久「思考中」）；kernel 超时与信号链路治理 7 项（断连孤儿子代理、停止宽限强杀、ask 流式心跳、httpIdleTimeoutMs 落盘、扩展子进程超时、Infinity 守卫）；httpIdleTimeoutMs 默认值落盘 + 保存校验；ask 改走流式 NDJSON 心跳保活（修复 ~4 分钟提前掐断）；流式 bridge 断连信号透传至子代理；subagent-runner settle 竞速重构（abort 短路 + Infinity 守卫 + 计时器清理）；提问卡片竞态误判失效 + bridge 断连僵尸提问修复。
- __frontend·主题外观系统（v0.1.13）__：CSS 变量分层重构，明暗模式 + 6 色主题 + 字号；AppearanceSection 组件 + ui-prefs store（themeMode/themeColor/fontSize）；system 模式实时跟随系统切换；yellow 深色对比度修复；设置页导航集成与字号迁移。
- __frontend·流式/渲染/滚动__：恢复 llm-ui 流式渲染（撤销 revert，重新采用分块渲染）；工具调用前未闭合 markdown 空白气泡修复；AI 回复中手动上翻不被自动滚动拉回；进行中轮次不提前显示复制/导出按钮；消息气泡最大宽度 78% → 90%；对话界面 duplicate key + Virtuoso 横向溢出 + 回收站长内容换行修复；项目右键菜单视口钳制。
- __desktop·端口/进程/OTA__：win 升级后端口幽灵占用治理（进程登记簿 + 退出清理加固 + 升级前优雅停 kernel + 启动自愈）；登记簿清扫连带 kernel 子孙链；升级安装前优雅停 kernel；退出清理加固（before-quit 同步杀进程树 + sidecar lastPid 兜底）；登记簿 createdAt 取 spawn 时刻 + 自愈异常兜底 + 坏值校验；macOS OTA 系列热修复（v0.1.19 Tray 保活 / v0.1.18 ShipIt 中止 / v0.1.16 验证链路 / v0.1.14 平台 updater + 自签名证书方案 B）；Windows 打包后任务栏图标修复（signExecutable 保留 resEdit）；desktop 数据目录与 kernel 对齐（~/.wa-pi → ~/.pi/agent）；清理 wa-pi 改名残留（死文件 + E2E 死回退 + 过时注释）；图标重新生成（logo.svg 换版 HiAgent/126 绿底）。
- __其他__：录音权限错误改为业务可读文案；移除过时 skip 用例；修复 3 个过时测试断言；发版 v0.1.20 / v0.1.15（进程登记簿 + 端口自愈 + 流式渲染修复 + 图标更新）。

## 2026-08-09 — 回收站功能 / 虚拟化与流式渲染 / i18n 双语 / 初始化向导与预设智能体 / 发版 v0.1.7–v0.1.11

### 变更

- __回收站功能__：全链路实现——类型定义、ProjectStore 软删除/恢复/彻底删除/清空/loadActive、自动归档调度器（6 小时 + 可选自动清理）、WS 事件 + HTTP 路由 + 设置存储、前端 store/trash + 弹窗/会话行/只读消息查看器 + SVG 图标化；最终审查 5 个问题（归档天数 clamp、deleteProject 改软删除、软删会话只读守卫等）。
- __前端·虚拟化/流式渲染__：消息列表 react-virtuoso 虚拟化（长会话性能）+ 移除无限 rAF 循环；流式 text 段改 llm-ui 分块渲染（未闭合代码块跳过 Prism 高亮）；llm-ui React 19 兼容性 spike；StreamingBatcher rAF 裸引用 this 修复（真实浏览器流式预览失效）；子代理卡片 memo + 流式停顿前纯文本预览降级；修复虚拟化后进入会话定位回归 + 滚动行为自动化覆盖。
- __前端·交互/修复__：粘贴超 30 行自动转为文件附件；点击附件 chip 内置文件预览器预览；文件树重新显示隐藏项；streaming 期间不提前显示复制/导出按钮；重命名会话改用内置弹窗；右键菜单互斥 + 项目重命名 + 遮罩不关闭；新建角色默认关系网包含所有内置智能体；切换模型后会话模型回滚（loadSession 竞态）；新会话消息串会话（草稿 id 未消费）/ 空会话（预热占位残留）；fleet 同名 agent 回复/状态串台（taskIndex 全链路透传）；消息流渲染稀疏空洞崩溃修复。
- __i18n 双语__：前端引入 react-i18next 国际化基础设施（自动语言检测 + 设置切换）；全部组件文案接入中英双语；修复英文界面露中文遗漏点 + 非组件层文案迁移；回收站 emoji 图标 SVG 化 + 图标居中。
- __kernel/其他__：修复设置页改 API key 不生效（auth.json 过期凭证劫持）；anthropic-messages 格式 provider 测试连接 404；新增开机自启功能（默认开启）；恢复 README 截图素材；发版 v0.1.10 / v0.1.9 / v0.1.8 / v0.1.7。
- __初始化向导 + 预设智能体体系__：无模型自动弹出两步引导（配置模型 → 设置默认智能体）；268 条预设智能体库 + from-preset 创建 + 部门筛选 + 完整提示词预览 + 3 列卡片弹窗；宫格新建面板独立弹窗；前端 18 个组件文案接入 i18n。

## 2026-08-08 — 适配 pi 0.84 流式协议 / 发版 v0.1.6 / 依赖升级 / 提示音与自动更新

### 变更

- __适配 pi 0.84 流式协议变更__：message_update 移除 partial 快照，前端与企微渠道改 delta 累积渲染；对话消息移除头像保留智能体名字。
- __发版 v0.1.6__：提示音（任务完成/需要操作）、渠道流式回复适配、依赖批量升级（pi-ai ^0.84.1 / vite ^8.2.1 / electron ^43.3.0 / electron-builder ^26.15.3）、README 英文化（拆分 README.zh-CN.md）。
- __新增功能__：任务完成/需要操作提示音（WebAudio，独立开关 + 试听）；系统设置通用页内容改为保存后才生效；设置弹窗导航选中高亮对齐会话样式。
- __修复(kernel)__：企微 IM 流式推送断线期 unhandledRejection 崩溃；skillsAllOff 语义失效（接口补字段透传）；会话清理与预热并发竞态噪音日志降级；新建页切换模型后聊天界面显示旧模型。
- __重构(desktop)__：自动更新源 Gitee Release → 阿里云 OSS（GenericProvider + publish-oss 脚本）。
- __新增(desktop)__：应用版本检查与自动更新（electron-updater，关于页 UI）；侧边栏新建项目入口图标化。
- __新增(frontend)__：输入框 Ctrl+Enter（macOS Cmd+Enter）引导发送。
- __文档/依赖__：README 双语版头部中英界面标识 + i18n 徽章；核心依赖批量升级；删除 docs/superpowers/mockups 早期原型与差异文档；新增初始化向导设计文档；引入 agency-agents-zh 中文角色参考库（268 个，仅参考资料）。

## 2026-08-07 — 初始化向导 / 前端 i18n 全量接入 / 智能体技能 tab 改造 / 企微 IM 渠道增强

### 变更

- __初始化向导__：无模型时自动弹出两步引导（配置模型 → 设置默认智能体，均可跳过），设置页可重开；预设智能体库选择 + 随机人名可改；附带修复 agent:prompt agent_missing 广播缺失。
- __前端 i18n 全量接入__：18 个组件（NewSessionPane / AgentGalleryModal / ProjectItem / Composer / CommandPalette / ImConversationList / Sidebar / ProjectList / MemoryPage 等）+ util/platform.ts 文案接入中英双语。
- __编辑智能体弹窗技能 tab 改造__：全部勾选开关 + `skillsAllOff` 字段表达显式全不选（主会话与子代理派发均识别）；技能名不换行 + 超长描述气泡。
- __角色选择器/卡片溢出修复__：小窗口下角色选择器不再超出屏幕（min-w-0 + 视口钳制）；委托/工具/思考卡片长文本不再撑破（overflow-wrap:anywhere）；统一「打开系统文件/目录」入口文案按平台区分。
- __企微 IM 渠道增强__：默认工作目录 + 切换开关；群聊会话改「群+用户维度」隔离（上下文互不可见）；`/new` 命令归档保留历史会话 + IM tab 右键删除；回复粒度新增「极简」选项；企业微信 token 级流式回复（打字机效果）；映射缓存失效会话兜底重建；IM 会话不再泄漏到任务列表。
- __其他修复__：ProviderFormModal 弹窗点击阴影不再关闭；回收站眼睛/关闭图标居中；emoji 图标 SVG 化。

## 2026-07-30 — 网络错误状态条 / 思考强度持久化 / 全项目重命名 HiAgent → WA PI Agent

### 变更

- __修复(kernel)__：网络错误不再灌入对话流，改用顶部状态条提示（transient / fatal 分类）；每个会话固定自己的思考强度（未设置回退全局默认）；重启后会话标题丢失（createSession 幂等）。
- __修复__：委托子代理「No API key」（跟随主模型 + extensionPaths 透传）；聊天界面未选模型自动选第一个可用模型；打包后 MCP 连接「Executable not found: npx」（新增 npx/npm 包装脚本 + findSystemNode）；已完成 thinking 块因新 thinking 到达误展开（每段独立成卡）；过程卡片展开/弱化逻辑统一（executingMode）。
- __新增__：README.md（产品定位/特性/架构图/截图）。
- __重构__：全项目重命名 HiAgent → WA PI Agent / wa-pi（约 290 个文件：包名 @hiagent/*→ @wa-pi/*、数据目录 ~/.hiagent → ~/.wa-pi、二进制 hiagent-kernel → wa-pi-kernel、环境变量 HIAGENT_*→ WA_PI_*）。

## 2026-07-29 — 思考强度持久化三次修复 / 依赖整体升级 / TUI 命令治理

### 变更

- __修复__：重启后思考强度重置 disabled（hydration 竞态，第三次修复——hydrate 前不写回 localStorage）；切换会话思考强度丢失 + defaults 改用 localStorage 持久化；编辑供应商弹窗快捷下拉卡住（TagInput onSubmit）；provider 配置变更后旧 extension 导致 Model not found（markAllDirty）；Mermaid 流式闪现渲染失败（错误 debounce）；打包后新建会话跳旧会话 / 复制功能失效（sandbox: false）；固定端口 9778 + 端口占用一键重启。
- __配置变更__：前后端依赖整体升级（pi-coding-agent 0.82.1 / pi-ai 0.82.1 / vite 8 / electron 43 / electron-builder 26 等）；pi-coding-agent 补丁移除 bash 默认超时 hunk。
- __TUI 命令治理__：`/mcp-auth` 卡死修复（pi 侧 custom() 同步抛错 + `/` 菜单静态预扫描屏蔽 + TUI-only 命令降级为大模型普通输入）；手动发送扩展命令后永久「思考中」（合成 agent_end）。
- __其他修复__：文件预览 ENOENT 自动搜索回退；文件预览胶囊仅对可解析路径显示；切回会话时 ask 不再错误取消；web_search 默认参数（auto-summary + numResults=8）。

## 2026-07-28（晚） — 委托提示词 v14 定稿

### 变更

- 委托提示词 v14 定稿：deepseek-v4-flash 无思考模式 60/60 通过，提示词总量约 -60%；派发评测脚本加固（每用例前重新生成扩展、自动重试、隔离 worktree 评测）。

## 2026-07-28 — 内联 / 命令菜单 / 命令状态修复

### 变更

- __新增__：内联 `/` 命令菜单动态注册 pi 的 slash 命令（get_commands 全链路，支持插件贡献命令）。
- __修复__：新建会话 `/` 菜单不显示动态插件命令（自动创建 session + 启动 pi 进程）；`/goal` 等命令执行后永久「思考中」（50ms 延迟检查复位）；扩展安装/升级/卸载永久卡「安装中」（broadcast 而非 reply）；MCP 连接器永久卡「测试中」；MCP 工具列表弹窗尺寸（60vw / 80vh）。

## 2026-07-27 — 委托提示词 v3 定稿 / Mermaid 渲染 / Token 显示 6 项修复

### 变更

- 委托提示词 v3 融合版定稿（A/B 实测驱动，explore 88.9% 误派 0%）；派发评测脚本扩容（用例 30→60，`--repeat N` 多轮采样）。
- __新增__：Mermaid 图表渲染（缩放/拖拽/PNG 导出）；内置 pi-cache-optimizer（Token/缓存显示，子 agent usage 累加）；高级项目经理 + 会议纪要专家角色。
- __修复__：刷新页面后会话未还原进行中状态；工具卡片展开/收起宽度跳变（固定 w-[78%]）；Token 显示 6 项缺陷；首次打开存量会话慢（5-10s → ~0.3s，直接解析 JSONL）；角色设置工具 Tab 加载中；编辑角色 SkillsTab 崩溃；记忆/指令/配置加载失败；归档记忆删除不掉；指令文件扫描对齐 pi 框架。

## 2026-07-26 — 去 WS 化阶段二 / 排队系统设计 / 卡顿修复

### 变更

- __设计__：排队系统重构（采用 pi 原生 steer() + 本地列表管理）。
- __修复__：流式输出 fallback（message_update 缺 partial 时用 event.message 兜底）；SSE 事件帧格式；REST 响应体丢失（8 个 store 补 .then）；Composer 错误兜底复位 UI。
- __重构__：阶段一卡顿修复（kernel 50ms 节流 + 前端 rAF 合帧）；去 WS 化阶段二全量迁移到 HTTP REST + SSE + 测试迁移。

## 2026-07-25 — 智能体编辑窗口放大 / 排版修复 / 动态扩展加载

### 变更

- 智能体编辑窗口放大（80vw × 80vh，禁用遮罩关闭）；代码块内 markdown 表格逐格竖排（CSS 作用域防护）；AI 回复中表格/列表行间距异常（lineHeight 3.1 → 1.55）。
- 动态扩展与 agent 目录双重加载（动态包优先 runtimeRequire）；pi-mcp-adapter 升级 2.13.0；发送按钮因过期模型 prefs 置灰（按 id 兜底匹配）。

## 2026-07-24 — 角色系统完善 / 子代理派发优化 / 专家角色预置

### 变更

- __修复__：角色提示词未注入系统提示词；主智能体不主动派发子代理（恢复 Proactive Delegation / Fleet）；FilePicker 搜索目录无法展开；DirTreePicker 搜索切换隐藏目录；工具调用卡弱化时机（拿到 result 即弱化）；阻止加载 Pi 默认 skill（--no-skills + 显式 --skill）；聊天界面时间线渲染顺序；子代理无效模型崩溃（校验 override model）；pi-lens 双重加载 + 工具过滤；关系网 tab 开关样式。
- __新增__：首启预置 7 个专家角色（前端/后端/PM/测试分析师/数据分析师/代码审查/UX 设计师）；子代理派发遥测 + 评测脚本；聊天界面 cocode 显示模式对齐（ProcessCard 体系 + 折叠/语法高亮/FilePill）；系统设置-技能页面优化；CoCode vs HiAgent 差异对比文档。
- __变更__：移除 4 个旧默认角色。
- __重构__：bridge 扩展静态化（tool-schemas.ts 唯一真源）；delegate 工具描述移除硬编码内置类型名。

## 2026-07-23 — pi RPC 子进程架构迁移

### 变更

- __重构__：kernel 从 pi SDK 内嵌迁移到 pi RPC 子进程架构（rpc-client.ts + agent-manager.ts 重写）；测试套件适配（6 个测试文件重写）。
- __新增__：bridge 扩展层（pi RPC 子进程架构的宿主工具桥）；RPC 迁移验收 E2E；技能触发符支持 ¥。
- __修复__：清理 kernel/tests 残留临时文件；frontend 测试套件 11 个既有失败（zustand store 污染）；引导消息重复发送（_promptLocks 只覆盖 ensureStarted）。

## 2026-07-22 — 子智能体调用策略 / 气泡拆分重写

### 变更

- __修复__：主智能体不主动调用子智能体（提示词引导重构，OpenCode 式强制策略）；按 R 重启端口冲突（POSIX 递归杀整棵进程树）；同一回合文本被拆成多个气泡（重写 segmentBlocks）。
- __新增__：内置智能体设置支持保存 model 和思考强度；委派引导可配置化（AgentConfig delegationHints）。
- __测试基础设施__：kernel 不再被强加 happy-dom；store-subagents 测试跨文件 mock 泄漏；SessionView 违反 React Hooks 规则。
- __移除__：死字段 partners.askFrom / inheritProjectContext。

## 2026-07-21 — 默认工作区 / 系统提示词组装框架 / 内置 subagent 全链路

### 变更

- __新增__：默认工作区虚拟项目（🏠 默认工作区）；系统提示词可配置化组装框架（6 段拼装 + prompts.json 配置）；内置 subagent 类型（general-purpose / Explore / Plan）全链路；@ 智能体 chip 渲染 + 按钮选择器自适应。
- __修复__：宫格弹窗左键内置 subagent 无效（打开只读详情）；多行发送换行丢失（contenteditable 块级元素转 \n）；内置 subagent 无 askTo 时无法调起（始终注册 delegate/fleet 工具）；@ 内置 subagent 中文 token 识别失败（改用英文 name）。
- __设计__：知识库检索技术方案调研；@ 智能体语义改造 spec。

## 2026-07-20 — @ 候选菜单与委托规则

### 变更

- __新增__：@ 候选菜单只显示 askTo 名单内；系统提示词加 @[agentName] 委托规则；askTo 非空时同时注册 fleet 工具。
- __重构__：彻底移除 AgentConfig.name 字段（displayName 唯一标识符）；Composer 发送路径不剥离 @[xxx]。
- __修复__：历史消息中 @[智能体] 渲染为 chip；委托后刷新出现空气泡（兼容 role: "custom"）。

## 2026-07-19 — 多智能体矩阵重写

### 变更

- 多智能体矩阵重写：动态增删改查 + 关系网调起 + @/$/# 触发符 + DelegateCard；新建会话页智能体选择器（搜索下拉 + 默认选中最近使用）。

## 2026-07-17 — 插件升级反馈 / 模型闸门 / Quick Invoke 修复

### 变更

- __修复__：动态插件升级无反馈（upgrading 状态 + 进度推送）；未配置模型也能发送（闸门改为验证模型真实存在）；agent 启动失败后会话卡「思考中」（failTurn 复位）；打包后 modelRuntime.getModels 报错（包根动态 import）；Quick Invoke 菜单过窄（560px + 自动滚入视野）；quick-invoke E2E 5 个既有缺陷；记忆页开关失效；Plugin 技能描述显示 "|"（YAML 块标量解析）；大文件上传超时（maxPayloadLength + WS 自动重连）；会话状态点永远「空闲」（活会话级状态）；业务校验错误崩掉 kernel（dispatch 边界 try/catch）。
- __新增__：@ 文件选择支持文件夹（📁/📄 图标区分）。

## 2026-07-16 — Quick Invoke / 供应商预设 / 发送修复

### 变更

- __新增__：Quick Invoke 聊天栏快速调用（@ 文件选择 + $ 技能选择 + contenteditable）；模型供应商预设快捷选择（10 条主流预设）。
- __修复__：新会话发送后白屏（kernel 创建 session 后立即回传用户消息）；停止/队列按钮无响应（session 注册时机提前）；会话列表时间不更新（message_end 也 touchSession）。
- __变更__：思考过程合并 + 工具调用分组折叠（两层折叠面板）。

## 2026-07-15 — MCP 连接器直连 SDK

### 变更

- __重构__：MCP 连接器改用直连 MCP SDK（连接测试/工具列举不再经 Pi agent session）。
- __修复__：HTTP MCP 鉴权失败（url 分支透传 headers）；已连接 MCP 仍保留连接测试按钮。
- __新增__：切换 MCP 项目作用域后自动连接测试；MCP 编辑改为模态弹窗；MCP 查看工具加载过渡。

## 2026-07-14 — 动态插件工具自动发现

### 变更

- 动态插件工具自动发现（遍历扩展 .tools Map）；SDK 自动发现冲突（自有字段 hiagent_packages）；包管理器鲁棒性（process.execPath 替代 bun + 自动创建 package.json）；Dev 模式运行时包解析（runtimeRequire 兜底）。

## 2026-07-13 — 动态插件系统 / Electron shell

### 变更

- __新增__：动态插件系统（安装/卸载/升级/启用/禁用 npm 插件）。
- __重构__：桌面 shell 从 tray-binary 迁到 Electron（为录音系统声音铺基座）。

## 2026-07-12 — 桌面分发模型 / ask 工具

### 变更

- __重构__：桌面分发定为文件夹模型（bun build 打包 kernel.js + node_modules）；前后端端口支持 .env 动态配置。
- __新增__：ask_user_question 结构化澄清提问工具；agent 系统提示词注入执行环境信息；kernel 可导入 + 可选静态前端伺服。
- __修复__：pi-lens 双重加载 + 工具白名单过滤；记忆页作用域选择器状态丢失。

## 2026-07-11 — FilePicker 手风琴 / 记忆管理

### 变更

- FilePicker 手风琴展开 + 限定范围搜索；记忆管理（集成 pi-hermes-memory，增删改查 + 指令文件加载）。

## 2026-07-10 — 工具集扩展

### 变更

- dev 脚本按 R 重启端口漂移（strictPort 固守 5180）；新增 grep/find/ls 与 web_search/fetch_content 工具。

## 2026-07-09 — Composer 重构 / 技能管理 / 系统设置

### 变更

- Composer 重构：胶囊输入 + per-session 偏好持久化 + 模型切换/思考强度/附件；技能管理（目录管理 + 启用/禁用 + 热生效）；系统设置页 + 模型供应商管理；DirTreePicker 搜索过滤。

## 2026-07-08 — Steer 队列控制 / Pi SDK 同进程重构

### 变更

- __新增__：Steer 消息队列控制（followUp 排队 + 引导/立即/取消/清空）；项目列表右键菜单（查看文件夹 + 删除项目）。
- __重构__：Pi SDK 模式重构（从 spawn RPC 子进程改为同进程 SDK 直连）。
- __修复__：pi-intercom 打包为项目依赖、Composer 发送防抖、会话列表重复、首条消息丢失、多 session 共享进程问题、dev 端口清理等多项。

## 2026-07-07 — 移除 Rust 窗口层 / Pi 原生消息模型重构

### 变更

- __架构重构__：移除 Rust 窗口层（bun 一键启动前后端，全 bun:test）；Pi 原生消息模型重构（收敛到 Pi 富消息模型，删除 broker-proxy 旁路系统）。
- __新增__：编排画布（React Flow 4 agent 节点 + 连线）；会话列表交互（右键菜单 + 删除确认）；多智能体委派（后随消息模型重构废弃）。
- __修复__：消息流全链路打通、会话消息重复、E2E 白屏等多项。
- __测试__：E2E 基础设施 + 7 spec；MVP 四层测试全绿（kernel 47 + frontend 42 + E2E 4）。

## 2026-07-06 — 前端数据层

### 变更

- 前端数据层：WS 客户端 + 4 个 Zustand store。

## 2025-08-02 — /mcp-auth 卡住修复

### 变更

- RpcClient.handleUiRequest 的 UI_DIALOG_METHODS 缺少 custom 方法，导致 pi-mcp-adapter 的 ctx.ui.custom() 面板请求无回复、进程永久挂起；将 custom 加入对话方法集合，无 handler 时自动回 cancelled。数据清理（测试遗留无效模型、过期会话文件）。

## 2025-07-28 — 思考文本换行 / 工具来源标签 / 打包白屏

### 变更

- 思考文本不换行（ThinkingCard/ThinkingPanel 加 break-words，ProcessCard 加 min-w-0）；工具来源标签细化（来源从「扩展」细化为 内置 / MCP / 插件包名）；打包后启动白屏（SEED_FILES 补 tool-schemas.ts 和 hiagent-bridge.extension.ts）。

## 2025-01-22 — Token 消耗进度条

### 变更

- 百分比胶囊改为进度条，宽度 = 累计 token / 模型 contextWindow。
