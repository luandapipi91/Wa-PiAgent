WA PI Agent 0.1.17 更新内容：

【修复】

- 修复 macOS 自动更新安装失败：quitAndInstall 后应用未完全退出，Squirrel.Mac 的 ShipIt 检测到运行实例中止安装（before-quit 的兜底清扫阻塞退出，现更新场景跳过清扫让应用秒退）
