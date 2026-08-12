WA PI Agent 0.1.25 更新内容：

【新增】

- 首启自动下载 Node.js 运行时：无系统 Node.js 的用户首次启动时，自动检测网络环境并从国内源（npmmirror）或官方源（nodejs.org）下载 Node.js LTS，解决 MCP 服务器（npx -y）在无 Node 环境下报错的问题

【改进】

- 系统 Node.js 检测改为优先扫描 PATH 环境变量（而非仅检查固定路径），能正确识别通过 nvm/scoop/volta 等工具安装的 Node.js
- 有真实 Node.js 时不再生成 bun 兼容包装脚本，直接使用 Node.js 自带的 npm/npx，提升 MCP 服务器兼容性
