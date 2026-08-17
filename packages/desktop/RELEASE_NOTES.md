WA PI Agent 0.2.4 更新内容：

【修复】

- 模型不可用（404）：Provider baseUrl 缺 /v1 时模型请求 404，现按 Provider 正确匹配 baseUrl（含测试连接），同名模型跨 Provider 不再串扰
- 新建会话页默认工作区不再显示「项目文件」浏览按钮（默认工作区目录为内部会话目录，非用户项目文件）
