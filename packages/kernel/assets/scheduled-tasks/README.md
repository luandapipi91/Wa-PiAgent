<!-- wa-pi-scheduled-tasks-assets v1 -->
# 定时任务

本目录管理**当前项目**的定时任务（由 wa-pi 调度执行，cron 按本地时间）。

## 目录结构

- `tasks/<任务id>.md` — 每个任务一个文件，frontmatter 是配置、正文是执行指令
- `logs/<任务id>.log` — 运行日志（追加，每行：时间/状态/耗时/摘要 + JSON 详情）
- `cron-task.ts` — 管理 CLI（`bun cron-task.ts help` 查看全部命令）

## 任务文件格式

```markdown
---
name: "每日站会提醒"
schedule: {"type":"weekdays","time":"09:30"}
agentId: "main"
enabled: true
---

提醒我写今日站会内容。
```

- `schedule.type`：`minute`/`hourly`/`daily`/`weekdays`/`weekly`/`monthly`/`custom`
  - minute: `{"type":"minute","time":"00:00","intervalMinutes":5}`
  - hourly: `{"type":"hourly","time":"00:00","intervalHours":2}`（可选 startTime）
  - daily/weekdays: `{"type":"daily","time":"09:30"}`
  - weekly: `{"type":"weekly","time":"09:30","dayOfWeek":1}`（0=周日）
  - monthly: `{"type":"monthly","time":"09:30","dayOfMonth":1}`
  - custom: `{"type":"custom","time":"00:00","cronExpression":"*/10 * * * *"}`
- `agentId`：执行角色的智能体名（必填）；`model` 可选（providerSlug/modelId）
- 正文支持 `$[技能名]` 技能标记和 `@im-push-to(机器人,联系人)` 推送标记

## 常用操作

```bash
bun cron-task.ts list                    # 列出任务（含下次触发时间）
bun cron-task.ts add --name "每日站会" --agent "main" \
  --schedule '{"type":"weekdays","time":"09:30"}' --prompt "提醒我写站会"
bun cron-task.ts test <id>               # 校验 + 预览未来 5 次触发
bun cron-task.ts run <id>                # 立即执行一次
bun cron-task.ts set <id> enabled false  # 停用
```

也可以直接编辑 `tasks/*.md`（保存后 wa-pi 自动热加载，无需通知）。
修改后建议 `bun cron-task.ts validate <id>` 校验；格式错误的任务不会被执行，
并会在 wa-pi 自动化面板显示「配置错误」。

注意：CLI 依赖 bun；若环境无 bun，直接按上面的格式编辑 tasks/*.md 即可，效果相同。
