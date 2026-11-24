"""K线派生服务: 日K聚合周/月(aggregate) → MACD(macd) → 日/周/月状态与趋势分(states)。

只做纯计算, 不触网也不读库; 原始K线抓取仍由 data/fetch/kline.py 负责。
"""
