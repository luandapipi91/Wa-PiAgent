# 提示音设置设计：任务完成 / 需要操作

日期：2026-08-08
状态：已确认

## 背景

系统设置的「通用」分区（`packages/frontend/src/components/settings/GeneralSection.tsx`）目前无任何提示音能力。项目中：

- 「任务完成」有现成事件：`agent_end` 终态（`willRetry === false`），前端在 `packages/frontend/src/store/session.ts` 约 :900 处处理
- 「需要操作」有现成状态：`ask_user_question` 工具调用待回答（`packages/frontend/src/store/ask.ts`）
- 无任何音频播放代码和音频资源文件
- 纯前端偏好经 `packages/frontend/src/store/ui-prefs.ts`（zustand persist，localStorage）持久化

## 需求

在系统设置「通用」分区新增提示音设置，任务完成或需要用户操作时播放声音提示：

- 总是播放（不判断窗口聚焦状态）
- WebAudio 蜂鸣实现，不引入音频资源文件
- 两个独立开关，各带试听按钮

## 设计

### 1. 设置存储

`ui-prefs.ts` 新增两个持久化字段：

- `soundTaskDone: boolean`，默认 `true`
- `soundNeedsAction: boolean`，默认 `true`

随 zustand persist 自动落 localStorage（key `wa-pi-ui-prefs`）。

### 2. 声音工具

新增 `packages/frontend/src/utils/sound.ts`：

- 懒创建单例 `AudioContext`
- `playTaskDone()`：上行两音（880Hz → 1320Hz，各 120ms）
- `playNeedsAction()`：660Hz 短音重复两次；500ms 内去抖，避免多个待回答事件同时出现时的叠加轰炸
- 内部 try/catch：AudioContext 创建失败或被浏览器自动播放策略挂起时静默跳过，不报错、不弹 toast
- 每次播放前读取 `ui-prefs` 对应开关，关闭时不播放

### 3. 触发点

- **任务完成**：`session.ts` 中 `agent_end` 终态分支（`willRetry === false`）调用 `playTaskDone()`。自动重试的中间态不触发；一轮只响一次
- **需要操作**：`session.ts` 消息流处理中，新增 `ask_user_question` 工具调用（此前不存在的 pending ask）出现时调用 `playNeedsAction()`。已有未回答问题不因重新渲染/重放历史消息重复触发

### 4. 设置 UI

`GeneralSection.tsx` 现有偏好区追加「提示音」分组，两行：

- 「任务完成提示音」：开关 + 「试听」按钮
- 「需要操作提示音」：开关 + 「试听」按钮

开关即改即存（直接写 ui-prefs persist），不走草稿 + 保存按钮流程。

### 5. i18n

`packages/frontend/src/i18n/locales/zh.ts` 与 `en.ts` 各新增文案：分组标题、两个开关名称、「试听」按钮，共 4 条。

### 6. 测试

- **单元测试（bun:test）**：
  - `sound.ts`：开关关闭时不调用 AudioContext；开启时调用（mock AudioContext）；needs-action 去抖生效
  - `session.ts`：`agent_end` 终态触发一次播放；`willRetry === true` 中间态不触发
- **组件测试（Vitest + happy-dom）**：GeneralSection 渲染两个开关与试听按钮；点击试听调用播放；开关切换后 ui-prefs 状态更新
- **E2E（Playwright）**：仅验证设置 UI 存在且开关可切换。声音本身无法在自动化中断言，不强制覆盖真实任务播放
