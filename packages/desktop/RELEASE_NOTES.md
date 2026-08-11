WA PI Agent 0.1.20 更新内容：

【新增】

- 主会话回合看门狗：pi 假死 5 分钟无事件自动强杀恢复，等待用户输入豁免

【修复】

- 扩展安装/卸载/升级子进程加 2 分钟超时，防离线挂起致设置页永久转圈
- httpIdleTimeoutMs 默认值启动落盘，保存加下限校验，恢复默认真正生效
- ask 改走流式 NDJSON 路径，心跳保活修复 Bun idleTimeout 255s 提前掐断
- 流式 bridge 断连信号透传至子代理，修复孤儿子代理跑满 settle 超时
- 子代理 abort 短路宽限强杀，修复 settle 竞速 Infinity 溢出与计时器泄漏
- 清理 wa-pi 改名残留（死文件 main.cjs + E2E 死回退 + 过时注释）
