# 分享渠道增加 Cloudflare Pages 设计规格

日期：2026-08-18
状态：已实现（SDD 任务 7 归档，供后续回溯）

## 1. 背景与目标

文件分享目前只支持腾讯 EdgeOne（3 小时有效 token 链接、需 API Token 部署）。部分用户希望有**永久公开**的分享链接。本功能新增第二条分享渠道 **Cloudflare Pages**：配置 Cloudflare API Token + Account ID 后，分享部署到 `wapi-shares.pages.dev`，链接永久公开、无需 token 时效，免费带宽。

## 2. 渠道选择模型

分享渠道是**全局设置**（`settings.json` 的 `share` 段），由「设置 → 分享」页切换，部署与刷新链接都**运行时按当前渠道分派**：

```
type ShareChannel = "edgeone" | "cloudflare";

// settings.json
interface ShareSettings {
  channel: ShareChannel;   // 默认 "edgeone"（兼容旧配置，缺失视为 edgeone）
  token: string;           // 两渠道共用同一字段（EdgeOne API Token / CF API Token）
  accountId?: string;      // 仅 cloudflare 使用（CF Account ID）
  customDomain?: string;   // 仅 edgeone 使用（EdgeOne 自定义域名）
}
```

关键约定：

- **channel 是运行时读取、不是部署快照字段**：`routes/share.ts` 的 `deployNow()` / `refresh-link` 每次实时 `loadShareSettings()` 再分派，切渠道后立即生效（`e9bccc1e`）。
- **token 字段复用**：`PUT /api/settings/share` 全量提交 `{ channel, token, accountId, customDomain }`；token 空串时 kernel 保留原值（脱敏不露明文）。
- **前端切换只影响设置表单渲染**：edgeone 渲染「注册入口 + API Token + 自定义域名」，cloudflare 渲染「API Token + Account ID + 注册链接 + 提示文案」，保存按钮共用（`b981ad0c`）。

## 3. Cloudflare Pages Direct Upload 流程时序

部署走 CF 官方 **Direct Upload**（内容寻址资产 + multipart 部署），实现在 `packages/kernel/src/share/cloudflare-pages-client.ts`：

```
routes/share.ts deployNow()
  ├─ loadShareSettings() → channel === "cloudflare"?
  ├─ buildDeployZip(workspaceDir)          # 打包工作区（edgeone 同款）
  ├─ unzipToFiles(zip)                     # 解出 相对路径 -> Uint8Array
  ├─ deployToCloudflare({ token, accountId, files, onProgress, pollIntervalMs })
  │   ├─ 1. getOrCreateProject()
  │   │      GET  /accounts/{accountId}/pages/projects/wapi-shares
  │   │      GET 失败（通常 404）→ POST 同路径创建（production_branch=main）
  │   ├─ 2. uploadFiles()（内容寻址）
  │   │      a. 逐文件 hashFileContent() → manifest { path: hash }（blake3，见 §4）
  │   │      b. POST /accounts/{accountId}/pages/projects/{project}/upload-token → JWT
  │   │      c. POST /pages/assets/check-missing { hashes } → 跳过已上传 hash
  │   │      d. 对 missing 的 hash 逐个 POST /pages/assets/upload（实现为逐文件串行，不做并发分桶；CF API 单桶 ≤40MiB / ≤2000 文件为兜底约束，分享文件量小不触界）
  │   │         进度回调 onProgress({ phase:"uploading", percent, loaded, total })
  │   ├─ 3. createDeployment()
  │   │      POST /accounts/{accountId}/pages/projects/{project}/deployments
  │   │      multipart：manifest(JSON) + branch(默认 main)
  │   ├─ 4. pollDeployment()               # 40 × 5s 上限（对齐 edgeone 轮询）
  │   │      GET .../deployments/{id} → latest_stage.name==="deploy" && status==="success" 即完成
  │   └─ 返回 { projectName, projectId, url: https://wapi-shares.pages.dev,
  │            deploymentId, deploymentUrl }
  ├─ saveLastDeployed(workspaceDir)         # 写部署快照（与 edgeone 一致）
  └─ return { url, expiresAt: 0, channel: "cloudflare" }
```

刷新链接（`GET /api/share/:id/refresh-link`）CF 分支**幂等**返回条目子路径（`b245b7e4`）：

```
channel === "cloudflare"
  → { url: "https://wapi-shares.pages.dev/{item.name}/", expiresAt: 0, channel: "cloudflare" }
  （不重签 token——CF 链接公开恒定，子路径即分享条目目录，目录下 index.html 可直接渲染）
```

错误路径：缺 token / 缺 accountId → 部署前抛「未配置 Cloudflare API Token / Account ID」；`check-missing` / `upload` 同时校验 HTTP 状态与业务 `success` 字段，避免 `success:false` 被静默跳过（`bf22a19f`）。

## 4. hash 算法（与 wrangler hashFile 完全一致）

内容寻址 hash 实现在 `packages/kernel/src/share/file-hash.ts`：

```
hash = blake3( base64(文件内容) + 扩展名 ).hex.slice(0, 32)
       （扩展名不带点；实现用 @noble/hashes 的 blake3）
```

- 与 wrangler `hashFile` 输出一致 → 相同内容跨部署复用 CF 资产，`check-missing` 可跳过重复上传。
- 扩展名参与 hash 的原因：CF 资产按 hash 存 content-type 元数据，同名不同 content-type 需不同 hash。
- manifest 以 `{ 相对路径: hash }` 提交给部署，CF 据此装配静态站点。

## 5. 免费限制

