WA PI Agent 0.2.26 更新内容：

【新增】

- 定时任务 AI 化：定时任务从全局 JSON 迁移为文件夹存储（~/.pi/agent/scheduled-tasks/ 下的 tasks/ 任务 md 文件 + logs/ 运行日志），agent 可用分发到各处的 cron-task.ts CLI 自主创建、查看、修改、启停、运行定时任务；kernel fs.watch 热加载，改动即生效；系统提示词注入定时任务管理引导；自动化面板新增「配置错误」条目展示与修复；旧 JSON 自动迁移归档
- 定时任务推送默认开启（--no-im-push 显式关闭）；cron-task.ts 支持 --project 归属与 set project，list 显示所属项目

【改进】

- 定时任务 CLI 升级到全局目录架构（v3）：任务统一存 ~/.pi/agent/scheduled-tasks/，项目归属记录在 frontmatter 的 projectId 字段

【修复】

- 发送前自动压缩阈值统一为窗口 80%（更早触发，防大窗口 token 估算偏低导致边缘溢出 400）
