# WaPi 聊天录音功能设计稿（spec B）

> 日期：2026-07-13
> 状态：设计已确认，待实现
> 依赖：[2026-07-12-desktop-electron-shell-design.md](./2026-07-12-desktop-electron-shell-design.md)（Electron shell 已交付；其 §6 已预留本 spec 的 session handler 接口，且 `setDisplayMediaRequestHandler` + `audio:'loopback'` Windows POC 已通过）

## 1. 背景与目标

在聊天 composer 旁增加录音入口，支持录制**系统音频回环**或**麦克风**输入，作为音频附件发送给 agent。

核心约束来自 spec A 的 POC：
- 系统音频 loopback 在 Electron 中通过 `session.setDisplayMediaRequestHandler` 拦截 `getDisplayMedia`，可**自动批准、不弹共享框、直接给 loopback 音频**。
- 麦克风通过 `session.setPermissionRequestHandler` / `setPermissionCheckHandler` 自动授权，不弹权限框。

因此本 spec 不引入原生插件、不改动 kernel 业务逻辑，全部基于 Electron Chromium + WebRTC 标准 API。

## 2. 已确认的需求

1. 在 composer 的 📎 附件按钮右侧增加录音 icon。
2. 移除并废弃「编排画布」按钮及其界面。
3. 录音时，在 session header 右上方出现录音状态胶囊（占据原编排画布按钮位置）。
4. 胶囊功能：录音计时、暂停/继续、停止，全部使用 icon。
5. 音源二选一：**系统音频**或**麦克风**；默认上次音源，长按/右键点击录音 icon 可切换。
6. 全局单例：整个应用同时只能存在一次录音。若会话 A 正在录音，会话 B 点击录音 icon 提示「项目 XX - 会话 XX 正在录音，需要等到上一个录音结束才能开始新的录音」。
7. 录音胶囊全局可控制：无论当前查看哪个会话，胶囊都显示并可暂停/停止；录音文件始终归属到**启动录音时的会话/项目**。
8. 停止录音后，录音文件上传到归属项目的附件目录，并自动作为 audio 附件挂到归属会话的 composer，可直接发送给 agent。
9. 支持长时间录音（小时级），录音数据必须边录边落盘，不能常驻内存。

## 3. 架构总览

```
packages/desktop/src/main.cjs
  ├ session.setDisplayMediaRequestHandler     → 系统音频: 自动批准 + loopback, 无共享框
  ├ session.setPermissionRequestHandler       → 麦克风: 自动授权, 无弹窗
  └ desktopCapturer.getSources({types:['screen']})  → 给 handler 提供主屏 video source

packages/frontend/src/
  ├ recording/recorder.ts                 → RecordingManager 模块级单例
  ├ store/recording.ts                    → useRecordingStore 全局状态
  ├ components/ui/RecordButton.tsx        → composer 里的 🎙
  ├ components/ui/RecordingCapsule.tsx    → header 右上的录音胶囊
  ├ components/ui/AttachmentChip.tsx      → 新增 audio kind 渲染
  └ fs-client.ts                          → 新增 fs:recording:append/finalize/discard

packages/kernel/src/ws-server.ts          → 新增三个 fs:recording:* handler
packages/shared/src/types.ts              → AttachmentDraft/Ref kind 增加 'audio'
```

**单例由模块级单例保证**：WaPi 当前是单 BrowserWindow 单 SPA，因此一个 `RecordingManager` 实例 + 一个 Zustand store 即天然实现「全局唯一录音」。不需要跨进程协调。

## 4. Electron main 改动

在 `app.whenReady` 中、创建 BrowserWindow 之前注册 handler。**实现时直接复用 spec A POC（`.spike/electron-audio-poc/`）里验证通过的 `setDisplayMediaRequestHandler` 写法**，下面仅为结构示意，确切回调参数以 POC 为准：

```js
const { session, desktopCapturer } = require("electron");

// 自动批准 getDisplayMedia：给系统回环音频，不弹共享框（POC 已验证可去框 + 抓系统声音）
session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  // 回调的 video/audio 取值以 POC 实测为准；audio 用 "loopback" 拿系统回环
  cb({ /* video: 主屏 source, */ audio: "loopback" });
});

// 麦克风自动授权，免弹窗
session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
session.defaultSession.setPermissionCheckHandler(() => true);
```

- 不需要 preload 脚本，不需要 IPC。
- renderer 仍走标准 `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })` / `getUserMedia({ audio: true })`。
- handler 返回的 video 用于满足 getDisplayMedia 协议；前端只取 audio track 给 MediaRecorder，video track 立即 stop 丢弃。

## 5. 录音引擎与全局状态

### 5.1 `packages/frontend/src/recording/recorder.ts`

模块级单例 `RecordingManager`：

