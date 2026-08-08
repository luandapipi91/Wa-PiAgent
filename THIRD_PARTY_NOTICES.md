# 第三方许可声明（Third-Party Notices）

本文件归档 wa-pi 运行时产物（kernel / sidecar / 桌面安装包）中携带的第三方软件及其许可证。

wa-pi 遵循各依赖自身的开源许可证。所有直接运行时依赖均为宽松许可证（MIT / Apache-2.0），无 copyleft 传染性依赖；修改过的包（见 `patches/`）在原许可证范围内使用。

---

## 直接运行时依赖（kernel）

| 包 | 版本 | 许可证 | 版权 / 作者 |
| ---- | ------ | -------- | ------------- |
| @amaster.ai/pi-memory | ^0.1.7 | Apache-2.0 | 未声明 |
| @earendil-works/pi-ai | ^0.83.0 | MIT | Mario Zechner |
| @earendil-works/pi-coding-agent | ^0.83.0 | MIT | Mario Zechner |
| @modelcontextprotocol/sdk | ^1.30.0 | MIT | Copyright (c) 2024 Anthropic, PBC |
| pi-mcp-adapter | 2.17.0 | MIT | Copyright (c) 2026 Nico Bailon |
| pi-web-access | ^0.17.1 | MIT | Copyright (c) 2025 Nico Bailon |
| pi-cache-optimizer | ^2.6.25 | MIT | Copyright (c) 2026 freescheme |
| typebox | ^1.3.10 | MIT | Copyright (c) 2017-2026 Haydn Paterson |

**说明**：`pi-mcp-adapter` 经 `patchedDependencies` 应用补丁（`patches/pi-mcp-adapter@2.17.0.patch`），修改其 exports 子路径与内部类型签名。补丁属 MIT 许可下的合法修改；修改版代码随本产品分发，本声明即为 MIT 要求的版权与许可声明。

## 运行时传递依赖中的非 MIT 宽松许可

- **BlueOak-1.0.0**：glob、minimatch、hosted-git-info、path-scurry、yallist、lru-cache 等（经 @earendil-works/pi-coding-agent 链引入）。BlueOak 为宽松许可证，非 copyleft。

## 构建 / 开发工具链依赖（不进运行时产物，仅供审计参考）

- **MPL-2.0**：lightningcss（经 vite 引入，frontend 构建工具链）
- **CC-BY-4.0**：caniuse-lite（经 browserslist / tailwindcss 引入）
- **Python-2.0**：argparse（经 js-yaml / electron-builder 引入）

---

## 完整依赖树

完整的许可证信息请查阅各包随附的 LICENSE 文件（`node_modules/<pkg>/LICENSE`）。新增或升级运行时依赖时，请同步更新本文件。
