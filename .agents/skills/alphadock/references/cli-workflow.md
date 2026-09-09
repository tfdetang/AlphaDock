# CLI 操作流程

只在需要运行命令时读取。以下假设 `alphadock` 已安装，命令中的路径、名称和 ID 都是占位示例；不要照抄为实际远程操作。

## 定位与准备

先运行 `alphadock --version`、`alphadock --help`。需要 Node.js >=22。

如果正在 AlphaDock 源码仓库且没有安装命令，可在依赖已安装的前提下执行 `npm run build`，然后把下面的 `alphadock` 替换为 `node /绝对路径/AlphaDock/dist/cli.js`。需要安装依赖或全局 CLI 时，按仓库 `README.md` 操作，不擅自改变全局环境。CLI 不要求本地 Python 或浏览器。

## 认证：只引用文件

用户提供已登录会话的外部 Cookie 文件后：

```sh
alphadock auth configure --platform joinquant --cookie-file /external/path/joinquant.json
alphadock auth status --platform joinquant
```

SuperMind 对应 `--platform supermind`。支持 Cookie JSON 数组、`{ "cookies": [...] }`、连续 JSON 对象；优先使用浏览器导出的数值时间戳，不假设字符串日期受支持。

路径配置优先级：平台环境变量 `ALPHADOCK_JOINQUANT_COOKIE_FILE` / `ALPHADOCK_SUPERMIND_COOKIE_FILE` > 已保存的该平台路径。状态目录优先级：`ALPHADOCK_HOME` > `$XDG_CONFIG_HOME/alphadock` > `~/.config/alphadock`。已有状态目录必须私有且属于当前用户；不要指向共享目录，也不要随意 chmod 用户目录。

认证失效则让用户更新会话文件；不打印 Cookie 检查、不自行绕过登录。帮助/API 查询不需要配置认证。

## 研究 Notebook

```sh
alphadock notebook list --platform joinquant
# 用户授权远程执行后，优先使用自己创建、自动清理的临时 kernel。
alphadock notebook exec research.py --platform joinquant --temporary --confirm-remote-execution
```

已有内核模式用 `--kernel-id KERNEL_ID` 替代 `--temporary`，两者必须且只能选一个。只有用户明确指定并授权时才使用已有内核；CLI 不清理已有内核。代码直接发送给平台，不会创建 `.ipynb`。

检查 `state`、`reply`、`idle`、`errors` 和 `cleanedUp`。执行成功但清理失败也需要报告保留的 kernel ID；不要重跑代码来“修复”清理失败。平台沙箱可能拒绝某些导入，不能靠安装本地 Python 包解决。

### 小批量取数与断连

Notebook 的 WebSocket 是执行通道，不应当作可靠的大文件导出通道。宽表的行数不代表输出字节数：日期、条款等长文本字段会显著增加 CSV 大小。不要默认一次输出 100 行全部字段；只查询当前需要的列，字段选择语法先查平台 API。宽表可先从每页 10–20 行的小样本起步，并统计序列化后的 UTF-8 字节数；这是保守起点，不是平台公布的安全上限。避免直接打印完整 DataFrame、长文本或重复调试输出。

- 用稳定、唯一的键排序并做游标分页。先确认键的唯一性；不唯一时需要经验证的复合游标，不能用单字段 `>` 跳过同键记录。记录本页游标、所选字段、页大小和请求哈希，不把完整查询或响应写进脱敏诊断。
- 每次只发一条查询，收到匹配本次消息 ID 的成功执行回复和 idle 后，再校验输出边界、CSV 完整性、字段及键的顺序/唯一性，可靠落盘后才推进游标。缺失、截断、解析失败或状态未知都不能当成空页结束。
- 分页不是数据快照。即使是基础信息表，也不应未经验证就假定运行期间不会变化；需要完整性保证时明确一致性检查与限制。
- CLI 不再静默截断单条 stream、display 或 error 文本。`--max-output-bytes` 限制整条连接累计接收的消息字节数（含协议开销和非本次执行消息），`--max-message-bytes` 限制单条 WebSocket 消息大小；两者默认均为 1000000，允许范围为 1–64000000 整数字节。超限报 `OUTPUT_LIMIT`，不能把已有部分当完整结果；提高预算不保证链路稳定，也不会自动重试。优先缩小查询，而不是直接开到硬上限。
- `EXECUTION_UNVERIFIED` 表示执行结果未知。channel closed/failed 本身不能证明是服务器主动重置、帧大小超限或限流；需要结合可用诊断区分。单次调用成功、降低频率、缩小页或复用 kernel 都不构成稳定性证明。
- WebSocket 错误的 `error.diagnostics` 含 `operation: notebook_execute`、`causeCode`、`elapsedMs`、`timeoutMs`、`receivedBytes`、`receivedMessages`、`maxMessageBytes`、`maxTotalBytes`、安全枚举 `reply`、`idle`，close 事件可带数字 `closeCode`。计数只含已交付给 CLI 的消息；被 ws 大小限制拒绝的消息不计入。调用方应更新字段/枚举白名单，不能直接保存整个原始异常；不保存关闭原因文本或堆栈。
- 断连后保留已确认落盘的页、失败请求哈希、已知 kernel ID、执行和清理状态并暂停。不要自动重发、推进游标、换 kernel 或改小 limit 后继续。经用户批准恢复前，先核对已保存数据与未知执行的影响；没有执行证据时不能仅凭 kernel 列表存在/idle 认定原查询完成。

