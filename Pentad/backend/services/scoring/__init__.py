"""core8 评分服务: 日度复盘、筛选漏斗与后台回填共用同一套评分口径。

阅读顺序:
1. descriptors/slices.py   时点切片(只给 ≤ 信号日的数据)
2. descriptors/scale.py    份额折算归一(跳变不是申购)
3. descriptors/factors.py  单标的趋势/风险因子; profile.py 成交画像
4. descriptors/cross_section.py + themes.py  截面分位与主题强度
5. features.py             总装成候选行
6. core/score.py           八因子横截面打分
7. core/rebalance.py       五日换仓网格与缓冲带
8. core/data.py            取数 + 单日评分(回填用)
9. core/store.py           节点/持仓持久化
10. reason/ranking.py      通用入选文案; reason/core8.py core8 专属理由
"""