```ts
interface StartArgs {
  source: "mic" | "system";
  projectId: string;
  sessionId: string;
  ownerLabel: string; // "项目A · 会话A"
}

interface RecordingResult {
  path: string;
  size: number;
  durationMs: number;
}

class RecordingManager {
  async start(args: StartArgs): Promise<void>;
  pause(): void;
  resume(): void;
  async stop(): Promise<RecordingResult>;
}

export const recordingManager = new RecordingManager();
```

内部行为：

1. `start` 先检查当前状态；若非 idle 直接 reject（调用方据此弹 busy toast）。
2. 生成 `recId = `${Date.now()}-${rand4}`。
3. 获取 audio stream：
   - mic → `getUserMedia({ audio: true })`
   - system → `getDisplayMedia({ video: true, audio: true })`，然后丢弃 video track，只留 audio track
4. `new MediaRecorder(stream, { mimeType: "audio/webm" })`。
5. `mediaRecorder.start(TIMESLICE_MS)`，默认 `TIMESLICE_MS = 2000`（崩溃最多丢 2s，每秒级 IPC 在本地 WS 可忽略）。
6. `ondataavailable` 每个 chunk 立即 `appendRecording(projectId, recId, base64(chunk))`。
7. `onstop` 时 `finalizeRecording(projectId, recId, finalName)` 拿到最终 `path`。
8. 内部用 `setInterval(250ms)` 维护 elapsed，通过回调更新 store。
9. 任何失败都 stop tracks、discard 临时文件、store 置 error。

**append/finalize 的 webm 合法性**：MediaRecorder 以固定 slice 输出时，第一个 chunk 含 EBML 头，后续 chunk 为连续的 Cluster；顺序追加到同一文件即得到合法 webm。暂停/继续不会破坏容器。

### 5.2 `packages/frontend/src/store/recording.ts`

Zustand store：

```ts
interface RecordingState {
  status: "idle" | "recording" | "paused";
  source: "mic" | "system";
  owningProjectId: string;
  owningSessionId: string;
  ownerLabel: string;
  startedAt: number;
  elapsedMs: number;
  error?: string;

  start(args: StartArgs): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<RecordingResult | undefined>;
}
```

- UI（RecordButton、RecordingCapsule）订阅该 store。
- `elapsedMs` 由 recorder 的 tick 回调更新，避免 UI 自己维护多个计时器。

## 6. UI

### 6.1 `RecordButton.tsx`（composer 内，📎 右侧）

- 短按：
  - idle → 取 persisted lastSource，调 `recordingStore.start(...)`。
  - 非 idle → 用 toast 提示「项目 XX - 会话 XX 正在录音，需要等到上一个录音结束才能开始新的录音」。
- 长按 / 右键：小气泡选音源 🎤 麦克风 / 🖥 系统音频；选择后更新 lastSource（持久化到 IndexedDB，与 composer prefs 同库）。
- 录音中：icon 变红并脉动，禁用点击（控制权在胶囊）。

### 6.2 `RecordingCapsule.tsx`（session header 右上）

- 仅在 `status !== 'idle'` 时渲染。
- 全局读取 store，与当前查看哪个 session 无关。
- 布局：
  - 左侧：音源 icon（mic / system）+ 归属 label（若 `owningSessionId !== currentSessionId` 显示「项目A · 会话A」）
  - 中部：计时 `mm:ss` 或 `hh:mm:ss` + 状态点（红=recording，黄=paused）
  - 右侧 icon 按钮：⏸/▶ 暂停/继续，⏹ 停止
- 停止后胶囊消失。

### 6.3 忙碌提示

复用现有 `useToastStore`，文案：

> 项目 `{projectName}` - 会话 `{sessionTitle}` 正在录音，需要等到上一个录音结束才能开始新的录音。

## 7. 停止 → 上传 + audio 附件

1. `recordingManager.stop()` 返回 `{ path, size, durationMs }`。
2. 创建 `AttachmentDraft`：
   ```ts
   { kind: "audio", name: "recording-<timestamp>-<source>.webm", path, size, durationMs }
   ```
3. 推入**归属 session** 的 composer 附件列表（`useComposerPrefsStore`，IndexedDB 持久化）。
4. 归属会话 composer 里出现 audio chip，可直接发送；发送时随 `agent:prompt.attachments` 走到 kernel。

### 7.1 shared 类型改动

`packages/shared/src/types.ts`：

```ts
export type AttachmentRef =
  | { kind: "image"; name: string; path: string; size: number }
  | { kind: "file"; name: string; path: string; size: number }
  | { kind: "audio"; name: string; path: string; size: number; durationMs?: number }
  | { kind: "folder"; name: string; path: string }
  | { kind: "snippet"; name: string; content: string };

