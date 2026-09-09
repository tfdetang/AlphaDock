---
name: alphadock
description: 使用 AlphaDock CLI 在聚宽 JoinQuant 或同花顺 SuperMind 上运行研究 Notebook、编写 Python 策略、创建策略和提交/查询回测。用户要求量化研究、策略回测、获取回测成交/日志，或查询这些平台的 API 用法时加载。优先查本地 CLI 帮助和 API 目录，再按需查官方文档。
---

# AlphaDock

通过本地 CLI 调用远程平台；策略 Python 在平台运行，不是本地回测。先确认平台、任务范围，以及用户是否授权远程执行/创建策略/提交回测。

## 从这里开始

1. 检查 `alphadock --version` 和 `alphadock --help`。命令不可用时，读 [CLI 流程](references/cli-workflow.md)，不要自动下载同名未知工具。
2. 不确定命令参数：`alphadock <命令> <子命令> --help`。不确定平台函数：先 `alphadock api search 关键词 --platform joinquant`（或 `supermind`），再用 `api show` 查看完整条目名。
3. 只加载当前需要的参考文件；缺少签名/平台行为证据时，沿 [文档查询](references/documentation.md) 的查找路径继续，不凭印象编 API。

## 按任务加载

| 当前任务 | 读取文件 |
| --- | --- |
| 认证、研究执行、创建/提交/读取回测、解释退出码 | [CLI 流程](references/cli-workflow.md) |
| 写策略、区分平台回调与证券代码、防止每根 bar 重复下单 | [策略骨架](references/strategies.md) |
| 查函数、参数、使用环境、来源与未知问题 | [文档查询](references/documentation.md) |

## 不可跳过的边界

- `api` 和帮助命令离线；其他命令可能访问真实账户。确认标志不是授权本身：用户授权后才能传 `--confirm-remote-write` / `--confirm-remote-execution`。
- Cookie 只通过外部文件路径交给 CLI；不把文件内容、Cookie、token 写入提示词、命令行、仓库或日志。不替用户登录、刷新凭据或开启付费功能。
- 新建专用策略，不修改用户已有策略。Notebook 优先 `--temporary`；已有 kernel 可能带有用户状态，未经明确授权不要执行。
- Notebook 批量取数先读 [小批量取数与断连](references/cli-workflow.md#小批量取数与断连)：只取必要字段、小页串行执行，完整校验并落盘后才推进游标。断连后即使缩小批次也不能自动重发；复用 kernel 不保证通道稳定。
- 创建/提交失败且结果未知时，先保留 operation ID、远程 ID 和本地 journal，禁止自动重试或删 journal 绕过重复保护。只做已知 ID 的只读查询；无法确认则询问用户。
- `accepted: true` 不等于回测完成；退出码 0 / `ok: true` 也不等于策略成功。读 `state`、`verified`、错误日志与 `bounds`。超时不表示取消。
- 结果可能分页/截断；`[]` 表示已返回的空集合，`null` 表示不可用，不能互换。不要把买卖金额曲线当成逐笔成交，也不要把日志 `total` 当错误数。
- 不做实盘、充值、删除远程策略/回测、自动启动停止的研究服务器，或未经授权的浏览器兜底。

## 交付

报告平台、实际执行的命令、退出码、策略/回测 ID、关键结果及读取边界。将本次真实执行、仅离线检查、未验证/阻塞项分开；别把目录中的示例或旧验证记录算作本次成功。远程资源与清理情况单独说明，不暴露凭据。
