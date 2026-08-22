WA PI Agent 0.2.19 更新内容：

【修复】

- 并行安装多个插件报错（EBUSY/ENOENT：bun 缓存与 node_modules 并发写冲突）——插件安装子进程串行化，任一时
间只执行一个安装操作
