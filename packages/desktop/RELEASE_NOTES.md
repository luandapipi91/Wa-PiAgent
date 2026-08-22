WA PI Agent 0.2.18 更新内容：

【新增】

- 会话级真实浏览器自动化工具（browser_navigate / browser_evaluate / browser_screenshot / browser_close）：agent 可打开网页、读取内容、点击输入、滚动、截图取证（Bun.WebView + Chrome 引擎，页面媒体自动静音）
- 命名智能体设置中可控制 browser_* 工具开关（默认开）；只读子智能体（Explore/Plan）不含浏览器工具

【修复】

- 插件安装失败：编译产物（WaPiKernel.exe）执行 bun add 时未带 BUN_BE_BUN=1，启动内嵌 kernel 而非安装命令——显式注入后插件安装正常
- 页面媒体自动播放：browser_navigate 打开含音频/视频的页面不再自动出声（--mute-audio）

【改进】

- bash 工具报错恢复为上游引擎原始提示（不再整段替换为自定义中文文案），保留自动下载 PortableGit 方案
