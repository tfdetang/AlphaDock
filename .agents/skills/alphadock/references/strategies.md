# 编写策略：先分清环境，再补逻辑

这是骨架，不是收益策略，也不是完整平台 API 文档。平台函数由远程运行环境提供；不要在本地安装同名包来替代它。

| 项目 | JoinQuant | SuperMind |
| --- | --- | --- |
| 初始化回调 | `initialize(context)` | `init(context)` |
| bar 回调 | `handle_data(context, data)` | `handle_bar(context, bar_dict)` |
| 平安银行代码 | `000001.XSHE` | `000001.SZ` |
| 沪深 300 基准示例 | `000300.XSHG` | `000300.SH` |
| 生命周期目录条目 | `initialize / handle_data` | `init / handle_bar` |

只在选定平台下写策略，不机械替换所有证券代码后缀。函数的研究环境可用性不意味着它能在策略回调中使用，反之亦然。

## 最小骨架（默认不下单）

将选定平台的片段保存为本地 `strategy.py`。以下基于平台生命周期例子，新增状态保护只是编写建议，不声明这个完整模板已经实测。

### JoinQuant

```python
def initialize(context):
    set_benchmark('000300.XSHG')
    context.alphadock_attempted = False


def handle_data(context, data):
    if context.alphadock_attempted:
        return
    # 在这里实现信号、仓位和风控；未实现时保持不交易。
    # 若用户授权做一次小额模拟下单测试，可启用下面两行：
    # context.alphadock_attempted = True
    # order('000001.XSHE', 100)
```

### SuperMind

```python
def init(context):
    set_benchmark('000300.SH')
    context.alphadock_attempted = False


def handle_bar(context, bar_dict):
    if context.alphadock_attempted:
        return
    # 在这里实现信号、仓位和风控；未实现时保持不交易。
    # 若用户授权做一次小额模拟下单测试，可启用下面两行：
    # context.alphadock_attempted = True
    # order('000001.SZ', 100)
```

保护变量表示“已尝试”，不保证已成交。不要把 `order(...)` 无条件放进每根 bar 的回调：分钟回测会大量重复下单。实际策略应依据持仓、未完成委托、目标仓位与交易规则决定是否下单；这些函数的准确签名请查当前官方文档，不在此猜测。

## 从骨架扩展

1. 把用户需求写清：股票池、信号、调仓时间、仓位上限、费用/滑点、历史区间、频率。缺少关键条件时询问，不自行制定交易政策。
2. 先查数据函数与字段，在研究 Notebook 用小范围数据核对形状、交易日与缺失值。再写回调；研究查询代码不是可直接上传的完整策略。
3. 明确复权、停牌处理、时区和可见数据截止点，避免未来数据。跨平台对比时统一这些条件，不能把不同默认参数产生的差异算作策略差异。
4. 小规模回测，读真实成交和错误日志，核对代码读回、实际日期/资金/频率。无错误不等于符合策略意图；零成交也可能只是模板没有启用下单。

## 不知道时怎么查

```sh
alphadock api show "initialize / handle_data" --platform joinquant
alphadock api show "init / handle_bar" --platform supermind
alphadock api search order --platform joinquant --category strategy
alphadock api show get_price --platform supermind
```

`order` 目前包含在生命周期条目的示例中，不一定是独立 `api show order` 条目。先 search/list 找到完整名称，再 show。更多字段、定时调度、持仓/委托、成本或复权参数的查法见 [文档查询](documentation.md)。执行流程见 [CLI 流程](cli-workflow.md)。