export type AttachmentDraft = /* 同上，kind 加 audio */;
```

### 7.2 `AttachmentChip.tsx`

`kind === 'audio'` 时渲染专用 chip：
- 显示文件名 + 时长（如有）
- 内嵌 `<audio controls src={pathToUrl(path)}>` 可试听
- 右侧 ✕ 移除

其余 kind 不变。

## 8. kernel 边录边落盘协议

新增三类 client→server 事件（与现有 `fs:upload`/`fs:copy` 同通道，`fs-client.ts` 各包一个 Promise）：

### 8.1 `fs:recording:append`

请求：
```ts
{ type: "fs:recording:append", projectId: string, recId: string, chunk: string /* base64 */ }
```

响应：
```ts
{ type: "fs:recording:append", recId: string, ok: true }
```

行为：追加写入 `<项目 uploads>/.recording-tmp/<recId>.webm`，首次调用时创建目录和文件。

### 8.2 `fs:recording:finalize`

请求：
```ts
{ type: "fs:recording:finalize", projectId: string, recId: string, finalName: string }
```

响应：
```ts
{ type: "fs:recording:finalize", recId: string, path: string }
```

行为：原子 move 临时文件到 `<项目 uploads>/<finalName>`，返回最终 path。

### 8.3 `fs:recording:discard`

请求：
```ts
{ type: "fs:recording:discard", projectId: string, recId: string }
```

行为：删除 `.recording-tmp/<recId>.webm`。

### 8.4 临时文件清理

kernel 启动时扫描各项目 uploads 下的 `.recording-tmp/`，删除所有文件（上次崩溃/异常退出的残留）。

## 9. 移除「编排画布」（废弃功能）

- `SessionView.tsx`：删除 header 的「编排画布」按钮及 `onSwitchToCanvas` prop。
- `App.tsx`：`type View` 去掉 `'canvas'`，删除 canvas 渲染分支与切换逻辑。
- 删除 `packages/frontend/src/components/canvas/Canvas.tsx`、`CanvasNode.tsx`、`canvas/types.ts`。
- `useAgentsStore`：实现时确认是否仅 canvas 使用；若是则一并删除，否则保留。

## 10. 边界情况

- **暂停**：直接调 `MediaRecorder.pause/resume`；暂停时段不计入文件与计时。
- **退出/崩溃**：
  - 正常退出且正在录音：Electron `beforeunload` / 前端 `window.onbeforeunload` 拦截，提示「正在录音，退出将丢失未保存录音」，用户确认后才退出。
  - 崩溃/强退：最多丢失最后一个 timeslice（默认 2s），已落盘部分可播放。
- **无设备/权限异常**：MediaRecorder / getUserMedia 失败 → store.error + toast + discard 临时文件。
- **track 泄漏**：start/stop/error 路径必须 `stream.getTracks().forEach(t => t.stop())`。
- **长录音**：opus 压缩后约 28MB/小时（系统回环视内容可能更高）；v1 不设最大时长限制。

## 11. 测试

### 11.1 单元测试

- `recorder.ts` 状态机：idle→recording→paused→recording→stopped；拒绝二次 start；elapsed 推算。
- store reducer 各 action。
- busy 文案按 `ownerLabel` 正确拼接。
- `AttachmentDraft` audio kind 的类型守卫与序列化。

### 11.2 集成测试（happy-dom + mock MediaRecorder/MediaStream）

- mock chunk 流：start → 2 个 dataavailable → stop → `appendRecording` 被调用 2 次 → `finalizeRecording` 被调用 1 次 → 归属 session composer 出现 audio draft。
- capsule 在 owner session 和非 owner session 中均渲染且控制按钮有效。
- RecordButton 在 busy 状态下点击触发 toast，不发起第二次 start。

### 11.3 真机手动（Windows，与 POC 同环境）

- 系统音频录音：实际录到电脑播放的声音，全程无共享框。
- 麦克风录音：点击即开始，无权限弹窗。
- 暂停/继续/停止、切 session 后胶囊全局可控。
- 停止后归属 composer 出现可试听 audio chip，发送给 agent 后附件路径正确。

## 12. 不做的事（YAGNI）

- STT / 语音转文字。
- 实时音频电平可视化。
- 录音设备选择器（默认系统默认麦克风 / 主屏回环）。
- 多窗口/多实例冲突（当前单窗口）。
- 录音加密、压缩格式转换（保持 webm/opus）。
- 最大录音时长限制。

## 13. 风险

| 风险 | 缓解 |
|---|---|
| `setDisplayMediaRequestHandler` 在 Linux 上行为与 Win 不一致 | POC 在 Win 通过；Linux 真机手动验证，必要时 fallback 为仅麦克风 |
| 长时间录音临时文件过大 | 2000ms slice + 追加写；崩溃丢 ≤2s |
| `getDisplayMedia` 返回的 audio track 在某些 GPU/驱动下为空 | 真机验证；失败时 toast 并建议换麦克风 |
| 编排画布移除影响 `useAgentsStore` 其他引用 | 实现前 grep 确认引用；保留若仍有用途 |
