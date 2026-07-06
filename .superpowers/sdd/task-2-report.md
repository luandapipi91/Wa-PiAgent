# Task 2 实施报告：monorepo 骨架

## 状态

**DONE** — commit `b6017fb`，`bun test` 1 passed，typecheck 退出码 0。

## 创建的文件清单

按 brief Step 1–8 创建，共 14 个新文件 + 1 个合并修改：

| 步骤 | 文件 | 说明 |
|---|---|---|
| 1 | `package.json` | root workspace 配置 |
| 2 | `bunfig.toml` | test coverage=false |
| 3 | `tsconfig.base.json` | 共享 TS 基线配置 |
| 4 | `packages/shared/package.json` | @hiagent/shared |
| 4 | `packages/kernel/package.json` | @hiagent/kernel，依赖 shared workspace:* |
| 4 | `packages/frontend/package.json` | @hiagent/frontend，含 react/zustand/reactflow 等 |
| 5 | `packages/shared/tsconfig.json` | extends base |
| 5 | `packages/kernel/tsconfig.json` | extends base |
| 5 | `packages/frontend/tsconfig.json` | extends base |
| 6 | `.gitignore` | **合并**而非覆盖（见下「偏离」） |
| 7 | `packages/shared/src/index.ts` | 导出 HIAGENT_VERSION |
| 7 | `packages/kernel/src/index.ts` | 启动占位 console.log |
| 7 | `packages/frontend/src/main.tsx` | 启动占位 console.log |
| 8 | `packages/shared/tests/scaffold.test.ts` | 冒烟测试 |
| — | `bun.lock` | bun install 自动生成，已纳入版本控制 |

## bun install 输出摘要

首次执行失败，happy-dom 包缓存迁移报 `EPERM: Operation not permitted (NtSetInformationFile())`——这是 Bun 在 Windows 上偶发的缓存锁问题。

修复：执行 `bun pm cache rm` 清缓存后重试。

重试成功：
```
bun install v1.3.14 (0d9b296a)
Resolving dependencies
Resolved, downloaded and extracted [1011]
Saved lockfile
Checked 237 installs across 307 packages (no changes) [4.34s]
```

## bun test 输出（关键行）

```
packages\shared\tests\scaffold.test.ts:
(pass) 骨架可导入 [0.15ms]

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file. [33.00ms]
```

符合 brief 期望（1 passed）。提交后再次复跑确认仍 1 pass。

## typecheck 结果

```
@hiagent/shared typecheck: Exited with code 0
```

无类型错误。

## commit hash

```
b6017fb
```

提交信息：`chore(scaffold): monorepo 骨架（shared/kernel/frontend 三包）`
15 files changed, 834 insertions(+)。提交后工作树干净（`git status --short` 无输出）。

## 偏离 brief 的地方及原因

**1. `.gitignore` 采用合并而非覆盖**

brief Step 6 给出的是一个精简版 `.gitignore`（仅 `node_modules/`、`dist/`、`.DS_Store`、`*.log`、`.vite/`、`.hiagent/`）。但仓库已存在一个 Task 1 留下的更完整 `.gitignore`，其中包含对本项目至关重要的 `.superpowers/`（SDD 临时文件目录）以及 IDE、env、Pi 状态等条目。

决策：保留原有内容，仅追加 brief 中缺失的 `*.log`、`.vite/`、`.hiagent/` 三条。理由：
- 覆盖会丢失 `.superpowers/` 忽略规则，导致 SDD 工作文件被误提交；
- 原 `.gitignore` 是 brief 内容的超集，合并后语义等价且更安全。

**2. `bun.lock` 纳入版本控制**

brief 未显式提及，但 `bun.lock` 是 workspace 依赖锁文件，Bun 官方推荐提交，故 `git add -A` 时一并纳入（符合惯例，非偏离）。

## 遇到的问题

**Bun install 首次 EPERM 缓存错误**：happy-dom 包在缓存迁移阶段报权限错误。通过 `bun pm cache rm` 清缓存后重试即解决，未对最终结果造成影响。这是 Bun 1.3.14 on Windows 的已知偶发问题，与项目配置无关。

## 验证（四层）

按 brief，本 Task 仅适用第一层：
- ✅ 第一层（骨架冒烟测试）：1 passed
- N/A 第二/三/四层（无业务组件 / API / E2E）