如经用户明确授权复用任务专属 kernel，只在同一任务内串行使用，不借用用户其他内核、不跨任务隐式共享。初始化一次，每次查询尽量封装为函数并显式传参，避免全局变量覆盖；这不隔离导入缓存、工作目录等状态。现有 CLI 的 `--kernel-id` 仅用于连接已知内核，不代表具备自动会话创建/恢复/关闭能力；不要编造管理命令或绕过 CLI 自行创建、删除资源。复用可以减少创建开销，但不能修复通道中断或输出过大的问题。

## 策略 → 回测 → 结果

先按 [策略骨架](strategies.md) 写本地 UTF-8 文件，确认平台与研究/回测环境。以下远程写入需用户授权：

```sh
alphadock strategy create strategy.py --platform joinquant --name "my-dedicated-strategy" --confirm-remote-write
# 从上一条 JSON 保存 strategyId，不要从网页或示例猜 ID。
alphadock backtest submit --platform joinquant --strategy-id STRATEGY_ID \
  --start 2024-01-02 --end 2024-01-05 --cash 100000 --frequency day \
  --confirm-remote-execution
# 从提交 JSON 保存 backtestId，后续只读，不要重新 submit。
alphadock backtest status --platform joinquant --backtest-id BACKTEST_ID
alphadock backtest wait --platform joinquant --backtest-id BACKTEST_ID --timeout 300 --interval 20
alphadock backtest result --platform joinquant --backtest-id BACKTEST_ID --out result.json
```

SuperMind 使用相同 CLI 参数形状，只替换平台和对应策略代码。`--frequency` 仅为 `day` 或 `minute`。先用短历史区间、小规模模拟订单，不使用付费/积分确认。

`strategy create` 总是新建并读回校验，不是覆盖远程代码。修改本地策略后需要创建新的专用策略，提交时 CLI 读取该远程策略的已保存代码。不要把本地文件变更误认为已同步到平台。

## 结果与失败处理

- 普通操作输出 JSON；帮助和 `api` 输出文本，不要统一 `JSON.parse` 所有命令。
- `status/result/wait --out` 不覆盖已有文件。成功时 stdout 可能只是含 `output` 路径的回执，应读取输出文件。发生 `OUTPUT_EXISTS` 时选新文件名，不删除用户文件。
- 退出码 `1` 表示命令错误或 Notebook 执行/清理失败；读结构化 `error.code`、`error.stage`，不要只看退出码。`wait` 超时退出 `2`，远程任务未取消，之后可继续 `status` 查询；默认轮询间隔 20 秒，不能忙轮询。
- 回测 `state: failed` 是可正常查询的终态；命令可能退出 `0`，但策略没有成功。检查错误日志。失败时没有绩效/成交数据是可能的，不把 `null` 写成零收益或零成交。
- 聚宽 `trades` 是交易接口返回的原始记录数组；`bounds.transactionMeta.returnedCount` 是本次返回条数，不是历史总量。保留 `max/status` 元数据。SuperMind 保留平台的分页封装，不假定两平台输出完全同构。
- `bounds` 声明首批次/页及响应大小限制；需要完整导出时明确提出需求，当前 CLI 不提供自动全量分页。
- `SUBMISSION_UNVERIFIED` / `CREATE_UNVERIFIED` / 传输中断：结果可能已有副作用。保留状态目录下 `operations/` 的 journal 和已知 ID；不重复提交、不删除 journal、不改参数来假装重试。`DUPLICATE_OPERATION` 也不是让 agent 绕过保护的提示。

不知道错误含义或返回字段时，读 [文档查询](documentation.md)，查到证据再决定下一步。
