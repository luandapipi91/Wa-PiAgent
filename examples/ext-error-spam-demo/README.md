# ext-error-spam-demo（扩展错误测试桩）

向「系统设置 > 诊断」的扩展错误列表（`extension_error`，内存态，最近 50 条）**一次性灌满 50 条**，用于回归 `DiagnosticsSection` 的：

- 满列表渲染（50 行不塌缩）
- 超过 50 条的截断（`/exterr reset` 后再发一条 → 又 50 条，旧的被挤掉）
- 清空按钮（`diag-clear-btn`）
- 滚动 / 时间戳 / 文案区分度

## 机制约束（kernel 现状）

| 约束 | 来源 | 对本桩的影响 |
| --- | --- | --- |
| 事件 handler 抛错 → runner 独立 try/catch → 一条 `extension_error` | `runner.js:emitInput` 对同一事件的多个 handler 逐个捕获 | 注册 50 个 `input` handler 各抛一次，**一条用户消息即可凑满 50 条** |
| 命令 handler 抛错只算 1 条（一次 throw 即中断） | `agent-session.js:_tryExecuteExtensionCommand` 整体 try/catch | 不能靠命令自身抛错凑 50 条，必须借事件 handler；但可反向利用——`/exterr one` 直接抛 1 条，用于验证命令级错误路径（`event:"command"`） |
| 扩展无法主动 emit 事件 / 注销 handler | `ExtensionAPI` 无 emit/off 接口 | 用模块级 `armed` 开关 + 每 handler 的 `fired` 一次性标志控制 |
| `event` 字段由 kernel 按事件类型填写 | `emitInput` 硬编码 `event:"input"` | 50 条错误的 `event` 字段均为 `input`，区分度体现在 `error` 文案（编号 #01..#50 + 场景） |

## 安装（本地扩展）

扩展管理页 → 安装扩展 → 输入本目录绝对路径：

```
/Users/pipi/work/HiAgent/examples/ext-error-spam-demo
```

或走 API：

```bash
curl -X POST http://127.0.0.1:9776/api/extensions/install \
  -H 'Content-Type: application/json' \
  -d '{"name": "/Users/pipi/work/HiAgent/examples/ext-error-spam-demo"}'
```

安装后在扩展管理页开启 `exterr` 命令开关。

## 演示

1. `/exterr one` —— 直接抛 1 条命令级错误（event 为 `command`，extensionPath 为 `command:exterr`），用于快速验证单条错误的渲染与诊断列表写入。
2. `/exterr fire` —— 装填 50 条错误（toast 提示「已装填，发任意消息触发」）。
2. **发任意一条消息**（内容无关紧要）→ 50 个 `input` handler 各抛一条带编号的错误：
   - 右上角 toast 逐一弹出（共 50 条）
   - 「系统设置 > 诊断」出现 50 行，每行 `error` 形如 `模拟扩展错误 #03/50: JSON 解析失败`。
3. `/exterr status` —— 查看本轮剩余条数（一轮触发后应为 `0/50`）。
4. `/exterr reset` —— 清空 `fired` 标志，配合已 `fire` 状态，再发一条消息又满 50 条（用于验证旧条目被挤出的截断逻辑）。
5. 「系统设置 > 诊断」点「清空」→ 列表清空。
6. `/exterr off` —— 卸装，不再产生错误（handler 遍历空转，开销可忽略）。

## 命令一览

```
/exterr one     # 命令级错误：直接抛 1 条（event:command）验证单条路径
/exterr fire    # 装填：armed=true，fired 全清空；等待下一条消息触发
/exterr off     # 卸装：armed=false
/exterr reset   # 重新装填：清空 fired 标志（armed 不变）
/exterr status  # 查询：armed 状态 + 本轮剩余条数
```

## 卸载

扩展管理页卸载即可（local 来源不会删本目录文件）。
