WA PI Agent 0.2.21 更新内容：

【新增】

- kernel 二进制动态更新：启动时自动检查 OSS 内核清单，发现新版本即下载 / 校验 / 解压覆盖正在运行的 WaPiKernel（发布端 publish-kernel.ts 打包内核包 + 客户端启动同步器，失败自动降级不阻断启动）
- 设置「关于」页新增「内核版本」显示，并引入内核独立版本管控（当前 0.1.1）
- 浏览器预览元素选中支持点击锁定高亮 + 锁图标；浏览器预览按会话独立记忆

【修复】

- 内核版本此前无独立版本号（关于页显示 — 或 bun 版本），现独立管控为 0.1.1
- 打包版本地 html 预览丢失元素选择 / 高亮（preview-inspect.js 未嵌入编译产物）
- 首启下载 node 的 npm / npx / corepack 符号链接指向临时解压目录，清理后 broken 致 MCP 报 Executable not found: npx
- 子代理派发前未按 providers.json 变更重生成 provider-extension，读到旧 contextWindow
- 升级 Pi 生态依赖：pi-mcp-adapter 2.17→2.27（移除 MCP OAuth）、@napi-rs/keyring、pi-web-access；打包 / 安装版本单一来源化
