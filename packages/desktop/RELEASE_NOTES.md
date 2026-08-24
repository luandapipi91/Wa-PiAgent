WA PI Agent 0.2.22 更新内容：

【修复】

- 关于页「内核版本」显示错误：内核动态更新后，runtime 内核清单被 syncSeed 覆盖回 app 捆绑的旧版（关于页读 runtime 的 package.json 显示旧值 0.1）。现 syncSeed 在动态 kernel 下不再覆盖 runtime 的 package.json / bun.lock，关于页正确显示更新后内核版本（0.1.1）
- Windows 下 WSL 的 bash stub（C:\Windows\system32\bash.exe，WSL 未装但存在）被误判为已装 Git Bash，导致内核报 "No bash shell found"；现校验 bash --version 才算真可用
- 内核独立发布时 kernelVersion 此前硬编码 bun runtime 版本（1.4.0），现改为读 kernel package.json 的独立管控版本（0.1.1）

【改进】

- 内核独立发布链路打通：publish-kernel.ts 发布内核包（kernel-<build>.zip + kernel-latest.json 传 OSS），客户端启动自动检查并更新，无需重发 app
- 内核版本独立管控（0.1.1）在「关于」页显示
