"""页面域: 一个前端页面一个目录, 文件夹名直接对上前端路由。

- pages/daily ↔ DailyReview(今日 / 历史 / 节点)
- pages/etf   ↔ EtfList + EtfDetail(清单 / K线 / MACD / 份额)
- pages/jobs  ↔ Jobs(数据任务 / 调度状态 / 数据就绪度)

HTTP 出口只放在页面域的 router 里; 多页面共用的计算下沉 services/,
后台调度与回填编排在 ops/(无页面)。
"""
