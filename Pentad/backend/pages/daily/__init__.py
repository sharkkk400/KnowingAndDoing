"""日度复盘领域: 换仓节点、逐日记录、筛选漏斗与盘中预选。

阅读顺序(主线):
1. review/store.py      读写三张 fitted 表, 无业务判断
2. review/execution.py  结算规则: 周四收盘卖、周五开盘补买/顺延卖
3. review/build.py      主流程 build_day: 取节点持仓 → 结算 → 落库
4. nodes.py             节点视角的收益/动作/持有区间
5. router.py            HTTP 出口, 只做参数与编排, 最后看

旁路: screen/ 筛选漏斗(复盘时逐级摊开筛选链路), live/ 盘中预演(现价合成K线)。
"""
