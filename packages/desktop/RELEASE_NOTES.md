WA PI Agent 0.1.21 更新内容：

【修复】

- macOS OTA 自动更新修复：托盘保活阻止退出 + 安装包 Electron Framework 丢失 + 更新无 loading 反馈
- 消息列表思考过程/工具调用/文字回答间距统一（父容器 gap 管理替代单边 margin）
- 对话中间通知（extension_notify）30s 后自动消失
- 回合看门狗 hard-cap 在 ask 豁免后重新武装
- 子代理无进展探活：工具执行中持续流式输出不算卡死，完全静默才判死
- 触摸惯性滚动不再被误判为内容变化拉回底部
