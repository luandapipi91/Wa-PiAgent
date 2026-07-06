# Task 4 报告：agent-md 解析与生成

## 状态
✅ 完成。TDD 全流程通过：先写测试看 FAIL（模块不存在）→ 写实现 → 5 passed → typecheck 干净 → 提交。

## 文件清单
| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/kernel/tests/agent-md.test.ts` | 新增 | 5 个测试，照抄 brief（DEV_MD 夹具 + 5 用例） |
| `packages/kernel/src/agent-md.ts` | 新增 | parseYaml/parseScalar/parseList + parseAgentMd/stringifyAgentMd/validateAgentConfig，照抄 brief |

未改动既有文件。共 +174 行。

## 测试输出
```
bun test v1.3.14 (0d9b296a)
packages\kernel\tests\agent-md.test.ts:
(pass) parseAgentMd 解析 frontmatter + 正文 [1.41ms]
(pass) parseAgentMd 处理空 mcpServers [0.80ms]
(pass) stringifyAgentMd 往返一致 [0.33ms]
(pass) validateAgentConfig 拒绝非法 name [0.09ms]
(pass) validateAgentConfig 合法配置返回空 [0.08ms]
 5 pass, 0 fail, 10 expect() calls
```

TDD 红阶段确认（Step 2）：实现写入前报 `Cannot find module '../src/agent-md'`，0 pass / 1 fail。

## Typecheck
```
cd packages/kernel && bun run typecheck   # tsc --noEmit
```
无输出（零错误）。`import type { AgentConfig, AgentName, Partners } from "@hiagent/shared"` 解析正常，workspace 依赖链通。

## Commit
- 短 hash：`9c83d12`
- 完整 hash：`9c83d122bd6c57841cdb2bc6903ff98677d090da`
- message：`feat(kernel): agent-md 解析与生成（frontmatter 双向）`
- 仅含 2 个目标文件，无意外内容混入。

## 偏离
无。实现与测试逐字照抄 brief，未自作主张引入 gray-mirror 或其它依赖，未改类型签名。parseYaml 轻量实现原样采用。

## 问题 / concerns
- **Git LF→CRLF 警告**：commit 时 git 提示 `LF will be replaced by CRLF the next time Git touches it`。这是 Windows + 当前仓库未配 `.gitattributes`/`core.autocrlf` 的常规现象，不影响功能与测试（往返测试已验证一致性）。若后续跨平台协作需统一行尾，可加 `.gitattributes`（`* text=auto eol=lf`），属可选优化，本 Task 未处理。
- parseYaml 仅覆盖 agent.md 实际用到的 YAML 子集（标量/逗号列表/两层嵌套 partners），对引号包裹的标量值（avatar/avatarColor）做了去引号处理。这与 DEV_MD 夹具匹配，但若未来 agent.md 出现多行列表或更复杂结构需扩展——当前 MVP 范围内无需。
