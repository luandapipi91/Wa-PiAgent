WA PI Agent 0.1.14 更新内容：

【修复】

- 修复 macOS 自动更新无法安装：点击"重启安装"后应用关闭但未完成安装（updater 误用 Windows 专用 NsisUpdater，改为按平台自动选择 MacUpdater）
- 修复发版脚本遗漏 macOS 产物上传（latest-mac.yml + dmg/zip，导致 Mac 客户端收不到更新推送）
