# 第三方许可声明（Third-Party Notices）

本文件归档 wa-pi 运行时产物（kernel / sidecar / 桌面安装包）中携带的第三方软件及其许可证。

wa-pi 遵循各依赖自身的开源许可证。所有直接运行时依赖均为宽松许可证（MIT / Apache-2.0 / ISC），无 copyleft 传染性依赖。

---

## 直接运行时依赖（kernel）

| 包 | 版本 | 许可证 | 版权 / 作者 |
| ---- | ------ | -------- | ------------- |
| @earendil-works/pi-ai | ~1.3.0 | MIT | Mario Zechner |
| @earendil-works/pi-coding-agent | ~1.3.0 | MIT | Mario Zechner |
| @earendil-works/pi-tui | 1.3.0 | MIT | Mario Zechner |
| @huggingface/transformers | 4.3.0 | Apache-2.0 | Hugging Face |
| @napi-rs/keyring | ^1.3.0 | MIT | Brooooooklyn (keyring-node) |
| @noble/hashes | ^2.3.0 | MIT | Paul Miller |
| @sqliteai/sqlite-vector | ^1.1.2 | Apache-2.0 | Gioele Cantoni (SQLite Cloud) |
| @wecom/aibot-node-sdk | ^1.0.7 | MIT | 未声明 |
| cos-nodejs-sdk-v5 | ^3.0.0 | ISC | carsonxu (Tencent Cloud) |
| fflate | ^0.8.3 | MIT | Arjun Barrett (101arrowz) |
| typebox | ^1.3.11 | MIT | Copyright (c) 2017-2026 Haydn Paterson |

（2026-10-18 全量核对：pi 系版本随 1.3.0 升级修正；补录 pi-tui、@huggingface/transformers、
@napi-rs/keyring、@noble/hashes、@sqliteai/sqlite-vector、cos-nodejs-sdk-v5、fflate；
移除已删除的 pi-web-access。版本列为 packages/kernel/package.json 的声明区间，单一来源。）

## 运行时传递依赖中的非 MIT 宽松许可

- **BlueOak-1.0.0**：glob、minimatch、path-scurry、yallist、lru-cache 等（经 @earendil-works/pi-coding-agent 链引入）。BlueOak 为宽松许可证，非 copyleft。

## 构建 / 开发工具链依赖（不进运行时产物，仅供审计参考）

- **MPL-2.0**：lightningcss（经 vite 引入，frontend 构建工具链）
- **Python-2.0**：argparse（经 js-yaml / electron-builder 引入）

---

## 完整依赖树

完整的许可证信息请查阅各包随附的 LICENSE 文件（`node_modules/<pkg>/LICENSE`）。新增或升级运行时依赖时，请同步更新本文件。
