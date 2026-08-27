WA PI Agent 0.2.27 更新内容：

【新增】

- 浏览器预览自动刷新：本地 HTML 预览页面支持自动刷新，嵌套预览（iframe 内再预览）也能正确刷新
- 定时任务调度链路完善：cron-task CLI 全局目录架构收口——list 显示所属项目、set im-push 注入推送标记、--project / --no-im-push 归属与关闭

【改进】

- 浏览器预览元素选择与浏览器 store 调整
- 设置-音效 / 通用面板调整

【修复】

- rpc-client 子进程 / 连接稳定性修复
- 内核崩溃日志（agent-crash-log）落盘
- 定时任务 cron-task CLI 测试确定性（避免受宿主项目 env 干扰）