| 限制项 | 数值 | 说明 |
|--------|------|------|
| 单文件大小 | ≤ 25MB | 应用层统一单文件上限：`POST /api/share/upload` 对所有渠道入口 413 拦截（`MAX_FILE_BYTES`）；CF Pages Direct Upload 另有同量级硬限制作为兜底 |
| 带宽/流量 | 无限（免费） | pages.dev 静态托管不计流量费 |
| 构建数 | 不限 | Direct Upload 走 API 上传，不占免费构建次数 |

前端设置页提示文案已固化：**「Cloudflare 分享链接永久公开；单文件 ≤ 25MB」**（任务 6，`ShareSection.tsx`）。

## 6. 与 EdgeOne 的差异表

| 维度 | EdgeOne（原渠道） | Cloudflare Pages（新渠道） |
|------|-------------------|---------------------------|
| 链接时效 | 3 小时 token（`expiresAt = Date.now() + 3*3600_000`） | 永久公开（`expiresAt = 0`） |
| 访问鉴权 | 链接内含签名 token，过期即 403 | 无需任何 token，直接 HTTP 200 |
| 部署协议 | 私有 API + COS 上传（edgeone-client） | CF API Direct Upload（内容寻址 + multipart） |
| 项目/域名 | edgeone 固定项目 + 应用内自定义域名设置 | `wapi-shares` 项目，默认 `*.pages.dev`；customDomain 需在 CF 控制台配置 |
| 单文件上限 | 应用层统一 ≤ 25MB（全渠道入口 413 拦截） | 应用层统一 ≤ 25MB + CF Direct Upload 同量级硬限制兜底 |
| 带宽成本 | COS 流量计费 | pages.dev 免费无限 |
| 国内访问 | 快（腾讯边缘） | 0.5~2s（跨境边缘，无国内直连优化） |
| refresh-link | 重签 token 返回新链接（3h） | 幂等返回条目子路径（不重签） |
| 进度事件 | packing → uploading（COS 百分比）→ deploying → done | packing → uploading（资产上传百分比）→ deploying → done |

**`expiresAt = 0` 语义（全链路约定）**：0 表示「永久 / 无过期时间」，非「epoch 起点」。后端约定 CF 渠道返回 `expiresAt: 0`（deployNow / refresh-link 两处与 `deployToCloudflare` 返回值 `{ url, expiresAt: 0, channel: "cloudflare" }` 对齐 routes 返回类型）；前端弹窗对 `expiresAt === 0` 渲染「永久有效」而非小时倒计时（任务 7 修复前曾因 `Math.max(1, …)` 兜底显示「1 小时」，已修正——前端直接按 0 判断，不依赖 channel 字段）。

## 7. 已知取舍（决策留痕）

1. **国内访问速度 0.5~2s**：CF 边缘节点无国内直连优化，首次访问可能有跨境延迟；换取永久公开 + 免费带宽。可接受——目标用户是「要长期公开链接」而非「要极速」的场景。
2. **customDomain 不在应用内配置**：CF 自定义域名是 Pages 项目级配置（需在 CF 控制台绑定 + DNS 校验），应用内不提供入口；CF 渠道下设置页不渲染自定义域名输入框。用户如需自有域名，在 CF 控制台配置即可，链接域名随之变化。
3. **单文件 ≤ 25MB 硬限制**：25MB 是应用层统一单文件上限——`POST /api/share/upload` 对所有渠道（含 EdgeOne/COS）统一用 `MAX_FILE_BYTES` 检查、超限返回 413；CF Pages Direct Upload 另有同量级硬限制作为兜底（应用层未拦截到的情况）。不做分片规避，前端仅提示限制文案，超限错误原样透出。
4. **E2E 不跑真实部署**：CF Direct Upload 需要真实 API Token + Account ID，E2E 只覆盖 UI 渠道切换（任务 7）；真实部署链路留手动验证清单（见 task-7-brief）。

## 8. 手动验证清单（需要真实 CF 凭证，上线前执行）

1. 在 Cloudflare 控制台创建 API Token（权限 `Account → Cloudflare Pages → Edit`），取得 Account ID。
2. 应用内「设置 → 分享」切到 Cloudflare，填入 token + accountId，保存。
3. 分享一个文件 → 拿到 `https://wapi-shares.pages.dev/<name>/...` 链接，弹窗应显示「永久有效」而非小时倒计时。
4. 无痕窗口直接打开链接，确认 **HTTP 200、无需任何 token、内容正确**。
5. 分享一个多文件条目，确认 `<name>/` 目录能渲染 `index.html`。
6. 再切回 EdgeOne 渠道，确认原 token 分享链路不受影响。
7. 用 wrangler 上传过同内容的资产后，`check-missing` 应命中（验证 hash 算法与 wrangler `hashFile` 一致）。

## 9. 文件清单（本次变更）

| 文件 | 变更 |
|------|------|
| `packages/kernel/src/share/cloudflare-pages-client.ts` | 新增：Direct Upload 客户端（fd97cc02 后经 bf22a19f 加固） |
| `packages/kernel/src/share/file-hash.ts` | 新增：blake3 内容寻址 hash（5c548c74） |
| `packages/kernel/src/routes/share.ts` | 部署/刷新链接按 channel 分派；cloudflare 分支返回 expiresAt:0（3b06ad8b / 0fa2e6ce / b245b7e4） |
| `packages/kernel/src/routes/settings.ts` | share 配置读写补 accountId（700a5b01） |
| `packages/frontend/src/components/settings/ShareSection.tsx` | 渠道切换 UI + CF 表单/提示（b981ad0c / edea7b88） |
| `packages/frontend/src/share-client.ts` | 类型补 accountId |
| `packages/frontend/e2e/share-management.spec.ts` | E2E：渠道切换用例（本任务） |
| `CHANGELOG.md` | 变更日志（本任务） |
