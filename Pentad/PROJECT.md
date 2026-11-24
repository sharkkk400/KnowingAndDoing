# DailyScope 技术文档

> 项目：DailyScope — ETF 日度复盘系统（core8 缓冲带口径）
> 代码范围：`backend/`（FastAPI + SQLite）+ `frontend/`（React 18 + antd 5 + ECharts）
> 代码版本：重构后快照（`main`）；第 14 节附录与仓库逐字一致，可据此还原全套源码。
>
> **关于数据**：本文档只描述**结构、规则与数据来源**，不保存任何静态行情/份额数据。
> 数据本体在运行时数据库 `~/.dailyscope/dailyscope.db`（不进 git），
> 冷启动基线以 `backend/seed/` 下的 gzip CSV 快照随仓库分发；两者都可以按第 10 节的方法重新生成。

---

## 目录

1. [项目定位与设计原则](#1-项目定位与设计原则)
2. [快速开始（怎么用）](#2-快速开始怎么用)
3. [运行机制：刷新链、调度与缓存](#3-运行机制刷新链调度与缓存)
4. [项目结构（逐文件职责）](#4-项目结构逐文件职责)
5. [计算口径：从全市场到 5 只持仓](#5-计算口径从全市场到-5-只持仓)
6. [数据表结构](#6-数据表结构)
7. [数据来源与抓取规则](#7-数据来源与抓取规则)
8. [HTTP 接口一览](#8-http-接口一览)
9. [前端页面与组件](#9-前端页面与组件)
10. [数据重建、快照与迁移](#10-数据重建快照与迁移)
11. [排障手册](#11-排障手册)
12. [扩展指南](#12-扩展指南)
13. [附录：常量与术语](#13-附录常量与术语)
14. [全量源码附录](#14-全量源码附录)

---

## 1. 项目定位与设计原则

DailyScope 是从 ETFScope 剥离出来的**纯日度复盘**项目：不做周度采样、不做 AI 回放、不做规则手册。
它回答一个问题：

> 今天（或历史上任意一个交易日），按 core8 的规则应该拿哪 5 只 ETF？持有到下一节点赚了多少？
> 如果今天就是换仓节点，明天开盘该买谁、卖谁？

### 1.1 三层结构

```
原始数据层（data/）        可联网重建，是唯一事实来源
    │
    ├── 派生层（services/）  纯函数：特征、评分、换仓网格、MACD 状态
    │
    └── 记录层（pages/）     日度记录、换仓节点、盘中预演、筛选快照
```

### 1.2 五条设计铁律

1. **时点纪律**：任何信号日 `T` 的计算只允许读取 `date <= T` 的行情/份额。份额 T+1 发布，所以节点日收盘只能用 T-1 份额算“预备排名”。
2. **派生数据必须可重建**：`fitted_*` 表全部由原始表 + 代码算出，删掉后按第 10 节重算即可，不手工修数。
3. **upsert 不得用 NULL 覆盖已有值**：所有写入用 `COALESCE(excluded.x, 原值)`，回填缺字段不能清空历史（曾因回填日度清空份额）。
4. **幂等 + 边拉边写**：所有回填任务可反复执行，已完成区间自动跳过，中断不丢已拉数据。
5. **纯函数不做 I/O**：`services/` 只接收数据、返回结果；取数在 `data/`，写库在 `*_repo.py` / `*_store.py`。

---

## 2. 快速开始（怎么用）

### 2.1 环境要求

| 项 | 要求 |
|---|---|
| Python | 3.9+（项目按 py3.9 语法约束，见 `backend/ruff.toml`） |
| Node.js | 18+（Vite 5） |
| 后端依赖 | `backend/requirements.txt`：fastapi / uvicorn[standard] / apscheduler / requests / akshare / pytest / ruff / mypy |
| 网络 | 需要访问腾讯行情、新浪、中证指数、上交所、东财（详见第 7 节） |

依赖安装：

```bash
cd backend
python3 -m venv ../.venv
../.venv/bin/pip install -r requirements.txt

cd ../frontend
npm install
```

### 2.2 启动

本项目约定使用仓库根的虚拟环境 `../.venv`（即 `DailyScope/.venv`）。

```bash
# 后端 API :8003（必须在 backend/ 目录下启动）
cd backend
../.venv/bin/python -m uvicorn main:app --port 8003

# 前端开发服 :5177（/api 代理到 127.0.0.1:8003）
cd frontend
npm run dev
```

> 后端**没有 `--reload`**：改完 Python 代码要手动重启 uvicorn。
> 健康检查：`GET http://127.0.0.1:8003/api/health` → `{"ok": true}`。

### 2.3 第一次使用（空库）

打开 `http://127.0.0.1:5177/jobs`，点「**一键准备**」。
它按依赖顺序串行执行 9 个阶段，每步幂等、可中断续跑：

| 阶段 | key | 做什么 | 大致耗时 |
|---|---|---|---|
| 预热快照 | `seed` | 把 `backend/seed/*.csv.gz` 装进空库（库内有数据的表自动跳过）；只有 manifest 没有 gz 时自动改在线全量 | 数十秒 |
| ETF 清单 | `etf_list` | 拉全市场 ETF，写入 `etfs` | 秒级 |
| 交易日历 | `calendar` | 拉 A 股全部交易日，覆盖 `trade_calendar` | 秒级 |
| 日线行情 | `daily` | 逐只补日 K（快照之后增量 / 缺失全历史），前复权 | 秒级~数十分钟 |
| 指数日线 | `index` | 11 个宽基/风格指数全历史（中证官方） | 秒级~分钟 |
| 份额数据 | `shares` | 逐交易日全市场 ETF 份额（2015 起） | 分钟级 |
| 折算甄别 | `scale` | 识别份额整倍跳变是折算还是申赎，写 `etf_share_scale` | 秒级~分钟 |
| 换仓节点 | `core` | 每 5 个交易日一个节点，算 core8 持仓 | 秒级 |
| 日度记录 | `records` | 每个交易日一条复盘记录（T+1 结算） | 秒级~1 分钟 |

进度通过 `GET /api/data/bootstrap` 轮询，前端 `BootstrapCard` 每秒刷新。
**限流保护**：日 K 连续失败 25 次会中止本轮（`KlineBlocked`），重跑会从缺口继续。

### 2.4 日常使用

每个交易日收盘后（16:15 之后），如果后端一直运行，自动刷新链会自己完成数据更新（见 3.2）。
若后端是收盘后才启动，启动后的第一个 tick 会补跑当天已过点的槽位。

页面上的手动入口：

| 位置 | 操作 | 语义 |
|---|---|---|
| 数据任务页 | 一键准备 | 空库从零拉齐（幂等） |
| 数据任务页 | 单项任务 | 只跑 `refresh_etf_list` / `refresh_calendar` / `backfill_daily` / `backfill_shares` / `backfill_index` / `detect_share_conversions` |
| 数据任务页 | 调度状态卡 | 查看当前阶段、今晚完成槽位、下次执行时间 |
| 数据任务页 | 数据就绪度 | 缺口、异常值、份额/指数覆盖（只读审计） |
| 日度复盘页 | 回填换仓节点 | `POST /api/dailypick/core/rebuild`，改锚点/改因子后必须重跑 |
| 日度复盘页 | 重算全部 | `POST /api/dailypick/rebuild`，重算日度记录（依赖节点） |
| 今日页 | 手动刷新 | 清行情缓存并立即重建盘中预演与全量排名 |

### 2.5 开发检查（提交前必须全绿）

```bash
cd backend
../.venv/bin/ruff check .
../.venv/bin/ruff format --check .
../.venv/bin/mypy .
../.venv/bin/python -m pytest -q

cd ../frontend
npm run lint          # eslint，0 error（react-refresh warning 容忍）
npm run build         # tsc && vite build
```

有意容忍项（勿“顺手修”）：

- ruff `target=py39, line-length=120`，忽略 `DTZ005/DTZ007`（中国市场 naive datetime 约定）与 `BLE001`（第三方库宽异常）。
- mypy 忽略 `akshare/requests/apscheduler/fastapi/pydantic` 的缺失 stubs。
- eslint 关闭 `react-hooks/set-state-in-effect`、`react-hooks/refs`（React 18 合法模式）。
- tsc 开启 `noUnusedLocals/noUnusedParameters`：未用变量会让构建失败。

### 2.6 数据目录

| 路径 | 内容 | 是否进 git |
|---|---|---|
| `~/.dailyscope/dailyscope.db` | 运行时 SQLite（WAL） | 否（`.gitignore: *.db*`） |
| `backend/seed/` | 冷启动快照：11 份 gzip CSV + `manifest.json`，约 50 MB | **是** |
| `frontend/dist/` | 构建产物 | 否 |

`DAILYSCOPE_HOME` 环境变量可整体改数据目录（默认 `~/.dailyscope`）。

---

## 3. 运行机制：刷新链、调度与缓存

### 3.1 三条数据更新路径

| 路径 | 入口 | 用途 |
|---|---|---|
| 一键准备 | `ops/bootstrap.py` | 空库/换机从零拉齐，九阶段串行 |
| 单项任务 | `ops/jobs.py` | 只补某一类数据（清单/日历/日K/份额/指数/甄别） |
| 自动刷新链 | `ops/scheduler.py` → `ops/refresh_chain.py` | 每晚按槽位补齐增量并重算节点/记录 |

### 3.2 调度槽位（`ops/scheduler.py`）

```python
RUN_SLOTS = (("shares", (0, 20)), ("close", (18, 30)), ("late", (22, 30)))
CHECK_INTERVAL_SEC = 60        # 每 60 秒检查一次
RETRY_COOLDOWN_SEC = 30 * 60   # 失败后冷却 30 分钟
MAX_ATTEMPTS_PER_SLOT = 3      # 单槽位每晚最多 3 次
```

| 槽位 | 时刻 | 链 | 说明 |
|---|---|---|---|
| `shares` | 00:20 | `shares_chain` | 份额 T+1 于 00:00 后发布；强制重拉最近 4 个交易日，补算前一晚用 T-1 份额建出的节点，再重算最近记录 |
| `close` | 18:30 | `close_chain` | 日K增量 → 指数 → 份额 → 节点 → 日度记录 → 预热筛选快照 |
| `late` | 22:30 | `close_chain` | 等中证指数当晚发布后补一次 |

调度细节：

- 槽位“到点且当天未成功”就会执行；因此后端 21:00 才启动，也会补跑 18:30 的 `close`。
- 周末跳过行情链；**周六 00:20 的份额槽位照常跑**（周五份额周六凌晨才发布）。
- 失败不标记完成，冷却 30 分钟后重试；3 次仍失败则放弃当晚，下一槽位的链会自然补上。
- 主链全程受请求级全局节流，正常约 10 分钟。
- 「一键准备」运行期间自动链让路（避免两套全量拉取并发）；准备结束后未完成的槽位仍会按增量补跑。
- 状态通过 `GET /api/data/scheduler` 暴露：`state/slot/stage/signal_date/started_at/finished_at/detail/next_run/done`。

### 3.3 收盘主链 `close_chain`（`ops/refresh_chain.py`）

```
交易日历刷新
  → 当日 K 线（增量；16:15 后再拉一次覆盖盘中快照）
  → 指数日线（每晚都补，中证发布常晚于收盘）
  → 份额补缺（已覆盖日期跳过）
  → core8 节点：
        a) 日历上最新节点尚未落库 → 全量/增量重算
        b) 当天正是节点且已过 16:15 → 按收盘价重算当天节点
        c) 节点日份额已落地但此前用 T-1 份额算过 → 用完整排名重算该节点
  → 日度记录重算（缺口前一日开始；最近 N 日缺指数收益则起点前移）
  → 预热当天的筛选快照（warm）
```

### 3.4 份额链 `shares_chain`

```
刷新日历
  → 强制重拉最近 4 个交易日份额
  → 若最新节点当时只有 T-1 份额，现在份额已落地 → 用完整排名重算该节点
  → 重算最近交易日日度记录
  → 预热筛选快照
```

### 3.5 16:15 终值规则

`DAILY_FINAL_TIME = (16, 15)`。腾讯当日 K 线约 16:14 才刷出最终价，**16:15 前拉到的是盘中快照**。
因此：

- 16:15 之后每次 `backfill_daily` 都会重拉当天，用收盘价覆盖盘中值；
- 若当天恰好是换仓节点，主链会重算该节点；
- 日度记录的“最后一次落库”必须在 16:15 之后，否则节点价与次日揭示价对不上。

### 3.6 缓存体系（从慢到快）

| 层 | 位置 | 失效条件 | 量级 |
|---|---|---|---|
| 落盘筛选快照 | `fitted_daily_screen.payload`（zlib） | 日度记录 `generated_at` 或所属节点 `generated_at` 变化、`min_aum` 变化、`PAYLOAD_VERSION` 升级 | 全量约 3–4 MB JSON，压缩后约 0.6 MB |
| 进程内筛选缓存 | `screen/rank.py` `OrderedDict` | 120 s TTL；最多 3 个日期 | 单份约 3 MB |
| 盘中预演缓存 | `live/preview.py` 三个字典 | 交易时段 60 s；非交易时段 300 s；全量排名 600 s | 全量排名约 3 MB |
| 行情缓存 | `data/fetch/realtime.py` | 5 s TTL | 按代码 |
| K 线缓存 | `data/fetch/kline.py` | 60 s TTL；失败冷却 30 s | 按 (code, limit, 区间, fq) |
| 份额单日缓存 | `data/fetch/shares.py` | 进程生命周期（按日期） | 全市场当日份额 |

冷算筛选快照约 6.7–7.0 s；预热后读取约 0.1 s。因此所有“重算会改变 `generated_at`”的路径
（收盘链、份额链、两个手动重算线程）结束时都会调用 `cache.warm()` 预热最新交易日，
前端在快照未返回时先渲染带 `loading` 的左卡，避免布局跳动。

### 3.7 时点纪律的具体落点

| 场景 | 允许的数据 |
|---|---|
| 节点日 `T` 收盘评分 | 行情/指数到 `T`；份额到 `T-1`（预备排名） |
| `T+1` 凌晨份额落地后 | 用完整份额重算节点目标（决定开盘补买/顺延卖） |
| 日度记录 `T` | 持仓取 `T` 所属节点；收益 = `T` 收盘 → `T+1` 收盘（节点日按混合执行价） |
| 盘中预演 | 历史到上一交易日 + 今日实时合成 bar；**结果不落库** |
| 筛选漏斗 | 行情/份额/基准全部截到 `signal_date` |

MACD 使用全历史递推序列后再截取窗口，避免窗口起点失真，也不引用未来数据。

---

## 4. 项目结构（逐文件职责）

### 4.1 目录树

```
DailyScope/
├── .venv/                       # 项目虚拟环境（约定）
├── backend/
│   ├── main.py                  # FastAPI 入口：建表、启动调度、挂 4 个路由
│   ├── requirements.txt
│   ├── ruff.toml  mypy.ini  pytest.ini
│   ├── seed/                    # 冷启动快照（gzip CSV + manifest.json）
│   ├── scripts/build_seed.py    # 从现有 DB 导出快照
│   ├── data/                    # 原始数据层（可联网重建）
│   │   ├── config.py            # 路径/URL/超时/限速/指数清单等系统常量
│   │   ├── fetch/               # 7 个数据源适配器
│   │   └── store/               # SQLite 连接、建表、各表 repo
│   ├── ops/                     # 运维编排层
│   │   ├── background.py        # 后台任务执行器（线程/状态/进度）
│   │   ├── jobs.py              # 单项回填任务
│   │   ├── bootstrap.py         # 空库一键准备（九阶段）
│   │   ├── core_backfill.py     # 换仓节点回填
│   │   ├── refresh_chain.py     # 收盘链/份额链
│   │   ├── scheduler.py         # 槽位调度、重试、状态
│   │   └── seed.py              # 快照装载/导出
│   ├── services/                # 纯计算层（无 I/O）
│   │   ├── kline/               # 周月聚合、MACD、MACD 状态
│   │   └── scoring/             # 特征、core8 评分、换仓网格、描述子、理由文案、截面秩
│   ├── pages/                   # 页面领域层（API + 业务编排）
│   │   ├── daily/               # 日度复盘领域（router/review/screen/live/nodes）
│   │   ├── etf/router.py        # 清单/K线/份额/实时行情（只读）
│   │   └── jobs/                # /api/data 任务 + /api/dataset 就绪度
│   └── tests/                   # 28 个 pytest 文件
└── frontend/
    ├── vite.config.ts           # :5177，/api → 127.0.0.1:8003
    ├── package.json
    └── src/
        ├── App.tsx              # 4 个路由 + 顶部导航
        ├── api/                 # client.ts + 按领域拆分的 types
        ├── hooks/               # React Query 数据 hooks
        ├── components/          # daily / data / dataset / kline / common（daily 内共享列定义）
        └── pages/               # DailyReview / EtfList / EtfDetail / Jobs
```

### 4.2 后端逐文件职责

#### `data/`（原始数据层）

| 文件 | 职责 | 关键点 |
|---|---|---|
| `config.py` | 路径、数据源 URL、超时、限速、指数清单 | `HOME/DB_PATH` 可由 `DAILYSCOPE_HOME` 覆盖；`DAILY_FINAL_TIME=(16,15)`；`INDEX_CODES` 11 个 |
| `fetch/kline.py` | 腾讯日 K（默认前复权）+ 新浪降级 + 区间分块 | 两等价入口互备；单块约 850 自然日/650 根；全局 0.2 s 节流；连续失败 25 次抛 `KlineBlocked` |
| `fetch/realtime.py` | 腾讯批量实时行情 | `qt.gtimg.cn`，100 只/批、4 线程、5 s 缓存；GBK `~` 分隔；只有现价，无 IOPV |
| `fetch/shares.py` | 沪深两市 ETF 份额 | 上交所官网（全历史）+ 深交所 akshare；整日空结果重试 2 次、退避 5 s |
| `fetch/etf_list.py` | 全市场 ETF 清单 | 东财实时列表（akshare）优先；天天基金静态清单兜底（带 `fund_type`） |
| `fetch/calendar.py` | A 股交易日历 | akshare `tool_trade_date_hist_sina`，进程内缓存 |
| `fetch/index_kline.py` | 中证官方指数日线 | 全历史 + 成交量/成交额/成分数/市盈率；剔除接口伪造的首行 |
| `fetch/adjust.py` | 份额跳变甄别 | 未复权/前复权收盘比值台阶 ≥15% 判定折算 |

| `store/` 文件 | 职责 |
|---|---|
| `database.py` | 每线程一条连接（WAL + `busy_timeout=10000`），建原始层 schema |
| `etf_repo.py` | `etfs` upsert / 覆盖统计 / 用首根 K 线回填 `list_date` |
| `daily_repo.py` | `etf_daily` upsert（COALESCE）、区间/最新日/覆盖统计、时点回放查询 |
| `shares_repo.py` | `etf_shares` 写入与查询；跳变候选（倍率 ≥1.3）；`etf_share_scale` 读写 |
| `index_repo.py` | `indices` + `index_daily` 读写、全历史收盘、时点回放 |
| `calendar_repo.py` | `trade_calendar` 全量替换、区间查询、最近交易日 |

#### `ops/`（运维编排层）

| 文件 | 职责 |
|---|---|
| `background.py` | 后台任务执行器：线程、运行状态、进度与失败兜底；`/api/data` 与 `/api/dailypick` 共用 |
| `jobs.py` | `refresh_etf_list` / `refresh_calendar` / `backfill_daily` / `backfill_shares` / `backfill_index` / `detect_share_conversions`；日 K 区间规划（无历史/被旧下限截断/区间缺根 → 全量重拉，否则只补最新日） |
| `bootstrap.py` | 九阶段一键准备，后台线程 + 阶段进度 |
| `core_backfill.py` | 从 `CORE_ANCHOR` 起每 5 个交易日一个节点；持仓沿节点延续；预留“从快照后续跑” |
| `refresh_chain.py` | 收盘链/份额链的具体步骤与筛选快照预热 |
| `scheduler.py` | 三槽位调度、30 分钟冷却、每晚 3 次上限、周末规则、状态暴露 |
| `seed.py` | 快照装载（按表跳过已有数据）与导出（派生表按 cutoff 截断） |

#### `services/`（纯计算层）

| 文件 | 职责 |
|---|---|
| `kline/aggregate.py` | 日 K → 周 K（ISO 周）/月 K |
| `kline/macd.py` | MACD(12,26,9)；柱体较上一根上行=走强，符号定水上/水下 |
| `kline/states.py` | 日/周/月 MACD 状态、趋势分、全历史 `MacdStateProvider` |
| `scoring/ranks.py` | 截面平均秩（并列取平均）：因子 `rank_z`、分位与 Rank IC 共用 |
| `scoring/features.py` | 候选池、特征构造、基线分、`is_a_share`、MACD 附加 |
| `scoring/core/score.py` | core8 八因子、固定权重、秩变换、高位高波扣分、因子拆解 |
| `scoring/core/rebalance.py` | 换仓网格、`should_rebalance`、目标持仓（缓冲带） |
| `scoring/core/data.py` | core8 取数与单日评分（节点回填使用） |
| `scoring/core/store.py` | `fitted_core_summary` / `fitted_core_pick` 读写 |
| `scoring/descriptors/slices.py` | 时点切片：行情/份额窗口 |
| `scoring/descriptors/cross_section.py` | 多因子分位、主题相对强度、相对沪深 300 超额与敏感度 |
| `scoring/descriptors/factors.py` | 52 周位置、均线结构、风险调整动量、回撤、胜率、beta |
| `scoring/descriptors/profile.py` | 成交额/换手/量比/缩量回撤画像 |
| `scoring/descriptors/scale.py` | 份额口径归一（折算不是申赎） |
| `scoring/descriptors/themes.py` | 名称 → 主题归一 |
| `scoring/reason/core8.py` | core8 入选理由（排名 + 原始画像） |
| `scoring/reason/ranking.py` | 基线入选理由（因子明细 + 综合分） |

#### `pages/`（页面领域层）

| 文件 | 职责 |
|---|---|
| `daily/router.py` | `/api/dailypick/*` 全部接口；两个后台重算任务（日度记录、换仓节点，经 `ops/background.py`），结束后预热快照 |
| `daily/nodes.py` | 节点列表/明细/持仓时间线：区间收益、TOP10 与沪深 300 对照、真实成交价 |
| `daily/review/build.py` | 逐日复盘：切片 → 特征 → 评分 → 读节点持仓 → T+1 结算 → 落库 |
| `daily/review/execution.py` | 节点混合执行：周四收盘卖 / 周五开盘卖 / 继续持有 / 周五开盘买 |
| `daily/review/evaluate.py` | 事后评估：股票池/基线/core 的次日收益、命中率、Rank IC |
| `daily/review/attribution.py` | 归因：逐日收益序列、累计复利、年线门控、换手率 |
| `daily/review/store.py` | `fitted_daily_summary` / `fitted_daily_pick` 读写 |
| `daily/screen/rank.py` | 九级漏斗 + 全量排名行（不落库，`build()` 返回中间结果） |
| `daily/screen/cache.py` | 落盘快照读取入口：`build_cached` / `warm` |
| `daily/screen/store.py` | `fitted_daily_screen` 读写与有效性键 |
| `daily/live/context.py` | 盘中取数：实时价合成今日 bar、历史上下文、节点收盘价、当前持仓 |
| `daily/live/preview.py` | 盘中预演：目标持仓、全量排名、手动刷新；结果不落库 |
| `daily/live/rows.py` | 盘中全量排名行（与收盘筛选同构） |
| `etf/router.py` | 清单、K 线（日/周/月 + MACD）、MACD 状态、份额、批量实时行情 |
| `jobs/router.py` | `/api/data/*`：单项任务（统一由 `jobs.run_job` 分发）、一键准备、调度状态 |
| `jobs/readiness.py` | `/api/dataset/*`：缺口、异常值、份额/指数覆盖（只读审计） |

### 4.3 前端结构

| 目录 | 文件 | 职责 |
|---|---|---|
| 根 | `App.tsx` | 导航：日度复盘 / 标的清单 / 数据任务；路由 `/`、`/etf/:code`、`/daily`、`/jobs` |
| `api/` | `client.ts` | 全部 HTTP 封装（超时、错误解析、重型接口长超时） |
| `api/types/` | `daily.ts` `dailyLive.ts` `dailyScreen.ts` `dataset.ts` `etf.ts` `jobs.ts` | 按领域拆分的类型，`types.ts` 聚合出口 |
| `hooks/` | `useDailyPick.ts` | 日度列表/明细/实时/排名/筛选/节点/时间线/归因/重算状态 |
| | `useEtfs.ts` `useQuotes.ts` | 清单/K线/MACD/份额；实时行情（交易时段 15 s，非交易 60 s） |
| | `useJobs.ts` `useDataset.ts` | 任务状态 1.5 s 轮询、调度状态、一键准备；数据就绪度 |
| `components/daily/` | `TodayPanel` | 今日页：双卡 → K 线 → 全量排名 |
| | `TopRankCard` `HoldingCard` | 左卡 TOP10 / 右卡当前持仓（排名「节点→今日」、节点涨跌、本轮等权） |
| | `NodePanel` `NodeDetailCard` `TimelineTable` | 节点页：节点列表、节点明细、持仓区间 |
| | `HistoryPanel` `HistoryTable` `AttributionPanel` `SummaryCards` | 历史页：逐日记录、归因曲线与年线门控、汇总卡 |
| | `ScreenRanking` `ScreenRowDetail` `screenColumns` | 全量排名表与行展开（因子拆解） |
| | `LiveKlinePanel` `ExpandedKline` | 今日 K 线与节点展开 K 线 |
| | `FactorBreakdown` `factorFormat` `rankBounds` `actionMeta` `actionTag` `ruleLabel` `quoteColumns` `linkColumns` `window` `gatedOption` `attributionOption` | 因子展示、代码/名称链接列、常量、列定义、区间与图表 option 纯函数 |
| `components/kline/` | `MacdStatePanel` `candleOption` `sharesOption` | MACD 状态卡、K 线 option、份额 option |
| `components/data/` | `BootstrapCard` | 一键准备进度 |
| `components/dataset/` | `DatasetReadiness` | 数据就绪度审计 |
| `components/common/` | `format.ts` | 数字/百分比/颜色格式化、`todayStr` |

### 4.4 依赖方向

```
data/fetch  →  services/*  →  pages/*  →  main.py
data/store  ↗        ops/*  ──────────┘
```

- `services/` 不 import `data/store`（纯计算）；
- `pages/*` 负责取数、调用纯函数、落库；
- `ops/*` 是编排层，允许调用各领域 analysis 与 store；
- 反向引用禁止。

### 4.5 测试清单（`backend/tests/`，28 个文件）

| 主题 | 文件 |
|---|---|
| 数据源解析 | `test_kline.py` `test_realtime.py` `test_index_kline.py` `test_etf_list.py` |
| 存储与时点 | `test_store.py` `test_seed.py` |
| 编排与调度 | `test_jobs.py` `test_bootstrap.py` `test_refresh_scheduler.py` `test_background.py` |
| 评分与特征 | `test_daily_core.py` `test_daily_core_backfill.py` `test_kline_states.py` `test_macd.py` `test_ranks.py` |
| 复盘与记录 | `test_daily_build_day.py` `test_daily_records.py` `test_execution.py` |
| 筛选与实时 | `test_daily_screen.py` `test_daily_screen_cache.py` `test_daily_live.py` `test_live_rows.py` |
| 节点与接口 | `test_daily_nodes.py` `test_etf_router.py` `test_dataset.py` |
| 夹具 | `conftest.py` `daily_seed.py` |

---

## 5. 计算口径：从全市场到 5 只持仓

### 5.1 九级筛选漏斗（`screen/rank.py`）

| 级 | key | 条件 | 被筛掉的含义 |
|---|---|---|---|
| 1 | `etfs` | `etfs` 表全部标的 | — |
| 2 | `equity` | `fund_type = "指数型-股票"` | QDII/债券/货币等 |
| 3 | `a_share` | 名称不含 港股/恒生/恒指/香港/H股/沪港深/沪深港/AH | 非 A 股底层 |
| 4 | `with_bar` | 信号日有 K 线 | 停牌/未上市/未回填 |
| 5 | `history` | ≥62 根日 K，近 61 日收盘与近 20 日成交量有效 | 历史太短/数据异常 |
| 6 | `shares` | 库内有 `date <= signal` 的份额 | 无法算规模 |
| 7 | `aum` | `aum_yi = 收盘 × 份额 ≥ 2 亿` | 规模不足 |
| 8 | `core_pool` | 进入 core8 截面评分 | — |
| 9 | `core_hold` | 前 5 名 + 已持有且排名仍在前 15 | 缓冲带之外 |

另有一条**并行分支**：基线前 10（`baseline_score` 降序，不做策略过滤），作为“无观点对照组”。

每只 ETF 在响应 `rows` 中带有：到达的最深一级、剔除原因、评分、`core8_rank`、`core8_score`、
因子明细、`node_close`、`node_date` 等（`PAYLOAD_VERSION=2`）。

### 5.2 特征（`services/scoring/features.py`）

- 回溯窗口：`HISTORY_DAYS=270` 个交易日；份额 `SHARES_HISTORY_DAYS=40`；5 日份额增速用 6 个点（首点为基期）。
- 规模：`aum_yi = 收盘价 × 份额(亿份)`；门槛 `DEFAULT_MIN_AUM_YI=2.0` 亿。
- 基线分 `baseline_score`：趋势分权重 0.60（MACD 定方向），多因子只做确认；`TREND_WEIGHT=0.60`。
- 异常标记：`EXT_FLOW=0.50`（5 日份额增长 >50% 视为拥挤）、`EXT_VOL=0.45`（年化波动 >45% 视为高波动）。
- MACD 状态：日/周/月分别给“收敛扩散 + 水上水下”；周线跳过未确认的当周。

### 5.3 core8 评分（`services/scoring/core/score.py`）

对第 8 级候选池做**截面秩变换**，再按固定符号加权：

```
score_i = Σ_k  w_k · rank_z(feature_k,i)  −  high_vol_penalty_i
```

| 因子 | 含义 | 权重 | 方向 |
|---|---|---|---|
| `dd60` | 60 日回撤 | +0.20 | 回撤越深越好（均值回复） |
| `z20` | 20 日超跌 | +0.20 | 越超跌越好 |
| `r250` | 250 日动量 | +0.10 | 长动量越强越好 |
| `vol20` | 20 日年化波动 | −0.15 | 高波动扣分 |
| `flow_z_60` | 5 日份额拥挤 | −0.15 | **反向因子**：净流入越多后续越弱 |
| `amount_z_60` | 5 日放量 | −0.10 | 放量扣分 |
| `hist_norm` | MACD 柱体强度（相对日波动） | +0.10 | 柱体走强加分 |
| `zero_cross_age` | MACD 穿轴天数 | +0.10 | 穿轴越久越加分 |

**高位高波单边扣分**（只减不加）：

```
vol20 ≥ 0.45 且 收盘 ≥ 250 日最高价 × (1 − 0.03)   →   总分 −0.10
```

定位是尾部保险而非 alpha：宽口径（−0.20 / 10%）会在熔涨日把最强动量名换出，反而跑输。

权重/因子符号是**固定**的，不做年度重估。岭回归重新定权在扩张窗口 OOS 为负，已弃用。
改因子后必须重跑：换仓节点 → 日度记录 → 筛选快照。

### 5.4 换仓网格与缓冲带（`core/rebalance.py`）

```python
CORE_ANCHOR = "2015-01-05"   # 网格锚点：第 1/6/11... 个交易日
REBALANCE_EVERY = 5          # 每 5 个交易日换仓
HOLD_TOP = 5
HOLD_BUFFER_RANK = 15        # 已持有名字跌出前 15 才卖
```

目标持仓：

```
kept = [已持有 c 且 rank(c) < HOLD_BUFFER_RANK][:HOLD_TOP]   # 最多 5 个继续持有
再从排名榜依次补入不在 kept 里的标的，直到凑满 HOLD_TOP
```

等价说法：跌出前 15 才卖，空位按排名补足；持仓在节点之间延续。

缓冲带的价值（代码注释中的回测口径）：每期换出从 3.79/5 降到 2.90/5，净收益 8.7%/年；
前 5 全换会多付约 1.1 pp/年的跳价与佣金成本。

**改锚点会平移整条网格**，必须重跑节点 + 日度记录，并清掉旧网格的筛选快照，否则两套节点会并存。

### 5.5 混合执行结算（`review/execution.py`）

节点日 `T` 收盘时只能拿到 `T-1` 份额，因此“预备排名”与“完整排名”可能差约 1 只：

| 腿 | 触发 | 成交价 |
|---|---|---|
| 周四收盘卖 `sell_close` | 已持有且预备排名缺失或 ≥15 | `T` 收盘 |
| 周五开盘卖 `sell_open` | 预备排名仍在缓冲带，但完整目标不要 | `T+1` 开盘 |
| 继续持有 `keep` | 两版都在目标里 | 不动 |
| 周五开盘买 `buy` | 完整目标有、原持仓没有 | `T+1` 开盘 |

区间收益按**真实成交价**计算：新买入只承担开盘→收盘；顺延卖出吃到收盘→次日开盘的跳空；
分母取节点前后较大仓位槽数，空槽按现金 0 计。

### 5.6 日度记录（`review/build.py`）

每个交易日一条 `fitted_daily_summary` + 两组成员逐笔 `fitted_daily_pick`（`bucket=core|baseline`）：

- 持仓：取 `signal_date` 所属的换仓节点（`bisect_right` 找最近节点，间隔期沿用）；
- 结算：节点日走混合执行价，其余交易日 `T` 收盘 → `T+1` 收盘；
- 评估：股票池/基线/core 的均值、中位数、命中率、Rank IC；
- 早于第一个节点的交易日没有持仓，只记录股票池与基线作参照；
- `RULE_VERSION = "daily-core8-v1"`，`DEFAULT_START = "2015-01-05"`（份额数据起点）。

节点持仓来自 `fitted_core_pick`（节点是真源），所以**必须先回填节点，再重算日度记录**。

### 5.7 盘中预演（`live/preview.py`）

- 拉全市场实时行情（100 只/批、4 线程），对“库里还没有今日 K 线”的标的用现价合成今日 bar；
- 复用同一套特征与 core8 评分；
- 持仓取 `node_at(上一交易日)` 的节点；若今天是换仓日，目标 = 按今日实时排名重算的缓冲带结果；
- 结果只进进程内缓存，**不落库**；
- 收盘后若已有正式记录，`/live` 直接让位（返回 `live=false`），前端切到收盘快照。

### 5.8 归因（`review/attribution.py`）

- 逐日序列：`core` / `baseline` / `universe` / `hs300`；
- 累计：逐日复利；
- 年线门控：沪深 300 收盘严格 `> MA250` 记为 `above`，只统计 `above` 日的 core 收益（`gated_cumulative`）；
- 换手率：相邻记录 core 名单的 `1 − overlap/max(n_prev, n_now)` 均值。

---

## 6. 数据表结构

数据库：`~/.dailyscope/dailyscope.db`（SQLite，WAL）。共 **12 张表、4 个索引**。

### 6.1 原始数据表（可联网重建）

#### `etfs` — ETF 清单

| 列 | 类型 | 说明 |
|---|---|---|
| `code` | TEXT PK | 6 位场内代码（`51/52/56/58` 沪，`15/16` 深） |
| `name` | TEXT NOT NULL | 基金简称 |
| `fund_type` | TEXT | 如“指数型-股票”；主源不提供时为 NULL（见 7.1 已知边界） |
| `list_date` | TEXT | 上市日；可用首根 K 线回填 |
| `track_index` | TEXT | 跟踪指数（当前未建映射，为空） |
| `updated_at` | TEXT | 最近一次清单刷新时间 |

写入：`etf_repo.upsert_list`（COALESCE 保护 `fund_type`，不清空未出现在快照中的老标的）。
读取：筛选/特征/回填任务。

#### `etf_daily` — 日 K（前复权）

| 列 | 类型 | 说明 |
|---|---|---|
| `date` | TEXT | `YYYY-MM-DD` |
| `code` | TEXT | ETF 代码 |
| `open/close/high/low` | REAL | 前复权 OHLC |
| `volume` | REAL | 成交量（腾讯原始单位） |

主键 `(date, code)`；索引 `idx_daily_code_date (code, date)`。
写入：`daily_repo.upsert_rows`（逐批、COALESCE）。读取：K 线、特征、结算、漏斗。

#### `etf_shares` — 份额

| 列 | 类型 | 说明 |
|---|---|---|
| `date` | TEXT | 份额所属交易日（T+1 发布） |
| `code` | TEXT | ETF 代码 |
| `shares_yi` | REAL | 份额（亿份） |

主键 `(date, code)`；索引 `idx_shares_code_date (code, date)`。
写入：`shares_repo.upsert_day`（只写在册标的）。读取：规模、份额拥挤因子、折算甄别。

#### `etf_share_scale` — 份额跳变甄别结果

| 列 | 类型 | 说明 |
|---|---|---|
| `code` | TEXT | ETF 代码 |
| `date` | TEXT | 跳变日 |
| `ratio` | REAL NOT NULL | 当日份额 / 前一日份额 |
| `method` | TEXT NOT NULL | `split`=折算/合并；`flow`=真实申赎 |
| `detected_at` | TEXT | 甄别时间 |

主键 `(code, date)`；索引 `idx_share_scale_date (date)`。
用途：`scale.normalize` 做份额口径归一，避免把 1:5 折算记成 +400% 申购。

#### `trade_calendar` — 交易日历

| 列 | 类型 | 说明 |
|---|---|---|
| `date` | TEXT PK | 交易日 |

全量替换（`calendar_repo.replace_all`），是“哪天应该有数据”的唯一口径。

#### `indices` — 指数元数据

| 列 | 类型 | 说明 |
|---|---|---|
| `code` | TEXT PK | 指数代码（如 `000300`） |
| `name` | TEXT | 指数简称 |
| `updated_at` | TEXT | 更新时间 |

#### `index_daily` — 指数日线（中证官方）

| 列 | 类型 | 说明 |
|---|---|---|
| `date` | TEXT | 交易日 |
| `code` | TEXT | 指数代码 |
| `open/close/high/low` | REAL | 指数点位 |
| `volume` | REAL | 成交量（股） |
| `amount_yi` | REAL | 成交额（亿元） |
| `cons_number` | REAL | 成分股数量 |
| `pe` | REAL | 市盈率（接口字段名 `peg`，实测为 PE） |

主键 `(date, code)`；索引 `idx_index_daily_code_date (code, date)`。
当前配置 11 个指数：上证、上证 50、沪深 300、科创 50、中证 1000、中证 500、中证 800、中证红利、中证 800 消费、中证全指、中证 2000。

### 6.2 派生表（可由代码重建）

#### `fitted_core_summary` — 换仓节点汇总

| 列 | 类型 | 说明 |
|---|---|---|
| `signal_date` | TEXT PK | 节点日 |
| `next_rebalance` | TEXT | 下一节点日 |
| `generated_at` | TEXT | 生成时间（筛选快照的有效性键之一） |
| `rule_version` | TEXT | 规则版本 |
| `scored` | INTEGER | 当日候选池数量 |
| `min_aum_yi` | REAL | 规模门槛 |
| `complete` | INTEGER NOT NULL DEFAULT 1 | 是否用完整份额算出（0=T-1 份额，待补算） |

#### `fitted_core_pick` — 节点持仓/卖出/评分榜

| 列 | 类型 | 说明 |
|---|---|---|
| `signal_date` | TEXT | 节点日 |
| `code` | TEXT | ETF 代码 |
| `name` | TEXT | 名称 |
| `core_rank` | INTEGER NOT NULL | 当日截面排名 |
| `core_score` | REAL NOT NULL | core8 总分 |
| `held` | INTEGER NOT NULL DEFAULT 0 | 是否在节点目标持仓内 |
| `action` | TEXT NOT NULL | `hold` / `buy` / `sell` |
| `factors_json` | TEXT | 8 因子原始值与 z 值（前端拆解用） |
| `pre_rank` | INTEGER | 用 T-1 份额算出的预备排名 |

主键 `(signal_date, code)`。`action` 与 `held` 的组合决定混合执行的腿。
`pre_rank` 缺失表示已掉出候选池（周四收盘卖）。

#### `fitted_daily_summary` — 日度复盘汇总

| 列 | 类型 | 说明 |
|---|---|---|
| `signal_date` | TEXT PK | 信号日 |
| `next_signal` | TEXT | 下一交易日（结算日） |
| `generated_at` | TEXT | 生成时间 |
| `rule_version` | TEXT | `daily-core8-v1` |
| `codes_with_bar` | INTEGER | 当日有 K 线的标的数 |
| `codes_with_enough_history` | INTEGER | 历史足够的标的数 |
| `scored` | INTEGER | 候选池数量 |
| `min_aum_yi` | REAL | 规模门槛 |
| `shares_available` | INTEGER | 有份额的标的数 |
| `universe_mean/median/hit` | REAL | 全股票池次日收益均值/中位/命中率 |
| `baseline_mean/median/hit` | REAL | 基线前 10 的结算 |
| `core_mean/median/hit` | REAL | core8 持仓的结算（混合执行价） |
| `rank_ic` | REAL | 评分与次日收益的 Spearman 相关 |
| `eval_json` | TEXT | 评估明细（含逐只收益、跳过原因） |
| `index_returns_json` | TEXT | 各指数次日收益，键为指数代码（含 `000300`） |

#### `fitted_daily_pick` — 日度逐笔记录

| 列 | 类型 | 说明 |
|---|---|---|
| `signal_date` | TEXT | 信号日 |
| `bucket` | TEXT | `core`（策略持仓）或 `baseline`（基线前 10） |
| `pick_rank` | INTEGER | 桶内序号 |
| `code` / `name` | TEXT | 标的 |
| `theme` | TEXT | 主题 |
| `fund_type` | TEXT | 基金类型 |
| `baseline_score` | REAL | 基线分 |
| `reason_text` | TEXT | 可独立读懂的入选理由 |
| `reason_json` | TEXT | 因子明细（前端展开） |
| `next_return` | REAL | 次日收益（节点日按混合执行价） |

主键 `(signal_date, bucket, pick_rank)`。

#### `fitted_daily_screen` — 单日筛选快照

| 列 | 类型 | 说明 |
|---|---|---|
| `signal_date` | TEXT PK | 信号日 |
| `day_generated_at` | TEXT | 写入时该日度记录的 `generated_at` |
| `node_generated_at` | TEXT | 写入时所属节点汇总的 `generated_at` |
| `min_aum_yi` | REAL | 规模门槛 |
| `generated_at` | TEXT | 快照生成时间 |
| `payload` | BLOB | zlib 压缩的 JSON（漏斗 + 全量行 + 因子明细） |

有效性键 = `(day_generated_at, node_generated_at, min_aum_yi, PAYLOAD_VERSION)`；
任一变化即视为失效，读取时重算并覆盖。这份表是“页面左卡秒开”的关键。

---

## 7. 数据来源与抓取规则

### 7.1 ETF 清单

| 项 | 内容 |
|---|---|
| 主源 | 东方财富实时列表，经 akshare `fund_etf_spot_em()`（代码/名称/最新价/成交额） |
| 兜底 | 天天基金静态清单 `https://fund.eastmoney.com/js/fundcode_search.js`（代码/名称/类型） |
| 过滤 | 前缀 `51/52/56/58/15/16`；名称含 `ETF` 且不含“联接” |
| 频率 | 手动/一键准备时刷新 |
| 已知边界 | 主源不带 `fund_type`；主源成功时新代码的 `fund_type` 为 NULL。存量值由 COALESCE 保留。若新标的未进入漏斗，先检查 `fund_type` 是否为空 |

### 7.2 日 K（ETF）

| 项 | 内容 |
|---|---|
| 主源 | 腾讯，两个等价入口互备：<br>`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get`<br>`http://web.ifzq.gtimg.cn/appstock/app/fqkline/get` |
| 参数 | `param={symbol},day,{start},{end},{limit},{fq}`；`symbol` 前缀 `sh`/`sz`；`fq=qfq` 前复权（甄别模块用 `fq=""` 未复权） |
| 降级 | 新浪 `https://quotes.sina.cn/.../CN_MarketDataService.getKLineData`（未复权、不支持日期区间） |
| 分块 | 从最新往前每块 850 自然日 / 650 根；取到上市首日即停 |
| 限速 | 全局最小请求间隔 0.2 s；并发 6 线程；连续失败 25 次抛 `KlineBlocked` 中止本轮 |
| 缓存 | 内存 60 s；失败冷却 30 s |
| 边界 | 腾讯单次上限约 640 根；大区间必须分块，否则中间段永久缺口 |
| 回填策略 | 无历史 / 首日停在旧下限 2015-01-05 / 区间缺根过半 → 全量重拉；其余只补最新日之后；16:15 后额外重拉当天 |

### 7.3 实时行情

| 项 | 内容 |
|---|---|
| 源 | 腾讯 `https://qt.gtimg.cn/q={symbols}` |
| 编码/格式 | GBK，`~` 分隔；字段下标：1 名称、3 现价、4 昨收、5 开盘、6 成交量、30 时间、31 涨跌、32 涨跌幅、33 最高、34 最低、37 成交额（万） |
| 批量 | 100 只/批、4 线程并发 |
| 缓存 | 5 s；上游异常沿用旧值或返回空，不抛错 |
| 交易时段 | 09:15–11:30、13:00–15:00；页面有交易日历时再排除法定节假日 |
| 语义 | 只有二级市场现价，**没有 IOPV/参考净值**；前端统一标“现价” |

### 7.4 份额

| 市场 | 源 | 说明 |
|---|---|---|
| 上交所 | `https://query.sse.com.cn/commonQuery.do`（`sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`） | 按 `STAT_DATE` 取历史；`TOT_VOL/1e4` → 亿份；带 Referer |
| 深交所 | akshare `fund_scale_daily_szse(start_date, end_date, symbol="ETF")` | `基金份额/1e8` → 亿份 |
| 合并 | 两市字典合并；只写在册标的 | 整日空结果重试 2 次，退避 5 s |
| 发布节奏 | T+1（约 T+1 日 00:00 后） | 收盘后用 T 日份额会为空，属正常 |
| 回填起点 | `BACKFILL_START_DATE = 2015-01-01` | 更早无份额，无法算规模与 core8 |

### 7.5 交易日历

| 项 | 内容 |
|---|---|
| 源 | akshare `tool_trade_date_hist_sina()` |
| 形态 | 全部 A 股交易日，升序 `YYYY-MM-DD` |
| 写入 | 全量替换 `trade_calendar` |

### 7.6 指数日线

| 项 | 内容 |
|---|---|
| 源 | 中证指数官方<br>`https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode={code}&startDate={start}&endDate={end}` |
| 字段映射 | `tradeDate→date`、`open/close/high/low`、`tradingVol→volume`、`tradingValue→amount_yi`（亿元）、`consNumber→cons_number`、`peg→pe` |
| 起点 | `CSINDEX_START_DATE = 1990-01-01` |
| 间隔 | 指数之间 0.5 s |
| 特殊处理 | 接口会把首行日期强制改成请求起点、数值复制第二个真实交易日 → 按“与次行完全同值”识别并剔除 |
| 为何不用腾讯 | 腾讯/新浪只给最近 650–1023 根，且不支持中证自编指数，长周期截面回测不够 |

### 7.7 份额折算甄别

| 项 | 内容 |
|---|---|
| 思路 | 折算日未复权价按 `1:ratio` 缩小，前复权价连续 → `raw/qfq` 出现台阶；真实申赎不改这个比值 |
| 候选 | 单日份额倍率 ≥1.3 或 ≤1/1.3 |
| 样本 | 跳变日前后各 12 自然日、各取 3 个边缘样本，避开台阶中间 |
| 阈值 | 比值台阶 ≥15% 判 `split`；否则 `flow` |
| 输出 | `etf_share_scale`；`no_history`（本地无前史）与 `unknown` 只计数不写库 |

---

## 8. HTTP 接口一览

### 8.1 `/api/etfs`（标的清单/K 线，只读）

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/etfs` | — | 清单 + 每只 K 线/份额覆盖 |
| GET | `/api/etfs/quotes` | `codes=a,b,...` ≤100 | 批量实时行情 |
| GET | `/api/etfs/{code}/history` | `limit` 1–6000（默认 800） | 原始日 K |
| GET | `/api/etfs/{code}/kline` | `period=day|week|month`、`limit`、`live`、`end` | 指定周期 + MACD（全历史算后截窗） |
| GET | `/api/etfs/{code}/macd-states` | — | 日/周/月 MACD 状态 |
| GET | `/api/etfs/{code}/shares` | `limit` 1–5000 | 份额序列 |

### 8.2 `/api/data`（任务）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/data/jobs` | `{job, start_date?, end_date?}`；同一任务同时只跑一个 |
| GET | `/api/data/jobs` | 各任务状态（running/done/failed） |
| GET | `/api/data/scheduler` | 自动刷新链状态 |
| POST | `/api/data/bootstrap` | 启动一键准备（有任务在跑时 409） |
| GET | `/api/data/bootstrap` | 九阶段进度 |

任务名：`refresh_etf_list`、`refresh_calendar`、`backfill_daily`、`backfill_shares`、`backfill_index`、`detect_share_conversions`。

### 8.3 `/api/dataset`（就绪度，只读）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dataset/summary` | 日历跨度、日 K/份额/指数覆盖、缺口 TOP5、异常值 |
| GET | `/api/dataset/indices` | 配置内 11 个指数的覆盖（未入库也列出） |

口径提醒：缺口 = `[首根,末根]` 间交易日槽位 − 实际行数，停牌也计入，是“待解释项”而非错误；
异常值只标记零/负价格、零量、单日涨跌 >30%，不做自动修复。

### 8.4 `/api/dailypick`（日度复盘）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/days` | 日度记录列表（轻量字段），可带 `start/end` |
| GET | `/days/{signal_date}` | 单日完整记录（含两桶逐笔与评估） |
| GET | `/days/{signal_date}/screen` | 九级漏斗 + 全量排名（走落盘快照） |
| GET | `/live` | 盘中预演轻量包（目标/持仓/元信息）；收盘后让位正式记录 |
| GET | `/live/ranking` | 盘中全量实时排名（约 3 MB） |
| POST | `/live/refresh` | 清缓存立即重建，返回耗时 |
| GET | `/attribution` | 逐日收益、累计、年线门控、换手 |
| POST | `/rebuild` | 后台重算日度记录 |
| GET | `/status` | 日度重算状态 |
| GET | `/core` | 某日所属节点的持仓（带节点收盘价） |
| GET | `/nodes` | 节点列表 + 区间收益 + TOP10/沪深 300 对照 |
| GET | `/nodes/{signal}` | 单节点明细（持仓/卖出/前 20 评分榜） |
| GET | `/timeline` | 持仓区间（连续持有合并） |
| POST | `/core/rebuild` | 后台回填换仓节点 |
| GET | `/core/status` | 节点回填状态 |

---

## 9. 前端页面与组件

### 9.1 路由

| 路径 | 页面 | 内容 |
|---|---|---|
| `/daily` | `DailyReview` | 今日 / 节点 / 历史 三个 tab |
| `/` | `EtfList` | 全市场清单 + 覆盖状态筛选 + 搜索 |
| `/etf/:code` | `EtfDetail` | 日/周/月 K + MACD 状态 + 份额曲线 |
| `/jobs` | `Jobs` | 一键准备、单项任务、调度状态、数据就绪度 |

### 9.2 今日页（`TodayPanel`）

```
┌───────────────────────────┬───────────────────────────┐
│ TopRankCard               │ HoldingCard               │
│ 今日实时/收盘 TOP10       │ 当前持仓（节点→今日排名） │
│ 买入区=前 5               │ 节点涨跌 / 本轮等权       │
└───────────────────────────┴───────────────────────────┘
                    LiveKlinePanel（点行切换）
                    ScreenRanking（全量排名，行展开因子）
```

- 盘中：左卡用实时排名；右卡持仓排名为“节点时 → 今日实时”。
- 收盘后：`/live` 返回 `live=false`，左卡改用当日收盘快照（`/days/{date}/screen`）的策略排名；
  快照未返回时左卡先以 `loading` 占位，避免右卡先满宽再被挤开。
- 「节点涨跌」= 现价 / 节点日收盘 − 1；「本轮等权」= 各持仓节点收盘→现价收益的等权平均（缺价剔除）。

### 9.3 节点页（`NodePanel`）

- 节点列表：节点日、下节点日、持仓、`hold/buy/sell` 计数、区间等权收益、TOP10 对照、沪深 300 对照。
- 点开节点：持仓/卖出/评分前 20 的当日价、真实成交价（开盘/收盘）、区间收益；
  展开行显示 K 线并标出节点日。
- `TimelineTable`：同一标的连续持有的节点合并为一段，用于核对买卖节奏。

### 9.4 历史页（`HistoryPanel`）

- `SummaryCards`：天数、core/baseline/universe 累计与均值、Rank IC。
- `AttributionPanel`：逐日收益与累计曲线；可切“年线开关”（仅 MA250 之上持有）。
- `HistoryTable`：逐日记录，点行展开当日 core/baseline 明细。
- 顶部「重算全部」：全量重算约 15 分钟，进度条轮询 `/status`；完成后自动 invalidate 查询。

### 9.5 数据任务页（`Jobs`）

- `BootstrapCard`：九阶段状态与整体百分比（`/api/data/bootstrap`，1 s 轮询）。
- 单项任务卡：每个任务的运行状态与结果。
- 调度卡：当前槽位/阶段/下次执行/今晚完成情况。
- `DatasetReadiness`：缺口、异常值、份额折算覆盖、指数覆盖。

---

## 10. 数据重建、快照与迁移

### 10.1 冷启动快照（`backend/seed/`）

为什么需要：在线全量回填要拉 1700+ 只 ETF 的全历史日 K 与 2015 年起逐日全市场份额，
网络与限流成本高；派生层全量重算也要十几分钟。快照把原始表与派生表一起固化成 gzip CSV（约 50 MB），
空库先本地装载到 `cutoff` 日，再在线补增量。

`manifest.json` 记录：

```json
{
  "generated_at": "…",
  "cutoff": "YYYY-MM-DD",          // etf_daily 最新日
  "derived_cutoff": "YYYY-MM-DD",  // 派生表截断日
  "tables": { "<table>": { "rows": N, "columns": [...], "file": "<table>.csv.gz" } }
}
```

装载规则（`ops/seed.py`）：

- 共 11 张表：7 张原始表 + 4 张派生表（`fitted_daily_screen` 不进快照，按需重算）；
- **目标表已有数据就整表跳过**，因此重复执行安全；
- 按 `PRAGMA table_info` 的声明类型转换数值，避免 REAL 被写成文本（否则排序退化为字符串比较）；
- 派生表按 `signal_date <= cutoff` 截断，未来日期的空结算行不分发（否则增量重算会从日历末尾起算）；
- 清单存在但 gzip 文件缺失（例如从文档还原的代码库）时，装载直接降级为在线全量拉取，不抛 `FileNotFoundError`。

### 10.2 重新生成快照

```bash
cd backend
../.venv/bin/python scripts/build_seed.py --src ~/.dailyscope/dailyscope.db
# 默认输出到 backend/seed/
```

导出后检查 `manifest.json` 的 `cutoff` 与各表行数；快照是静态基线，**数据库本体不进 git**。

### 10.3 从零重建派生层

```bash
# 1) 回填换仓节点（改锚点/改因子后必须执行）
curl -X POST http://127.0.0.1:8003/api/dailypick/core/rebuild \
     -H 'Content-Type: application/json' -d '{"start_date":"2015-01-05"}'
# 轮询 GET /api/dailypick/core/status

# 2) 重算日度记录
curl -X POST http://127.0.0.1:8003/api/dailypick/rebuild \
     -H 'Content-Type: application/json' -d '{"start_date":"2015-01-05"}'
# 轮询 GET /api/dailypick/status

# 3) 筛选快照：两个重算线程结束会自动 warm 最新一天；
#    历史日期首次打开时按需重算（约 7 秒），之后落盘秒开
```

### 10.4 换机/迁移

1. 克隆仓库（含 `backend/seed/`）；
2. 建库：直接启动后端（首次连接自动建表）；
3. 页面「一键准备」：装载快照 → 在线补 `cutoff` 之后的增量 → 重算节点/记录；
4. 核对 `/api/dataset/summary` 与 `/api/dailypick/days` 的最后日期。

### 10.5 生产/多环境注意

- 数据库路径由 `DAILYSCOPE_HOME` 决定；不同环境不要共用同一 DB 文件。
- WAL 模式下备份/迁移前应先停写（停后端），再拷贝 `.db`（连同 `-wal`/`-shm` 或先 checkpoint）。
- 前端构建无独立 `typecheck` 脚本，类型检查即 `npm run build` 内的 `tsc`。

---

## 11. 排障手册

| 现象 | 先查什么 | 处理 |
|---|---|---|
| 今日数据没有当天 | `SELECT MAX(date) FROM etf_daily`；当前时间是否 <16:15 | 16:15 后重跑 `backfill_daily`；这不是 bug |
| 份额当天为空 | 份额 T+1 发布 | 次日 00:20 份额链会自动补；也可手动 `backfill_shares` |
| 节点持仓与页面不一致 | 节点是否用 T-1 份额算出（`fitted_core_summary.complete=0`） | 份额落地后重算该节点（主链会自动做） |
| 筛选左卡要等 7 秒 | `fitted_daily_screen` 是否刚失效 | 正常冷算；重算链结束会 warm；可手动再打开一次 |
| 新 ETF 不进漏斗 | `etfs.fund_type` 是否 NULL | 跑一次清单兜底/补分类；主源不带类型 |
| 日 K 中间缺一段 | 是否曾用大区间一次拉取 | 删该标的相关行后 `backfill_daily` 全量重拉（分区间接 850 自然日） |
| `KlineBlocked` | 腾讯限流（连续失败 25 次） | 等几分钟重跑，增量会从缺口继续 |
| 折算被记成巨额申购 | `etf_share_scale` 是否缺少该事件 | 跑 `detect_share_conversions`；大跳变会按 raw/qfq 台阶甄别 |
| 节点/记录重算后页面还是旧数 | 前端 React Query 缓存 | 重算完成会自动 invalidate；否则刷新页面 |
| 指数缺最近几天 | 中证发布晚于收盘 | 22:30 的 `late` 槽位会补；或手动 `backfill_index` |
| 一键准备某阶段失败 | 该阶段 `detail` | 修复后重跑；幂等，已完成部分不会重做 |

**时点问题排查顺序**：先看 `fitted_core_summary.generated_at`，再看 `fitted_core_pick.pre_rank`，
最后看 `fitted_daily_summary.rule_version` 与 `next_signal`。任何“未来数据”疑虑都应能在这三处定位。

---

## 12. 扩展指南

### 12.1 新增一个数据源

1. 在 `data/fetch/` 新建适配器，只做“请求 + 解析”，失败返回空/`None`，不抛业务异常；
2. 端点/超时/限速常量加到 `data/config.py`；
3. 在 `data/store/` 新建或扩展 repo，写入必须 COALESCE；
4. 在 `ops/jobs.py` 加任务函数并注册到 `JOB_FNS`；
5. 如需并入一键准备，在 `ops/bootstrap.py` 的 `STAGE_LABELS/STAGE_FNS` 加阶段（注意依赖顺序）；
6. 补 `backend/tests/test_<source>.py`，用固定响应文本做纯解析测试。

### 12.2 新增一个因子

1. `services/scoring/core/score.py`：在 `CORE_WEIGHTS`/`FACTOR_LABELS`/`FACTOR_KINDS` 加因子，`describe()` 产出原始值；
2. 若需要新数据窗口，在 `descriptors/` 里扩展切片；
3. 前端 `FactorBreakdown` 会自动读取 `factors_json`，无需改表结构；
4. **重跑**：换仓节点 → 日度记录 → 筛选快照；并跑 `pytest` 与全历史回测对比。

### 12.3 新增一个页面领域

1. 后端：`pages/<domain>/`（`router.py` + 子包），在 `main.py` 挂 `include_router`；
2. 前端：`pages/<Domain>.tsx` + `components/<domain>/` + `hooks/use<Domain>.ts` + `api/types/<domain>.ts`；
3. 路由加入 `App.tsx` 的 `NAV_ITEMS` 与 `Routes`；
4. 领域私有逻辑不要塞进 `components/common/`。

### 12.4 新增一张表

1. 若属原始层：加到 `data/store/database.py` 的 `SCHEMA`（`CREATE TABLE IF NOT EXISTS` + 必要索引）；
2. 若属派生层：在对应 `store.py` 里建 `SCHEMA` + `ensure_schema`（后加列用 `PRAGMA table_info` 兼容升级）；
3. 若需进快照：加到 `ops/seed.py` 的 `RAW_TABLES` 或 `DERIVED_TABLES`，并重新导出 `backend/seed/`；
4. 派生表必须能从原始表重建，禁止手工修数。

### 12.5 文件与命名规范

- 单文件 ≤300 行（超了就按子功能拆目录/文件）；
- Python：type hints 全覆盖、`snake_case`、常量 `UPPER_SNAKE_CASE`、函数 ≤50 行；
- 前端：`strict`、禁止 `any`（ECharts option 例外）、option 构建用 `useMemo` 且为纯函数；
- 新增策略/算法常量必须附注释说明依据与历史案例；
- 文档与代码同步：行为变更时更新本文档与相关 docstring。

---

## 13. 附录：常量与术语

### 13.1 关键常量

| 常量 | 值 | 位置 |
|---|---|---|
| `DAILY_FINAL_TIME` | `(16, 15)` | `data/config.py` |
| `BACKFILL_START_DATE` | `2015-01-01` | `data/config.py` |
| `KLINE_START_DATE` | `2004-01-01` | `data/config.py` |
| `KLINE_CACHE_TTL_SEC` / 失败冷却 | 60 s / 30 s | `data/config.py` |
| `QUOTE_BATCH_SIZE` / `WORKERS` / TTL | 100 / 4 / 5 s | `data/config.py` |
| `FETCH_WORKERS` | 6 | `data/config.py` |
| 请求级节流 | 0.2 s | `data/fetch/kline.py` |
| 连续失败中止 | 25 | `data/fetch/kline.py` |
| 区间分块 | 850 自然日 / 650 根 | `data/fetch/kline.py` |
| `CORE_ANCHOR` | `2015-01-05` | `services/scoring/core/score.py` |
| `REBALANCE_EVERY` | 5 | 同上 |
| `HOLD_TOP` / `HOLD_BUFFER_RANK` | 5 / 15 | 同上 |
| `DEFAULT_MIN_AUM_YI` | 2.0 亿 | `services/scoring/features.py` |
| `MIN_BARS` | 62 | 同上 |
| `HISTORY_DAYS` | 270 | 同上 |
| `HIGH_VOL_MIN` / `HIGH_POS_DRAWDOWN` / `HIGH_VOL_PENALTY` | 0.45 / −0.03 / 0.10 | `services/scoring/core/score.py` |
| `RUN_SLOTS` | 00:20 / 18:30 / 22:30 | `ops/scheduler.py` |
| 重试冷却 / 次数 | 30 min / 3 | 同上 |
| 筛选快照 TTL / 槽位 | 120 s / 3 | `pages/daily/screen/rank.py` |
| `PAYLOAD_VERSION` | 2 | 同上 |
| 盘中预演 TTL | 60 s / 300 s / 600 s | `pages/daily/live/preview.py` |
| `RULE_VERSION`（日度） | `daily-core8-v1` | `pages/daily/review/build.py` |
| `LIVE_RULE_VERSION` | `core8-live-v1` | `pages/daily/live/preview.py` |
| 年线窗口 | 250 | `pages/daily/review/attribution.py` |
| 份额跳变扫描倍率 | 1.3 | `data/store/shares_repo.py` |

### 13.2 术语

| 术语 | 含义 |
|---|---|
| 节点（换仓节点） | 每 5 个交易日一个的调仓日；持仓在节点间延续 |
| 预备排名 `pre_rank` | 节点日收盘时用 T-1 份额算出的排名，用于决定周四收盘卖谁 |
| 完整目标 | T+1 份额落地后重算的目标持仓，决定周五开盘买/卖 |
| 缓冲带 | 已持有名字排名仍在前 15 就不卖，避免每期全换 |
| 基线 | 综合分前 10、不做策略过滤的对照组 |
| 股票池 `universe` | 通过前 7 级漏斗的全部候选 |
| 年线门控 | 沪深 300 收盘严格高于 MA250 才持有，用于归因视图 |
| 混合执行 | 周四收盘卖 + 周五开盘买卖的真实成交价结算口径 |
| 折算 `split` | 份额整倍变化导致的价格折算/合并，不是申购赎回 |
| 筛选快照 | 单日漏斗 + 全量排名的压缩落盘结果，用于秒开 |

### 13.3 一句话验收清单

- [ ] `pytest -q` 全绿，`ruff check/format`、`mypy`、`npm run lint/build` 全绿；
- [ ] `/api/health` 正常，`/api/data/scheduler` 的 `next_run` 合理；
- [ ] `/api/dataset/summary` 中日 K/份额/指数最后日期与最近交易日一致（16:15 后）；
- [ ] `/api/dailypick/days` 最新记录有 `core_mean` 与 `next_signal`；
- [ ] 今日页左卡在快照未返回时显示加载态，返回后 TOP 与持仓对照正确；
- [ ] 节点页区间收益与 `/api/dailypick/attribution` 的累计口径可对上。

---

## 14. 全量源码附录

> 本节把仓库内全部**手写源码与配置**逐字收录，共 164 个文件、16192 行，与第 4 节的逐文件职责表一一对应（后者讲"为什么这么拆"，本节给"原文是什么"）。
>
> 收录范围：`git ls-files` 中的全部文本文件，包含后端 `backend/`（含 `tests/`）、前端 `frontend/src/`、前端构建配置与仓库根 `.gitignore`。
>
> 明确排除（非手写源码，或体积不适合放进文档）：
>
> | 路径 | 排除原因 |
> |---|---|
> | `backend/seed/*.csv.gz`（11 个） | 二进制快照数据，随仓库分发；生成与还原见第 10 节 |
> | `backend/seed/manifest.json` | **已收录**（它是快照的元数据清单，不是数据本体） |
> | `PROJECT.md` | 本文档自身（附录无法收录自身） |
| `frontend/package-lock.json` | npm 自动生成的依赖锁文件，重跑 `npm install` 即重建 |
> | `frontend/dist/`、`node_modules/`、`.venv/`、`__pycache__/` | 构建产物与依赖目录，不进 git |

### 14.1 文件索引

按第 4 节的分层顺序排列，点击跳到该文件的源码。

**仓库根**（1）

- [`.gitignore`](#file-gitignore) — 11 行

**后端 · 入口与运行配置**（5）

- [`backend/main.py`](#file-backend-main-py) — 44 行
- [`backend/mypy.ini`](#file-backend-mypy-ini) — 20 行
- [`backend/pytest.ini`](#file-backend-pytest-ini) — 3 行
- [`backend/requirements.txt`](#file-backend-requirements-txt) — 8 行
- [`backend/ruff.toml`](#file-backend-ruff-toml) — 9 行

**后端 · 数据层 backend/data/**（17）

- [`backend/data/__init__.py`](#file-backend-data-init-py) — 1 行
- [`backend/data/config.py`](#file-backend-data-config-py) — 61 行
- [`backend/data/fetch/__init__.py`](#file-backend-data-fetch-init-py) — 1 行
- [`backend/data/fetch/adjust.py`](#file-backend-data-fetch-adjust-py) — 74 行
- [`backend/data/fetch/calendar.py`](#file-backend-data-fetch-calendar-py) — 25 行
- [`backend/data/fetch/etf_list.py`](#file-backend-data-fetch-etf-list-py) — 91 行
- [`backend/data/fetch/index_kline.py`](#file-backend-data-fetch-index-kline-py) — 91 行
- [`backend/data/fetch/kline.py`](#file-backend-data-fetch-kline-py) — 198 行
- [`backend/data/fetch/realtime.py`](#file-backend-data-fetch-realtime-py) — 167 行
- [`backend/data/fetch/shares.py`](#file-backend-data-fetch-shares-py) — 87 行
- [`backend/data/store/__init__.py`](#file-backend-data-store-init-py) — 1 行
- [`backend/data/store/calendar_repo.py`](#file-backend-data-store-calendar-repo-py) — 30 行
- [`backend/data/store/daily_repo.py`](#file-backend-data-store-daily-repo-py) — 113 行
- [`backend/data/store/database.py`](#file-backend-data-store-database-py) — 81 行
- [`backend/data/store/etf_repo.py`](#file-backend-data-store-etf-repo-py) — 87 行
- [`backend/data/store/index_repo.py`](#file-backend-data-store-index-repo-py) — 125 行
- [`backend/data/store/shares_repo.py`](#file-backend-data-store-shares-repo-py) — 109 行

**后端 · 任务编排 backend/ops/**（8）

- [`backend/ops/__init__.py`](#file-backend-ops-init-py) — 4 行
- [`backend/ops/background.py`](#file-backend-ops-background-py) — 80 行
- [`backend/ops/bootstrap.py`](#file-backend-ops-bootstrap-py) — 228 行
- [`backend/ops/core_backfill.py`](#file-backend-ops-core-backfill-py) — 186 行
- [`backend/ops/jobs.py`](#file-backend-ops-jobs-py) — 264 行
- [`backend/ops/refresh_chain.py`](#file-backend-ops-refresh-chain-py) — 232 行
- [`backend/ops/scheduler.py`](#file-backend-ops-scheduler-py) — 188 行
- [`backend/ops/seed.py`](#file-backend-ops-seed-py) — 159 行

**后端 · 计算服务 backend/services/**（23）

- [`backend/services/__init__.py`](#file-backend-services-init-py) — 5 行
- [`backend/services/kline/__init__.py`](#file-backend-services-kline-init-py) — 4 行
- [`backend/services/kline/aggregate.py`](#file-backend-services-kline-aggregate-py) — 81 行
- [`backend/services/kline/macd.py`](#file-backend-services-kline-macd-py) — 116 行
- [`backend/services/kline/states.py`](#file-backend-services-kline-states-py) — 242 行
- [`backend/services/scoring/__init__.py`](#file-backend-services-scoring-init-py) — 14 行
- [`backend/services/scoring/core/__init__.py`](#file-backend-services-scoring-core-init-py) — 1 行
- [`backend/services/scoring/core/data.py`](#file-backend-services-scoring-core-data-py) — 108 行
- [`backend/services/scoring/core/rebalance.py`](#file-backend-services-scoring-core-rebalance-py) — 62 行
- [`backend/services/scoring/core/score.py`](#file-backend-services-scoring-core-score-py) — 267 行
- [`backend/services/scoring/core/store.py`](#file-backend-services-scoring-core-store-py) — 251 行
- [`backend/services/scoring/descriptors/__init__.py`](#file-backend-services-scoring-descriptors-init-py) — 3 行
- [`backend/services/scoring/descriptors/cross_section.py`](#file-backend-services-scoring-descriptors-cross-section-py) — 99 行
- [`backend/services/scoring/descriptors/factors.py`](#file-backend-services-scoring-descriptors-factors-py) — 124 行
- [`backend/services/scoring/descriptors/profile.py`](#file-backend-services-scoring-descriptors-profile-py) — 58 行
- [`backend/services/scoring/descriptors/scale.py`](#file-backend-services-scoring-descriptors-scale-py) — 62 行
- [`backend/services/scoring/descriptors/slices.py`](#file-backend-services-scoring-descriptors-slices-py) — 96 行
- [`backend/services/scoring/descriptors/themes.py`](#file-backend-services-scoring-descriptors-themes-py) — 50 行
- [`backend/services/scoring/features.py`](#file-backend-services-scoring-features-py) — 250 行
- [`backend/services/scoring/ranks.py`](#file-backend-services-scoring-ranks-py) — 25 行
- [`backend/services/scoring/reason/__init__.py`](#file-backend-services-scoring-reason-init-py) — 1 行
- [`backend/services/scoring/reason/core8.py`](#file-backend-services-scoring-reason-core8-py) — 59 行
- [`backend/services/scoring/reason/ranking.py`](#file-backend-services-scoring-reason-ranking-py) — 184 行

**后端 · 页面领域 backend/pages/**（23）

- [`backend/pages/__init__.py`](#file-backend-pages-init-py) — 9 行
- [`backend/pages/daily/__init__.py`](#file-backend-pages-daily-init-py) — 11 行
- [`backend/pages/daily/live/__init__.py`](#file-backend-pages-daily-live-init-py) — 1 行
- [`backend/pages/daily/live/context.py`](#file-backend-pages-daily-live-context-py) — 96 行
- [`backend/pages/daily/live/preview.py`](#file-backend-pages-daily-live-preview-py) — 268 行
- [`backend/pages/daily/live/rows.py`](#file-backend-pages-daily-live-rows-py) — 104 行
- [`backend/pages/daily/nodes.py`](#file-backend-pages-daily-nodes-py) — 268 行
- [`backend/pages/daily/review/__init__.py`](#file-backend-pages-daily-review-init-py) — 4 行
- [`backend/pages/daily/review/attribution.py`](#file-backend-pages-daily-review-attribution-py) — 169 行
- [`backend/pages/daily/review/build.py`](#file-backend-pages-daily-review-build-py) — 262 行
- [`backend/pages/daily/review/evaluate.py`](#file-backend-pages-daily-review-evaluate-py) — 93 行
- [`backend/pages/daily/review/execution.py`](#file-backend-pages-daily-review-execution-py) — 182 行
- [`backend/pages/daily/review/store.py`](#file-backend-pages-daily-review-store-py) — 216 行
- [`backend/pages/daily/router.py`](#file-backend-pages-daily-router-py) — 237 行
- [`backend/pages/daily/screen/__init__.py`](#file-backend-pages-daily-screen-init-py) — 1 行
- [`backend/pages/daily/screen/cache.py`](#file-backend-pages-daily-screen-cache-py) — 93 行
- [`backend/pages/daily/screen/rank.py`](#file-backend-pages-daily-screen-rank-py) — 275 行
- [`backend/pages/daily/screen/store.py`](#file-backend-pages-daily-screen-store-py) — 60 行
- [`backend/pages/etf/__init__.py`](#file-backend-pages-etf-init-py) — 4 行
- [`backend/pages/etf/router.py`](#file-backend-pages-etf-router-py) — 147 行
- [`backend/pages/jobs/__init__.py`](#file-backend-pages-jobs-init-py) — 4 行
- [`backend/pages/jobs/readiness.py`](#file-backend-pages-jobs-readiness-py) — 172 行
- [`backend/pages/jobs/router.py`](#file-backend-pages-jobs-router-py) — 70 行

**后端 · 脚本与快照清单**（2）

- [`backend/scripts/build_seed.py`](#file-backend-scripts-build-seed-py) — 35 行
- [`backend/seed/manifest.json`](#file-backend-seed-manifest-json) — 156 行

**后端 · 测试 backend/tests/**（28）

- [`backend/tests/__init__.py`](#file-backend-tests-init-py) — 1 行
- [`backend/tests/conftest.py`](#file-backend-tests-conftest-py) — 41 行
- [`backend/tests/daily_seed.py`](#file-backend-tests-daily-seed-py) — 141 行
- [`backend/tests/test_background.py`](#file-backend-tests-test-background-py) — 61 行
- [`backend/tests/test_bootstrap.py`](#file-backend-tests-test-bootstrap-py) — 160 行
- [`backend/tests/test_daily_build_day.py`](#file-backend-tests-test-daily-build-day-py) — 72 行
- [`backend/tests/test_daily_core.py`](#file-backend-tests-test-daily-core-py) — 243 行
- [`backend/tests/test_daily_core_backfill.py`](#file-backend-tests-test-daily-core-backfill-py) — 263 行
- [`backend/tests/test_daily_live.py`](#file-backend-tests-test-daily-live-py) — 45 行
- [`backend/tests/test_daily_nodes.py`](#file-backend-tests-test-daily-nodes-py) — 174 行
- [`backend/tests/test_daily_records.py`](#file-backend-tests-test-daily-records-py) — 252 行
- [`backend/tests/test_daily_screen.py`](#file-backend-tests-test-daily-screen-py) — 199 行
- [`backend/tests/test_daily_screen_cache.py`](#file-backend-tests-test-daily-screen-cache-py) — 82 行
- [`backend/tests/test_dataset.py`](#file-backend-tests-test-dataset-py) — 68 行
- [`backend/tests/test_etf_list.py`](#file-backend-tests-test-etf-list-py) — 25 行
- [`backend/tests/test_etf_router.py`](#file-backend-tests-test-etf-router-py) — 31 行
- [`backend/tests/test_execution.py`](#file-backend-tests-test-execution-py) — 116 行
- [`backend/tests/test_index_kline.py`](#file-backend-tests-test-index-kline-py) — 86 行
- [`backend/tests/test_jobs.py`](#file-backend-tests-test-jobs-py) — 204 行
- [`backend/tests/test_kline.py`](#file-backend-tests-test-kline-py) — 91 行
- [`backend/tests/test_kline_states.py`](#file-backend-tests-test-kline-states-py) — 169 行
- [`backend/tests/test_live_rows.py`](#file-backend-tests-test-live-rows-py) — 103 行
- [`backend/tests/test_macd.py`](#file-backend-tests-test-macd-py) — 115 行
- [`backend/tests/test_ranks.py`](#file-backend-tests-test-ranks-py) — 35 行
- [`backend/tests/test_realtime.py`](#file-backend-tests-test-realtime-py) — 168 行
- [`backend/tests/test_refresh_scheduler.py`](#file-backend-tests-test-refresh-scheduler-py) — 197 行
- [`backend/tests/test_seed.py`](#file-backend-tests-test-seed-py) — 152 行
- [`backend/tests/test_store.py`](#file-backend-tests-test-store-py) — 55 行

**前端 · 入口与构建配置**（5）

- [`frontend/eslint.config.js`](#file-frontend-eslint-config-js) — 25 行
- [`frontend/index.html`](#file-frontend-index-html) — 12 行
- [`frontend/package.json`](#file-frontend-package-json) — 34 行
- [`frontend/tsconfig.json`](#file-frontend-tsconfig-json) — 20 行
- [`frontend/vite.config.ts`](#file-frontend-vite-config-ts) — 15 行

**前端 · 应用入口与样式**（3）

- [`frontend/src/App.tsx`](#file-frontend-src-app-tsx) — 63 行
- [`frontend/src/main.tsx`](#file-frontend-src-main-tsx) — 24 行
- [`frontend/src/styles.css`](#file-frontend-src-styles-css) — 20 行

**前端 · API 层 frontend/src/api/**（8）

- [`frontend/src/api/client.ts`](#file-frontend-src-api-client-ts) — 151 行
- [`frontend/src/api/types.ts`](#file-frontend-src-api-types-ts) — 6 行
- [`frontend/src/api/types/daily.ts`](#file-frontend-src-api-types-daily-ts) — 191 行
- [`frontend/src/api/types/dailyLive.ts`](#file-frontend-src-api-types-dailylive-ts) — 78 行
- [`frontend/src/api/types/dailyScreen.ts`](#file-frontend-src-api-types-dailyscreen-ts) — 154 行
- [`frontend/src/api/types/dataset.ts`](#file-frontend-src-api-types-dataset-ts) — 37 行
- [`frontend/src/api/types/etf.ts`](#file-frontend-src-api-types-etf-ts) — 86 行
- [`frontend/src/api/types/jobs.ts`](#file-frontend-src-api-types-jobs-ts) — 61 行

**前端 · Hooks frontend/src/hooks/**（5）

- [`frontend/src/hooks/useDailyPick.ts`](#file-frontend-src-hooks-usedailypick-ts) — 138 行
- [`frontend/src/hooks/useDataset.ts`](#file-frontend-src-hooks-usedataset-ts) — 18 行
- [`frontend/src/hooks/useEtfs.ts`](#file-frontend-src-hooks-useetfs-ts) — 44 行
- [`frontend/src/hooks/useJobs.ts`](#file-frontend-src-hooks-usejobs-ts) — 43 行
- [`frontend/src/hooks/useQuotes.ts`](#file-frontend-src-hooks-usequotes-ts) — 21 行

**前端 · 通用 / 图表 / 数据集组件**（6）

- [`frontend/src/components/common/format.ts`](#file-frontend-src-components-common-format-ts) — 35 行
- [`frontend/src/components/data/BootstrapCard.tsx`](#file-frontend-src-components-data-bootstrapcard-tsx) — 82 行
- [`frontend/src/components/dataset/DatasetReadiness.tsx`](#file-frontend-src-components-dataset-datasetreadiness-tsx) — 104 行
- [`frontend/src/components/kline/MacdStatePanel.tsx`](#file-frontend-src-components-kline-macdstatepanel-tsx) — 104 行
- [`frontend/src/components/kline/candleOption.ts`](#file-frontend-src-components-kline-candleoption-ts) — 197 行
- [`frontend/src/components/kline/sharesOption.ts`](#file-frontend-src-components-kline-sharesoption-ts) — 39 行

**前端 · 日度复盘组件 frontend/src/components/daily/**（26）

- [`frontend/src/components/daily/AttributionPanel.tsx`](#file-frontend-src-components-daily-attributionpanel-tsx) — 197 行
- [`frontend/src/components/daily/ExpandedKline.tsx`](#file-frontend-src-components-daily-expandedkline-tsx) — 39 行
- [`frontend/src/components/daily/FactorBreakdown.tsx`](#file-frontend-src-components-daily-factorbreakdown-tsx) — 76 行
- [`frontend/src/components/daily/HistoryPanel.tsx`](#file-frontend-src-components-daily-historypanel-tsx) — 41 行
- [`frontend/src/components/daily/HistoryTable.tsx`](#file-frontend-src-components-daily-historytable-tsx) — 65 行
- [`frontend/src/components/daily/HoldingCard.tsx`](#file-frontend-src-components-daily-holdingcard-tsx) — 126 行
- [`frontend/src/components/daily/LiveKlinePanel.tsx`](#file-frontend-src-components-daily-liveklinepanel-tsx) — 71 行
- [`frontend/src/components/daily/NodeDetailCard.tsx`](#file-frontend-src-components-daily-nodedetailcard-tsx) — 134 行
- [`frontend/src/components/daily/NodePanel.tsx`](#file-frontend-src-components-daily-nodepanel-tsx) — 158 行
- [`frontend/src/components/daily/ScreenRanking.tsx`](#file-frontend-src-components-daily-screenranking-tsx) — 152 行
- [`frontend/src/components/daily/ScreenRowDetail.tsx`](#file-frontend-src-components-daily-screenrowdetail-tsx) — 125 行
- [`frontend/src/components/daily/SummaryCards.tsx`](#file-frontend-src-components-daily-summarycards-tsx) — 71 行
- [`frontend/src/components/daily/TimelineTable.tsx`](#file-frontend-src-components-daily-timelinetable-tsx) — 125 行
- [`frontend/src/components/daily/TodayPanel.tsx`](#file-frontend-src-components-daily-todaypanel-tsx) — 186 行
- [`frontend/src/components/daily/TopRankCard.tsx`](#file-frontend-src-components-daily-toprankcard-tsx) — 156 行
- [`frontend/src/components/daily/actionMeta.ts`](#file-frontend-src-components-daily-actionmeta-ts) — 8 行
- [`frontend/src/components/daily/actionTag.tsx`](#file-frontend-src-components-daily-actiontag-tsx) — 8 行
- [`frontend/src/components/daily/attributionOption.ts`](#file-frontend-src-components-daily-attributionoption-ts) — 129 行
- [`frontend/src/components/daily/factorFormat.ts`](#file-frontend-src-components-daily-factorformat-ts) — 42 行
- [`frontend/src/components/daily/gatedOption.ts`](#file-frontend-src-components-daily-gatedoption-ts) — 176 行
- [`frontend/src/components/daily/linkColumns.tsx`](#file-frontend-src-components-daily-linkcolumns-tsx) — 31 行
- [`frontend/src/components/daily/quoteColumns.tsx`](#file-frontend-src-components-daily-quotecolumns-tsx) — 32 行
- [`frontend/src/components/daily/rankBounds.ts`](#file-frontend-src-components-daily-rankbounds-ts) — 6 行
- [`frontend/src/components/daily/ruleLabel.ts`](#file-frontend-src-components-daily-rulelabel-ts) — 5 行
- [`frontend/src/components/daily/screenColumns.tsx`](#file-frontend-src-components-daily-screencolumns-tsx) — 165 行
- [`frontend/src/components/daily/window.ts`](#file-frontend-src-components-daily-window-ts) — 166 行

**前端 · 页面 frontend/src/pages/**（4）

- [`frontend/src/pages/DailyReview.tsx`](#file-frontend-src-pages-dailyreview-tsx) — 85 行
- [`frontend/src/pages/EtfDetail.tsx`](#file-frontend-src-pages-etfdetail-tsx) — 187 行
- [`frontend/src/pages/EtfList.tsx`](#file-frontend-src-pages-etflist-tsx) — 180 行
- [`frontend/src/pages/Jobs.tsx`](#file-frontend-src-pages-jobs-tsx) — 222 行

### 14.2 仓库根

<a id="file-gitignore"></a>

#### `.gitignore`

```text
.venv
__pycache__/
*.pyc
*.db
*.db-wal
*.db-shm
nohup.out
.idea/
node_modules
dist
.DS_Store
```

### 14.3 后端 · 入口与运行配置

<a id="file-backend-main-py"></a>

#### `backend/main.py`

```python
"""DailyScope 后端入口: 原始数据 + 日度复盘接口。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from data.store.database import get_conn
from ops import scheduler as refresh_scheduler
from pages.daily import router as dailypick_api
from pages.daily.review import store as daily_store
from pages.etf import router as etfs_api
from pages.jobs import readiness as dataset_api
from pages.jobs import router as data_api

app = FastAPI(title="DailyScope", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _init_db() -> None:
    daily_store.ensure_schema(get_conn())
    refresh_scheduler.start()


@app.on_event("shutdown")
def _stop_refresh() -> None:
    refresh_scheduler.stop()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


app.include_router(etfs_api.router)
app.include_router(data_api.router)
app.include_router(dataset_api.router)
app.include_router(dailypick_api.router)
```

<a id="file-backend-mypy-ini"></a>

#### `backend/mypy.ini`

```ini
[mypy]
python_version = 3.9
warn_return_any = True
warn_unused_configs = True
disallow_untyped_defs = True

[mypy-akshare.*]
ignore_missing_imports = True

[mypy-requests.*]
ignore_missing_imports = True

[mypy-apscheduler.*]
ignore_missing_imports = True

[mypy-fastapi.*]
ignore_missing_imports = True

[mypy-pydantic.*]
ignore_missing_imports = True
```

<a id="file-backend-pytest-ini"></a>

#### `backend/pytest.ini`

```ini
[pytest]
pythonpath = .
testpaths = tests
```

<a id="file-backend-requirements-txt"></a>

#### `backend/requirements.txt`

```text
fastapi
uvicorn[standard]
apscheduler
requests
akshare
pytest
ruff
mypy
```

<a id="file-backend-ruff-toml"></a>

#### `backend/ruff.toml`

```toml
target-version = "py39"
line-length = 120

[lint]
select = ["E", "F", "W", "I", "UP", "B", "SIM", "DTZ", "BLE"]
ignore = ["DTZ005", "DTZ007", "BLE001"]

[lint.isort]
known-first-party = ["data", "domains", "ops"]
```

### 14.4 后端 · 数据层 backend/data/

<a id="file-backend-data-init-py"></a>

#### `backend/data/__init__.py`

```python
# 空文件：声明 data 为包
```

<a id="file-backend-data-config-py"></a>

#### `backend/data/config.py`

```python
"""系统级常量：路径、数据源 URL、超时与限速参数。"""

from __future__ import annotations

import os
from pathlib import Path

HOME = Path(os.environ.get("DAILYSCOPE_HOME", Path.home() / ".dailyscope"))
DB_PATH = HOME / "dailyscope.db"

HTTP_TIMEOUT = 15
AKSHARE_TIMEOUT = 30

KLINE_LIMIT = 60
# 腾讯两个等价入口(参数格式一致): web.ifzq 批量抓取数百请求后会 501(IP 限流),
# proxy.finance 仍可用, 故按顺序互为备份。
KLINE_URLS = (
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param={symbol},day,,,{limit},{fq}",
    "http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,,,{limit},{fq}",
)
KLINE_URLS_RANGE = (
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param={symbol},day,{start},{end},{limit},{fq}",
    "http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,{start},{end},{limit},{fq}",
)
SINA_KLINE_URL = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_/CN_MarketDataService.getKLineData?symbol={symbol}&scale=240&ma=no&datalen={limit}"

KLINE_CACHE_TTL_SEC = 60
KLINE_FAIL_COOLDOWN_SEC = 30
QUOTE_BATCH_SIZE = 100  # 腾讯实时行情实测可稳定返回 100+ 标的(500 亦可达), 留一半余量
QUOTE_BATCH_WORKERS = 4  # 盘中全市场预选需拉 1400+ 标的, 分批并发把串行 12s 压到 3s 内
QUOTE_CACHE_TTL_SEC = 5  # 15 秒轮询的短缓存: 合并并发请求, 又不至于卡住刷新节奏
FETCH_WORKERS = 6  # 并发抓取线程数; 请求实际发送受 kline.REQUEST_INTERVAL_SEC 全局节流

SHARES_RETRY = 2
SHARES_RETRY_BACKOFF_SEC = 5

BACKFILL_START_DATE = "2015-01-01"  # 份额回填起点(数据源 2015 起)
KLINE_START_DATE = "2004-01-01"  # 日K全历史起点(最早一批 ETF 2005 年上市, 腾讯有全历史)
DAILY_FINAL_TIME = (16, 15)  # 当日K线终值时刻: 腾讯收盘后约 16:14 才刷出最终价, 此前拉到的是盘中快照

# 中证官方指数日线(含全历史与市盈率/成分数): 腾讯/新浪只能给最近 650~1023 根, 且不支持中证自编指数。
CSINDEX_PERF_URL = (
    "https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode={code}&startDate={start}&endDate={end}"
)
CSINDEX_START_DATE = "1990-01-01"  # 上证指数最早 1990-12-19 起, 其余指数各自基准日起
CSINDEX_REFERER = "https://www.csindex.com.cn/"
INDEX_FETCH_SLEEP_SEC = 0.5  # 指数数量少, 只做温和间隔
# 宽基/风格基准: 回测截面对比的锚, 不是 ETF 跟踪指数全集(track_index 仍为空, 映射待建)
INDEX_CODES = (
    "000001",  # 上证指数
    "000016",  # 上证50
    "000300",  # 沪深300
    "000688",  # 科创50
    "000852",  # 中证1000
    "000905",  # 中证500
    "000906",  # 中证800
    "000922",  # 中证红利
    "000932",  # 中证800消费
    "000985",  # 中证全指
    "932000",  # 中证2000
)
```

<a id="file-backend-data-fetch-init-py"></a>

#### `backend/data/fetch/__init__.py`

```python
# 空文件：声明 data.fetch 为包
```

<a id="file-backend-data-fetch-adjust-py"></a>

#### `backend/data/fetch/adjust.py`

```python
"""份额跳变甄别: 用未复权(raw)与前复权(qfq)收盘之比, 区分份额折算与真实申赎。

份额折算/拆分当日 raw 价格按 1:ratio 缩小、qfq 价格保持连续, 于是 raw/qfq 出现
台阶式变化; 真实申购赎回只会改变份额, 这个比值不变。ETF 的折算在前复权价格上
完全不可见, 只能靠两个口径对照, 否则折算会被记成巨额申购(2026-07-10 半导体ETF
159582 份额 ×5.64 就是折算, 不是申购)。

阈值取 15%: 分红除权对该比值的影响在千分位, 15% 只能来自份额整倍变化。
"""

from __future__ import annotations

import statistics
from collections.abc import Collection
from datetime import datetime, timedelta
from typing import Any

from data.fetch import kline as kline_fetch

EDGE_DAYS = 12  # jump_date 前后取自对比值的自然日跨度
EDGE_SAMPLES = 3  # 前后各取的样本数(取最近/最早, 避开台阶中间那一天)
SPLIT_MIN_STEP = 1.15  # raw/qfq 比值台阶超过 15% 判定为折算/合并


def fetch_raw_bars(code: str, start: str, end: str) -> list[dict[str, Any]]:
    """未复权日线(腾讯 day 口径); 失败返回空列表, 由调用方按"未甄别"处理。"""
    try:
        return kline_fetch.fetch_kline(code, start_date=start, end_date=end, fq="")
    except kline_fetch.KlineBlocked as e:
        print(f"[FETCH] adjust {code} 限流: {e}")
        return []


def fetch_window(jump_dates: list[str]) -> tuple[str, str]:
    """覆盖全部跳变日前后的最小自然日窗口。"""
    first = datetime.strptime(min(jump_dates), "%Y-%m-%d") - timedelta(days=EDGE_DAYS)
    last = datetime.strptime(max(jump_dates), "%Y-%m-%d") + timedelta(days=EDGE_DAYS)
    return first.strftime("%Y-%m-%d"), last.strftime("%Y-%m-%d")


def _edge_bounds(jump_date: str) -> tuple[str, str]:
    return (
        (datetime.strptime(jump_date, "%Y-%m-%d") - timedelta(days=EDGE_DAYS)).strftime("%Y-%m-%d"),
        (datetime.strptime(jump_date, "%Y-%m-%d") + timedelta(days=EDGE_DAYS)).strftime("%Y-%m-%d"),
    )


def has_edge_samples(dates: Collection[str], jump_date: str) -> bool:
    """本地台账是否够判: 跳变日前后各需 2 个交易日(新上市标的上市前没有价格, 判不了)。"""
    lo, hi = _edge_bounds(jump_date)
    before = sum(1 for d in dates if lo <= d < jump_date)
    after = sum(1 for d in dates if jump_date <= d <= hi)
    return before >= 2 and after >= 2


def _step_ratio(factors: list[tuple[str, float]], jump_date: str) -> float | None:
    """折算前后 raw/qfq 比值之比(前/后); 样本不足返回 None。"""
    lo, hi = _edge_bounds(jump_date)
    before = [f for d, f in factors if lo <= d < jump_date][-EDGE_SAMPLES:]
    after = [f for d, f in factors if jump_date <= d <= hi][:EDGE_SAMPLES]
    if len(before) < 2 or len(after) < 2:
        return None
    return statistics.median(before) / statistics.median(after)


def classify(raw_bars: list[dict[str, Any]], qfq: dict[str, float], jump_date: str) -> str | None:
    """返回 'split'(折算/合并) 或 'flow'(真实申赎); 样本不足返回 None 表示待重试。"""
    factors = [
        (b["date"], b["close"] / qfq[b["date"]]) for b in raw_bars if b["date"] in qfq and b["close"] and qfq[b["date"]]
    ]
    step = _step_ratio(factors, jump_date)
    if step is None:
        return None
    return "split" if step >= SPLIT_MIN_STEP or step <= 1 / SPLIT_MIN_STEP else "flow"
```

<a id="file-backend-data-fetch-calendar-py"></a>

#### `backend/data/fetch/calendar.py`

```python
"""A 股交易日历源(akshare/新浪)。"""

from __future__ import annotations

_CACHE: list[str] | None = None


def fetch_trade_dates() -> list[str]:
    """全部 A 股交易日(YYYY-MM-DD 升序), 失败返回空列表。"""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    try:
        import akshare as ak

        df = ak.tool_trade_date_hist_sina()
        if df is None or df.empty or "trade_date" not in df.columns:
            return []
        dates = sorted({str(d)[:10] for d in df["trade_date"]})
        _CACHE = dates
        print(f"[FETCH] trade calendar loaded: {len(dates)} days")
        return dates
    except Exception as e:
        print(f"[FETCH] trade calendar failed: {e}")
        return []
```

<a id="file-backend-data-fetch-etf-list-py"></a>

#### `backend/data/fetch/etf_list.py`

```python
"""全量 ETF 清单源：东财实时列表(akshare) 优先, 天天基金静态清单兜底。

静态清单 fundcode_search.js 在公司网络直连可达(push2delay 行情域不可达),
包含全市场场内 ETF(代码/名称/类型), 但无实时成交额; 快照优先是因为它带
成交额与实时价格。上市日期、跟踪指数等字段本期不取(需逐只访问, 成本高)。
"""

from __future__ import annotations

import json
import urllib.request

from data.config import HTTP_TIMEOUT

_FUNDCODE_URL = "https://fund.eastmoney.com/js/fundcode_search.js"
_VALID_PREFIXES = ("51", "52", "56", "58", "15", "16")


def parse_fundcode_rows(text: str) -> list[dict]:
    """解析 fundcode_search.js 文本为 [{code, name, fund_type}](纯函数)。"""
    try:
        payload = text[text.index("=") + 1 : text.rindex(";")]
        data = json.loads(payload)
    except (ValueError, json.JSONDecodeError):
        return []
    result = []
    for entry in data:
        if len(entry) < 4:
            continue
        code, name, fund_type = str(entry[0]).strip(), str(entry[2]).strip(), str(entry[3]).strip()
        if code[:2] not in _VALID_PREFIXES or "ETF" not in name.upper() or "联接" in name:
            continue
        result.append({"code": code, "name": name, "fund_type": fund_type, "price": None, "amount_yi": None})
    return result


def _fetch_fundcode_list() -> list[dict]:
    try:
        req = urllib.request.Request(_FUNDCODE_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return parse_fundcode_rows(resp.read().decode("utf-8", "ignore"))
    except Exception as e:
        print(f"[FETCH] fundcode_search list failed: {e}")
        return []


def _fetch_spot_list() -> list[dict]:
    try:
        import akshare as ak

        df = ak.fund_etf_spot_em()
        if df is None or df.empty:
            return []
        result = []
        for _, row in df.iterrows():
            code = str(row.get("代码", "")).strip()
            if not code.isdigit() or code[:2] not in _VALID_PREFIXES:
                continue
            result.append(
                {
                    "code": code,
                    "name": str(row.get("名称", "")).strip(),
                    "fund_type": None,
                    "price": _to_float(row.get("最新价")),
                    "amount_yi": _to_float(row.get("成交额")),
                }
            )
        return result
    except Exception as e:
        print(f"[FETCH] etf spot list failed: {e}")
        return []


def fetch_etf_list() -> list[dict]:
    """全量 ETF 清单; 两个源都失败时返回空列表(调用方保留存量不清空)。"""
    rows = _fetch_spot_list()
    if rows:
        return rows
    rows = _fetch_fundcode_list()
    if rows:
        print(f"[FETCH] etf list via fundcode_search fallback: {len(rows)} 只")
    return rows


def _to_float(value: object) -> float | None:
    try:
        if value is None:
            return None
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
```

<a id="file-backend-data-fetch-index-kline-py"></a>

#### `backend/data/fetch/index_kline.py`

```python
"""中证官方指数日线(CSIndex index-perf), 全历史 + 市盈率/成分数。

腾讯/新浪只能给最近 650~1023 根且不支持中证自编指数, 做长周期截面回测必须用官方源。
接口怪癖: 首行日期被强制改写为请求的 startDate, 数值等于第二行(首个真实交易日);
解析时按"与次行完全同值"识别并剔除, 否则会凭空多出一个 1990-01-01 的假基准点。

单位: tradingValue 为亿元, tradingVol 为股, peg 实测为市盈率(非 PEG)。
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime

from data.config import CSINDEX_PERF_URL, CSINDEX_REFERER, CSINDEX_START_DATE, HTTP_TIMEOUT

_FQ_FIELDS = ("open", "close", "high", "low", "volume")


def _to_iso(value: str) -> str:
    return f"{value[:4]}-{value[4:6]}-{value[6:8]}"


def _num(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def _parse_rows(payload: dict, start_date: str) -> tuple[str | None, list[dict]]:
    """解析响应: 返回 (指数简称, 按日期升序的行)。"""
    raw_rows = payload.get("data") or []
    if not isinstance(raw_rows, list):
        return None, []
    name: str | None = None
    rows: list[dict] = []
    for r in raw_rows:
        if not isinstance(r, dict) or not r.get("tradeDate") or r.get("close") is None:
            continue
        name = name or r.get("indexNameCn")
        rows.append(
            {
                "date": _to_iso(str(r["tradeDate"])),
                "open": _num(r.get("open")),
                "close": _num(r.get("close")),
                "high": _num(r.get("high")),
                "low": _num(r.get("low")),
                "volume": _num(r.get("tradingVol")),
                "amount_yi": _num(r.get("tradingValue")),
                "cons_number": _num(r.get("consNumber")),
                "pe": _num(r.get("peg")),
            }
        )
    rows = [r for r in rows if r["date"] >= start_date]
    if (
        len(rows) >= 2
        and rows[0]["date"] == start_date
        and rows[1]["date"] > start_date
        and all(rows[0][k] == rows[1][k] for k in _FQ_FIELDS)
    ):
        rows.pop(0)  # 接口补的假首行: 日期=请求起点, 数值复制首个真实交易日
    return name, _dedup(rows)


def _dedup(rows: list[dict]) -> list[dict]:
    seen: set[str] = set()
    result: list[dict] = []
    for r in rows:
        if r["date"] in seen:
            continue
        seen.add(r["date"])
        result.append(r)
    return result


def fetch_index_daily(
    code: str, start_date: str = CSINDEX_START_DATE, end_date: str | None = None
) -> tuple[str | None, list[dict]]:
    """拉取指数全历史日线; 失败返回 (None, []), 由调用方决定是否跳过。"""
    end = (end_date or datetime.now().strftime("%Y-%m-%d")).replace("-", "")
    url = CSINDEX_PERF_URL.format(code=code, start=start_date.replace("-", ""), end=end)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": CSINDEX_REFERER})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 - 单指数失败不应中断整轮回填
        print(f"[FETCH] index {code} failed: {e}")
        return None, []
    if not isinstance(payload, dict):
        print(f"[FETCH] index {code} unexpected payload")
        return None, []
    return _parse_rows(payload, start_date)
```

<a id="file-backend-data-fetch-kline-py"></a>

#### `backend/data/fetch/kline.py`

```python
"""腾讯日K线拉取(前复权), 新浪降级, 日期区间自动分块。

腾讯日期区间接口单次响应上限约 640~700 根, 历史回填必须分块,
否则大区间只返回最近 640 根导致中间段永久缺口(Resonance 曾踩坑)。
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from datetime import datetime, timedelta

from data.config import (
    HTTP_TIMEOUT,
    KLINE_CACHE_TTL_SEC,
    KLINE_FAIL_COOLDOWN_SEC,
    KLINE_LIMIT,
    KLINE_URLS,
    KLINE_URLS_RANGE,
    SINA_KLINE_URL,
)

RANGE_CHUNK_NATURAL_DAYS = 850  # 每块自然日跨度(≈600 交易日, 低于接口单次上限)
RANGE_CHUNK_LIMIT = 650
MAX_CONSECUTIVE_FAIL = 25  # 腾讯批量抓取超出阈值即判定限流, 中止本轮(增量重跑自动续)
REQUEST_INTERVAL_SEC = 0.2  # 全局最小请求间隔(多线程共享), 压住腾讯的批量限流阈值

_CACHE: dict[tuple, tuple[float, list[dict] | None]] = {}
_streak = 0
_pace_lock = threading.Lock()
_last_request = 0.0


class KlineBlocked(RuntimeError):
    """上游连续失败(疑似 IP 限流): 本轮应停止抓取, 间隔一段时间后增量重跑。"""


def _pace() -> None:
    """全局节流: 多线程并发时保证任意两次请求的发起间隔不小于 REQUEST_INTERVAL_SEC。"""
    global _last_request
    with _pace_lock:
        wait = _last_request + REQUEST_INTERVAL_SEC - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_request = time.time()


def _market_prefix(code: str) -> str:
    if code.startswith(("51", "52", "56", "58")):
        return "sh"
    if code.startswith(("15", "16")):
        return "sz"
    raise ValueError(f"无法识别的场内基金代码段: {code}")


def _lookup(key: tuple) -> tuple[bool, list[dict] | None]:
    """缓存查找: 返回 (是否命中, 数据)。命中且数据为 None 表示失败冷却期(按空结果返回)。"""
    hit = _CACHE.get(key)
    if hit is None:
        return False, None
    ts, data = hit
    age = time.time() - ts
    if data is None:
        return age < KLINE_FAIL_COOLDOWN_SEC, None
    if age < KLINE_CACHE_TTL_SEC:
        return True, data
    _CACHE.pop(key, None)
    return False, None


def _iter_windows_desc(start_date: str, end_date: str) -> list[tuple[str, str]]:
    """从 end 向前切块, 按时间倒序返回; 配合"取到上市首日即停"只需最少的请求。"""
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    windows: list[tuple[str, str]] = []
    cur_end = end
    while cur_end >= start:
        cur_start = max(start, cur_end - timedelta(days=RANGE_CHUNK_NATURAL_DAYS - 1))
        windows.append((cur_start.strftime("%Y-%m-%d"), cur_end.strftime("%Y-%m-%d")))
        cur_end = cur_start - timedelta(days=1)
    return windows


def _parse_tencent_rows(symbol: str, data: dict, fq: str = "qfq") -> list[dict]:
    node = data.get("data", {}).get(symbol, {})
    adjusted_key = {"qfq": "qfqday", "hfq": "hfqday"}.get(fq)
    rows = (node.get(adjusted_key) if adjusted_key else None) or node.get("day") or []
    result = []
    for r in rows:
        if len(r) < 6 or not r[0]:
            continue
        result.append(
            {
                "date": r[0],
                "open": float(r[1]),
                "close": float(r[2]),
                "high": float(r[3]),
                "low": float(r[4]),
                "volume": float(r[5]),
            }
        )
    return result


def _fetch_tencent(symbol: str, urls: tuple[str, ...], fq: str = "qfq") -> list[dict] | None:
    """按序尝试等价入口; 全部失败才计入连续失败数。"""
    global _streak
    last_error: Exception | None = None
    for url in urls:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            _pace()
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last_error = e
            continue
        _streak = 0
        return _parse_tencent_rows(symbol, data, fq) or None
    _streak += 1
    print(f"[FETCH] kline {symbol} failed({_streak}): {last_error}")
    return None


def _fetch_sina(symbol: str, limit: int) -> list[dict] | None:
    """新浪日线(未复权): 腾讯不可达时的降级源, 不支持日期区间。"""
    url = SINA_KLINE_URL.format(symbol=symbol, limit=limit)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[FETCH] kline sina {symbol} failed: {e}")
        return None
    if not isinstance(data, list) or not data:
        return None
    rows = [
        {
            "date": r["day"],
            "open": float(r["open"]),
            "close": float(r["close"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "volume": float(r["volume"]),
        }
        for r in data
        if r.get("day")
    ]
    return rows or None


def fetch_kline(
    code: str,
    limit: int = KLINE_LIMIT,
    start_date: str | None = None,
    end_date: str | None = None,
    fq: str = "qfq",
) -> list[dict]:
    """拉取日K线(默认前复权)。带日期时从最新往前分块, 取到上市首日即停; 失败冷却防重试风暴。"""
    key = (code, limit, start_date, end_date, fq)
    hit, cached = _lookup(key)
    if hit:
        return cached or []

    symbol = _market_prefix(code) + code
    if start_date or end_date:
        s = start_date or "2000-01-01"
        e = end_date or datetime.now().strftime("%Y-%m-%d")
        merged: list[dict] = []
        for ws, we in _iter_windows_desc(s, e):
            if _streak >= MAX_CONSECUTIVE_FAIL:
                raise KlineBlocked(f"连续失败 {_streak} 次, 疑似限流; 停止本轮, 稍后增量重跑")
            urls = tuple(
                t.format(symbol=symbol, start=ws, end=we, limit=RANGE_CHUNK_LIMIT, fq=fq) for t in KLINE_URLS_RANGE
            )
            raw = _fetch_tencent(symbol, urls, fq) or []
            merged.extend(b for b in raw if ws <= b["date"] <= we)
            # 接口按 end 返回最近 limit 根: 不足 limit 且首根晚于窗口起点 = 已到上市首日
            if not raw or (len(raw) < RANGE_CHUNK_LIMIT and raw[0]["date"] > ws):
                break
        seen: set[str] = set()
        result: list[dict] = []
        for r in sorted(merged, key=lambda x: x["date"]):
            if r["date"] in seen:
                continue
            seen.add(r["date"])
            result.append(r)
        _CACHE[key] = (time.time(), result)
        return result

    urls = tuple(t.format(symbol=symbol, limit=limit, fq=fq) for t in KLINE_URLS)
    bars = _fetch_tencent(symbol, urls, fq)
    if bars is None:
        bars = _fetch_sina(symbol, limit)
    _CACHE[key] = (time.time(), bars if bars else None)
    return bars or []
```

<a id="file-backend-data-fetch-realtime-py"></a>

#### `backend/data/fetch/realtime.py`

```python
"""腾讯实时行情(二级市场现价), 供周度当周盯盘使用。

`qt.gtimg.cn/q=` 支持一次批量查询数十只标的, 返回 GBK 文本、字段以 `~` 分隔。
这里只有二级市场成交价, **没有 IOPV/参考净值**, 前端必须标注为"现价"而不是净值。
15 秒轮询用短 TTL 缓存合并并发请求; 上游异常时沿用旧缓存或返回空, 不抛错。
"""

from __future__ import annotations

import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Union

from data.config import HTTP_TIMEOUT, QUOTE_BATCH_SIZE, QUOTE_BATCH_WORKERS, QUOTE_CACHE_TTL_SEC

QUOTE_URL = "https://qt.gtimg.cn/q={symbols}"
TRADING_SESSIONS = (((9, 15), (11, 30)), ((13, 0), (15, 0)))  # 连续竞价(含开盘集合竞价段)

# 腾讯返回字段下标(按 `~` 切分后), 其余字段(买卖五档等)本系统不用。
_IDX_NAME = 1
_IDX_CODE = 2
_IDX_PRICE = 3
_IDX_PREV_CLOSE = 4
_IDX_OPEN = 5
_IDX_VOLUME = 6
_IDX_TIME = 30
_IDX_CHANGE = 31
_IDX_PCT = 32
_IDX_HIGH = 33
_IDX_LOW = 34
_IDX_AMOUNT_WAN = 37

Quote = dict[str, Union[float, str, None]]

_CACHE: dict[str, tuple[float, Quote]] = {}
_lock = threading.Lock()


def _market_prefix(code: str) -> str:
    if code.startswith(("51", "52", "56", "58")):
        return "sh"
    if code.startswith(("15", "16")):
        return "sz"
    raise ValueError(f"无法识别的场内基金代码段: {code}")


def _f(raw: str) -> float | None:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _fmt_time(raw: str) -> str | None:
    if len(raw) < 14 or not raw.isdigit():
        return None
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]} {raw[8:10]}:{raw[10:12]}:{raw[12:14]}"


def is_trading_time(now: datetime | None = None) -> bool:
    """周一至周五的连续竞价时段; 只判断时钟, 法定节假日由调用方叠加交易日历排除。"""
    cur = now or datetime.now()
    if cur.weekday() >= 5:
        return False
    minutes = cur.hour * 60 + cur.minute
    return any(
        start_h * 60 + start_m <= minutes < end_h * 60 + end_m
        for (start_h, start_m), (end_h, end_m) in TRADING_SESSIONS
    )


def _parse_line(line: str) -> tuple[str, Quote] | None:
    """解析 `v_sh510300="..."` 单行; 停牌/无效标的(现价<=0)直接丢弃。"""
    if "=" not in line:
        return None
    payload = line.split("=", 1)[1].strip().rstrip(";").strip('"')
    fields = payload.split("~")
    if len(fields) <= _IDX_AMOUNT_WAN:
        return None
    price = _f(fields[_IDX_PRICE])
    if price is None or price <= 0:
        return None
    pct = _f(fields[_IDX_PCT])
    return fields[_IDX_CODE], {
        "name": fields[_IDX_NAME] or None,
        "price": price,
        "prev_close": _f(fields[_IDX_PREV_CLOSE]),
        "open": _f(fields[_IDX_OPEN]),
        "high": _f(fields[_IDX_HIGH]),
        "low": _f(fields[_IDX_LOW]),
        "change": _f(fields[_IDX_CHANGE]),
        "pct": None if pct is None else round(pct / 100, 6),  # 统一成小数, 与其它收益字段口径一致
        "volume": _f(fields[_IDX_VOLUME]),
        "amount_wan": _f(fields[_IDX_AMOUNT_WAN]),
        "time": _fmt_time(fields[_IDX_TIME]),
    }


def _fetch_batch(codes: list[str]) -> dict[str, Quote]:
    symbols = []
    for code in codes:
        try:
            symbols.append(f"{_market_prefix(code)}{code}")
        except ValueError:
            continue
    if not symbols:
        return {}
    url = QUOTE_URL.format(symbols=urllib.parse.quote(",".join(symbols), safe=","))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        text = resp.read().decode("gbk", errors="replace")
    quotes: dict[str, Quote] = {}
    for line in text.split(";"):
        parsed = _parse_line(line.strip())
        if parsed is not None:
            quotes[parsed[0]] = parsed[1]
    return quotes


def clear_cache() -> None:
    """手动全量拉取前清空行情缓存, 保证下一次 fetch 真正冷拉上游并测出真实耗时。"""
    with _lock:
        _CACHE.clear()


def fetch_quotes(codes: list[str]) -> dict[str, Quote]:
    """批量取实时行情; 非法代码跳过, 上游失败回退旧缓存, 全部失败返回空字典。"""
    wanted = list(dict.fromkeys(code for code in codes if code))
    now = time.time()
    result: dict[str, Quote] = {}
    missing: list[str] = []
    with _lock:
        for code in wanted:
            hit = _CACHE.get(code)
            if hit is not None and now - hit[0] < QUOTE_CACHE_TTL_SEC:
                result[code] = hit[1]
            else:
                missing.append(code)
    batches = [missing[i : i + QUOTE_BATCH_SIZE] for i in range(0, len(missing), QUOTE_BATCH_SIZE)]

    def one(batch: list[str]) -> tuple[list[str], dict[str, Quote]]:
        try:
            return batch, _fetch_batch(batch)
        except Exception as e:  # 上游抖动: 保留旧缓存, 下一次轮询自愈
            print(f"[FETCH] realtime quotes failed: {e}")
            return batch, {}

    with ThreadPoolExecutor(max_workers=QUOTE_BATCH_WORKERS) as pool:
        fetched = list(pool.map(one, batches))
    stamp = time.time()
    with _lock:
        for batch, fresh in fetched:
            for code, quote in fresh.items():
                _CACHE[code] = (stamp, quote)
            for code in batch:
                if code in fresh:
                    continue
                stale = _CACHE.get(code)
                if stale is not None:
                    result[code] = stale[1]
        for _, fresh in fetched:
            result.update(fresh)
    return result
```

<a id="file-backend-data-fetch-shares-py"></a>

#### `backend/data/fetch/shares.py`

```python
"""ETF 份额逐日数据源：上交所官网(全历史) + 深交所(akshare, 全历史)。

与 Resonance 的区别: 不做在册清单过滤, 返回当日全市场 ETF 份额,
由存储层按清单落库。份额 T+1 发布, 拉当日可能为空, 属正常。
"""

from __future__ import annotations

import time

from data.config import AKSHARE_TIMEOUT, SHARES_RETRY, SHARES_RETRY_BACKOFF_SEC

_SSE_HEADERS = {
    "Referer": "https://www.sse.com.cn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}
_SSE_CACHE: dict[str, dict[str, float]] = {}
_SZSE_CACHE: dict[str, dict[str, float]] = {}


def fetch_shares_sse(date_str: str) -> dict[str, float]:
    """上交所 ETF 规模公告(亿份), 键为 6 位代码; 支持历史日期。"""
    if date_str in _SSE_CACHE:
        return _SSE_CACHE[date_str]
    try:
        import requests

        url = "https://query.sse.com.cn/commonQuery.do"
        params = {
            "isPagination": "true",
            "pageHelp.pageSize": "10000",
            "pageHelp.pageNo": "1",
            "pageHelp.beginPage": "1",
            "pageHelp.cacheSize": "1",
            "pageHelp.endPage": "1",
            "sqlId": "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",
            "STAT_DATE": date_str,
        }
        r = requests.get(url, params=params, headers=_SSE_HEADERS, timeout=AKSHARE_TIMEOUT)
        rows = r.json().get("result") or []
        result = {
            str(row["SEC_CODE"]): float(row["TOT_VOL"]) / 1e4
            for row in rows
            if row.get("SEC_CODE") and row.get("TOT_VOL") is not None
        }
        _SSE_CACHE[date_str] = result
        return result
    except Exception as e:
        print(f"[FETCH] SSE shares {date_str} failed: {e}")
        return {}


def fetch_shares_szse(date_str: str) -> dict[str, float]:
    """深交所 ETF 份额(亿份), 经 akshare fund_scale_daily_szse; 支持历史日期。"""
    if date_str in _SZSE_CACHE:
        return _SZSE_CACHE[date_str]
    try:
        import akshare as ak

        d8 = date_str.replace("-", "")
        df = ak.fund_scale_daily_szse(start_date=d8, end_date=d8, symbol="ETF")
        if df is None or df.empty:
            _SZSE_CACHE[date_str] = {}
            return {}
        result = {
            str(row.get("基金代码")): float(row.get("基金份额")) / 1e8
            for _, row in df.iterrows()
            if row.get("基金代码") and row.get("基金份额") is not None
        }
        _SZSE_CACHE[date_str] = result
        return result
    except Exception as e:
        print(f"[FETCH] SZSE shares {date_str} failed: {e}")
        return {}


def fetch_shares_for_date(date_str: str) -> dict[str, float]:
    """某日沪深两市全部 ETF 份额合并; 整日空结果重试(限流容错)。"""
    for attempt in range(SHARES_RETRY + 1):
        merged = {**fetch_shares_sse(date_str), **fetch_shares_szse(date_str)}
        if merged:
            return merged
        if attempt < SHARES_RETRY:
            wait = SHARES_RETRY_BACKOFF_SEC * (attempt + 1)
            print(f"[FETCH] shares {date_str} 空结果, {wait}s 后重试 ({attempt + 1}/{SHARES_RETRY})")
            time.sleep(wait)
    return {}
```

<a id="file-backend-data-store-init-py"></a>

#### `backend/data/store/__init__.py`

```python
# 空文件：声明 data.store 为包
```

<a id="file-backend-data-store-calendar-repo-py"></a>

#### `backend/data/store/calendar_repo.py`

```python
"""trade_calendar 交易日历表。"""

from __future__ import annotations

from data.store.database import get_conn


def replace_all(dates: list[str]) -> int:
    with get_conn() as conn:
        conn.execute("DELETE FROM trade_calendar")
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in dates])
    return len(dates)


def all_dates() -> list[str]:
    return [r["date"] for r in get_conn().execute("SELECT date FROM trade_calendar ORDER BY date")]


def trading_days_between(start_date: str, end_date: str) -> list[str]:
    return [
        r["date"]
        for r in get_conn().execute(
            "SELECT date FROM trade_calendar WHERE date BETWEEN ? AND ? ORDER BY date", (start_date, end_date)
        )
    ]


def last_trading_day(on_or_before: str) -> str | None:
    row = get_conn().execute("SELECT MAX(date) AS d FROM trade_calendar WHERE date <= ?", (on_or_before,)).fetchone()
    return row["d"] if row else None
```

<a id="file-backend-data-store-daily-repo-py"></a>

#### `backend/data/store/daily_repo.py`

```python
"""etf_daily 日K表写入与覆盖查询。"""

from __future__ import annotations

from typing import Any

from data.store.database import get_conn

_UPSERT_SQL = """
INSERT INTO etf_daily (date, code, open, close, high, low, volume)
VALUES (:date, :code, :open, :close, :high, :low, :volume)
ON CONFLICT(date, code) DO UPDATE SET
    open=COALESCE(excluded.open, open),
    close=COALESCE(excluded.close, close),
    high=COALESCE(excluded.high, high),
    low=COALESCE(excluded.low, low),
    volume=COALESCE(excluded.volume, volume)
"""


def upsert_rows(code: str, rows: list[dict]) -> int:
    """写入某日K序列(边拉边写场景逐批调用); 返回写入条数。"""
    if not rows:
        return 0
    conn = get_conn()
    with conn:
        conn.executemany(
            _UPSERT_SQL,
            [
                {
                    "date": r["date"],
                    "code": code,
                    "open": r.get("open"),
                    "close": r.get("close"),
                    "high": r.get("high"),
                    "low": r.get("low"),
                    "volume": r.get("volume"),
                }
                for r in rows
            ],
        )
    return len(rows)


def coverage(code: str) -> dict[str, Any]:
    row = (
        get_conn()
        .execute(
            "SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS n FROM etf_daily WHERE code=?",
            (code,),
        )
        .fetchone()
    )
    return {"first_date": row["first_date"], "last_date": row["last_date"], "rows": row["n"]}


def latest_date(code: str) -> str | None:
    row = get_conn().execute("SELECT MAX(date) AS last_date FROM etf_daily WHERE code=?", (code,)).fetchone()
    return row["last_date"] if row else None


def history(code: str, limit: int = 800) -> list[dict]:
    """按日期升序返回最近 limit 根(默认 800, 覆盖腾讯单次区间上限)。"""
    rows = (
        get_conn()
        .execute(
            "SELECT date, open, close, high, low, volume FROM etf_daily WHERE code=? ORDER BY date DESC LIMIT ?",
            (code, limit),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]


def history_until(code: str, end: str, limit: int = 120) -> list[dict]:
    """截止 end 的最近 limit 根(时点回放用, 绝不返回 end 之后的行)。"""
    rows = (
        get_conn()
        .execute(
            "SELECT date, open, close, high, low, volume FROM etf_daily "
            "WHERE code=? AND date<=? ORDER BY date DESC LIMIT ?",
            (code, end, limit),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]


def latest_per_code() -> dict[str, str]:
    """全部标的的最新 K 线日期 {code: date}, 回填增量判断用。"""
    return {
        r["code"]: r["last_date"]
        for r in get_conn().execute("SELECT code, MAX(date) AS last_date FROM etf_daily GROUP BY code")
        if r["last_date"]
    }


def stats_per_code() -> dict[str, tuple[str, str, int]]:
    """{code: (最早日期, 最新日期, 行数)}; 最早日期用于识别被旧回填下限截断的标的。"""
    return {
        r["code"]: (r["first_date"], r["last_date"], r["n"])
        for r in get_conn().execute(
            "SELECT code, MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS n FROM etf_daily GROUP BY code"
        )
    }


def empty_codes(codes: list[str]) -> list[str]:
    """清单中有但完全没有 K 线的标的。"""
    if not codes:
        return []
    have = set(latest_per_code())
    return [c for c in codes if c not in have]
```

<a id="file-backend-data-store-database-py"></a>

#### `backend/data/store/database.py`

```python
"""SQLite 连接与 schema（原始数据层）。

表结构只表达"原始数据", 不含任何指标/信号; 拟合层数据另起表前缀 fitted_*
(本期不建)。upsert 一律 COALESCE 保护, 新数据缺字段不得清空已有值。
"""

from __future__ import annotations

import sqlite3
import threading

from data.config import DB_PATH, HOME

SCHEMA = """
CREATE TABLE IF NOT EXISTS etfs (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    fund_type TEXT,
    list_date TEXT,
    track_index TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS etf_daily (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    open REAL, close REAL, high REAL, low REAL, volume REAL,
    PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_daily_code_date ON etf_daily (code, date);
CREATE TABLE IF NOT EXISTS etf_shares (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    shares_yi REAL,
    PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_shares_code_date ON etf_shares (code, date);
-- 份额跳变甄别结果: method='split' 是折算/合并(份额整倍变、价格反向缩), 'flow' 是真实申赎。
-- 折算在前复权价格上不可见, 只能靠未复权/前复权比值台阶确认, 否则会被当成巨额申购。
CREATE TABLE IF NOT EXISTS etf_share_scale (
    code TEXT NOT NULL,
    date TEXT NOT NULL,
    ratio REAL NOT NULL,
    method TEXT NOT NULL,
    detected_at TEXT,
    PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_share_scale_date ON etf_share_scale (date);
CREATE TABLE IF NOT EXISTS trade_calendar (
    date TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS indices (
    code TEXT PRIMARY KEY,
    name TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS index_daily (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    open REAL, close REAL, high REAL, low REAL,
    volume REAL, amount_yi REAL, cons_number REAL, pe REAL,
    PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_index_daily_code_date ON index_daily (code, date);
"""


_local = threading.local()


def get_conn() -> sqlite3.Connection:
    """每线程独立连接(WAL 允许读写并发); 共用连接曾被 API 线程池并发使用导致连接损坏。"""
    conn: sqlite3.Connection | None = getattr(_local, "conn", None)
    if conn is None:
        HOME.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")
        conn.executescript(SCHEMA)
        _local.conn = conn
    return conn
```

<a id="file-backend-data-store-etf-repo-py"></a>

#### `backend/data/store/etf_repo.py`

```python
"""etfs 清单表 CRUD 与数据覆盖统计。"""

from __future__ import annotations

from datetime import datetime

from data.store.database import get_conn


def upsert_list(rows: list[dict]) -> int:
    """全量清单快照 upsert(不清空未出现在快照中的老标的); 返回新增数量。"""
    conn = get_conn()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    before = {r["code"] for r in conn.execute("SELECT code FROM etfs")}
    with conn:
        conn.executemany(
            """
            INSERT INTO etfs (code, name, fund_type, list_date, track_index, updated_at)
            VALUES (:code, :name, :fund_type, :list_date, :track_index, :updated_at)
            ON CONFLICT(code) DO UPDATE SET
                name=excluded.name,
                fund_type=COALESCE(excluded.fund_type, etfs.fund_type),
                updated_at=excluded.updated_at
            """,
            [
                {
                    "code": r["code"],
                    "name": r.get("name") or "",
                    "fund_type": r.get("fund_type"),
                    "list_date": r.get("list_date"),
                    "track_index": r.get("track_index"),
                    "updated_at": now,
                }
                for r in rows
            ],
        )
    after = {r["code"] for r in conn.execute("SELECT code FROM etfs")}
    return len(after - before)


def all_codes() -> list[str]:
    return [r["code"] for r in get_conn().execute("SELECT code FROM etfs ORDER BY code")]


def backfill_list_dates() -> int:
    """用首根K线日期回填/纠正 etfs.list_date; 返回更新条数。

    数据已回填至上市首日, 首根K线是上市日的可靠近似; 仅当源头缺该标的首段历史时偏晚。
    """
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE etfs SET list_date = (SELECT MIN(date) FROM etf_daily d WHERE d.code = etfs.code)
            WHERE EXISTS (SELECT 1 FROM etf_daily d WHERE d.code = etfs.code)
              AND (list_date IS NULL
                   OR list_date > (SELECT MIN(date) FROM etf_daily d WHERE d.code = etfs.code))
            """
        )
        return cur.rowcount


def list_with_coverage() -> list[dict]:
    """清单 + 每只标的 K线/份额覆盖区间(供数据管理页)。"""
    conn = get_conn()
    return [
        {
            "code": row["code"],
            "name": row["name"],
            "fund_type": row["fund_type"],
            "daily_first": row["df"],
            "daily_last": row["dl"],
            "daily_rows": row["dn"],
            "shares_last": row["sl"],
            "shares_rows": row["sn"],
        }
        for row in conn.execute(
            """
            SELECT e.code, e.name, e.fund_type,
                (SELECT MIN(date) FROM etf_daily d WHERE d.code = e.code) AS df,
                (SELECT MAX(date) FROM etf_daily d WHERE d.code = e.code) AS dl,
                (SELECT COUNT(*) FROM etf_daily d WHERE d.code = e.code) AS dn,
                (SELECT MAX(date) FROM etf_shares s WHERE s.code = e.code) AS sl,
                (SELECT COUNT(*) FROM etf_shares s WHERE s.code = e.code) AS sn
            FROM etfs e ORDER BY e.code
            """
        )
    ]
```

<a id="file-backend-data-store-index-repo-py"></a>

#### `backend/data/store/index_repo.py`

```python
"""indices / index_daily 指数元数据与日线读写。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from data.store.database import get_conn

_UPSERT_SQL = """
INSERT INTO index_daily (date, code, open, close, high, low, volume, amount_yi, cons_number, pe)
VALUES (:date, :code, :open, :close, :high, :low, :volume, :amount_yi, :cons_number, :pe)
ON CONFLICT(date, code) DO UPDATE SET
    open=COALESCE(excluded.open, open),
    close=COALESCE(excluded.close, close),
    high=COALESCE(excluded.high, high),
    low=COALESCE(excluded.low, low),
    volume=COALESCE(excluded.volume, volume),
    amount_yi=COALESCE(excluded.amount_yi, amount_yi),
    cons_number=COALESCE(excluded.cons_number, cons_number),
    pe=COALESCE(excluded.pe, pe)
"""


def upsert_rows(code: str, name: str | None, rows: list[dict]) -> int:
    """写入某指数日线并更新简称; 缺字段不清空已有值。返回写入条数。"""
    conn = get_conn()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with conn:
        if name:
            conn.execute(
                """
                INSERT INTO indices (code, name, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(code) DO UPDATE SET
                    name=COALESCE(excluded.name, indices.name), updated_at=excluded.updated_at
                """,
                (code, name, now),
            )
        if rows:
            conn.executemany(
                _UPSERT_SQL,
                [
                    {
                        "date": r["date"],
                        "code": code,
                        "open": r.get("open"),
                        "close": r.get("close"),
                        "high": r.get("high"),
                        "low": r.get("low"),
                        "volume": r.get("volume"),
                        "amount_yi": r.get("amount_yi"),
                        "cons_number": r.get("cons_number"),
                        "pe": r.get("pe"),
                    }
                    for r in rows
                ],
            )
    return len(rows)


def stats_per_code() -> dict[str, tuple[str, str, int]]:
    """{code: (最早日期, 最新日期, 行数)}, 增量回填从最新日次日开始。"""
    return {
        r["code"]: (r["f"], r["l"], r["n"])
        for r in get_conn().execute(
            "SELECT code, MIN(date) AS f, MAX(date) AS l, COUNT(*) AS n FROM index_daily GROUP BY code"
        )
    }


def coverage(code: str) -> dict[str, Any]:
    row = (
        get_conn()
        .execute(
            "SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS n FROM index_daily WHERE code=?",
            (code,),
        )
        .fetchone()
    )
    return {"first_date": row["first_date"], "last_date": row["last_date"], "rows": row["n"]}


def daily_closes(code: str) -> list[dict]:
    """全历史收盘序列(升序), 年线类长周期计算用; 缺收盘的行直接剔除。"""
    rows = (
        get_conn()
        .execute(
            "SELECT date, close FROM index_daily WHERE code=? AND close IS NOT NULL AND close > 0 ORDER BY date",
            (code,),
        )
        .fetchall()
    )
    return [dict(r) for r in rows]


def index_name(code: str) -> str | None:
    row = get_conn().execute("SELECT name FROM indices WHERE code=?", (code,)).fetchone()
    return row["name"] if row else None


def history(code: str, limit: int = 800) -> list[dict]:
    rows = (
        get_conn()
        .execute(
            "SELECT date, open, close, high, low, volume, amount_yi, cons_number, pe "
            "FROM index_daily WHERE code=? ORDER BY date DESC LIMIT ?",
            (code, limit),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]


def history_until(code: str, end: str, limit: int = 120) -> list[dict]:
    """截止 end 的最近 limit 根(时点回放用, 绝不返回 end 之后的行)。"""
    rows = (
        get_conn()
        .execute(
            "SELECT date, open, close, high, low, volume, amount_yi, cons_number, pe "
            "FROM index_daily WHERE code=? AND date<=? ORDER BY date DESC LIMIT ?",
            (code, end, limit),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]
```

<a id="file-backend-data-store-shares-repo-py"></a>

#### `backend/data/store/shares_repo.py`

```python
"""etf_shares 份额表写入、查询与份额跳变甄别结果(etf_share_scale)读写。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from data.store.database import get_conn


def upsert_day(date: str, shares_by_code: dict[str, float], known_codes: set[str]) -> int:
    """写入某日份额快照(仅落在册标的); 返回写入条数。"""
    rows = [{"date": date, "code": c, "shares_yi": v} for c, v in shares_by_code.items() if c in known_codes]
    if not rows:
        return 0
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO etf_shares (date, code, shares_yi) VALUES (:date, :code, :shares_yi)
            ON CONFLICT(date, code) DO UPDATE SET shares_yi=excluded.shares_yi
            """,
            rows,
        )
    return len(rows)


def existing_dates() -> set[str]:
    return {r["date"] for r in get_conn().execute("SELECT DISTINCT date FROM etf_shares")}


def history(code: str, limit: int = 2000) -> list[dict]:
    """按日期升序返回最近 limit 条份额(默认 2000, 覆盖 8 年交易日)。"""
    rows = (
        get_conn()
        .execute(
            "SELECT date, shares_yi FROM etf_shares WHERE code=? ORDER BY date DESC LIMIT ?",
            (code, limit),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]


def history_until(code: str, end: str, limit: int = 60) -> list[dict]:
    """截止 end 的最近 limit 条份额(份额 T+1 发布, 调用方先按发布日退一天)。"""
    rows = (
        get_conn()
        .execute(
            "SELECT date, shares_yi FROM etf_shares WHERE code=? AND date<=? ORDER BY date DESC LIMIT ?",
            (code, end, limit),
        )
        .fetchall()
    )
    return [dict(r) for r in reversed(rows)]


def latest_per_code() -> dict[str, str]:
    return {
        r["code"]: r["last_date"]
        for r in get_conn().execute("SELECT code, MAX(date) AS last_date FROM etf_shares GROUP BY code")
        if r["last_date"]
    }


JUMP_SCAN_RATIO = 1.3  # 单日份额倍率超出 1/1.3~1.3 才送甄别(更小的变化是正常申赎)


def jump_candidates(min_ratio: float = JUMP_SCAN_RATIO) -> list[dict[str, Any]]:
    """单日份额倍率超出 [1/min_ratio, min_ratio] 的跳变(含比值), 按代码/日期升序。"""
    rows = get_conn().execute(
        """
        SELECT code, date, shares_yi / prev AS ratio FROM (
            SELECT code, date, shares_yi, LAG(shares_yi) OVER (PARTITION BY code ORDER BY date) AS prev
            FROM etf_shares
        )
        WHERE prev > 0 AND shares_yi > 0 AND (shares_yi / prev >= ? OR shares_yi / prev <= ?)
        ORDER BY code, date
        """,
        (min_ratio, 1 / min_ratio),
    )
    return [dict(r) for r in rows]


def scale_events(code: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
    """已甄别的份额跳变; 不传 code 返回全部(code 用于批量归一)。"""
    sql = "SELECT code, date, ratio, method FROM etf_share_scale WHERE date <= ?"
    params: list[Any] = [end or "9999-12-31"]
    if code:
        sql += " AND code = ?"
        params.append(code)
    return [dict(r) for r in get_conn().execute(sql + " ORDER BY code, date", params)]


def upsert_scales(events: list[dict[str, Any]]) -> int:
    """写入甄别结果(幂等覆盖): events 每项含 code/date/ratio/method。"""
    if not events:
        return 0
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO etf_share_scale (code, date, ratio, method, detected_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(code, date) DO UPDATE SET
                ratio=excluded.ratio, method=excluded.method, detected_at=excluded.detected_at
            """,
            [(e["code"], e["date"], e["ratio"], e["method"], stamp) for e in events],
        )
    return len(events)
```

### 14.5 后端 · 任务编排 backend/ops/

<a id="file-backend-ops-init-py"></a>

#### `backend/ops/__init__.py`

```python
"""后台编排层(无页面): 收盘刷新链、回填/重算/快照的编排与执行。

HTTP 入口不在这里: 任务触发接口在 pages/jobs/router.py。
"""
```

<a id="file-backend-ops-background-py"></a>

#### `backend/ops/background.py`

```python
"""后台任务执行器: 线程、运行状态与进度, 供各页面的 HTTP 接口复用。

任务函数必须在后台线程里自行取 SQLite 连接(连接是按线程缓存的, 见
data.store.database); 调用方只负责提交任务与轮询状态。同一 key 同时只允许一个
任务运行, 冲突由接口层转成 409。
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

ProgressFn = Callable[[int, int, str], None]
WorkFn = Callable[[ProgressFn], Any]


class TaskBusy(RuntimeError):
    """同一任务已在运行, 接口层据此返回 409。"""

    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


class TaskRunner:
    """{key: 任务状态} 的轻量注册表: 启动即返回, 结果/错误落在状态里。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status: dict[str, dict[str, Any]] = {}

    def status(self, key: str) -> dict[str, Any]:
        with self._lock:
            return dict(self._status.get(key) or {"state": "idle"})

    def statuses(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {key: dict(value) for key, value in self._status.items()}

    def is_running(self, key: str) -> bool:
        with self._lock:
            return self._status.get(key, {}).get("state") == "running"

    def running_keys(self) -> list[str]:
        with self._lock:
            return [key for key, value in self._status.items() if value.get("state") == "running"]

    def start(
        self,
        key: str,
        work: WorkFn,
        *,
        on_finished: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        """提交任务; 已在运行时抛 TaskBusy。on_finished 在任务成功/失败后都会执行。"""
        with self._lock:
            if self._status.get(key, {}).get("state") == "running":
                raise TaskBusy(key)
            self._status[key] = {"state": "running", "done": 0, "total": 0, "msg": "启动中"}

        def progress(done: int, total: int, msg: str) -> None:
            self._set(key, {"state": "running", "done": done, "total": total, "msg": msg})

        def run() -> None:
            try:
                result = work(progress)
                self._set(key, {"state": "done", "result": result})
            except Exception as error:  # noqa: BLE001 - 后台任务失败要落状态而不是炸掉线程
                self._set(key, {"state": "failed", "error": str(error)})
            finally:
                if on_finished is not None:
                    on_finished()

        threading.Thread(target=run, daemon=True, name=f"task-{key}").start()
        return {"state": "running"}

    def _set(self, key: str, fields: dict[str, Any]) -> None:
        with self._lock:
            self._status[key] = fields
```

<a id="file-backend-ops-bootstrap-py"></a>

#### `backend/ops/bootstrap.py`

```python
"""空库一键数据准备: 按依赖顺序跑通「日度复盘」所需的全部数据。

顺序即依赖: 预热快照 → 清单 → 日历 → 日K → 指数 → 份额 → 折算甄别 → 换仓节点 → 日度记录。
每步都幂等, 中断后重跑只补缺失部分(限流导致日K未拉完时, 重启即可续跑);
后台线程执行, 状态由 /api/data/bootstrap 轮询。
"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Any, Callable

from data.store.database import get_conn
from ops import core_backfill, jobs, refresh_chain, seed
from pages.daily.review import build
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core

Report = Callable[[int, int, str], None]
StageFn = Callable[[Report], str]

STAGE_LABELS = {
    "seed": "预热快照",
    "etf_list": "ETF 清单",
    "calendar": "交易日历",
    "daily": "日线行情",
    "index": "指数日线",
    "shares": "份额数据",
    "scale": "折算甄别",
    "core": "换仓节点",
    "records": "日度记录",
}

_LOCK = threading.Lock()
_STATE: dict[str, Any] = {}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _fresh_stages() -> list[dict[str, Any]]:
    return [
        {"key": key, "label": label, "state": "pending", "detail": None, "done": 0, "total": 0}
        for key, label in STAGE_LABELS.items()
    ]


def _copy() -> dict[str, Any]:
    return {**_STATE, "stages": [dict(s) for s in _STATE.get("stages", [])]}


def status() -> dict[str, Any]:
    with _LOCK:
        if not _STATE:
            return {
                "state": "idle",
                "stage": None,
                "percent": 0,
                "started_at": None,
                "finished_at": None,
                "error": None,
                "stages": _fresh_stages(),
            }
        return _copy()


def _percent() -> int:
    stages = _STATE.get("stages", [])
    done = sum(1 for s in stages if s["state"] in ("done", "skipped"))
    return round(done * 100 / len(stages)) if stages else 0


def _update(key: str, **fields: Any) -> None:
    with _LOCK:
        for stage in _STATE["stages"]:
            if stage["key"] == key:
                stage.update(fields)
        _STATE["stage"] = key
        _STATE["percent"] = _percent()


def _progress(key: str) -> Report:
    def report(done: int, total: int, msg: str) -> None:
        _update(key, done=done, total=total, detail=msg)

    return report


def _seed(report: Report) -> str:
    def cb(table: str, done: int, total: int) -> None:
        report(done, total, f"{table} {done}/{total} 行")

    result = seed.restore(get_conn(), on_rows=cb)
    if result.get("skipped"):
        return str(result["skipped"])
    return f"装载至 {result['cutoff']} · {int(result['rows'])} 行"


def _etf_list(_: Report) -> str:
    result = jobs.refresh_etf_list()
    if result.get("error"):
        raise RuntimeError(result["error"])
    if not result.get("total"):
        raise RuntimeError("ETF 清单为空, 请检查网络后重试")
    return f"{result['total']} 只(新增 {result.get('added', 0)})"


def _calendar(_: Report) -> str:
    result = jobs.refresh_calendar()
    if result.get("error"):
        raise RuntimeError(result["error"])
    return f"{result['days']} 个交易日"


def _daily(report: Report) -> str:
    result = jobs.backfill_daily(on_progress=report)
    if result.get("blocked"):
        raise RuntimeError("腾讯接口限流, 日K未拉完; 稍后重跑会从中断处继续")
    return f"{result['etfs']} 只 / {result['rows']} 根"


def _index(report: Report) -> str:
    result = jobs.backfill_index(on_progress=report)
    return f"{result['indices']} 个指数 / {result['rows']} 行"


def _shares(report: Report) -> str:
    result = jobs.backfill_shares(on_progress=report)
    return f"{result['days']} 个交易日 / {result['rows']} 行"


def _scale(report: Report) -> str:
    result = jobs.detect_share_conversions(on_progress=report)
    unknown = result["no_history"] + result["unknown"]
    return f"折算 {result['split']} / 申赎 {result['flow']} / 无法判定 {unknown}"


def _last_bar(conn: Any) -> str | None:
    row = conn.execute("SELECT MAX(date) FROM etf_daily").fetchone()
    return row[0] if row and row[0] else None


def _core_start(conn: Any) -> str | None:
    """快照已带节点时从最后节点次日起算; 空白库仍从锚点走全程。"""
    row = conn.execute("SELECT MAX(signal_date) FROM fitted_core_summary").fetchone()
    last = row[0] if row and row[0] else None
    if not last:
        return core.CORE_ANCHOR
    nxt = conn.execute("SELECT MIN(date) FROM trade_calendar WHERE date > ?", (last,)).fetchone()
    return nxt[0] if nxt and nxt[0] else None


def _core(report: Report) -> str:
    conn = get_conn()
    last_bar = _last_bar(conn)
    calendar = features.trading_days(conn)
    start = _core_start(conn)
    if not last_bar or not calendar or start is None:
        return "尚无行情, 跳过换仓节点"
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    if not nodes or nodes[-1] < start:
        return "换仓节点已最新"
    result = core_backfill.rebuild(conn, start=start, end=last_bar, on_progress=report)
    span = f"{result.get('start')} ~ {result.get('end')}" if result.get("written") else "无新节点"
    return f"{result.get('written', 0)} 个换仓节点({span})"


def _records(report: Report) -> str:
    conn = get_conn()
    calendar = features.trading_days(conn)
    last_bar = _last_bar(conn)
    if not calendar or not last_bar:
        raise RuntimeError("尚无行情, 请先回填日K")
    start = refresh_chain.records_start(conn, calendar, last_bar)
    if start is None:
        return "无新交易日"
    result = build.rebuild(conn, start_date=start, end_date=last_bar, on_progress=report)
    return f"{result.get('days', 0)} 个交易日({start} ~ {last_bar})"


STAGE_FNS: dict[str, StageFn] = {
    "seed": _seed,
    "etf_list": _etf_list,
    "calendar": _calendar,
    "daily": _daily,
    "index": _index,
    "shares": _shares,
    "scale": _scale,
    "core": _core,
    "records": _records,
}


def _run() -> None:
    for key in STAGE_LABELS:
        _update(key, state="running", detail="执行中")
        try:
            detail = STAGE_FNS[key](_progress(key))
        except Exception as e:  # noqa: BLE001 - 失败要落状态给页面, 而不是丢进后台线程
            _update(key, state="failed", detail=str(e))
            with _LOCK:
                _STATE.update(state="failed", error=str(e), finished_at=_now())
            return
        _update(key, state="done", detail=detail)
    with _LOCK:
        _STATE.update(state="done", stage=None, finished_at=_now())


def start() -> dict[str, Any]:
    """后台启动一键准备; 已在运行时返回当前状态而不是重复启动。"""
    with _LOCK:
        if _STATE.get("state") == "running":
            return _copy()
        _STATE.clear()
        _STATE.update(
            state="running",
            stage=None,
            percent=0,
            started_at=_now(),
            finished_at=None,
            error=None,
            stages=_fresh_stages(),
        )
        threading.Thread(target=_run, name="dailyscope-bootstrap", daemon=True).start()
        return _copy()
```

<a id="file-backend-ops-core-backfill-py"></a>

#### `backend/ops/core_backfill.py`

```python
"""core8 缓冲带的换仓节点回填: 从 CORE_ANCHOR 起每 5 个交易日一个节点。

节点本身就是换仓日, 持仓带到下一节点(缓冲带: 排名仍在前 15 就继续持有)。
节点日收盘只有 T-1 份额, 除完整目标外还存一份预备排名(pre_rank): 结算层据此区分
周四收盘就卖的仓位与周五开盘顺延卖的仓位。回填从锚点走完全程以保证持仓状态连续,
只落 [start, end] 内的节点; 行情/份额只加载一次, 逐节点切片, 不做逐节点重读全库。
不计交易成本——这里只记目标持仓, 结算留给图表。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Any, Callable

from pages.daily.review import execution
from services.scoring import features
from services.scoring.core import data as core_data
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.core import store as core_store

RULE_VERSION = "core8-v1"
KEEP_TOP = 20  # 页面展示前 20; 持仓即使排名掉队也强制保留

ProgressFn = Callable[[int, int, str], None]


def _row(row: dict[str, Any], held: bool, action: str, pre_rank: int | None = None) -> dict[str, Any]:
    return {
        "code": row["code"],
        "name": row.get("name"),
        "core_rank": row["core_rank"],
        "core_score": row["core_score"],
        "held": held,
        "action": action,
        "factors": row.get("core_factors"),
        "pre_rank": pre_rank,
    }


def _picks(
    scored: list[dict[str, Any]],
    target: list[str],
    held_prev: list[str],
    pre_rank: dict[str, int] | None = None,
    rebought: set[str] | None = None,
) -> list[dict[str, Any]]:
    """持仓(hold/buy) + 本次卖出(sell) + 评分前 20(rank, 已列的跳过)。

    pre_rank 是只用 T-1 份额算出的预备排名: 节点日收盘先卖谁由它决定, 与完整目标无关。
    rebought 是周四收盘卖掉、周五开盘又买回的名字, 动作记 buy 而不是 hold——持仓看着连续,
    实际先卖出再成交。
    """
    details = {r["code"]: r for r in scored}
    pre = pre_rank or {}
    back = rebought or set()
    target_set, prev_set = set(target), set(held_prev)
    picks = [
        _row(details[c], True, "hold" if c in prev_set and c not in back else "buy", pre.get(c))
        for c in target
        if c in details
    ]
    picks += [_row(details[c], False, "sell", pre.get(c)) for c in held_prev if c not in target_set and c in details]
    listed = target_set | prev_set
    picks += [_row(r, False, "rank", pre.get(r["code"])) for r in scored[:KEEP_TOP] if r["code"] not in listed]
    return picks


def _pre_ranks(ctx: dict[str, Any], signal: str, min_aum: float) -> dict[str, int]:
    """节点日收盘时的预备排名: 份额只用严格早于信号日的点(T+1 才发布)。"""
    prelim = core_data.score_signal(ctx, signal, min_aum, shares_before=True)
    return {r["code"]: r["core_rank"] for r in prelim}


def _next_node(calendar: list[str], signal: str) -> str | None:
    return rebalance.next_rebalance(calendar, signal)


def _resume_holdings(conn: sqlite3.Connection, earlier: list[str]) -> list[str] | None:
    """增量重算的初始持仓: 直接取 start 前一个已落库节点; 缺节点时返回 None, 退回全程计算。"""
    if not earlier:
        return []
    node = core_store.get_node(conn, earlier[-1])
    return [p["code"] for p in node["holdings"]] if node else None


def rebuild(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """回填 [start, end] 内的换仓节点; start 缺省取锚点(全历史)。

    起点之前的节点只用于推导初始持仓, 直接从已落库的上一节点续跑, 不重复评分。
    """
    core_store.ensure_schema(conn)
    calendar = features.trading_days(conn)
    if not calendar:
        return {"nodes": 0, "written": 0}
    end = end or calendar[-1]
    start = start or core.CORE_ANCHOR
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, end)
    if not nodes:
        return {"nodes": 0, "written": 0}
    ctx = core_data.load_context(conn, nodes[0], load_end=end)
    earlier = [d for d in nodes if d < start]
    wanted = [d for d in nodes if d >= start]
    held = _resume_holdings(conn, earlier)
    resume = held is not None
    held = held or []
    written: list[str] = []
    for i, signal in enumerate(nodes):
        if resume and signal < start:
            continue
        scored = core_data.score_signal(ctx, signal, min_aum)
        if not scored:
            # 交易日历含未来日期, 尾部节点还没有行情: 不落空节点, 持仓延续。
            continue
        pre = _pre_ranks(ctx, signal, min_aum)
        after = execution.remaining_after_close_sells(held, pre)
        target = rebalance.rebalance(after, [r["code"] for r in scored])
        if signal >= start:
            core_store.replace_node(
                conn,
                {
                    "signal_date": signal,
                    "next_rebalance": nodes[i + 1] if i + 1 < len(nodes) else None,
                    "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "rule_version": RULE_VERSION,
                    "scored": len(scored),
                    "min_aum_yi": min_aum,
                    "complete": (ctx.get("shares_through") or "") >= signal,
                },
                _picks(scored, target, held, pre, set(target) - set(after)),
            )
            written.append(signal)
            if on_progress:
                on_progress(len(written), len(wanted), f"{signal} 持仓 {len(target)} 只, 评分池 {len(scored)}")
        held = target
    core_store.prune_nodes(conn, start, end, written)
    return {
        "nodes": len(nodes),
        "written": len(written),
        "start": written[0] if written else None,
        "end": written[-1] if written else None,
    }


def rebuild_node(
    conn: sqlite3.Connection,
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    """单节点重算: T+1 凌晨份额落地后, 用完整份额补算目标并保留预备排名。

    只动该节点, 上一节点(含)之前的历史不变; 上一节点持仓是本次换仓的状态。
    """
    core_store.ensure_schema(conn)
    calendar = features.trading_days(conn)
    ctx = core_data.load_context(conn, signal)
    scored = core_data.score_signal(ctx, signal, min_aum)
    if not scored:
        return {"signal_date": signal, "written": False, "reason": "节点日无评分"}
    pre = _pre_ranks(ctx, signal, min_aum)
    prev = core_store.prev_node(conn, signal)
    prev_node = core_store.get_node(conn, prev) if prev else None
    held_prev = [p["code"] for p in (prev_node or {}).get("holdings", [])]
    after = execution.remaining_after_close_sells(held_prev, pre)
    target = rebalance.rebalance(after, [r["code"] for r in scored])
    core_store.replace_node(
        conn,
        {
            "signal_date": signal,
            "next_rebalance": _next_node(calendar, signal),
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "rule_version": RULE_VERSION,
            "scored": len(scored),
            "min_aum_yi": min_aum,
            "complete": (ctx.get("shares_through") or "") >= signal,
        },
        _picks(scored, target, held_prev, pre, set(target) - set(after)),
    )
    return {"signal_date": signal, "written": True, "holdings": len(target), "scored": len(scored)}
```

<a id="file-backend-ops-jobs-py"></a>

#### `backend/ops/jobs.py`

```python
"""回填任务编排：全量清单、交易日历、日K、份额、指数日线。

原则：边拉边写(中断不丢已拉数据)、重跑自动跳过已完成区间、
相邻请求限速。所有任务幂等, 可反复执行。
"""

from __future__ import annotations

import time
from bisect import bisect_left, bisect_right
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from data.config import (
    BACKFILL_START_DATE,
    CSINDEX_START_DATE,
    DAILY_FINAL_TIME,
    FETCH_WORKERS,
    INDEX_CODES,
    INDEX_FETCH_SLEEP_SEC,
    KLINE_START_DATE,
)
from data.fetch import adjust as adjust_fetch
from data.fetch import calendar as calendar_fetch
from data.fetch import etf_list as list_fetch
from data.fetch import index_kline as index_fetch
from data.fetch import kline as kline_fetch
from data.fetch import shares as shares_fetch
from data.store import calendar_repo, daily_repo, etf_repo, index_repo, shares_repo
from data.store.database import get_conn

OnProgress = Callable[[int, int, str], None]

PREV_FLOOR_DAY = "2015-01-05"  # 旧回填下限的首个交易日: 起点仍停在这一天的标的是被截断的, 需向前补深
GAP_MIN_BARS = 30  # 区间内缺根数低于此值不值得全量重拉
GAP_RATIO = 0.5  # 缺口占区间交易日槽位过半才算丢失整段历史(货币 ETF 成交稀疏属正常, 不触发)
SHARE_JUMP_SCAN_RATIO = shares_repo.JUMP_SCAN_RATIO  # 单日份额倍率超 1/1.3~1.3 才送甄别


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def final_bar_ready(now: datetime | None = None) -> bool:
    """当日 K 线是否已到终值时刻(16:15): 在此之前拉到的是盘中快照, 之后才是收盘价。"""
    now = now or datetime.now()
    return (now.hour, now.minute) >= DAILY_FINAL_TIME


def _report(on_progress: OnProgress | None, done: int, total: int, msg: str) -> None:
    print(f"[BACKFILL] {done}/{total} {msg}", flush=True)
    if on_progress:
        on_progress(done, total, msg)


def refresh_etf_list() -> dict:
    """全量清单快照入库; 返回在册数量与本次新增数量。"""
    rows = list_fetch.fetch_etf_list()
    if not rows:
        return {"total": len(etf_repo.all_codes()), "added": 0, "error": "拉取清单为空"}
    added = etf_repo.upsert_list(rows)
    return {"total": len(etf_repo.all_codes()), "added": added}


def refresh_calendar() -> dict:
    dates = calendar_fetch.fetch_trade_dates()
    if not dates:
        return {"days": 0, "error": "交易日历拉取失败"}
    return {"days": calendar_repo.replace_all(dates)}


def _has_hole(earliest: str, latest: str, rows: int, calendar: list[str]) -> bool:
    """区间内实有根数明显少于交易日槽位 → 历史拉取中途被截断, 尾部增量补不回来。"""
    slots = bisect_right(calendar, latest) - bisect_left(calendar, earliest)
    missing = slots - rows
    return missing >= GAP_MIN_BARS and missing > slots * GAP_RATIO


def _daily_ranges(
    code: str,
    stats: dict[str, tuple[str, str, int]],
    today: str,
    calendar: list[str],
    final_ready: bool,
) -> list[tuple[str, str]]:
    """需要的拉取区间: 无历史 / 被旧下限截断 / 区间内明显缺根 → 从最早起点重拉
    (反向分块, 取到上市首日即停); 其余(含上市晚、历史短但完整的标的)只补最新日之后的增量。

    库里已有今天时, 收盘终值时刻(16:15)之后再重拉一次当天: 盘中写入的当天 K 线只是快照,
    必须让「最后一次落库」取到收盘价, 否则节点与当日揭示价会一直对不上。
    """
    if code not in stats:
        return [(KLINE_START_DATE, today)]
    earliest, latest, rows = stats[code]
    if earliest == PREV_FLOOR_DAY or _has_hole(earliest, latest, rows, calendar):
        return [(KLINE_START_DATE, today)]
    start = (datetime.strptime(latest, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    if start > today:
        return [(today, today)] if final_ready else []
    return [(start, today)]


def _daily_one(code: str, stats: dict[str, tuple[str, str, int]], today: str, calendar: list[str]) -> int:
    written = 0
    for start, end in _daily_ranges(code, stats, today, calendar, final_bar_ready()):
        written += daily_repo.upsert_rows(code, kline_fetch.fetch_kline(code, start_date=start, end_date=end))
    return written


def backfill_daily(on_progress: OnProgress | None = None, workers: int = FETCH_WORKERS) -> dict:
    """全部在册标的日K回填: 多线程并发(请求级全局限速), 已完成区间自动跳过。

    新标的反向分块取到上市首日即停, 通常只需 1 个请求; 已完整的标的每次只补最新一日。
    16:15 之后每次运行都会重拉当天, 保证收盘终值覆盖掉盘中快照。
    """
    codes = etf_repo.all_codes()
    stats = daily_repo.stats_per_code()
    calendar = calendar_repo.all_dates()
    today = _today()
    total = len(codes)
    done = 0
    rows_total = 0
    blocked = False
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_daily_one, code, stats, today, calendar): code for code in codes}
        for fut in as_completed(futures):
            code = futures[fut]
            try:
                written = fut.result()
            except kline_fetch.KlineBlocked as e:
                print(f"[BACKFILL] 中止: {e}")
                blocked = True
                for pending in futures:
                    pending.cancel()
                break
            done += 1
            rows_total += written
            _report(on_progress, done, total, f"{code} +{written} 根")
    return {"etfs": done, "rows": rows_total, "blocked": blocked, "list_dates": etf_repo.backfill_list_dates()}


def backfill_shares(on_progress: OnProgress | None = None, recent_days: int = 0, end_date: str | None = None) -> dict:
    """逐交易日回填全市场 ETF 份额(仅写在册标的), 已覆盖日期跳过。

    recent_days > 0 时强制重拉末尾 N 个交易日: 份额 T+1 发布, 昨晚的空结果要在
    次日凌晨补上(全部 upsert, 重拉幂等)。
    """
    days = calendar_repo.trading_days_between(BACKFILL_START_DATE, end_date or _today())
    existing = shares_repo.existing_dates()
    known = set(etf_repo.all_codes())
    todo = [d for d in days if d not in existing]
    if recent_days > 0 and days:
        todo = sorted(set(todo) | set(days[-recent_days:]))
    written = 0
    for i, d in enumerate(todo, 1):
        got = shares_fetch.fetch_shares_for_date(d)
        written += shares_repo.upsert_day(d, got, known)
        if i % 20 == 0 or i == len(todo):
            _report(on_progress, i, len(todo), f"{d} 累计{written}条")
    return {"days": len(todo), "rows": written}


def _detect_one(code: str, jumps: list[dict]) -> tuple[str, list[dict], dict[str, int]]:
    """单个标的的折算甄别: 本地取窗口内前复权, 必要时抓一次未复权, 返回待写事件与计数。"""
    conn = get_conn()
    start, end = adjust_fetch.fetch_window([j["date"] for j in jumps])
    qfq = {
        r["date"]: r["close"]
        for r in conn.execute(
            "SELECT date, close FROM etf_daily WHERE code = ? AND date BETWEEN ? AND ?", (code, start, end)
        )
    }
    todo = [j for j in jumps if adjust_fetch.has_edge_samples(qfq, j["date"])]
    stats = {"split": 0, "flow": 0, "no_history": len(jumps) - len(todo), "unknown": 0}
    events: list[dict] = []
    if not todo:
        return code, events, stats
    raw_start, raw_end = adjust_fetch.fetch_window([j["date"] for j in todo])
    raw = adjust_fetch.fetch_raw_bars(code, raw_start, raw_end)
    for jump in todo:
        method = adjust_fetch.classify(raw, qfq, jump["date"])
        if method is None:
            stats["unknown"] += 1
            continue
        stats[method] += 1
        events.append({"code": code, "date": jump["date"], "ratio": jump["ratio"], "method": method})
    return code, events, stats


def detect_share_conversions(on_progress: OnProgress | None = None, workers: int = FETCH_WORKERS) -> dict:
    """甄别份额整倍跳变: 折算/合并 vs 真实申赎, 结果写 etf_share_scale(幂等增量)。

    每个标的一次未复权区间抓取, 与前复权比值对照; 多线程并发(请求级全局限速),
    写库留在主线程。本地无前史的跳变(上市首日即跳变)无法判定, 直接跳过并计入
    no_history, 不浪费网络请求。
    """
    done = {(e["code"], e["date"]) for e in shares_repo.scale_events()}
    grouped: dict[str, list[dict]] = {}
    for jump in shares_repo.jump_candidates(SHARE_JUMP_SCAN_RATIO):
        if (jump["code"], jump["date"]) not in done:
            grouped.setdefault(jump["code"], []).append(jump)
    counts = {"codes": len(grouped), "split": 0, "flow": 0, "no_history": 0, "unknown": 0}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_detect_one, code, jumps): code for code, jumps in grouped.items()}
        for processed, future in enumerate(as_completed(futures), 1):
            code, events, stats = future.result()
            shares_repo.upsert_scales(events)
            for key in ("split", "flow", "no_history", "unknown"):
                counts[key] += stats[key]
            _report(on_progress, processed, len(grouped), f"{code} {len(events)} 条已甄别")
    return counts


def _index_start(stats: dict[str, tuple[str, str, int]], code: str, today: str) -> str | None:
    """增量起点: 无历史→全历史; 已到最新→None(跳过)。"""
    if code not in stats:
        return CSINDEX_START_DATE
    last = stats[code][1]
    start = (datetime.strptime(last, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    return start if start <= today else None


def backfill_index(on_progress: OnProgress | None = None) -> dict:
    """中证官方指数日线回填(全历史/增量); 单指数失败只记录不中断。"""
    stats = index_repo.stats_per_code()
    today = _today()
    total = len(INDEX_CODES)
    rows_total = 0
    for i, code in enumerate(INDEX_CODES, 1):
        start = _index_start(stats, code, today)
        if start is not None:
            name, rows = index_fetch.fetch_index_daily(code, start_date=start)
            rows_total += index_repo.upsert_rows(code, name, rows)
            time.sleep(INDEX_FETCH_SLEEP_SEC)
        _report(on_progress, i, total, f"{code} {start or '已是最新'}")
    return {"indices": total, "rows": rows_total}


JOB_FNS: dict[str, Callable[..., dict]] = {
    "refresh_etf_list": refresh_etf_list,
    "refresh_calendar": refresh_calendar,
    "backfill_daily": backfill_daily,
    "backfill_shares": backfill_shares,
    "backfill_index": backfill_index,
    "detect_share_conversions": detect_share_conversions,
}

# 带进度回调的任务: 各任务签名不同, 在编排层显式分发, 路由层只认任务名。
_PROGRESS_JOBS: dict[str, Callable[..., dict]] = {
    "backfill_daily": backfill_daily,
    "backfill_shares": backfill_shares,
    "backfill_index": backfill_index,
    "detect_share_conversions": detect_share_conversions,
}


def run_job(name: str, on_progress: OnProgress | None = None) -> dict:
    """按任务名执行; 未知任务抛 ValueError(接口层已提前校验并返回 400)。"""
    if name in _PROGRESS_JOBS:
        return _PROGRESS_JOBS[name](on_progress=on_progress)
    if name in JOB_FNS:
        return JOB_FNS[name]()
    raise ValueError(f"未知任务 {name}, 可选: {sorted(JOB_FNS)}")
```

<a id="file-backend-ops-refresh-chain-py"></a>

#### `backend/ops/refresh_chain.py`

```python
"""收盘/凌晨刷新链的具体步骤: 行情/指数/份额 → core8 节点 → 日度记录。

与调度槽位解耦: 这里只回答"这一趟该做什么并做到哪一步", 由 ops/scheduler 决定
"什么时刻做"并把阶段与进度写进运行时状态。每步都幂等, 失败由调度层统一冷却重试。
"""

from __future__ import annotations

from bisect import bisect_left
from datetime import datetime
from typing import Any, Callable, Optional

from data.store.database import get_conn
from ops import core_backfill
from ops import jobs as raw_jobs
from pages.daily.review import attribution, build
from pages.daily.screen import cache
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.core import store as core_store

SETTLE_TAIL_DAYS = 2  # 每晚兜底重算最后两个交易日: 前一晚结算 + 当晚建行
SHARES_RESYNC_DAYS = 4  # 与 Resonance 手工同步同口径: 覆盖滞后/回补的最近四日
INDEX_HEAL_DAYS = 5  # 指数晚于收盘发布: 最近五日缺指数收益的结算行要补算

Report = Callable[[Optional[str], Optional[str]], None]  # (stage, detail)
Progress = Callable[[int, int, str], None]


def _progress(report: Report, stage: str) -> Progress:
    def cb(done: int, total: int, msg: str) -> None:
        report(stage, f"{msg} ({done}/{total})")

    return cb


def _last_daily(conn: Any) -> str | None:
    row = conn.execute("SELECT MAX(date) FROM etf_daily").fetchone()
    return row[0] if row and row[0] else None


def _has_universe(conn: Any) -> bool:
    """空库(或清单还没拉过)时整条链无事可做, 直接跳过, 避免空跑份额抓取。"""
    return conn.execute("SELECT 1 FROM etfs LIMIT 1").fetchone() is not None


def _has_bar(conn: Any, day: str) -> bool:
    return conn.execute("SELECT 1 FROM etf_daily WHERE date = ? LIMIT 1", (day,)).fetchone() is not None


def _core_stale(conn: Any, calendar: list[str], last_bar: str) -> bool:
    """日历上的最新换仓节点是否还没落库(节点日必须有行情, 否则等下一晚)。"""
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    if not nodes or not _has_bar(conn, nodes[-1]):
        return False
    return core_store.node_at(conn, last_bar) != nodes[-1]


def _final_node_needs_rebuild(conn: Any, calendar: list[str], last_bar: str) -> bool:
    """当天正是换仓节点、节点已落库且已过 16:15 终值时刻 → 可能按盘中快照算过, 需按收盘价重算。"""
    if not raw_jobs.final_bar_ready():
        return False
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    return bool(nodes) and nodes[-1] == last_bar and core_store.node_at(conn, last_bar) == last_bar


def _shares_through(conn: Any) -> str | None:
    row = conn.execute("SELECT MAX(date) FROM etf_shares").fetchone()
    return row[0] if row and row[0] else None


def node_to_complete(conn: Any, calendar: list[str], last_bar: str) -> str | None:
    """最新节点收盘时只有 T-1 份额(预备目标), 且节点日份额现已落地 → 返回要重算的节点日。

    节点日 T 的份额在 T+1 凌晨 00:00 后才发布, 所以周四 18:30 建出的节点必然不完整;
    用完整排名重算后, 周四收盘卖的名单不变, 周五开盘的补买/顺延卖名单才定下来。
    """
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    if not nodes:
        return None
    node = nodes[-1]
    if core_store.node_at(conn, last_bar) != node:
        return None
    if core_store.node_complete(conn, node):
        return None
    through = _shares_through(conn)
    return node if through and through >= node else None


def _index_lagging(conn: Any, days: list[str], last_bar: str) -> list[str]:
    """最近几日已结算却缺指数收益: 快照可能跑在中证指数落库之前。

    只检查指数现在已有行情的日子, 避免指数长期缺失时每晚重复重算。
    """
    window = days[-INDEX_HEAL_DAYS:]
    rows = conn.execute(
        "SELECT s.signal_date FROM fitted_daily_summary s"
        " WHERE s.signal_date >= ? AND s.signal_date <= ?"
        " AND s.next_signal IS NOT NULL AND s.next_signal <= ?"
        " AND (s.index_returns_json IS NULL OR s.index_returns_json IN ('{}', ''))"
        " AND EXISTS (SELECT 1 FROM index_daily i WHERE i.code = ? AND i.date = s.next_signal)"
        " ORDER BY s.signal_date",
        (window[0], last_bar, last_bar, attribution.HS300_CODE),
    ).fetchall()
    return [r["signal_date"] for r in rows]


def records_start(conn: Any, calendar: list[str], last_bar: str) -> str | None:
    """有缺口从缺口前一日重算(顺带结算前一日), 否则兜底重算最后两个交易日;
    最近几日若缺指数收益(指数晚于收盘发布), 起点前移到最早那天。"""
    days = [d for d in calendar if build.DEFAULT_START <= d <= last_bar]
    if not days:
        return None
    existing = {
        r["signal_date"]
        for r in conn.execute(
            "SELECT signal_date FROM fitted_daily_summary WHERE signal_date BETWEEN ? AND ?",
            (days[0], last_bar),
        )
    }
    missing = [d for d in days if d not in existing]
    start = days[max(0, bisect_left(days, missing[0]) - 1)] if missing else days[-min(SETTLE_TAIL_DAYS, len(days))]
    lagging = _index_lagging(conn, days, last_bar)
    return min(start, lagging[0]) if lagging else start


def _rebuild_records(conn: Any, calendar: list[str], last_bar: str, report: Report) -> int:
    start = records_start(conn, calendar, last_bar)
    if not start:
        return 0
    report("records", f"重算 {start} → {last_bar}")
    result = build.rebuild(conn, start_date=start, end_date=last_bar, on_progress=_progress(report, "records"))
    return int(result.get("days") or 0)


def _warm_screen(conn: Any, day: str, report: Report) -> None:
    """记录/节点刚重算过, 落盘筛选快照已失效; 先算好, 页面左卡打开时不必再等一次冷算。"""
    report("screen", f"预热 {day} 筛选快照")
    try:
        cache.warm(conn, day)
    except Exception as e:  # noqa: BLE001 - 预热失败不影响主链, 页面首次打开会自行重算
        report("screen", f"预热失败({e}), 页面首次打开时重算")


def close_chain(report: Report) -> dict[str, Any]:
    """收盘主链: 行情/指数/份额 → 节点 → 日度记录; 未到收盘/未发布时提前结束。

    16:15 之后会重拉当天 K 线终值(覆盖盘中快照), 当天若正是换仓节点则按收盘价重算节点。
    """
    conn = get_conn()
    if not _has_universe(conn):
        return {"skipped": "ETF 清单为空, 请先在数据任务页执行一键准备"}
    report("calendar", None)
    raw_jobs.refresh_calendar()
    calendar = features.trading_days(conn)
    today = datetime.now().strftime("%Y-%m-%d")
    if not calendar:
        return {"skipped": "交易日历为空"}
    if today > calendar[-1]:
        return {"skipped": f"交易日历未更新到 {today}", "calendar_end": calendar[-1]}
    if today not in calendar:
        return {"skipped": "非交易日"}

    last_bar = _last_daily(conn)
    if last_bar is None or last_bar < today or raw_jobs.final_bar_ready():
        report("daily", "增量抓取日K" if last_bar is None or last_bar < today else "重拉当日K线终值")
        raw_jobs.backfill_daily(on_progress=_progress(report, "daily"))
        last_bar = _last_daily(conn)

    # 指数每晚都补: 中证官方当天数据常在收盘之后才发布。
    report("index", "增量抓取指数日线")
    raw_jobs.backfill_index(on_progress=_progress(report, "index"))

    # 份额(T+1 发布): 已覆盖日期自动跳过, 当天没发布就只多一次空请求。
    report("shares", "补齐缺失份额")
    raw_jobs.backfill_shares(on_progress=_progress(report, "shares"))

    if last_bar is None or last_bar < today:
        return {"skipped": "今日行情尚未发布", "last_bar": last_bar}

    core_written = 0
    if _core_stale(conn, calendar, last_bar):
        report("core", "换仓节点重算")
        result = core_backfill.rebuild(conn, end=last_bar, on_progress=_progress(report, "core"))
        core_written = int(result.get("written") or 0)
        calendar = features.trading_days(conn)
    elif _final_node_needs_rebuild(conn, calendar, last_bar):
        report("core", f"{last_bar} 当日节点按收盘终值重算")
        core_backfill.rebuild_node(conn, last_bar)
        core_written += 1

    heal = node_to_complete(conn, calendar, last_bar)
    if heal:
        report("core", f"{heal} 节点日份额已落地, 用完整排名重算")
        core_backfill.rebuild_node(conn, heal)
        core_written += 1

    record_days = _rebuild_records(conn, calendar, last_bar, report)
    _warm_screen(conn, last_bar, report)
    report(None, None)
    return {"last_bar": last_bar, "core_nodes": core_written, "record_days": record_days}


def shares_chain(report: Report) -> dict[str, Any]:
    """凌晨份额链: 重拉最近 N 个交易日份额 → 补算节点日份额缺失的节点 → 重算最近交易日记录。"""
    conn = get_conn()
    if not _has_universe(conn):
        return {"skipped": "ETF 清单为空, 请先在数据任务页执行一键准备"}
    last_bar = _last_daily(conn)
    if last_bar is None:
        return {"skipped": "尚无日K, 请先执行一键准备"}
    report("calendar", None)
    raw_jobs.refresh_calendar()
    calendar = features.trading_days(conn)
    report("shares", f"重拉最近 {SHARES_RESYNC_DAYS} 个交易日份额")
    raw_jobs.backfill_shares(on_progress=_progress(report, "shares"), recent_days=SHARES_RESYNC_DAYS, end_date=last_bar)
    nodes = 0
    heal = node_to_complete(conn, calendar, last_bar)
    if heal:
        report("core", f"{heal} 节点日份额已落地, 用完整排名重算")
        core_backfill.rebuild_node(conn, heal)
        nodes = 1
    record_days = _rebuild_records(conn, calendar, last_bar, report)
    _warm_screen(conn, last_bar, report)
    report(None, None)
    return {
        "last_bar": last_bar,
        "record_days": record_days,
        "shares_days": SHARES_RESYNC_DAYS,
        "core_nodes": nodes,
    }
```

<a id="file-backend-ops-scheduler-py"></a>

#### `backend/ops/scheduler.py`

```python
"""收盘自动刷新链的调度器: 槽位时刻、失败重试与运行时状态。

手动按钮仍是权威入口, 这里只回答"什么时刻跑哪条链"; 链的具体步骤(均幂等)在
ops/refresh_chain 里:
- 18:30 主链: 日K增量 → 指数补抓 → 份额补缺 → core8 节点 → 日度记录。
- 22:30 补一趟, 主要等中证指数当晚发布。
- 次日 00:20 份额链: 交易所份额 T+1 发布(00:00 之后), 强制重拉最近 4 个交易日,
  先补算前一晚用 T-1 份额建出的最新节点(完整排名定下开盘补买/顺延卖), 再重算最近
  交易日的日度记录, 让快照落到"份额已完整"的终态。收盘主链也会兜底补算一次。

任何一步失败都不推进"今晚已完成"标记, 冷却 30 分钟后重试; 重试 3 次仍失败则
放弃当晚(下一槽位的链会自然补上)。网抓全程受 kline 请求级节流, 主链约 10 分钟。
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta
from typing import Any

from ops import refresh_chain

# 00:20 份额回补(T+1 数据 00:00 后才发布); 18:30 收盘主链; 22:30 等中证指数。
RUN_SLOTS = (("shares", (0, 20)), ("close", (18, 30)), ("late", (22, 30)))
CHECK_INTERVAL_SEC = 60
RETRY_COOLDOWN_SEC = 30 * 60
MAX_ATTEMPTS_PER_SLOT = 3

_STATE_LOCK = threading.Lock()
_CHAIN_LOCK = threading.Lock()
_STOP = threading.Event()
_STARTED = False
_DONE: dict[str, str] = {}
_ATTEMPTS: dict[str, int] = {}
_COOLDOWN_UNTIL: dict[str, float] = {}
_STATE: dict[str, Any] = {
    "state": "idle",
    "slot": None,
    "stage": None,
    "signal_date": None,
    "started_at": None,
    "finished_at": None,
    "detail": None,
    "next_run": None,
}


def _set(**fields: Any) -> None:
    with _STATE_LOCK:
        _STATE.update(fields)


def status() -> dict[str, Any]:
    with _STATE_LOCK:
        data = dict(_STATE)
        data["done"] = dict(_DONE)
    return data


def _stamp(now: datetime) -> str:
    return now.strftime("%Y-%m-%d %H:%M:%S")


def _report(stage: str | None, detail: str | None = None) -> None:
    """刷新链的运行阶段回调: 每步开始/结束时更新对外状态。"""
    _set(stage=stage, detail=detail)


def _chain(slot: str) -> dict[str, Any]:
    return refresh_chain.shares_chain(_report) if slot == "shares" else refresh_chain.close_chain(_report)


def run_chain(slot: str = "manual") -> dict[str, Any]:
    """同步跑对应槽位的链(供调度线程使用); 状态写入模块级 _STATE 供接口查询。"""
    now = datetime.now()
    with _CHAIN_LOCK:
        _set(
            state="running",
            slot=slot,
            stage="starting",
            started_at=_stamp(now),
            finished_at=None,
            detail=None,
        )
        try:
            result = _chain(slot)
        except Exception as e:  # noqa: BLE001 - 后台失败要落状态, 由重试机制兜底
            _set(state="failed", stage=None, detail=str(e), finished_at=_stamp(datetime.now()))
            raise
        signal_date = result.get("last_bar") or _STATE["signal_date"]
        _set(
            state="skipped" if result.get("skipped") else "done",
            stage=None,
            signal_date=signal_date,
            detail=str(result),
            finished_at=_stamp(datetime.now()),
        )
        return result


def _slot_key(today: str, slot: str) -> str:
    return f"{today}:{slot}"


def _due_slot(now: datetime) -> str | None:
    """当前时刻应执行、且今晚还没成功的槽位; 早于第一个槽位返回 None。"""
    today = now.strftime("%Y-%m-%d")
    for slot, (hour, minute) in RUN_SLOTS:
        if now.hour < hour or (now.hour == hour and now.minute < minute):
            return None
        if _DONE.get(slot) != today:
            return slot
    return None


def _next_run(now: datetime) -> str:
    for _, (hour, minute) in RUN_SLOTS:
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target > now:
            return _stamp(target)
    first = (now + timedelta(days=1)).replace(hour=RUN_SLOTS[0][1][0], minute=RUN_SLOTS[0][1][1], second=0)
    return _stamp(first)


def _mark_done(slot: str, today: str) -> None:
    with _STATE_LOCK:
        _DONE[slot] = today


def _manual_bootstrap_running() -> bool:
    """手动「一键准备」是空库初始化/全量补数的权威入口, 运行期间自动链让路。

    两套全量拉取并发会重复请求并放大限流风险; 让路不丢事: 准备结束后下一个 tick
    仍会发现槽位未完成, 自动链再按增量补一遍即可。
    """
    from ops import bootstrap  # 延迟导入: 页面域反向依赖调度器, 模块级导入容易成环

    return bool(bootstrap.status()["state"] == "running")


def _tick(now: datetime) -> None:
    _set(next_run=_next_run(now))
    if _manual_bootstrap_running():
        return
    slot = _due_slot(now)
    if slot is None:
        return
    # 周末不抓行情; 但周五份额周六凌晨才发布, 周六的份额槽位照常跑一趟。
    if now.weekday() >= 5 and not (slot == "shares" and now.weekday() == 5):
        return
    today = now.strftime("%Y-%m-%d")
    key = _slot_key(today, slot)
    if _ATTEMPTS.get(key, 0) >= MAX_ATTEMPTS_PER_SLOT:
        _mark_done(slot, today)
        return
    if _COOLDOWN_UNTIL.get(key, 0) > time.time():
        return
    try:
        run_chain(slot)
        _mark_done(slot, today)
    except Exception:  # noqa: BLE001 - 单晚失败不终止调度线程
        _ATTEMPTS[key] = _ATTEMPTS.get(key, 0) + 1
        _COOLDOWN_UNTIL[key] = time.time() + RETRY_COOLDOWN_SEC


def _loop() -> None:
    while not _STOP.is_set():
        try:
            _tick(datetime.now())
        except Exception as e:  # noqa: BLE001 - 调度线程必须存活到下一次 tick
            _set(state="failed", detail=f"调度异常: {e}")
        _STOP.wait(CHECK_INTERVAL_SEC)


def start() -> None:
    """FastAPI 启动时调用; 重复调用只起一个线程。"""
    global _STARTED
    if _STARTED:
        return
    _STARTED = True
    threading.Thread(target=_loop, name="daily-refresh", daemon=True).start()


def stop() -> None:
    global _STARTED
    _STOP.set()
    _STARTED = False
```

<a id="file-backend-ops-seed-py"></a>

#### `backend/ops/seed.py`

```python
"""预热快照: 代码库自带一份历史切片, 空库先本地装载, 只在线补快照之后的增量。

为什么需要: 全量在线回填要拉 1767 只 ETF 的全历史日K 和 2015 年起逐日全市场份额,
网络与限流成本高(数十分钟起步); 派生层(core8 节点 + 日度记录)全量重算也要二十分钟。
快照把原始表与派生表一起固化成 gzip CSV(约 35MB)随仓库分发, 一键准备时先装载到
cut-off 日, 再由增量链路补齐之后的部分。

装载按表进行: 目标表已有数据就跳过该表, 因此重复执行安全; 数值列按 schema 类型回填,
不会把 REAL 写成文本(否则 SQL 排序与计算都会退化成字符串比较)。派生表按 signal_date
截到 cut-off, 未来日期的空结算行不随快照分发(否则增量重算会从日历末尾起算)。
"""

from __future__ import annotations

import csv
import gzip
import json
import sqlite3
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from pages.daily.review import store as daily_store
from services.scoring.core import store as core_store

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
MANIFEST_PATH = SEED_DIR / "manifest.json"
RAW_TABLES = ("etfs", "trade_calendar", "etf_daily", "etf_shares", "etf_share_scale", "indices", "index_daily")
DERIVED_TABLES = ("fitted_core_summary", "fitted_core_pick", "fitted_daily_summary", "fitted_daily_pick")
TABLES = RAW_TABLES + DERIVED_TABLES
BATCH_ROWS = 5000
RowReport = Callable[[str, int, int], None]


def manifest() -> dict[str, Any] | None:
    """读取快照清单; 缺失或损坏时返回 None, 由调用方降级为在线全量。"""
    if not MANIFEST_PATH.is_file():
        return None
    try:
        with MANIFEST_PATH.open(encoding="utf-8") as f:
            info: dict[str, Any] = json.load(f)
            return info
    except (OSError, json.JSONDecodeError):
        return None


def _has_rows(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is not None


def _missing_files(conn: sqlite3.Connection, info: dict[str, Any]) -> list[str]:
    """清单里仍需装载却缺失的快照文件。

    只检查库内还没有数据的表: 已有数据的表本来就会跳过, 缺文件不影响它。
    文档/仓库只带 manifest 而没带 gzip 时(例如从文档还原的代码库), 这里返回非空,
    调用方降级为在线全量拉取, 而不是在装载第一张表时抛 FileNotFoundError。
    """
    missing: list[str] = []
    for table in TABLES:
        meta = info["tables"].get(table)
        if not meta or _has_rows(conn, table):
            continue
        if not (SEED_DIR / meta["file"]).is_file():
            missing.append(meta["file"])
    return missing


def _convert(raw: str, decl: str) -> Any:
    if raw == "":
        return None
    upper = decl.upper()
    if "INT" in upper:
        return int(raw)
    if any(t in upper for t in ("REAL", "FLOA", "DOUB", "NUMERIC", "DECIMAL")):
        return float(raw)
    return raw


def _load_table(conn: sqlite3.Connection, table: str, info: dict[str, Any], on_rows: RowReport | None) -> int:
    columns: list[str] = info["columns"]
    total = int(info.get("rows", 0))
    decls = {row[1]: str(row[2] or "") for row in conn.execute(f"PRAGMA table_info({table})")}
    sql = f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})"
    done = 0
    with gzip.open(SEED_DIR / info["file"], "rt", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        if header != columns:
            raise ValueError(f"{table} 快照列与 schema 不一致")
        batch: list[list[Any]] = []
        for raw in reader:
            batch.append([_convert(v, decls.get(c, "")) for c, v in zip(header, raw)])
            if len(batch) >= BATCH_ROWS:
                conn.executemany(sql, batch)
                done += len(batch)
                batch.clear()
                conn.commit()
                if on_rows:
                    on_rows(table, done, total)
        if batch:
            conn.executemany(sql, batch)
            done += len(batch)
            conn.commit()
    if on_rows:
        on_rows(table, done, total)
    return done


def restore(conn: sqlite3.Connection, on_rows: RowReport | None = None) -> dict[str, Any]:
    """把快照装进空库; 已有数据的表跳过。返回装载的截止日与行数。"""
    m = manifest()
    if m is None:
        return {"skipped": "代码库未附带预热快照, 改为在线全量拉取"}
    core_store.ensure_schema(conn)
    daily_store.ensure_schema(conn)
    missing = _missing_files(conn, m)
    if missing:
        return {"skipped": f"快照文件缺失({len(missing)} 个), 改为在线全量拉取"}
    restored: dict[str, int] = {}
    for table in TABLES:
        info = m["tables"].get(table)
        if not info or _has_rows(conn, table):
            continue
        restored[table] = _load_table(conn, table, info, on_rows)
    if not restored:
        return {"skipped": "库内已有数据, 无需装载快照"}
    return {"cutoff": m.get("cutoff"), "tables": restored, "rows": sum(restored.values())}


def build(src: str | Path, out_dir: Path = SEED_DIR) -> dict[str, Any]:
    """从已有数据库导出快照(gzip CSV + manifest), 供随仓库分发。"""
    src_conn = sqlite3.connect(str(src))
    out_dir.mkdir(parents=True, exist_ok=True)
    cutoff = src_conn.execute("SELECT MAX(date) FROM etf_daily").fetchone()[0]
    tables: dict[str, Any] = {}
    for table in TABLES:
        columns = [row[1] for row in src_conn.execute(f"PRAGMA table_info({table})")]
        where = f" WHERE signal_date <= '{cutoff}'" if table in DERIVED_TABLES and cutoff else ""
        path = out_dir / f"{table}.csv.gz"
        rows = 0
        with gzip.open(path, "wt", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(columns)
            for row in src_conn.execute(f"SELECT {', '.join(columns)} FROM {table}{where}"):
                writer.writerow(["" if v is None else v for v in row])
                rows += 1
        tables[table] = {"rows": rows, "columns": columns, "file": path.name}
    derived_max = src_conn.execute("SELECT MAX(signal_date) FROM fitted_daily_summary").fetchone()[0]
    src_conn.close()
    info = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "cutoff": cutoff,
        "derived_cutoff": min(derived_max, cutoff) if derived_max and cutoff else derived_max,
        "tables": tables,
    }
    with (out_dir / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    return info
```

### 14.6 后端 · 计算服务 backend/services/

<a id="file-backend-services-init-py"></a>

#### `backend/services/__init__.py`

```python
"""共用业务服务: 被多个页面与后台编排复用的纯计算, 不含 HTTP 入口。

- kline/   K线派生: 周月聚合、MACD、日/周/月状态
- scoring/ core8 评分: 描述子 → 候选行 → 打分 → 换仓 → 落库 → 理由文案
"""
```

<a id="file-backend-services-kline-init-py"></a>

#### `backend/services/kline/__init__.py`

```python
"""K线派生服务: 日K聚合周/月(aggregate) → MACD(macd) → 日/周/月状态与趋势分(states)。

只做纯计算, 不触网也不读库; 原始K线抓取仍由 data/fetch/kline.py 负责。
"""
```

<a id="file-backend-services-kline-aggregate-py"></a>

#### `backend/services/kline/aggregate.py`

```python
"""日K聚合为周K/月K: 周按 ISO 周分组, 月按自然月分组, 标签取组内最后一个交易日。"""

from __future__ import annotations

from datetime import date
from typing import Any, Callable

PERIODS = ("day", "week", "month")
Bar = dict[str, Any]
GroupKey = Callable[[date], tuple[int, ...]]


def _iso_week(day: date) -> tuple[int, int]:
    iso = day.isocalendar()
    return iso.year, iso.week


def _month(day: date) -> tuple[int, int]:
    return day.year, day.month


def _first(group: list[Bar], field: str) -> float | None:
    for bar in group:
        if bar.get(field) is not None:
            return float(bar[field])
    return None


def _last(group: list[Bar], field: str) -> float | None:
    for bar in reversed(group):
        if bar.get(field) is not None:
            return float(bar[field])
    return None


def _max(group: list[Bar], field: str) -> float | None:
    values = [bar[field] for bar in group if bar.get(field) is not None]
    return max(values) if values else None


def _min(group: list[Bar], field: str) -> float | None:
    values = [bar[field] for bar in group if bar.get(field) is not None]
    return min(values) if values else None


def _sum(group: list[Bar], field: str) -> float | None:
    values = [bar[field] for bar in group if bar.get(field) is not None]
    return sum(values) if values else None


def _aggregate(bars: list[Bar], key_of: GroupKey) -> list[Bar]:
    groups: list[list[Bar]] = []
    current: tuple[int, ...] | None = None
    for bar in bars:
        key = key_of(date.fromisoformat(bar["date"]))
        if key != current:
            groups.append([])
            current = key
        groups[-1].append(bar)
    return [
        {
            "date": group[-1]["date"],
            "open": _first(group, "open"),
            "close": _last(group, "close"),
            "high": _max(group, "high"),
            "low": _min(group, "low"),
            "volume": _sum(group, "volume"),
        }
        for group in groups
    ]


def resample(bars: list[Bar], period: str) -> list[Bar]:
    """按周期聚合; day 原样返回, 未知周期抛 ValueError。"""
    if period == "day":
        return list(bars)
    if period == "week":
        return _aggregate(bars, _iso_week)
    if period == "month":
        return _aggregate(bars, _month)
    raise ValueError(f"unsupported period: {period}")
```

<a id="file-backend-services-kline-macd-py"></a>

#### `backend/services/kline/macd.py`

```python
"""MACD(12,26,9)与周期状态: 柱体较上一根上行=走强, 下行=走弱; 柱体符号定水上/水下。"""

from __future__ import annotations

from typing import Any

FAST = 12
SLOW = 26
SIGNAL = 9
# DIF 需 SLOW 根; DEA/柱再需 SIGNAL-1 根, 与常见行情软件的预热口径一致。
MIN_BARS = SLOW + SIGNAL - 2

Bar = dict[str, Any]


def ema(values: list[float], span: int) -> list[float]:
    alpha = 2 / (span + 1)
    out: list[float] = []
    for value in values:
        out.append(value if not out else alpha * value + (1 - alpha) * out[-1])
    return out


def _closes(bars: list[Bar]) -> list[float | None]:
    """缺收盘(停牌/坏数据)沿用前值, 保证序列连续; 序列头部缺失保持 None。"""
    out: list[float | None] = []
    last: float | None = None
    for bar in bars:
        close = bar.get("close")
        if close is not None:
            last = float(close)
        out.append(last)
    return out


def attach(bars: list[Bar]) -> list[Bar]:
    """返回带 dif/dea/hist 的新列表; 预热期字段为 None, 不伪造指标值。"""
    result = [dict(bar) for bar in bars]
    closes = _closes(bars)
    start = next((i for i, value in enumerate(closes) if value is not None), None)
    if start is None:
        return _fill(result, range(len(result)), None, None, None)

    values = [value for value in closes[start:] if value is not None]
    fast = ema(values, FAST)
    slow = ema(values, SLOW)
    dif = [f - s for f, s in zip(fast, slow)]
    dea = ema(dif, SIGNAL)
    hist = [2 * (d - e) for d, e in zip(dif, dea)]

    result = _fill(result, range(start), None, None, None)
    for index in range(start, len(result)):
        offset = index - start
        if offset < SLOW - 1:
            result[index].update(dif=None, dea=None, hist=None)
        elif offset < MIN_BARS:
            result[index].update(dif=dif[offset], dea=None, hist=None)
        else:
            result[index].update(dif=dif[offset], dea=dea[offset], hist=hist[offset])
    return result


def _fill(bars: list[Bar], indexes: range, dif: float | None, dea: float | None, hist: float | None) -> list[Bar]:
    for index in indexes:
        bars[index].update(dif=dif, dea=dea, hist=hist)
    return bars


def state(bars: list[Bar], period: str | None = None, lag: int = 0) -> dict[str, Any] | None:
    """最新一根相对上一根的柱体变化与零轴位置; lag 用于跳过尚未确认的末根; 预热不足返回 None。

    trend 按带符号的柱体差值判定: 上行=rising(走强), 下行=falling(走弱)。
    不能比较绝对值——柱体由 +0.001 翻到 -0.002 时绝对值变大, 但那是死叉转空而非"放大"。
    zone 按当根柱体符号判定: 红柱=above(水上), 绿柱=below(水下), 柱体恰为 0=zero(零轴)。
    不用 DIF/DEA 符号定区——用户看图按柱体颜色读水上/水下, DIF/DEA 同侧时柱体常已翻绿,
    旧口径会把"绿柱区里的形态"标成水上, 与看图口径矛盾。
    flip 标记当根是否穿越零轴(golden/dead), 供展示用。
    """
    if len(bars) < 2 + lag:
        return None
    last, prev = bars[-1 - lag], bars[-2 - lag]
    if last.get("hist") is None or prev.get("hist") is None:
        return None
    hist = float(last["hist"])
    hist_prev = float(prev["hist"])
    if hist > hist_prev:
        trend = "rising"
    elif hist < hist_prev:
        trend = "falling"
    else:
        trend = "flat"
    if hist > 0 >= hist_prev:
        flip = "golden"
    elif hist < 0 <= hist_prev:
        flip = "dead"
    else:
        flip = None
    dif = float(last["dif"])
    dea = float(last["dea"])
    if hist > 0:
        zone = "above"
    elif hist < 0:
        zone = "below"
    else:
        zone = "zero"
    return {
        "period": period,
        "date": last["date"],
        "dif": dif,
        "dea": dea,
        "hist": hist,
        "hist_prev": hist_prev,
        "trend": trend,
        "flip": flip,
        "zone": zone,
    }
```

<a id="file-backend-services-kline-states-py"></a>

#### `backend/services/kline/states.py`

```python
"""信号日的日/周/月 MACD 状态与趋势分。

时点纪律(防后视镜):
1) 日线/周线只取信号日及之前的已收盘 K 线, 周线标签=该周最后交易日;
2) 周线看"上周 vs 上上周": 信号周的周K与信号同日收盘, 拿它比上一周会和日线同源、
   连 2% 的柱体抖动都算放大; 只用已结算的两根周K判断周线动能;
3) 月线用"当月至今"收盘 + 已完成月份递推, 绝不引用未来月末收盘;
4) MACD 从标的上市首根 K 线递推, 预热不足的周期返回 None, 不参与打分。

评分口径(四象限, zone 按当根柱体符号: 红柱=水上/绿柱=水下):
水上走强(红柱放大)= 唯一两周期都跑赢基准的象限 → 满分。
水下走强(绿柱缩短)≠ 见底信号: 事件研究(全部信号周候选, 信号→下周收益)显示其为最差
日线象限(均值 -0.20%/胜率 46.8%, 全样本基准 +0.06%/48.5%)——绿柱缩短只说明本轮下跌
动能暂停, 常见于持续阴跌的中继; 周线口径略正(+0.21%), 故减半扣分而非扣满。
水上走弱(红柱缩短)= 动能衰减但两样本均值 ≈ 0, 方向不明确, 不奖不罚; 真转空由死叉
落到水下走弱扣分。水下走弱(绿柱放大)= 做空动能增强, 回撤子集 -0.60%/胜率 43.5% → 扣满。
柱体持平/零轴记 0。不能比较柱体绝对值——否则会把死叉后的扩张误判成"放大"。
趋势分按 日0.6/周0.3/月0.1 加权, 三周期合计范围 [-1, 1]; 日线最灵敏且权重是周线两倍,
月线只做背景; 缺失周期不参与, 不放大剩余周期。

2026-11-13 教训: 曾实验"滑动窗口相位分"(柱体/自身振幅 + 日周齐升硬门槛,
mechanical-v4), 设计验证时误把"信号→下一交易日"当"信号→下一周", 把次日惯性
(+0.61%/日)当成周度边际; 真实周线口径下日周齐升是一周内短期反转信号
(门槛内 −0.12%/周 vs 全池 +0.11%/周), 已全部回退。此类事件研究必须核对持有期
与换仓口径一致。
"""

from __future__ import annotations

import math
import sqlite3
from array import array
from bisect import bisect_left
from collections.abc import Iterator
from typing import Any

from services.kline import aggregate, macd

# 趋势分权重: 日线主导(周线的两倍), 月线只做背景; 三周期合计最大 ±1。
PERIOD_WEIGHTS: dict[str, float] = {"day": 0.60, "week": 0.30, "month": 0.10}
# 周线回退一根: 信号周的周K与信号同日收盘, 用它比上周等于判日线, 只能看已结算的两根周K。
WEEK_LAG = 1
# 四象限得分, 依据 2026-11 事件研究(139k 日线样本 / 12.6k 回撤子集, 信号→下周收益)。
SIGN: dict[tuple[str, str], float] = {
    ("above", "rising"): 1.0,  # 红柱放大: 全样本 +0.28%/hit 51.0%, 回撤子集 +0.11%/hit 54.0%
    ("above", "falling"): 0.0,  # 红柱缩短: 动能衰减但两样本均值 ≈ 0, 不奖不罚; 死叉转空落 (below, falling)
    ("below", "rising"): -0.5,  # 绿柱缩短: 全样本 -0.20% 最差/hit 46.8%; 周线 +0.21% 故减半
    ("below", "falling"): -1.0,  # 绿柱放大: 回撤子集 -0.60%/hit 43.5%, 做空动能增强
}
PERIODS: tuple[tuple[str, str], ...] = (("day", "日"), ("week", "周"), ("month", "月"))


def trend_score(states: dict[str, dict[str, Any] | None]) -> float:
    """三周期四象限趋势分, 范围 [-1, 1]; 缺失周期不参与, 不放大剩余周期。"""
    total = 0.0
    for period, weight in PERIOD_WEIGHTS.items():
        state = states.get(period)
        if state is not None:
            total += weight * SIGN.get((state["zone"], state["trend"]), 0.0)
    return round(total, 4)


def latest(bars: list[dict[str, Any]], period: str) -> dict[str, Any] | None:
    """最新一根K线的状态(页面实时展示用); 周线同样跳过尚未确认的当周。"""
    return macd.state(bars, period, WEEK_LAG if period == "week" else 0)


def _date_key(day: str) -> int:
    return int(day.replace("-", ""))


def _key_date(key: int) -> str:
    return f"{key // 10000:04d}-{key // 100 % 100:02d}-{key % 100:02d}"


def _value(values: array, index: int) -> float | None:
    value = values[index]
    return None if math.isnan(value) else float(value)


def _values(rows: list[dict[str, Any]], field: str) -> array:
    return array("d", [math.nan if row.get(field) is None else float(row[field]) for row in rows])


def _step(value: float, previous: float, span: int) -> float:
    alpha = 2 / (span + 1)
    return alpha * value + (1 - alpha) * previous


def _forward_closes(bars: list[dict[str, Any]]) -> list[float | None]:
    out: list[float | None] = []
    last: float | None = None
    for bar in bars:
        if bar.get("close") is not None:
            last = float(bar["close"])
        out.append(last)
    return out


class _Series:
    """日线或周线: 标签=该周期最后交易日, 指标已按整段历史递推。"""

    __slots__ = ("labels", "dif", "dea", "hist")

    def __init__(self, enriched: list[dict[str, Any]]) -> None:
        self.labels = array("i", [_date_key(bar["date"]) for bar in enriched])
        self.dif = _values(enriched, "dif")
        self.dea = _values(enriched, "dea")
        self.hist = _values(enriched, "hist")

    def state_at(self, key: int, period: str, lag: int = 0) -> dict[str, Any] | None:
        index = bisect_left(self.labels, key)
        if index < 1 or index >= len(self.labels) or self.labels[index] != key:
            return None
        index -= lag
        if index < 1:
            return None
        last = self._bar(index)
        prev = self._bar(index - 1)
        if last["hist"] is None or prev["hist"] is None:
            return None
        return macd.state([prev, last], period)

    def _bar(self, index: int) -> dict[str, Any]:
        return {
            "date": _key_date(int(self.labels[index])),
            "dif": _value(self.dif, index),
            "dea": _value(self.dea, index),
            "hist": _value(self.hist, index),
        }


class _MonthSeries:
    """月线: 已完成月份用于递推, 当月柱体由调用方传入的信号日收盘补成 MTD。"""

    __slots__ = ("keys", "labels", "start", "fast", "slow", "dif", "dea", "hist")

    def __init__(self, bars: list[dict[str, Any]]) -> None:
        groups = aggregate.resample(bars, "month")
        self.labels = array("i", [_date_key(bar["date"]) for bar in groups])
        self.keys = array("i", [int(label) // 100 for label in self.labels])
        closes = _forward_closes(groups)
        start = next((i for i, value in enumerate(closes) if value is not None), len(groups))
        self.start = start
        values = [float(value) for value in closes[start:] if value is not None]
        fast = macd.ema(values, macd.FAST)
        slow = macd.ema(values, macd.SLOW)
        dif = [f - s for f, s in zip(fast, slow)]
        dea = macd.ema(dif, macd.SIGNAL)
        hist = [2 * (d - e) for d, e in zip(dif, dea)]
        pad = [math.nan] * start
        self.fast = array("d", pad + fast)
        self.slow = array("d", pad + slow)
        self.dif = array("d", pad + dif)
        self.dea = array("d", pad + dea)
        self.hist = array("d", pad + hist)

    def state_at(self, day_key: int, close: float | None) -> dict[str, Any] | None:
        if close is None:
            return None
        month_key = day_key // 100
        index = bisect_left(self.keys, month_key)
        if index >= len(self.keys) or self.keys[index] != month_key:
            return None
        if index <= 0 or index < self.start + macd.MIN_BARS:
            return None
        fast_prev = _value(self.fast, index - 1)
        slow_prev = _value(self.slow, index - 1)
        dif_prev = _value(self.dif, index - 1)
        dea_prev = _value(self.dea, index - 1)
        hist_prev = _value(self.hist, index - 1)
        if fast_prev is None or slow_prev is None or dif_prev is None or dea_prev is None or hist_prev is None:
            return None
        fast = _step(close, fast_prev, macd.FAST)
        slow = _step(close, slow_prev, macd.SLOW)
        dif = fast - slow
        dea = _step(dif, dea_prev, macd.SIGNAL)
        hist = 2 * (dif - dea)
        prev = {"date": _key_date(int(self.labels[index - 1])), "dif": dif_prev, "dea": dea_prev, "hist": hist_prev}
        last = {"date": _key_date(day_key), "dif": dif, "dea": dea, "hist": hist}
        return macd.state([prev, last], "month")


class _CodeStates:
    __slots__ = ("day", "week", "month")

    def __init__(self, bars: list[dict[str, Any]]) -> None:
        self.day = _Series(macd.attach(bars))
        self.week = _Series(macd.attach(aggregate.resample(bars, "week")))
        self.month = _MonthSeries(bars)

    def states(self, signal: str, close: float | None) -> dict[str, dict[str, Any] | None]:
        key = _date_key(signal)
        return {
            "day": self.day.state_at(key, "day"),
            "week": self.week.state_at(key, "week", WEEK_LAG),
            "month": self.month.state_at(key, close),
        }


def _iter_by_code(conn: sqlite3.Connection, end: str) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    cursor = conn.execute(
        "SELECT code, date, open, close, high, low, volume FROM etf_daily WHERE date <= ? ORDER BY code, date",
        (end,),
    )
    code: str | None = None
    bars: list[dict[str, Any]] = []
    for row in cursor:
        if row["code"] != code:
            if code is not None:
                yield code, bars
            code, bars = row["code"], []
        bars.append(dict(row))
    if code is not None:
        yield code, bars


class MacdStateProvider:
    """一次加载全历史, 之后按 (code, signal) 查询; 不缓存 607 个信号的结果以省内存。"""

    def __init__(self, series: dict[str, _CodeStates] | None = None) -> None:
        self._series = series or {}

    @classmethod
    def load(cls, conn: sqlite3.Connection, end: str) -> MacdStateProvider:
        return cls({code: _CodeStates(bars) for code, bars in _iter_by_code(conn, end)})

    @classmethod
    def from_bars(cls, bars_by_code: dict[str, list[dict[str, Any]]]) -> MacdStateProvider:
        """内存 K 线构造: 盘中实时预选要把今日合成 bar 并入序列, 只读库拿不到这根。"""
        return cls({code: _CodeStates(bars) for code, bars in bars_by_code.items()})

    def day_series(self, code: str) -> _Series | None:
        """core8 需要柱体原值(dif/dea/hist), 而不是四象限状态。"""
        item = self._series.get(code)
        return item.day if item is not None else None

    def states(self, code: str, signal: str, close: float | None) -> dict[str, dict[str, Any] | None]:
        item = self._series.get(code)
        if item is None:
            return {period: None for period in PERIOD_WEIGHTS}
        return item.states(signal, close)
```

<a id="file-backend-services-scoring-init-py"></a>

#### `backend/services/scoring/__init__.py`

```python
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
```

<a id="file-backend-services-scoring-core-init-py"></a>

#### `backend/services/scoring/core/__init__.py`

```python
"""core8 组合: 打分(score) → 换仓网格(rebalance) → 取数与单日评分(data) → 持久化(store)。"""
```

<a id="file-backend-services-scoring-core-data-py"></a>

#### `backend/services/scoring/core/data.py`

```python
"""core8 的取数与单日评分: 加载截至信号日的行情/份额/基准, 复用 core 的纯函数打分。

拆在这里是因为回填要"一次加载、逐节点切片"(每个节点都重读全库会慢一个数量级),
build 与 core_backfill 共用同一份切片口径, 避免两套 logic 打分。
时点纪律: 只读 ≤ 信号日的行; load_end 只放大"能读到哪天", 切片仍按信号日截断。
"""

from __future__ import annotations

import math
import sqlite3
from bisect import bisect_left, bisect_right
from typing import Any

from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.descriptors import cross_section, slices


def load_context(conn: sqlite3.Connection, signal: str, load_end: str | None = None) -> dict[str, Any]:
    """加载 [信号日-270 交易日, load_end]; 份额窗口取 120 日以保证 60 点切片是满的。"""
    calendar = features.trading_days(conn)
    idx = bisect_left(calendar, signal)
    if idx >= len(calendar) or calendar[idx] != signal:
        raise ValueError(f"{signal} 不是交易日")
    end = load_end or signal
    data_start = calendar[max(0, idx - features.HISTORY_DAYS)]
    shares_start = calendar[max(0, idx - slices.SHARES_SLICE_DAYS * 2)]
    meta = features.load_meta(conn)
    scope = features.equity_a_share_codes(meta)
    daily_all = {c: b for c, b in features.load_daily(conn, data_start, end).items() if c in scope}
    shares_all = {c: s for c, s in features.load_shares(conn, shares_start, end).items() if c in scope}
    indices = features.load_index(conn, data_start, end)
    return {
        "meta": meta,
        "daily_all": daily_all,
        "daily_dates": {c: [bar["date"] for bar in bars] for c, bars in daily_all.items()},
        "shares_all": shares_all,
        "shares_dates": {c: [pt["date"] for pt in pts] for c, pts in shares_all.items()},
        "shares_through": max((pts[-1]["date"] for pts in shares_all.values() if pts), default=None),
        "bench": indices.get(cross_section.HS300_CODE, []),
        "provider": macd_states.MacdStateProvider.load(conn, end),
    }


def score_signal(
    ctx: dict[str, Any],
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
    shares_before: bool = False,
) -> list[dict[str, Any]]:
    """切片 → 特征 → 候选池 → core8 评分, 返回按分降序的行(含 core_rank)。

    shares_before=True 只用严格早于信号日的份额 = 节点日收盘时的"预备排名"
    (当日份额 T+1 才发布), 用来决定周四收盘先卖谁。
    """
    daily, shares = slices.slice_universe(
        ctx["daily_all"],
        ctx["daily_dates"],
        ctx["shares_all"],
        ctx["shares_dates"],
        signal,
        features.HISTORY_DAYS,
        shares_before=shares_before,
    )
    bench = ctx["bench"]
    b_idx = bisect_right([b["date"] for b in bench], signal)
    bench_map = {b["date"]: b["close"] for b in bench[max(0, b_idx - features.HISTORY_DAYS) : b_idx]}
    rows = features.build_features(signal, ctx["meta"], daily, shares, bench_map)
    candidates = features.select_candidates(rows, min_aum)
    return core.score_rows(candidates, daily, shares, ctx["provider"], signal)


def item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": row["code"],
        "name": row.get("name"),
        "core_rank": row["core_rank"],
        "core_score": row["core_score"],
        "features": {k: (None if not math.isfinite(v) else round(v, 4)) for k, v in row["core_features"].items()},
    }


def build(
    conn: sqlite3.Connection,
    signal: str,
    held: list[str],
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    """单日评分与目标持仓; 非换仓日保持 held 不变(held 为空时按首次建仓处理)。"""
    scored = score_signal(load_context(conn, signal), signal, min_aum)
    calendar = features.trading_days(conn)
    ranked = [row["code"] for row in scored]
    on_rebalance = rebalance.should_rebalance(calendar, signal)
    target = rebalance.rebalance(held, ranked) if (on_rebalance or not held) else list(held)
    details = {row["code"]: row for row in scored}
    return {
        "signal_date": signal,
        "rebalance": on_rebalance,
        "next_rebalance": rebalance.next_rebalance(calendar, signal),
        "scored": len(scored),
        "min_aum_yi": min_aum,
        "holdings": target,
        "holding_details": [item(details[c]) for c in target if c in details],
        "ranked": [item(row) for row in scored[:20]],
    }
```

<a id="file-backend-services-scoring-core-rebalance-py"></a>

#### `backend/services/scoring/core/rebalance.py`

```python
"""core8 换仓网格与缓冲带: 节点判定与目标持仓, 与评分计算(core.py)分开。

缓冲带口径: 已持有名字排名仍在前 HOLD_BUFFER_RANK 就继续持有, 空位按排名补足;
节点网格以 CORE_ANCHOR 为起点每 REBALANCE_EVERY 个交易日一个节点。两者同源,
改锚点必须 core_backfill 全量重建(见 core.py 的 CORE_ANCHOR 注释)。
"""

from __future__ import annotations

from bisect import bisect_left
from collections.abc import Sequence

from services.scoring.core.score import CORE_ANCHOR, HOLD_BUFFER_RANK, HOLD_TOP, REBALANCE_EVERY


def rebalance(
    held: Sequence[str],
    ranked: Sequence[str],
    top: int = HOLD_TOP,
    buffer: int = HOLD_BUFFER_RANK,
) -> list[str]:
    """已持有名字排名仍在前 buffer 就继续持有, 空位按排名补足。"""
    rank = {code: i for i, code in enumerate(ranked)}
    kept = [c for c in held if rank.get(c, len(ranked)) < buffer][:top]
    picked = set(kept)
    for code in ranked:
        if len(kept) >= top:
            break
        if code not in picked:
            kept.append(code)
            picked.add(code)
    return kept


def should_rebalance(
    calendar: Sequence[str],
    signal: str,
    anchor: str = CORE_ANCHOR,
    step: int = REBALANCE_EVERY,
) -> bool:
    idx = calendar.index(signal)
    start = bisect_left(calendar, anchor)
    return (idx - start) % step == 0


def next_rebalance(
    calendar: Sequence[str],
    signal: str,
    anchor: str = CORE_ANCHOR,
    step: int = REBALANCE_EVERY,
) -> str | None:
    idx = calendar.index(signal)
    start = bisect_left(calendar, anchor)
    nxt = idx + step - (idx - start) % step
    return calendar[nxt] if nxt < len(calendar) else None


def rebalance_nodes(calendar: Sequence[str], start: str = CORE_ANCHOR, end: str | None = None) -> list[str]:
    """从锚点起每 step 个交易日一个换仓节点, 与 should_rebalance 判定同源。"""
    idx = bisect_left(calendar, start)
    nodes = calendar[idx::REBALANCE_EVERY]
    return [d for d in nodes if end is None or d <= end]
```

<a id="file-backend-services-scoring-core-score-py"></a>

#### `backend/services/scoring/core/score.py`

```python
"""core8 日频核心分 + 排名缓冲带: 每日评分, 每 5 个交易日换仓, 跌出前 15 才卖。

核心认知(2022-01..2026-11, 236 个五日采样日, A股指数型-股票 + 规模≥2亿):
- 15 个窗口描述子做岭回归定权没有样本外效果(扩张窗口 OOS 为负); 固定符号的 8 因子
  在 2022-2026 每年截面 IC 为正, 权重不随年份调整。
- 因子方向: 深回撤(dd60)、短期超跌(z20)、长动量(r250)为正; 高波动、份额拥挤
  (flow_z_60)与放量(amount_z_60)为负; MACD 柱体相对日波动(hist_norm)为正,
  穿轴天数(zero_cross_age)为正。份额拥挤是"反向"因子: 净流入越多, 后续越弱。
- 5 日全换: 毛 11.8%/年、回撤 25.1%; 扣一跳价差 + 万1.5 佣金后净 6.8%、回撤 27.9%。
- 排名缓冲带: 已持有名字跌出前 15 才卖, 每期换出 3.79/5 -> 2.90/5, 净 8.7%/年、
  回撤 25.3%; 毛收益同时从 68.5% 升到 74.1%, 不是单纯省成本。
- 沪深300 年线门控曾把回撤压到 15.7%, 但扩张窗口 walk-forward 只有 +2~5%/年
  (2024 年被 9 月底急涨甩下车), 未落地。
- 高位高波单边扣分: vol20≥45% 且收盘在 250 交易日最高价 3% 以内时总分 −0.10, 只减不加。
  2022-2026 累计 48.8%→52.1%(2024 +34.9%→+37.8%), 2015-2021 59.2%→59.7%; 事件口径
  命中名 5 日超额两段同为负(-0.3~-0.5%)但按节点聚类 t 仅 -0.3~-1.3, 定位是尾部保险而非 alpha。
  曾试 −0.20/10% 宽口径: 熔涨日几乎全市场命中(2024-10-08 数千行), 等于把最强的动量名换出,
  同一段反而 -5.7pp; 只在"贴着年内新高"时扣分两段才都不亏。单用"高波动"更不稳(2015-21 +16pp、
  2022-26 -5.5pp), 必须与"年内高位"成对; 老登波动 8-20% 天然豁免, 低波高位(正常估值抬升)不罚。
  白酒/光伏/新能源/半导体在 2019-2021 最好名次 6-13、从未进前 5, 该规则对它们无感。

时点纪律: 只用 signal 日及之前的行情/份额; MACD 用全历史递推序列, 不引用未来数据。
本文件只放纯计算; 取数与单日建仓在 core_data.py, 节点回填在 core_backfill.py。
"""

from __future__ import annotations

import math
import statistics
from bisect import bisect_left
from collections.abc import Sequence
from typing import Any

from services.kline import states as macd_states
from services.scoring.ranks import average_ranks

HOLD_TOP = 5
HOLD_BUFFER_RANK = 15  # 排名跌出前 15 才卖; 前 5 全换会多付约 1.1pp/年成本
REBALANCE_EVERY = 5  # 交易日; 与回测网格一致
CORE_ANCHOR = "2015-01-05"  # 换仓日网格锚点: 第 1/6/11... 个交易日; 全量历史从 2015 起算
# 注意: 改锚点会平移整条网格(2015-01-05 与旧 2022-01-04 网格相位差 1 个交易日),
# 必须 core_backfill + 日度/周度记录全量重建, 且旧网格的节点/筛选缓存要先清空,
# 否则 fitted_core_* 里会并存两套网格的节点。周度层不受影响的原因是
# weekly/records 以 min(节点日) 截断起点(2022-01-07)。
CORE_WEIGHTS: dict[str, float] = {
    "dd60": 0.20,
    "z20": 0.20,
    "r250": 0.10,
    "vol20": -0.15,
    "flow_z_60": -0.15,
    "amount_z_60": -0.10,
    "hist_norm": 0.10,
    "zero_cross_age": 0.10,
}
CORE_FEATURES: tuple[str, ...] = tuple(CORE_WEIGHTS)  # 顺序与权重表一致
FACTOR_LABELS: dict[str, str] = {
    "dd60": "60日回撤",
    "z20": "20日超跌",
    "r250": "250日动量",
    "vol20": "20日年化波动",
    "flow_z_60": "5日份额拥挤",
    "amount_z_60": "5日放量",
    "hist_norm": "MACD柱体强度",
    "zero_cross_age": "MACD穿轴天数",
}
FACTOR_KINDS: dict[str, str] = {  # 前端格式化用: pct 百分比 / num 纯数值 / days 天数
    "dd60": "pct",
    "z20": "num",
    "r250": "pct",
    "vol20": "pct",
    "flow_z_60": "num",
    "amount_z_60": "num",
    "hist_norm": "num",
    "zero_cross_age": "days",
}
MACD_BARS = 60  # 柱体形状与穿轴天数的观察窗
HIGH_VOL_MIN = 0.45  # 年化 20 日波动: 老登多在 9-20%, 双创顶部 57-94%, 45% 只命中极端段
HIGH_POS_WINDOW = 250  # 年内高位口径; 60 日口径会把回撤中的反弹也算成高位
HIGH_POS_DRAWDOWN = -0.03  # 贴年内新高才算疯牛; 放宽到 10% 会在熔涨日全市场命中, 反而跑输
HIGH_VOL_PENALTY = 0.10  # 策略分单边扣减(只减不加); 约等于半个因子的权重, 不改变主线排序


def _finite(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return math.nan
    return number if math.isfinite(number) else math.nan


def _key_date(key: int) -> str:
    return f"{key // 10000:04d}-{key // 100 % 100:02d}-{key % 100:02d}"


def rank_z(values: Sequence[float]) -> list[float]:
    """当日截面百分位(并列取平均), 映射到 [-1, 1]; 缺失给 0(中性)。

    不用标准差 z: 离散量(穿轴天数)在长尾下会被单个极值压扁, 秩变换更稳。
    """
    out = [0.0] * len(values)
    idx = [i for i, value in enumerate(values) if math.isfinite(value)]
    n = len(idx)
    if n < 20:
        return out
    ranks = average_ranks([values[i] for i in idx])
    for pos, i in enumerate(idx):
        out[i] = (ranks[pos] / (n + 1) - 0.5) * 2
    return out


def _macd_shape(
    out: dict[str, float],
    bars: Sequence[dict[str, Any]],
    series: Any,
    signal: str,
    vol20: float,
) -> None:
    if series is None or not math.isfinite(vol20) or vol20 <= 0:
        return
    key = int(signal.replace("-", ""))
    labels = series.labels
    idx = bisect_left(labels, key)
    if idx < MACD_BARS or idx >= len(labels) or labels[idx] != key:
        return
    lo = idx - MACD_BARS + 1
    hist = [_finite(series.hist[i]) for i in range(lo, idx + 1)]
    dif = [_finite(series.dif[i]) for i in range(lo, idx + 1)]
    dea = [_finite(series.dea[i]) for i in range(lo, idx + 1)]
    if any(not math.isfinite(v) for v in hist[-6:]) or any(not math.isfinite(v) for v in dif + dea):
        return
    dates = [_key_date(int(labels[i])) for i in range(lo, idx + 1)]
    close_map = {b["date"]: float(b["close"]) for b in bars}
    if any(d not in close_map for d in dates):
        return
    sig_d = vol20 / math.sqrt(252)
    if sig_d <= 0:
        return
    hrel = [hist[i] / close_map[dates[i]] for i in range(MACD_BARS)]
    out["hist_norm"] = hrel[-1] / sig_d
    age = float(MACD_BARS)
    for i in range(MACD_BARS - 1, 0, -1):
        if (dif[i] - dea[i] > 0) != (dif[i - 1] - dea[i - 1] > 0):
            age = float(MACD_BARS - 1 - i)
            break
    out["zero_cross_age"] = age


def high_vol_penalty(features: dict[str, float]) -> float:
    """年内高位 + 高波动的单边扣分: 条件不满足或数据不足都返回 0, 只减不加。"""
    vol = _finite(features.get("vol20"))
    dd = _finite(features.get("dd250"))
    if not (math.isfinite(vol) and math.isfinite(dd)):
        return 0.0
    if vol >= HIGH_VOL_MIN and dd >= HIGH_POS_DRAWDOWN:
        return HIGH_VOL_PENALTY
    return 0.0


def describe(
    row: dict[str, Any],
    bars: Sequence[dict[str, Any]],
    shares: Sequence[dict[str, Any]],
    series: Any,
    signal: str,
) -> dict[str, float]:
    """窗口内描述子; 不足样本或数据缺失给 NaN, 由 rank_z 转成中性 0。"""
    out = {name: math.nan for name in CORE_FEATURES}
    if len(bars) < 2:
        return out
    out["dd60"] = _finite(row.get("dd60"))
    out["r250"] = _finite(row.get("r250"))
    vol20 = _finite(row.get("vol20"))
    out["vol20"] = vol20
    r20 = _finite(row.get("r20"))
    if len(bars) >= 61 and math.isfinite(r20) and math.isfinite(vol20) and vol20:
        out["z20"] = r20 / (vol20 / math.sqrt(252) * math.sqrt(20))
    if len(bars) >= 60:
        amounts = [float(b["volume"]) * float(b["close"]) for b in bars[-60:]]
        sd = statistics.pstdev(amounts)
        if sd and math.isfinite(sd):
            out["amount_z_60"] = (statistics.fmean(amounts[-5:]) - statistics.fmean(amounts)) / sd
    if len(shares) >= 21:
        growths = [
            float(shares[i]["shares_yi"]) / float(shares[i - 5]["shares_yi"]) - 1
            for i in range(5, len(shares))
            if shares[i - 5].get("shares_yi") and shares[i].get("shares_yi")
        ]
        flow = _finite(row.get("flow_5d"))
        sd_f = statistics.pstdev(growths) if len(growths) > 1 else 0.0
        if math.isfinite(flow) and len(growths) >= 15 and sd_f and math.isfinite(sd_f):
            out["flow_z_60"] = (flow - statistics.fmean(growths)) / sd_f
    if len(bars) >= HIGH_POS_WINDOW:
        peak = max(float(b["close"]) for b in bars[-HIGH_POS_WINDOW:])
        if peak:
            out["dd250"] = float(bars[-1]["close"]) / peak - 1
    _macd_shape(out, bars, series, signal, vol20)
    return out


def factor_rows(features: dict[str, float], z: dict[str, float]) -> list[dict[str, Any]]:
    """单只标的的 8 因子拆解 + 命中时的扣分行, 供页面展示公式构成与合计。"""
    out = []
    for name in CORE_FEATURES:
        value = _finite(features.get(name))
        weight = CORE_WEIGHTS[name]
        rank = z.get(name, 0.0)
        out.append(
            {
                "key": name,
                "label": FACTOR_LABELS[name],
                "kind": FACTOR_KINDS[name],
                "value": value if math.isfinite(value) else None,
                "z": round(rank, 6),
                "weight": weight,
                "contrib": round(weight * rank, 6),
            }
        )
    penalty = high_vol_penalty(features)
    if penalty:
        dd = _finite(features.get("dd250"))
        out.append(
            {
                "key": "high_vol_penalty",
                "label": "高位高波惩罚",
                "kind": "pct",
                "value": dd if math.isfinite(dd) else None,
                "z": None,
                "weight": None,
                "contrib": round(-penalty, 6),
            }
        )
    return out


def score_rows(
    rows: Sequence[dict[str, Any]],
    bars_by_code: dict[str, list[dict[str, Any]]],
    shares_by_code: dict[str, list[dict[str, Any]]],
    provider: macd_states.MacdStateProvider,
    signal: str,
) -> list[dict[str, Any]]:
    """截面评分: 8 因子秩变换后按固定符号加权, 返回按分降序的行(附 core_rank)。"""
    desc = {
        r["code"]: describe(
            r,
            bars_by_code.get(r["code"], []),
            shares_by_code.get(r["code"], []),
            provider.day_series(r["code"]),
            signal,
        )
        for r in rows
    }
    z = {name: rank_z([desc[r["code"]][name] for r in rows]) for name in CORE_FEATURES}
    scored: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        item = dict(row)
        item["core_features"] = desc[row["code"]]
        item["core_factors"] = factor_rows(desc[row["code"]], {name: z[name][i] for name in CORE_FEATURES})
        item["core_score"] = round(
            sum(CORE_WEIGHTS[name] * z[name][i] for name in CORE_FEATURES) - high_vol_penalty(desc[row["code"]]),
            6,
        )
        scored.append(item)
    scored.sort(key=lambda r: -r["core_score"])
    for rank, row in enumerate(scored, 1):
        row["core_rank"] = rank
    return scored
```

<a id="file-backend-services-scoring-core-store-py"></a>

#### `backend/services/scoring/core/store.py`

```python
"""core8 缓冲带的持久化: 每个 5 日换仓节点一条汇总 + 该节点持仓/卖出/评分榜。

与 pages/daily/review/store.py 分开: 那套是逐日复盘记录(每天独立结算),
这套是带持仓记忆的状态机(持仓在节点间延续), 复盘记录从本表读取当日有效的节点持仓。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS fitted_core_summary (
    signal_date TEXT PRIMARY KEY,
    next_rebalance TEXT,
    generated_at TEXT,
    rule_version TEXT,
    scored INTEGER,
    min_aum_yi REAL,
    complete INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fitted_core_pick (
    signal_date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    core_rank INTEGER NOT NULL,
    core_score REAL NOT NULL,
    held INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL,
    factors_json TEXT,
    pre_rank INTEGER,
    PRIMARY KEY (signal_date, code)
);
"""

PICK_COLUMNS = "signal_date, code, name, core_rank, core_score, held, action, factors_json, pre_rank"


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    # 因子拆解/预备排名是后加列: 旧库 CREATE IF NOT EXISTS 不会补, 这里兼容升级。
    columns = {row[1] for row in conn.execute("PRAGMA table_info(fitted_core_pick)")}
    if "factors_json" not in columns:
        conn.execute("ALTER TABLE fitted_core_pick ADD COLUMN factors_json TEXT")
    if "pre_rank" not in columns:
        conn.execute("ALTER TABLE fitted_core_pick ADD COLUMN pre_rank INTEGER")
    summary_columns = {row[1] for row in conn.execute("PRAGMA table_info(fitted_core_summary)")}
    if "complete" not in summary_columns:
        conn.execute("ALTER TABLE fitted_core_summary ADD COLUMN complete INTEGER NOT NULL DEFAULT 1")
    conn.commit()


def _decode_pick(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    raw = item.pop("factors_json", None)
    item["factors"] = json.loads(raw) if raw else None
    return item


def replace_node(conn: sqlite3.Connection, summary: dict[str, Any], picks: list[dict[str, Any]]) -> None:
    """整节点覆盖: 重复回填不会残留旧成员。"""
    signal = summary["signal_date"]
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_core_summary "
            "(signal_date, next_rebalance, generated_at, rule_version, scored, min_aum_yi, complete) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                signal,
                summary.get("next_rebalance"),
                summary.get("generated_at"),
                summary.get("rule_version"),
                summary.get("scored"),
                summary.get("min_aum_yi"),
                1 if summary.get("complete", True) else 0,
            ),
        )
        conn.execute("DELETE FROM fitted_core_pick WHERE signal_date = ?", (signal,))
        conn.executemany(
            f"INSERT INTO fitted_core_pick ({PICK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    signal,
                    p["code"],
                    p.get("name"),
                    p["core_rank"],
                    p["core_score"],
                    1 if p.get("held") else 0,
                    p["action"],
                    json.dumps(p["factors"], ensure_ascii=False) if p.get("factors") else None,
                    p.get("pre_rank"),
                )
                for p in picks
            ],
        )


def list_nodes(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM fitted_core_summary"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("signal_date >= ?")
        params.append(start)
    if end:
        where.append("signal_date <= ?")
        params.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY signal_date"
    return [dict(r) for r in conn.execute(sql, params)]


def prune_nodes(conn: sqlite3.Connection, start: str, end: str, keep: list[str]) -> int:
    """删除窗口内本次未写入的旧节点(日历尾部无行情的空节点), 返回删除数。"""
    params: list[Any] = [start, end]
    sql = "SELECT signal_date FROM fitted_core_summary WHERE signal_date >= ? AND signal_date <= ?"
    if keep:
        sql += f" AND signal_date NOT IN ({','.join('?' * len(keep))})"
        params.extend(keep)
    dates = [r["signal_date"] for r in conn.execute(sql, params)]
    with conn:
        for date in dates:
            conn.execute("DELETE FROM fitted_core_pick WHERE signal_date = ?", (date,))
            conn.execute("DELETE FROM fitted_core_summary WHERE signal_date = ?", (date,))
    return len(dates)


def holdings_by_node(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """{节点日: 该节点持仓(按 core_rank 排序)}: 日度记录按节点延续持仓, 一次查询取全。"""
    sql = (
        "SELECT p.* FROM fitted_core_pick p "
        "JOIN fitted_core_summary s ON s.signal_date = p.signal_date "
        "WHERE p.held = 1"
    )
    params: list[Any] = []
    if start:
        sql += " AND p.signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND p.signal_date <= ?"
        params.append(end)
    sql += " ORDER BY p.signal_date, p.core_rank"
    nodes: dict[str, list[dict[str, Any]]] = {}
    for row in conn.execute(sql, params):
        item = _decode_pick(row)
        nodes.setdefault(item.pop("signal_date"), []).append(item)
    return nodes


def pre_ranks_by_node(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, dict[str, int | None]]:
    """{节点日: {code: 预备排名}}: 卖出动作属于掉出名单, 也要带出它周四收盘时的排名。"""
    sql = "SELECT signal_date, code, pre_rank FROM fitted_core_pick"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("signal_date >= ?")
        params.append(start)
    if end:
        where.append("signal_date <= ?")
        params.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    out: dict[str, dict[str, int | None]] = {}
    for row in conn.execute(sql, params):
        out.setdefault(row["signal_date"], {})[row["code"]] = row["pre_rank"]
    return out


def action_counts(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, dict[str, int]]:
    """{节点日: {hold/buy/sell/rank: 只数}}; 节点收益与换手需要。"""
    sql = "SELECT signal_date, action, COUNT(*) AS n FROM fitted_core_pick"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("signal_date >= ?")
        params.append(start)
    if end:
        where.append("signal_date <= ?")
        params.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " GROUP BY signal_date, action"
    counts: dict[str, dict[str, int]] = {}
    for row in conn.execute(sql, params):
        counts.setdefault(row["signal_date"], {})[row["action"]] = row["n"]
    return counts


def node_at(conn: sqlite3.Connection, date: str) -> str | None:
    """≤ date 的最近换仓节点: 换仓间隔期内页面继续展示上一个节点的持仓。"""
    row = conn.execute(
        "SELECT signal_date FROM fitted_core_summary WHERE signal_date <= ? ORDER BY signal_date DESC LIMIT 1",
        (date,),
    ).fetchone()
    return row["signal_date"] if row else None


def prev_node(conn: sqlite3.Connection, signal: str) -> str | None:
    """严格早于该节点的上一个节点: 单节点重算要靠它的持仓当状态。"""
    row = conn.execute(
        "SELECT signal_date FROM fitted_core_summary WHERE signal_date < ? ORDER BY signal_date DESC LIMIT 1",
        (signal,),
    ).fetchone()
    return row["signal_date"] if row else None


def node_complete(conn: sqlite3.Connection, signal: str) -> bool:
    """节点日份额是否已落地(False = 收盘时只有 T-1 份额算出的预备目标)。"""
    row = conn.execute("SELECT complete FROM fitted_core_summary WHERE signal_date = ?", (signal,)).fetchone()
    return bool(row and row["complete"])


def get_node(conn: sqlite3.Connection, signal: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM fitted_core_summary WHERE signal_date = ?", (signal,)).fetchone()
    if row is None:
        return None
    picks = [
        _decode_pick(r)
        for r in conn.execute(
            "SELECT * FROM fitted_core_pick WHERE signal_date = ? ORDER BY core_rank",
            (signal,),
        )
    ]
    data = dict(row)
    data["holdings"] = [p for p in picks if p["held"]]
    data["sells"] = [p for p in picks if p["action"] == "sell"]
    data["ranked"] = [p for p in picks if p["core_rank"] <= 20]
    data["counts"] = {
        "hold": sum(1 for p in picks if p["action"] == "hold"),
        "buy": sum(1 for p in picks if p["action"] == "buy"),
        "sell": len(data["sells"]),
    }
    return data
```

<a id="file-backend-services-scoring-descriptors-init-py"></a>

#### `backend/services/scoring/descriptors/__init__.py`

```python
"""截面描述子: 时点切片(slices) → 份额归一(scale) → 单标的因子(factors/profile)
→ 截面分位与主题(cross_section/themes)。全部是纯函数, 不读库不触网。
"""
```

<a id="file-backend-services-scoring-descriptors-cross-section-py"></a>

#### `backend/services/scoring/descriptors/cross_section.py`

```python
"""截面位置与基准对比: 多因子分位、主题相对强度、相对沪深300 的超额与敏感度。

单只 ETF 的涨幅/波动是绝对量; 截面分位回答"同期全市场同类里算强还是弱",
主题分位回答"是个体行情还是板块普涨", 基准超额与 alpha 剥离大盘 beta。
纯函数, 输入是同一信号日的候选行与 ≤ signal_date 的沪深300 收盘。
"""

from __future__ import annotations

import math
import statistics
from typing import Any

from services.scoring.descriptors import themes
from services.scoring.ranks import average_ranks

HS300_CODE = "000300"
MIN_THEME_MEMBERS = 3  # 主题成员不足时不给主题分位(小样本分位没有区分度)
RS_STRONG_RANK = 0.8
RS_STRONG_RANK_60 = 0.7  # 60 日分位要求略低: 中期强势允许最近一月先回调
RS_WEAK_RANK = 0.3
NEAR_HIGH_52W = -0.02  # 距 52 周高点 2% 以内视为贴近新高

RANK_KEYS = ("r5", "r20", "r60", "vol20", "flow_5d", "r250", "dist_52w_high")


def _ret(closes: list[float], n: int) -> float | None:
    if len(closes) <= n or closes[-1 - n] <= 0:
        return None
    return closes[-1] / closes[-1 - n] - 1


def _pct_rank(values: list[float | None]) -> list[float | None]:
    """平均秩百分位(0~1, 1=最高); 并列取平均, 缺失保持 None。"""
    out: list[float | None] = [None] * len(values)
    positions = [i for i, value in enumerate(values) if value is not None and math.isfinite(value)]
    valid = [value for value in values if value is not None and math.isfinite(value)]
    if not valid:
        return out
    if len(valid) == 1:
        return [1.0 if value is not None else None for value in values]
    ranks = average_ranks(valid)
    for offset, position in enumerate(positions):
        out[position] = (ranks[offset] - 1) / (len(valid) - 1)
    return out


def _bench_returns(bench_bars: list[dict[str, Any]]) -> dict[str, float | None]:
    closes = [b["close"] for b in sorted(bench_bars, key=lambda x: x["date"]) if b["close"]]
    return {f"r{n}": _ret(closes, n) for n in (5, 20, 60)}


def _assign_ranks(rows: list[dict[str, Any]], key: str) -> None:
    for row, rank in zip(rows, _pct_rank([row.get(key) for row in rows])):
        row[f"rank_{key}"] = rank


def _theme_stats(rows: list[dict[str, Any]]) -> None:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        row["theme"] = themes.theme_of(row.get("name"))
        groups.setdefault(row["theme"], []).append(row)
    for theme, members in groups.items():
        median = statistics.median([m["r20"] for m in members if m.get("r20") is not None] or [0.0])
        ranks = (
            _pct_rank([m.get("r20") for m in members]) if len(members) >= MIN_THEME_MEMBERS else [None] * len(members)
        )
        for member, rank in zip(members, ranks):
            member["theme"] = theme
            member["theme_count"] = len(members)
            member["theme_median_r20"] = median
            member["theme_rank_r20"] = rank
            member["theme_excess_r20"] = (member["r20"] - median) if member.get("r20") is not None else None


def enrich(rows: list[dict[str, Any]], bench_bars: list[dict[str, Any]]) -> None:
    """原地补截面分位/主题相对强度/基准超额(不改动既有评分字段)。"""
    for key in RANK_KEYS:
        _assign_ranks(rows, key)
    _theme_stats(rows)
    bench = _bench_returns(bench_bars)
    for row in rows:
        for n in (5, 20, 60):
            value, base = row.get(f"r{n}"), bench.get(f"r{n}")
            row[f"excess_r{n}"] = value - base if value is not None and base is not None else None
        r20_rank, r60_rank = row.get("rank_r20"), row.get("rank_r60")
        row["rs_strong"] = bool(
            r20_rank is not None
            and r20_rank >= RS_STRONG_RANK
            and r60_rank is not None
            and r60_rank >= RS_STRONG_RANK_60
        )
        row["rs_weak"] = bool(
            r20_rank is not None and r20_rank <= RS_WEAK_RANK and r60_rank is not None and r60_rank <= RS_WEAK_RANK
        )
        row["near_high_52w"] = bool(row.get("dist_52w_high") is not None and row["dist_52w_high"] >= NEAR_HIGH_52W)
        row["theme_leader"] = bool(
            (row.get("theme_count") or 0) >= MIN_THEME_MEMBERS and (row.get("theme_rank_r20") or 0) >= RS_STRONG_RANK
        )
```

<a id="file-backend-services-scoring-descriptors-factors-py"></a>

#### `backend/services/scoring/descriptors/factors.py`

```python
"""趋势结构与风险因子: 52 周位置、均线结构、风险调整动量、回撤、胜率、基准敏感度。

与 profile.py 分工: profile 看成交/规模, 本模块看价格自身的位置与质量。全部只用
传入的日线(已截到 signal_date), 纯函数、不做 I/O; 样本不足的因子一律返回 None,
不拿短样本硬算(新上市 ETF 的 52 周位置没有意义)。
"""

from __future__ import annotations

import math
import statistics
from typing import Any

LOOKBACK_52W = 250
SLOPE_STEP = 5
MDD_WINDOW = 60
BETA_WINDOW = 60
MIN_BETA_SAMPLES = 30


def ret(closes: list[float], n: int) -> float | None:
    if len(closes) <= n or closes[-1 - n] <= 0:
        return None
    return closes[-1] / closes[-1 - n] - 1


def _slope(closes: list[float], window: int, step: int = SLOPE_STEP) -> float | None:
    if len(closes) < window + step:
        return None
    now = statistics.fmean(closes[-window:])
    prev = statistics.fmean(closes[-window - step : -step])
    return now / prev - 1 if prev > 0 else None


def _max_drawdown(closes: list[float]) -> float:
    peak, mdd = closes[0], 0.0
    for close in closes:
        peak = max(peak, close)
        mdd = min(mdd, close / peak - 1)
    return mdd


def _annualized(rets: list[float], downside_only: bool = False) -> float | None:
    sample = [r for r in rets if r < 0] if downside_only else rets
    if len(sample) < 2:
        return None
    return statistics.pstdev(sample) * math.sqrt(252)


def _sharpe(rets: list[float]) -> float | None:
    if len(rets) < 2:
        return None
    sd = statistics.pstdev(rets)
    return statistics.fmean(rets) / sd * math.sqrt(252) if sd else None


def _bench_returns(
    dates: list[str], closes: list[float], bench: dict[str, float], n: int
) -> tuple[list[float], list[float]]:
    """ETF 与基准在共同交易日上的日收益(基准缺该日则跳过), 取最近 n 组。"""
    pairs_etf: list[float] = []
    pairs_bench: list[float] = []
    for i in range(max(1, len(dates) - n), len(dates)):
        prev_date, date = dates[i - 1], dates[i]
        if prev_date not in bench or date not in bench or closes[i - 1] <= 0:
            continue
        pairs_etf.append(closes[i] / closes[i - 1] - 1)
        pairs_bench.append(bench[date] / bench[prev_date] - 1)
    return pairs_etf, pairs_bench


def _beta(er: list[float], br: list[float]) -> tuple[float | None, float | None]:
    if len(er) < MIN_BETA_SAMPLES:
        return None, None
    var = statistics.pvariance(br)
    if not var:
        return None, None
    cov = sum((a - statistics.fmean(er)) * (b - statistics.fmean(br)) for a, b in zip(er, br)) / len(er)
    sd = statistics.pstdev(er) * statistics.pstdev(br)
    return cov / var, (cov / sd if sd else None)


def build(bars: list[dict[str, Any]], bench: dict[str, float] | None = None) -> dict[str, Any]:
    closes = [b["close"] for b in bars]
    rets20 = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 20, len(closes))]
    rets60 = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 60, len(closes))] if len(closes) > 60 else []
    window_52w = closes[-LOOKBACK_52W:]
    has_52w = len(closes) >= LOOKBACK_52W
    ma20 = statistics.fmean(closes[-20:])
    ma60 = statistics.fmean(closes[-60:])
    ma120 = statistics.fmean(closes[-120:]) if len(closes) >= 120 else None
    result: dict[str, Any] = {
        "r120": ret(closes, 120),
        "r250": ret(closes, 250),
        "dist_52w_high": closes[-1] / max(window_52w) - 1 if has_52w else None,
        "dist_52w_low": closes[-1] / min(window_52w) - 1 if has_52w else None,
        "ma120_dev": closes[-1] / ma120 - 1 if ma120 else None,
        "ma_bull": ma20 > ma60 and (ma120 is None or ma60 > ma120),
        "ma_bear": ma20 < ma60 and (ma120 is None or ma60 < ma120),
        "ma20_slope_5": _slope(closes, 20),
        "ma60_slope_20": _slope(closes, 60, 20),
        "up_ratio_20": sum(r > 0 for r in rets20) / len(rets20),
        "up_ratio_60": sum(r > 0 for r in rets60) / len(rets60) if rets60 else None,
        "downside_vol20": _annualized(rets20, downside_only=True),
        "mdd60": _max_drawdown(closes[-MDD_WINDOW:]),
        "sharpe_20": _sharpe(rets20),
        "sharpe_60": _sharpe(rets60),
        "vol60": _annualized(rets60),
    }
    if bench:
        er, br = _bench_returns([b["date"] for b in bars], closes, bench, BETA_WINDOW)
        beta, corr = _beta(er, br)
        bench_r60 = ret([bench[d] for d in sorted(bench)], 60)
        r60 = ret(closes, 60)
        result.update(
            {
                "beta60": beta,
                "corr60": corr,
                "alpha60": (
                    r60 - beta * bench_r60 if r60 is not None and beta is not None and bench_r60 is not None else None
                ),
            }
        )
    return result
```

<a id="file-backend-services-scoring-descriptors-profile-py"></a>

#### `backend/services/scoring/descriptors/profile.py`

```python
"""成交画像: 成交额 / 换手率 / 量比 / 缩量回撤。

纯展示字段, 不参与 rule/baseline 排序; 全部只用 signal_date 及之前的行情与份额。
成交量按现金额单位校准: 腾讯日线为"手", 1 手 = 100 份。
"""

from __future__ import annotations

import statistics
from bisect import bisect_right
from typing import Any

VOLUME_SHARES_MULTIPLIER = 100  # 腾讯日线成交量单位为手, 1 手 = 100 份
PROFILE_BARS = 20
# 新浪降级源按"股"返回(相差 100 倍), 超阈值视为单位异常, 不输出换手/成交额。
MAX_PLAUSIBLE_TURNOVER = 0.60
MAX_PLAUSIBLE_AMOUNT_YI = 1000.0
SHRINK_VOL_RATIO = 0.8  # 5 日均量/20 日均量 低于 0.8 视为缩量
SHRINK_DD20 = -0.03  # 距 20 日高点回撤超过 3% 视为回撤
LIQUIDITY_MIN_AMOUNT_YI = 0.5  # 5 日均成交额低于 0.5 亿视为流动性偏弱


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _turnover_series(bars: list[dict[str, Any]], pool: list[dict[str, Any]], n: int) -> list[float | None]:
    """逐日换手率 = 成交份额 / 当日已知总份额; 份额按 T+1 披露, 取 <= 当日的最后一条。"""
    points = [(s["date"], float(s["shares_yi"])) for s in pool if s["shares_yi"]]
    dates = [p[0] for p in points]
    result: list[float | None] = []
    for bar in bars[-n:]:
        idx = bisect_right(dates, bar["date"]) - 1
        if idx < 0:
            result.append(None)
            continue
        result.append(bar["volume"] * VOLUME_SHARES_MULTIPLIER / (points[idx][1] * 1e8))
    return result


def build(bars: list[dict[str, Any]], pool: list[dict[str, Any]], r20: float) -> dict[str, Any]:
    closes = [b["close"] for b in bars]
    volumes = [b["volume"] for b in bars]
    amounts = [v * VOLUME_SHARES_MULTIPLIER * c / 1e8 for v, c in zip(volumes[-PROFILE_BARS:], closes[-PROFILE_BARS:])]
    turnovers = _turnover_series(bars, pool, PROFILE_BARS)
    amount_ok = len(amounts) == PROFILE_BARS and max(amounts) <= MAX_PLAUSIBLE_AMOUNT_YI
    turnover_ok = amount_ok and all(t is not None and t <= MAX_PLAUSIBLE_TURNOVER for t in turnovers)
    vol_ratio = statistics.fmean(volumes[-5:]) / statistics.fmean(volumes[-PROFILE_BARS:])
    dd20 = closes[-1] / max(closes[-PROFILE_BARS:]) - 1
    return {
        "vol_ratio_5_20": vol_ratio,
        "dd20": dd20,
        "amount_yi_5d": _mean(amounts[-5:]) if amount_ok else None,
        "amount_yi_20d": _mean(amounts) if amount_ok else None,
        "turnover_5d": _mean([t for t in turnovers[-5:] if t is not None]) if turnover_ok else None,
        "turnover_20d": _mean([t for t in turnovers if t is not None]) if turnover_ok else None,
        "shrink_pullback": bool(dd20 <= SHRINK_DD20 and vol_ratio <= SHRINK_VOL_RATIO and r20 > 0),
    }
```

<a id="file-backend-services-scoring-descriptors-scale-py"></a>

#### `backend/services/scoring/descriptors/scale.py`

```python
"""份额口径归一: 折算/拆分是口径变化, 不是申购赎回。

份额折算会让单日份额整倍跳变(159582 2026-07-10: 1.52 亿份 → 8.56 亿份), 而腾讯
前复权价格保持连续, 于是 `close × shares` 的规模、5 日份额增速会被凭空放大 5 倍,
在截面 z 分数里直接压过趋势项。这里把窗口内的历史份额按**已甄别**的折算倍率
折算到最新口径, 只保留真实申赎; 未甄别的跳变不猜测, 标记为可疑, 由调用方把
资金因子按缺失处理, 避免把折算当申购。

甄别来源: data.fetch.adjust 用未复权/前复权比值台阶确认, 结果存在 etf_share_scale。
"""

from __future__ import annotations

from typing import Any

UNVERIFIED_JUMP_RATIO = 1.5  # 单日份额倍率超 1.5 且无甄别结论 → 资金因子按缺失处理


def normalize(points: list[dict[str, Any]], events: list[dict[str, Any]]) -> None:
    """原地把 points 的 shares_yi 折算到最新口径; 同时写 shares_raw / scale / event。

    events: [{"date", "ratio", "method"}] 按日期升序; 只有 method='split' 参与折算,
    method='flow' 仅表示"跳变已甄别为真实申赎", 不改变数值, 但会标记该日已验明。
    """
    splits = [(e["date"], float(e["ratio"])) for e in events if e.get("method") == "split"]
    known = {e["date"]: e.get("method") for e in events}
    for point in points:
        raw = point.get("shares_raw", point["shares_yi"])
        point["shares_raw"] = raw
        point["event"] = known.get(point["date"])
        scale = 1.0
        for date, ratio in splits:
            if point["date"] < date:
                scale *= ratio
        point["scale"] = scale
        if raw is not None:
            point["shares_yi"] = raw * scale


def unverified_jump(points: list[dict[str, Any]]) -> dict[str, Any] | None:
    """窗口内最大的一笔未甄别大跳变, 无则 None; 只读 raw 值, 与归一结果无关。"""
    worst: dict[str, Any] | None = None
    for prev, cur in zip(points, points[1:]):
        ratio = _ratio(prev, cur)
        if ratio is None or cur.get("event"):
            continue
        if not (ratio >= UNVERIFIED_JUMP_RATIO or ratio <= 1 / UNVERIFIED_JUMP_RATIO):
            continue
        if worst is None or max(ratio, 1 / ratio) > max(worst["ratio"], 1 / worst["ratio"]):
            worst = {"date": cur["date"], "ratio": ratio}
    return worst


def split_events(points: list[dict[str, Any]]) -> int:
    return sum(1 for p in points if p.get("event") == "split")


def _ratio(prev: dict[str, Any], cur: dict[str, Any]) -> float | None:
    a, b = prev.get("shares_raw"), cur.get("shares_raw")
    if not a or not b or a <= 0:
        return None
    return float(b) / float(a)
```

<a id="file-backend-services-scoring-descriptors-slices-py"></a>

#### `backend/services/scoring/descriptors/slices.py`

```python
"""时点切片: 把截至信号日的行情/份额窗口切给特征与评分使用。

单日评分(daily 的 records/screen/live)与 core8 节点回填(core_data)共用同一份切片口径,
拆到评分域是为了让 daily → scoring 保持单向依赖, 不出现两套时点截断逻辑。
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from typing import Any

SHARES_SLICE_DAYS = 60  # 份额切片冗余: 覆盖 FLOW_WINDOW 与滞后


def slice_bars(
    bars: Sequence[dict[str, Any]],
    dates: Sequence[str],
    signal: str,
    window: int,
) -> list[dict[str, Any]] | None:
    """截取 [signal-window, signal] 的 bar 列表; 信号日无 bar(停牌/未上市)返回 None。"""
    idx = bisect_right(dates, signal)
    if idx == 0 or dates[idx - 1] != signal:
        return None
    return list(bars[max(0, idx - window) : idx])


def slice_points(
    bars: Sequence[dict[str, Any]],
    dates: Sequence[str],
    signal: str,
    window: int,
    *,
    before: bool = False,
) -> list[dict[str, Any]] | None:
    """取 ≤ signal 的最后 window 个点; 份额等滞后数据当日可能未更新, 允许缺信号日。

    before=True 取严格早于 signal 的点 = 节点日收盘时"当时已知"的份额。
    """
    idx = bisect_left(dates, signal) if before else bisect_right(dates, signal)
    if idx == 0:
        return None
    return list(bars[max(0, idx - window) : idx])


def slice_daily(
    daily_all: dict[str, list[dict[str, Any]]],
    daily_dates: dict[str, list[str]],
    signal: str,
    window: int,
) -> dict[str, list[dict[str, Any]]]:
    """把全量日K切片到信号日; 信号日停牌/未上市的标的整体剔除。"""
    daily: dict[str, list[dict[str, Any]]] = {}
    for code, bars in daily_all.items():
        part = slice_bars(bars, daily_dates[code], signal, window)
        if part is not None:
            daily[code] = part
    return daily


def slice_shares(
    shares_all: dict[str, list[dict[str, Any]]],
    shares_dates: dict[str, list[str]],
    signal: str,
    *,
    before: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    """把全量份额切片到信号日; 当日份额未发布时保留上一个交易日的点。"""
    shares: dict[str, list[dict[str, Any]]] = {}
    for code, points in shares_all.items():
        part = slice_points(points, shares_dates[code], signal, SHARES_SLICE_DAYS, before=before)
        if part is not None:
            shares[code] = part
    return shares


def slice_universe(
    daily_all: dict[str, list[dict[str, Any]]],
    daily_dates: dict[str, list[str]],
    shares_all: dict[str, list[dict[str, Any]]],
    shares_dates: dict[str, list[str]],
    signal: str,
    daily_window: int,
    *,
    shares_before: bool = False,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    """单日评分链路的统一入口: 日K与份额按同一信号日截断。

    daily 的 records/screen/live 与 core 节点回填都走这里, 避免各处自己写循环导致
    时点口径漂移。
    """
    return (
        slice_daily(daily_all, daily_dates, signal, daily_window),
        slice_shares(shares_all, shares_dates, signal, before=shares_before),
    )
```

<a id="file-backend-services-scoring-descriptors-themes-py"></a>

#### `backend/services/scoring/descriptors/themes.py`

```python
"""名称→主题归一: 截面相对强度与归因统计都按主题聚合。

关键词表按"先具体后宽泛"排列, 命中即停; 认不出时退回 ETF 前缀, 保证任何标的都有
可聚合的桶(否则主题相对强度会把一堆标的塞进"其他")。
"""

from __future__ import annotations

THEME_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("沪深300", ("沪深300", "HS300")),
    ("中证A500", ("中证A500", "A500")),
    ("中证A50", ("中证A50", "A50")),
    ("中证500", ("中证500",)),
    ("中证1000", ("中证1000",)),
    ("中证2000", ("中证2000",)),
    ("上证50", ("上证50",)),
    ("科创", ("科创",)),
    ("创业板", ("创业板", "创业")),
    ("北证", ("北证",)),
    ("港股", ("港股", "恒生", "恒指", "香港")),
    ("海外", ("纳指", "标普", "美国", "日经", "德国", "法国")),
    ("半导体", ("半导体", "芯片", "集成电路", "电子")),
    ("医药", ("医药", "医疗", "创新药", "生物")),
    ("消费", ("消费", "食品饮料", "酒", "家电", "旅游")),
    ("新能源", ("新能源", "光伏", "锂", "电池", "储能", "风电")),
    ("军工", ("军工", "国防", "卫星", "航天")),
    ("金融", ("金融", "证券", "券商", "银行", "保险")),
    ("地产基建", ("地产", "基建", "建筑")),
    ("有色", ("黄金", "有色", "稀有金属", "稀土")),
    ("周期资源", ("石油", "天然气", "能源", "煤炭", "钢铁", "化工")),
    ("TMT", ("人工智能", "算力", "计算机", "软件", "互联网", "科技", "通信", "传媒", "游戏", "TMT")),
    ("红利", ("红利",)),
    ("风格", ("价值", "成长", "现金流", "基本面", "质量", "均衡", "国企", "央企", "ESG", "可持续", "创新100")),
    ("固收", ("债", "国债", "政金", "信用", "利率")),
    ("货币", ("货币",)),
    ("农业", ("农业", "粮食", "养殖", "畜牧")),
    ("公用事业", ("电力", "公用", "环保")),
    ("高端制造", ("机器人", "机械", "装备")),
)


def theme_of(name: str | None) -> str:
    """按名称关键词归到可聚合的主题; 认不出时退回 ETF 前缀。"""
    if not name:
        return "其他"
    for theme, keywords in THEME_RULES:
        if any(k in name for k in keywords):
            return theme
    prefix = name.split("ETF")[0].strip()
    return prefix[:10] or "其他"
```

<a id="file-backend-services-scoring-features-py"></a>

#### `backend/services/scoring/features.py`

```python
"""周度截面特征：只使用 signal_date 及之前的数据构造 AI 分析上下文。

防后视镜边界:
1) 标的池 = signal_date 当日真有 K 线的 ETF, 未来上市标的不会出现;
2) 只输出收益/比率类特征, 不把绝对 qfq 价位当作"当时已知信息";
3) 份额取 <= signal_date 的最后一条, 缺失即 None, 不用未来值回填;
4) 本模块不读取任何 signal_date 之后的行, 评估逻辑单独放在 evaluate.py。
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from typing import Any

from services.kline import states as macd_states
from services.scoring.descriptors import factors, profile, scale

DOMESTIC_EQUITY = "指数型-股票"
# 底层含港股的产品仍被数据源记为"指数型-股票", 但交易时段/汇率/估值体系不同, 不进 A 股周度池
HK_NAME_HINTS = ("港股", "恒生", "恒指", "香港", "H股", "沪港深", "沪深港", "AH")
MIN_BARS = 62
DEFAULT_MIN_AUM_YI = 2.0
HISTORY_DAYS = 270  # 交易日回溯, 覆盖 250 日(52 周)位置 + 60 日动量 + 缓冲
SHARES_HISTORY_DAYS = 40
FLOW_WINDOW = 6  # 5 日份额增速用 6 个点(首点为基期)

EXT_R20 = 0.25  # 20 日涨幅超过 25% 视为拥挤
EXT_R5 = 0.08  # 单周涨幅超过 8% 视为短期过热
EXT_FLOW = 0.50  # 5 日份额增长超过 50% 视为资金拥挤
EXT_VOL = 0.45  # 年化波动超过 45% 视为高波动
PULLBACK_R5_MIN = -0.08  # 近 5 日跌幅超过 8% 视为回调过深
PULLBACK_R5_MAX = 0.02  # 近 5 日涨幅超过 2% 视为未回调(追高)
TREND_WEIGHT = 0.60  # 趋势分占总分 60%: MACD 定方向, 多因子只做确认


def trading_days(conn: sqlite3.Connection) -> list[str]:
    return [r["date"] for r in conn.execute("SELECT date FROM trade_calendar ORDER BY date")]


def load_meta(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    return {r["code"]: dict(r) for r in conn.execute("SELECT code, name, fund_type FROM etfs")}


def is_a_share(name: str | None) -> bool:
    """名称未命中港股系关键词即视为 A 股底层; 无名称时保留, 不误杀。"""
    return name is None or not any(hint in name for hint in HK_NAME_HINTS)


def equity_a_share_codes(meta: dict[str, dict[str, Any]]) -> set[str]:
    """日度链路共用的标的池: 指数型-股票 且 A 股底层(剔除港股系)。"""
    return {
        code for code, info in meta.items() if info.get("fund_type") == DOMESTIC_EQUITY and is_a_share(info.get("name"))
    }


def is_candidate(row: dict[str, Any], min_aum: float = DEFAULT_MIN_AUM_YI) -> bool:
    """是否进入评分池: 指数型-股票、A 股底层、规模达标; 三条缺一不可。"""
    return row["fund_type"] == DOMESTIC_EQUITY and (row["aum_yi"] or 0) >= min_aum and is_a_share(row.get("name"))


def select_candidates(
    rows: list[dict[str, Any]],
    min_aum: float = DEFAULT_MIN_AUM_YI,
) -> list[dict[str, Any]]:
    """从特征行里挑出评分池; records/screen/live/core 四处必须同口径。"""
    return [row for row in rows if is_candidate(row, min_aum)]


def _load_by_code(conn: sqlite3.Connection, sql: str, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for r in conn.execute(sql, (start, end)):
        result.setdefault(r["code"], []).append(dict(r))
    return result


def load_daily(conn: sqlite3.Connection, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    return _load_by_code(
        conn,
        "SELECT date, code, close, volume FROM etf_daily WHERE date BETWEEN ? AND ? ORDER BY code, date",
        start,
        end,
    )


def load_shares(conn: sqlite3.Connection, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    """读取份额并把已甄别的折算事件折算到最新口径(见 scale.py)。"""
    rows = _load_by_code(
        conn,
        "SELECT date, code, shares_yi FROM etf_shares WHERE date BETWEEN ? AND ? ORDER BY code, date",
        start,
        end,
    )
    events: dict[str, list[dict[str, Any]]] = {}
    for e in conn.execute("SELECT code, date, ratio, method FROM etf_share_scale WHERE date <= ?", (end,)):
        events.setdefault(e["code"], []).append(dict(e))
    for code, points in rows.items():
        scale.normalize(points, events.get(code, []))
    return rows


def load_index(conn: sqlite3.Connection, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    return _load_by_code(
        conn,
        "SELECT date, code, close FROM index_daily WHERE date BETWEEN ? AND ? ORDER BY code, date",
        start,
        end,
    )


def _ret(closes: list[float], n: int) -> float | None:
    if len(closes) <= n or closes[-1 - n] <= 0:
        return None
    return closes[-1] / closes[-1 - n] - 1


def _pct_change(values: list[float], n: int) -> float | None:
    if len(values) <= n or not values[-1 - n]:
        return None
    return values[-1] / values[-1 - n] - 1


def build_features(
    signal: str,
    meta: dict[str, dict[str, Any]],
    daily: dict[str, list[dict[str, Any]]],
    shares: dict[str, list[dict[str, Any]]],
    bench: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for code, bars in daily.items():
        if bars[-1]["date"] != signal or len(bars) < MIN_BARS:
            continue
        closes = [b["close"] for b in bars]
        volumes = [b["volume"] for b in bars]
        if any(c is None or c <= 0 for c in closes[-61:]) or any(v is None or v <= 0 for v in volumes[-20:]):
            continue
        rets = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 20, len(closes))]
        pool = [s for s in shares.get(code, []) if s["date"] <= signal]
        shares_yi = shares_raw = flow = flow_raw = None
        suspect = False
        split_5d = 0
        # 份额更新通常滞后一天: 取 signal_date 及之前最后一条, 仍是"当时已知"的规模。
        if pool and pool[-1]["shares_yi"]:
            shares_yi, shares_raw = pool[-1]["shares_yi"], pool[-1].get("shares_raw")
            if len(pool) >= FLOW_WINDOW:
                window = pool[-FLOW_WINDOW:]
                flow = _pct_change([s["shares_yi"] for s in window], FLOW_WINDOW - 1)
                flow_raw = _pct_change([s.get("shares_raw") or s["shares_yi"] for s in window], FLOW_WINDOW - 1)
                suspect = scale.unverified_jump(window) is not None
                split_5d = scale.split_events(window)
        info = meta.get(code, {})
        r20 = _ret(closes, 20)
        rows.append(
            {
                "code": code,
                "name": info.get("name"),
                "fund_type": info.get("fund_type"),
                "close": closes[-1],
                "r5": _ret(closes, 5),
                "r20": r20,
                "r60": _ret(closes, 60),
                "vol20": statistics.pstdev(rets) * math.sqrt(252),
                "dd60": closes[-1] / max(closes[-60:]) - 1,
                "ma20_dev": closes[-1] / statistics.fmean(closes[-20:]) - 1,
                "ma60_dev": closes[-1] / statistics.fmean(closes[-60:]) - 1,
                "shares_yi": shares_yi,
                "shares_raw": shares_raw,
                "flow_5d": flow,
                "flow_5d_raw": flow_raw,
                "flow_suspect": suspect,
                "share_split_5d": split_5d,
                "aum_yi": closes[-1] * shares_yi if shares_yi else None,
                **profile.build(bars, pool, r20 or 0.0),
                **factors.build(bars, bench),
            }
        )
    return rows


def attach_macd(rows: list[dict[str, Any]], signal: str, provider: macd_states.MacdStateProvider) -> None:
    """给候选行补三周期 MACD 状态与趋势分; 只用 ≤ signal 的行情。"""
    for row in rows:
        states = provider.states(row["code"], signal, row["close"])
        row["macd_states"] = states
        row["trend_score"] = macd_states.trend_score(states)
        row["macd_weak"] = macd_weak(row)


def macd_weak(row: dict[str, Any]) -> bool:
    """日线在水下且走弱 = 趋势已破, 不再继续持有(供 AI 规则池补齐判断)。"""
    day = (row.get("macd_states") or {}).get("day") or {}
    return day.get("zone") == "below" and day.get("trend") == "falling"


def _z(values: list[float | None]) -> tuple[float, float]:
    clean = [v for v in values if v is not None and math.isfinite(v)]
    if len(clean) < 2:
        return 0.0, 1.0
    return statistics.fmean(clean), statistics.pstdev(clean) or 1e-9


def score(rows: list[dict[str, Any]]) -> None:
    """趋势主项 + 多因子确认: 综合分 = 0.6*趋势分 + 0.4*core。

    趋势分来自日/周/月 MACD 四象限(±1); core 是动量/资金/波动/规模的截面 z 组合。
    权重固定, 避免每周临时调参。未甄别的份额大跳变(可能是未识别的折算)不进入
    资金因子: 既不计自身的 z, 也不污染截面均值/方差。
    """
    flow_clean = [None if r.get("flow_suspect") else r["flow_5d"] for r in rows]
    stats = {
        "r20": _z([r["r20"] for r in rows]),
        "r60": _z([r["r60"] for r in rows]),
        "r5": _z([r["r5"] for r in rows]),
        "vol20": _z([r["vol20"] for r in rows]),
        "flow_5d": _z(flow_clean),
        "aum_yi": _z([r["aum_yi"] for r in rows]),
    }

    def z(key: str, value: float | None) -> float:
        mean, std = stats[key]
        return ((value if value is not None else mean) - mean) / std

    for r in rows:
        momentum = 0.67 * z("r20", r["r20"]) + 0.33 * z("r60", r["r60"])
        flow_z = 0.0 if r.get("flow_suspect") else z("flow_5d", r["flow_5d"])
        core = (
            0.50 * momentum
            - 0.20 * z("r5", r["r5"])
            - 0.10 * z("vol20", r["vol20"])
            + 0.15 * flow_z
            + 0.05 * z("aum_yi", r["aum_yi"])
        )
        r["core_score"] = round(core, 4)
        r["baseline_score"] = round(TREND_WEIGHT * (r.get("trend_score") or 0.0) + (1 - TREND_WEIGHT) * core, 4)
        r["extended"] = bool(
            (r["r20"] or 0) > EXT_R20
            or (r["r5"] or 0) > EXT_R5
            or (not r.get("flow_suspect") and (r["flow_5d"] or 0) > EXT_FLOW)
            or r["vol20"] > EXT_VOL
        )
        r["pullback_in_uptrend"] = bool(
            (r["r20"] or 0) > 0
            and (r["r60"] or 0) > 0
            and PULLBACK_R5_MIN <= (r["r5"] or 0) <= PULLBACK_R5_MAX
            and not r.get("flow_suspect")
            and (r["flow_5d"] or 0) > 0
            and r["vol20"] < EXT_VOL
        )
```

<a id="file-backend-services-scoring-ranks-py"></a>

#### `backend/services/scoring/ranks.py`

```python
"""截面秩: 并列取平均的秩变换, 供因子打分、分位与 Rank IC 共用。

三处调用方(因子 rank_z、分位 _pct_rank、Spearman)原先各自实现一套并列处理,
口径必须一致, 否则同一批分数在不同视图里名次会不同。
"""

from __future__ import annotations

from collections.abc import Sequence


def average_ranks(values: Sequence[float]) -> list[float]:
    """1 基平均秩: 并列元素取平均名次; 输入需全部为有限值。"""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and values[order[end + 1]] == values[order[start]]:
            end += 1
        rank = (start + end) / 2 + 1
        for k in range(start, end + 1):
            ranks[order[k]] = rank
        start = end + 1
    return ranks
```

<a id="file-backend-services-scoring-reason-init-py"></a>

#### `backend/services/scoring/reason/__init__.py`

```python
"""入选理由文案: ranking(综合分排名理由) 与 core8(core8 横截面专属理由), 两套口径不能混用。"""
```

<a id="file-backend-services-scoring-reason-core8-py"></a>

#### `backend/services/scoring/reason/core8.py`

```python
"""core8 入选理由: 排名 + 原始画像指标, 压成一段可独立读懂的说明。

与 weekly/reasons.py 的综合分文案分开: 那套讲趋势/资金/主题排名, 这套口径是
core8 横截面秩评分(深回撤/超跌/长动量为正, 高波动/份额拥挤/放量为负), 不能混用。
八因子的秩分只在排名表里展开; 这里用原始指标, 避免重复做截面计算。
"""

from __future__ import annotations

import math
from typing import Any

from services.scoring.core import score as core
from services.scoring.reason import ranking as reasons


def _pct(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    return f"{number * 100:+.1f}%" if math.isfinite(number) else "—"


def _num(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    return f"{number:.1f}" if math.isfinite(number) else "—"


def reason_text(row: dict[str, Any], rank: int, held: bool) -> str:
    """held 且排名在缓冲带内: 说明是缓冲带留仓, 不是本期重新买回。"""
    score = row.get("core_score")
    head = f"策略第{rank}（{score:+.2f}）" if isinstance(score, (int, float)) else f"策略第{rank}"
    if held and rank > core.HOLD_TOP:
        head = f"缓冲带继续持有（策略第{rank}）"
    return (
        f"{head}：60日回撤 {_pct(row.get('dd60'))}，20日 {_pct(row.get('r20'))} / "
        f"250日 {_pct(row.get('r250'))}，年化波动 {_pct(row.get('vol20'))}，"
        f"5日份额 {_pct(row.get('flow_5d'))}，规模 {_num(row.get('aum_yi'))} 亿"
    )


def reason_json(row: dict[str, Any], rank: int, held: bool) -> dict[str, Any]:
    """沿用共享因子明细, 追加策略分、排名与 8 因子拆解(供页面展示公式构成)。"""
    flags: list[str] = ["core8_hold"] if held else []
    if row.get("shrink_pullback"):
        flags.append("shrink_pullback")
    data = reasons.reason_json(row, flags)
    data.update(
        {
            "core8_rank": rank,
            "core8_score": row.get("core_score"),
            "core_factors": row.get("core_factors"),
        }
    )
    return data
```

<a id="file-backend-services-scoring-reason-ranking-py"></a>

#### `backend/services/scoring/reason/ranking.py`

```python
"""入选理由: 因子明细 JSON + 综合分文案; core8 持仓的专属文案在 daily/core_reason。"""

from __future__ import annotations

from typing import Any

from services.kline import states as macd_states
from services.scoring import features
from services.scoring.descriptors import profile

DISPLAY_SIGNALS = (
    "rs_strong",
    "rs_weak",
    "theme_leader",
    "near_high_52w",
    "ma_bull",
    "ma_bear",
    "flow_suspect",
    "share_split_5d",
)


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:+.1f}%"


def _vol(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def _ratio(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.2f}%"


def _amount(value: float | None) -> str:
    return "—" if value is None else f"{value:.1f} 亿"


def _rank(value: float | None) -> str:
    return "—" if value is None else f"第{value * 100:.0f}分位"


def _num(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(float(value), digits)


def _signals(row: dict[str, Any]) -> list[str]:
    """展示用强弱标记(不参与排序): 只收被触发的键, 文案由前端映射。"""
    return [key for key in DISPLAY_SIGNALS if (row.get("share_split_5d") if key == "share_split_5d" else row.get(key))]


def reason_json(row: dict[str, Any], flags: list[str]) -> dict[str, Any]:
    return {
        "flags": flags,
        "signals": _signals(row),
        "r5": _num(row["r5"]),
        "r20": _num(row["r20"]),
        "r60": _num(row["r60"]),
        "r120": _num(row.get("r120")),
        "r250": _num(row.get("r250")),
        "vol20": _num(row["vol20"]),
        "vol60": _num(row.get("vol60")),
        "dd60": _num(row["dd60"]),
        "dd20": _num(row.get("dd20")),
        "mdd60": _num(row.get("mdd60")),
        "dist_52w_high": _num(row.get("dist_52w_high")),
        "dist_52w_low": _num(row.get("dist_52w_low")),
        "vol_ratio_5_20": _num(row["vol_ratio_5_20"]),
        "amount_yi_5d": _num(row.get("amount_yi_5d")),
        "amount_yi_20d": _num(row.get("amount_yi_20d")),
        "turnover_5d": _num(row.get("turnover_5d")),
        "turnover_20d": _num(row.get("turnover_20d")),
        "shrink_pullback": bool(row.get("shrink_pullback")),
        "ma20_dev": _num(row["ma20_dev"]),
        "ma60_dev": _num(row["ma60_dev"]),
        "ma120_dev": _num(row.get("ma120_dev")),
        "ma20_slope_5": _num(row.get("ma20_slope_5")),
        "ma60_slope_20": _num(row.get("ma60_slope_20")),
        "up_ratio_20": _num(row.get("up_ratio_20")),
        "up_ratio_60": _num(row.get("up_ratio_60")),
        "downside_vol20": _num(row.get("downside_vol20")),
        "sharpe_20": _num(row.get("sharpe_20")),
        "sharpe_60": _num(row.get("sharpe_60")),
        "rank_r5": _num(row.get("rank_r5")),
        "rank_r20": _num(row.get("rank_r20")),
        "rank_r60": _num(row.get("rank_r60")),
        "rank_r250": _num(row.get("rank_r250")),
        "rank_vol20": _num(row.get("rank_vol20")),
        "rank_flow_5d": _num(row.get("rank_flow_5d")),
        "rank_dist_52w_high": _num(row.get("rank_dist_52w_high")),
        "excess_r5": _num(row.get("excess_r5")),
        "excess_r20": _num(row.get("excess_r20")),
        "excess_r60": _num(row.get("excess_r60")),
        "beta60": _num(row.get("beta60")),
        "corr60": _num(row.get("corr60")),
        "alpha60": _num(row.get("alpha60")),
        "theme": row.get("theme"),
        "theme_count": row.get("theme_count"),
        "theme_median_r20": _num(row.get("theme_median_r20")),
        "theme_rank_r20": _num(row.get("theme_rank_r20")),
        "theme_excess_r20": _num(row.get("theme_excess_r20")),
        "shares_yi": _num(row["shares_yi"]),
        "shares_raw": _num(row.get("shares_raw")),
        "flow_5d": _num(row["flow_5d"]),
        "flow_5d_raw": _num(row.get("flow_5d_raw")),
        "flow_suspect": bool(row.get("flow_suspect")),
        "share_split_5d": int(row.get("share_split_5d") or 0),
        "aum_yi": _num(row["aum_yi"]),
        "core_score": _num(row.get("core_score")),
        "trend_score": _num(row.get("trend_score")),
        "macd_states": row.get("macd_states") or {},
        "baseline_score": row["baseline_score"],
    }


def _theme_text(row: dict[str, Any]) -> str:
    theme = row.get("theme") or "其他"
    rank = row.get("theme_rank_r20")
    if rank is None:
        return f"主题「{theme}」"
    return f"主题「{theme}」内{_rank(rank)}"


def _rs_text(row: dict[str, Any]) -> str:
    share = f"近5日 {_pct(row['r5'])}，5日份额 {_pct(row['flow_5d'])}"
    if row.get("share_split_5d"):
        share += "（含份额折算，已归一）"
    return share


def _risk_notes(row: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    if (row["r20"] or 0) > features.EXT_R20:
        notes.append("20日涨幅超过25%，拥挤")
    if (row["r5"] or 0) > features.EXT_R5:
        notes.append("单周涨幅超过8%，短期过热")
    if (row["flow_5d"] or 0) > features.EXT_FLOW:
        notes.append("5日份额增长超过50%，资金拥挤")
    if row["vol20"] > features.EXT_VOL:
        notes.append("年化波动超过45%，高波动")
    if row.get("flow_suspect"):
        notes.append("份额单日跳变未甄别，资金因子未计入")
    if row.get("rs_weak"):
        notes.append("20/60日截面都在后30%，相对弱势")
    amount = row.get("amount_yi_5d")
    if amount is not None and amount < profile.LIQUIDITY_MIN_AMOUNT_YI:
        notes.append("5日均额不足0.5亿，流动性偏弱")
    return notes


def _macd_text(row: dict[str, Any]) -> str:
    """把三周期状态压成一行: 趋势 +0.48（日水上走强+0.82/周水上死叉-1.00/月预热不足）。"""
    states = row.get("macd_states") or {}
    zone_text = {"above": "水上", "below": "水下", "zero": "零轴"}
    trend_text = {"rising": "走强", "falling": "走弱", "flat": "走平"}
    flip_text = {"golden": "金叉", "dead": "死叉"}
    parts: list[str] = []
    for period, label in macd_states.PERIODS:
        state = states.get(period)
        if state is None:
            parts.append(f"{label}预热不足")
        else:
            word = flip_text.get(state.get("flip") or "") or trend_text.get(state["trend"], "走平")
            parts.append(f"{label}{zone_text.get(state['zone'], '零轴')}{word}")
    return f"趋势 {(row.get('trend_score') or 0.0):+.2f}（{'/'.join(parts)}）"


def reason_text(row: dict[str, Any], rank: int) -> str:
    """基线理由必须能独立读懂: 截面位置 + 基准对比 + 资金 + 成交画像 + MACD + 风险 + 规模。"""
    aum = "—" if row["aum_yi"] is None else f"{row['aum_yi']:.1f} 亿"
    position = (
        f"20日 {_pct(row['r20'])} / 60日 {_pct(row['r60'])}，"
        f"相对沪深300 20日 {_pct(row.get('excess_r20'))}，"
        f"截面 {_rank(row.get('rank_r20'))}（{_theme_text(row)}），"
        f"距52周高 {_pct(row.get('dist_52w_high'))}"
    )
    core = (
        f"{position}，{_rs_text(row)}，"
        f"{_macd_text(row)}，年化波动 {_vol(row['vol20'])}，规模 {aum}，"
        f"5日均额 {_amount(row.get('amount_yi_5d'))}，5日换手 {_ratio(row.get('turnover_5d'))}"
    )
    head = f"综合分 {row['baseline_score']:+.2f}（第{rank}）："
    notes = _risk_notes(row)
    return head + core + (f"；注意：{'、'.join(notes)}" if notes else "")
```

### 14.7 后端 · 页面领域 backend/pages/

<a id="file-backend-pages-init-py"></a>

#### `backend/pages/__init__.py`

```python
"""页面域: 一个前端页面一个目录, 文件夹名直接对上前端路由。

- pages/daily ↔ DailyReview(今日 / 历史 / 节点)
- pages/etf   ↔ EtfList + EtfDetail(清单 / K线 / MACD / 份额)
- pages/jobs  ↔ Jobs(数据任务 / 调度状态 / 数据就绪度)

HTTP 出口只放在页面域的 router 里; 多页面共用的计算下沉 services/,
后台调度与回填编排在 ops/(无页面)。
"""
```

<a id="file-backend-pages-daily-init-py"></a>

#### `backend/pages/daily/__init__.py`

```python
"""日度复盘领域: 换仓节点、逐日记录、筛选漏斗与盘中预选。

阅读顺序(主线):
1. review/store.py      读写三张 fitted 表, 无业务判断
2. review/execution.py  结算规则: 周四收盘卖、周五开盘补买/顺延卖
3. review/build.py      主流程 build_day: 取节点持仓 → 结算 → 落库
4. nodes.py             节点视角的收益/动作/持有区间
5. router.py            HTTP 出口, 只做参数与编排, 最后看

旁路: screen/ 筛选漏斗(复盘时逐级摊开筛选链路), live/ 盘中预演(现价合成K线)。
"""
```

<a id="file-backend-pages-daily-live-init-py"></a>

#### `backend/pages/daily/live/__init__.py`

```python
"""盘中预演: 现价合成K线(context) → 全量排名行(rows) → 预演入口(preview)。"""
```

<a id="file-backend-pages-daily-live-context-py"></a>

#### `backend/pages/daily/live/context.py`

```python
"""盘中预演的取数: 现价合成 bar、历史上下文加载与节点持仓读取。

与 live.py 的缓存/响应组装分开: 这里只回答"今天能拿到什么数据", 不关心 TTL 与
页面载荷; 份额与沪深300 截止上一交易日(当日不可得), 与收盘后正式节点的细微差异
统一由 live.py 的说明承担。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from services.scoring import features
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section


def synthetic_bar(today: str, quote: dict[str, Any]) -> dict[str, Any] | None:
    """现价合成今日 bar; 停牌(现价<=0)返回 None, 与日K缺失同处理。"""
    price = quote.get("price")
    if not isinstance(price, (int, float)) or price <= 0:
        return None
    return {
        "date": today,
        "open": quote.get("open") or price,
        "close": price,
        "high": quote.get("high") or price,
        "low": quote.get("low") or price,
        "volume": quote.get("volume") or 0.0,
    }


def load_context(conn: sqlite3.Connection, today: str, calendar: list[str]) -> dict[str, Any] | None:
    """加载截至上一交易日的历史上下文; 只做一次 SQL, 供每个缓存窗口复用。"""
    base = calendar.index(today) if today in calendar else len(calendar)
    if base == 0:
        return None
    last_day = calendar[base - 1]
    data_start = calendar[max(0, base - 1 - features.HISTORY_DAYS - 5)]
    shares_start = calendar[max(0, base - 1 - features.SHARES_HISTORY_DAYS - 5)]
    meta = features.load_meta(conn)
    scope = features.equity_a_share_codes(meta)
    raw_daily = features.load_daily(conn, data_start, last_day)
    daily_all = {c: b for c, b in raw_daily.items() if c in scope}
    raw_shares = features.load_shares(conn, shares_start, last_day)
    shares_all = {c: s for c, s in raw_shares.items() if c in scope}
    indices = features.load_index(conn, data_start, last_day)
    bench = indices.get(cross_section.HS300_CODE, [])
    return {
        "last_day": last_day,
        "meta": meta,
        "daily_all": daily_all,
        "daily_dates": {c: [bar["date"] for bar in bars] for c, bars in daily_all.items()},
        "shares_all": shares_all,
        "shares_dates": {c: [bar["date"] for bar in bars] for c, bars in shares_all.items()},
        "bench": bench,
        "bench_dates": [b["date"] for b in bench],
    }


def quote_bar(quote: dict[str, Any], today: str) -> dict[str, Any] | None:
    """只采用行情时间已落到今日的报价: 开盘前拿到的是昨日收盘, 拼成今日 bar 会重复一天。"""
    stamp = str(quote.get("time") or "")
    return synthetic_bar(today, quote) if stamp.startswith(today) else None


def node_closes(conn: sqlite3.Connection, day: str | None, codes: list[str]) -> dict[str, float]:
    """节点日收盘价 {code: close}: 持仓期涨跌幅的基准。"""
    if not day or not codes:
        return {}
    marks = ",".join("?" * len(codes))
    rows = conn.execute(
        f"SELECT code, close FROM etf_daily WHERE date=? AND code IN ({marks})",
        (day, *codes),
    )
    return {r["code"]: r["close"] for r in rows if r["close"] is not None}


def held_positions(conn: sqlite3.Connection, last_day: str) -> tuple[list[str], list[dict[str, Any]]]:
    """(持仓代码, 卡片用轻量明细): 因子拆解不进预演卡片, 需要时看底部全量表。"""
    node = core_store.node_at(conn, last_day)
    data = core_store.get_node(conn, node) if node else None
    holdings = (data or {}).get("holdings", [])
    closes = node_closes(conn, node, [p["code"] for p in holdings])
    detail = [
        {
            "code": p["code"],
            "name": p.get("name"),
            "core_rank": p["core_rank"],
            "core_score": p["core_score"],
            "action": p["action"],
            "node_close": closes.get(p["code"]),
        }
        for p in holdings
    ]
    return [p["code"] for p in holdings], detail
```

<a id="file-backend-pages-daily-live-preview-py"></a>

#### `backend/pages/daily/live/preview.py`

```python
"""盘中 core8 预演: 用腾讯现价合成今日未收盘K线, 复用 core8 评分, 结果不落库。

腾讯日K接口收盘后才返回当日K线, 盘中"今天若换仓会持有谁"只能拿实时现价临时拼
一根 bar 提前算一遍: close=现价, open/high/low/volume 取当日行情。份额与沪深300
仍截止上一交易日(当日不可得), 与收盘后的正式节点可能存在细微差异。

持仓语义与收盘一致: 今天不是换仓节点时沿用上一节点持仓; 是节点日则按 core8
排名与缓冲带(已持有排名≤15 继续持有)给出目标持仓。

缓存分两级: 评分/持仓预演交易时段 60 秒重算一次(现价每 15 秒由行情接口负责,
策略层不必更勤); 全量排名行(含因子拆解, 单份约 3MB)10 分钟一批, 「手动全量
拉取」可立即重建。与周度页"当周实时行情"同一纪律: 实时数据只用于展示, 绝不写
入历史表。
"""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime
from typing import Any

from data.fetch import realtime
from pages.daily.live import context, rows
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section, slices
from services.scoring.reason import core8 as core_reason

LIVE_TTL_SEC = 60  # 评分/持仓预演: 交易时段每分钟重算; 现价列由行情接口 15 秒轮询
LIVE_IDLE_TTL_SEC = 300  # 非交易时段行情不再变, 降频重算
RANKING_TTL_SEC = 600  # 全量排名行(含因子拆解): 10 分钟一批, 手动刷新立即重建
LIVE_RULE_VERSION = "core8-live-v1"
BASELINE_TOP = 10
TODAY_TOP_N = 10  # 左卡「今日 TOP」对照列表: 覆盖买入区(前 5)与缓冲带(前 15)的前段

_guard = threading.Lock()
_compute_cache: dict[str, Any] = {"date": None, "stamp": 0.0, "data": None}
_picks_cache: dict[str, Any] = {"date": None, "stamp": 0.0, "data": None}
_ranking_cache: dict[str, Any] = {"date": None, "stamp": 0.0, "data": None}


def _ttl() -> int:
    return LIVE_TTL_SEC if realtime.is_trading_time() else LIVE_IDLE_TTL_SEC


def _cached(cache: dict[str, Any], day: str, ttl: int) -> dict[str, Any] | None:
    with _guard:
        if cache["date"] == day and time.time() - cache["stamp"] < ttl:
            return dict(cache["data"])
    return None


def _store(cache: dict[str, Any], day: str, data: dict[str, Any]) -> dict[str, Any]:
    with _guard:
        cache.update(date=day, stamp=time.time(), data=data)
    return dict(data)


def _compute(conn: sqlite3.Connection, day: str, force: bool = False) -> dict[str, Any]:
    """完整预演计算(拉行情→拼bar→特征→评分→目标持仓), 结果多级缓存共享。"""
    if not force:
        hit = _cached(_compute_cache, day, _ttl())
        if hit is not None:
            return hit
    calendar = features.trading_days(conn)
    if day not in calendar:
        return _store(_compute_cache, day, {"live": False, "reason": "今日非交易日", "signal_date": day})
    ctx = context.load_context(conn, day, calendar)
    if ctx is None:
        return _store(_compute_cache, day, {"live": False, "reason": "无历史交易日", "signal_date": day})

    t0 = time.time()
    quotes = realtime.fetch_quotes(list(ctx["daily_all"]))
    quotes_sec = time.time() - t0
    live_bars: dict[str, dict[str, Any]] = {}
    as_of: str | None = None
    for code, quote in quotes.items():
        if ctx["daily_dates"].get(code) and ctx["daily_dates"][code][-1] >= day:
            continue  # 库里已有今日K线, 交给正式记录
        bar = context.quote_bar(quote, day)
        if bar is None:
            continue
        live_bars[code] = bar
        stamp = str(quote.get("time") or "")
        if stamp and (as_of is None or stamp > as_of):
            as_of = stamp
    if not live_bars:
        return _store(
            _compute_cache,
            day,
            {"live": False, "reason": "实时行情尚未覆盖今日", "signal_date": day, "as_of": as_of},
        )

    t1 = time.time()
    daily_all = {c: list(b) for c, b in ctx["daily_all"].items()}
    daily_dates = {c: list(d) for c, d in ctx["daily_dates"].items()}
    for code, bar in live_bars.items():
        daily_all[code].append(bar)
        daily_dates[code].append(day)
    provider = macd_states.MacdStateProvider.from_bars(daily_all)

    bench_map = {b["date"]: b["close"] for b in ctx["bench"]}
    rows = features.build_features(day, ctx["meta"], daily_all, ctx["shares_all"], bench_map)
    features.attach_macd(rows, day, provider)
    candidates = features.select_candidates(rows)
    cross_section.enrich(candidates, ctx["bench"])
    features.score(candidates)
    shares = slices.slice_shares(ctx["shares_all"], ctx["shares_dates"], day)
    scored = core.score_rows(candidates, daily_all, shares, provider, day)
    scoring_sec = time.time() - t1

    held_codes, held = context.held_positions(conn, ctx["last_day"])
    on_rebalance = rebalance.should_rebalance(calendar, day)
    ranked = [r["code"] for r in scored]
    target = rebalance.rebalance(held_codes, ranked) if (on_rebalance or not held_codes) else list(held_codes)
    data = {
        "live": True,
        "signal_date": day,
        "last_day": ctx["last_day"],
        "as_of": as_of,
        "meta": ctx["meta"],
        "daily_all": daily_all,
        "rows": rows,
        "candidates": candidates,
        "scored": scored,
        "held_codes": held_codes,
        "held": held,
        "target": target,
        "on_rebalance": bool(on_rebalance or not held_codes),
        "next_rebalance": rebalance.next_rebalance(calendar, day),
        "last_node": core_store.node_at(conn, ctx["last_day"]),
        "quotes": quotes,
        "live_bars": live_bars,
        "timing": {"quotes_sec": round(quotes_sec, 3), "scoring_sec": round(scoring_sec, 3)},
    }
    return _store(_compute_cache, day, data)


def _pick(bucket: str, rank: int, row: dict[str, Any], text: str, reason: dict[str, Any]) -> dict[str, Any]:
    return {
        "bucket": bucket,
        "rank": rank,
        "pick_rank": rank,
        "code": row["code"],
        "name": row["name"],
        "theme": row["theme"],
        "fund_type": row["fund_type"],
        "baseline_score": row["baseline_score"],
        "reason_text": text,
        "reason": reason,
        "next_return": None,
    }


def _core_picks(scored: list[dict[str, Any]], target: list[str]) -> list[dict[str, Any]]:
    by_code = {r["code"]: r for r in scored}
    picks = []
    for code in target:
        row = by_code.get(code)
        if row is None:
            continue
        picks.append(
            _pick(
                "core",
                row["core_rank"],
                row,
                core_reason.reason_text(row, row["core_rank"], True),
                core_reason.reason_json(row, row["core_rank"], True),
            )
        )
    return picks


def build_picks(conn: sqlite3.Connection, day: str, force: bool = False) -> dict[str, Any]:
    """轻量预演响应: 目标持仓 + 当前持仓 + 元信息; 给今日页上部双卡。"""
    if not force:
        hit = _cached(_picks_cache, day, _ttl())
        if hit is not None:
            return hit
    c = _compute(conn, day, force=force)
    if not c.get("live"):
        return _store(_picks_cache, day, c)
    baseline_sorted = sorted(c["candidates"], key=lambda r: -r["baseline_score"])
    today_rank = {r["code"]: r["core_rank"] for r in c["scored"]}
    top_rows = c["scored"][:TODAY_TOP_N]
    top_closes = context.node_closes(conn, c["last_node"], [r["code"] for r in top_rows])
    payload = {
        "live": True,
        "signal_date": day,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "rule_version": LIVE_RULE_VERSION,
        "codes_with_bar": len(c["live_bars"]),
        "codes_with_enough_history": len(c["rows"]),
        "scored": len(c["candidates"]),
        "min_aum_yi": features.DEFAULT_MIN_AUM_YI,
        "shares_available": sum(r["shares_yi"] is not None for r in c["rows"]),
        "evaluation": {"skipped": "盘中预演不结算"},
        "rebalance": c["on_rebalance"],
        "next_rebalance": c["next_rebalance"],
        "last_node": c["last_node"],
        "picks": {
            "core": _core_picks(c["scored"], c["target"]),
            "baseline_codes": [r["code"] for r in baseline_sorted[:BASELINE_TOP]],
        },
        "today_top": [
            {
                "rank": r["core_rank"],
                "code": r["code"],
                "name": r["name"],
                "score": r["core_score"],
                "node_close": top_closes.get(r["code"]),
            }
            for r in top_rows
        ],
        "hold_top": core.HOLD_TOP,
        "buffer_rank": core.HOLD_BUFFER_RANK,
        "held": [{**h, "today_rank": today_rank.get(h["code"])} for h in c["held"]],
        "as_of": c["as_of"],
        "is_trading": realtime.is_trading_time(),
        "last_day": c["last_day"],
        "server_now": int(time.time()),
        "timing": c["timing"],
    }
    return _store(_picks_cache, day, payload)


def build_ranking(conn: sqlite3.Connection, day: str, force: bool = False) -> dict[str, Any]:
    """全量实时排名(约 3MB): 10 分钟一批; 与收盘筛选同构, 前端复用同一表格组件。"""
    if not force:
        hit = _cached(_ranking_cache, day, RANKING_TTL_SEC)
        if hit is not None:
            return hit
    c = _compute(conn, day, force=force)
    if not c.get("live"):
        return _store(_ranking_cache, day, c)
    built = rows.build_rows(
        c["meta"], c["daily_all"], c["rows"], c["candidates"], c["scored"], set(c["held_codes"]), c["quotes"], day
    )
    payload = {
        "live": True,
        "signal_date": day,
        "as_of": c["as_of"],
        "scored": len(c["candidates"]),
        "server_now": int(time.time()),
        "rows": built,
    }
    return _store(_ranking_cache, day, payload)


def refresh(conn: sqlite3.Connection, day: str | None = None) -> dict[str, Any]:
    """手动全量拉取: 清行情缓存与全部预演缓存, 立即重建 picks 与排名, 返回实测耗时。"""
    d = day or datetime.now().strftime("%Y-%m-%d")
    realtime.clear_cache()
    with _guard:
        for cache in (_compute_cache, _picks_cache, _ranking_cache):
            cache.update(date=None, stamp=0.0, data=None)
    picks = build_picks(conn, d, force=True)
    ranking = build_ranking(conn, d, force=True)
    return {
        "refreshed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "picks": picks,
        "ranking_rows": len(ranking.get("rows") or []),
    }
```

<a id="file-backend-pages-daily-live-rows-py"></a>

#### `backend/pages/daily/live/rows.py`

```python
"""盘中实时全量排名行: 与收盘筛选(screen/rank.py)同构的行数据, 供今日页底部全量表复用同一组件。

只在盘中预演(live)时生成: 行情截至实时报价合成bar, 份额/基准截止上一交易日。
stage 语义与 screen 一致, 只是"信号日"换成今天——当日拿不到实时bar 的标的一律
no_bar(停牌/未更新/源端无数据), 不会被误标成"昨日有K线"。
"""

from __future__ import annotations

from typing import Any

from pages.daily.screen import rank as screen_rank
from services.scoring import features
from services.scoring.descriptors import themes
from services.scoring.reason import core8 as core_reason
from services.scoring.reason.ranking import reason_json, reason_text


def _quote(quote: dict[str, Any] | None) -> dict[str, Any] | None:
    """只把卡片/表格需要的三个行情字段带在行上; 时间必须是今日才有效。"""
    if not quote:
        return None
    stamp = str(quote.get("time") or "")
    return {"price": quote.get("price"), "pct": quote.get("pct"), "time": stamp or None}


def build_rows(
    meta: dict[str, Any],
    daily_all: dict[str, list[dict[str, Any]]],
    rows: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    scored: list[dict[str, Any]],
    held_codes: set[str],
    quotes: dict[str, dict[str, Any]],
    today: str,
) -> list[dict[str, Any]]:
    """全量行: 在册每只 ETF 一行, 排序与 screen 一致(综合分名次升序, 未评分排末尾)。"""
    feature_by_code = {r["code"]: r for r in rows}
    scored_codes = {r["code"] for r in candidates}
    core8 = {r["code"]: r for r in scored}
    baseline_sorted = sorted(candidates, key=lambda r: -r["baseline_score"])
    ranks = {r["code"]: i for i, r in enumerate(baseline_sorted, 1)}

    items: list[dict[str, Any]] = []
    for code, m in meta.items():
        bars = daily_all.get(code)
        row = feature_by_code.get(code)
        if m.get("fund_type") != features.DOMESTIC_EQUITY:
            stage = "non_equity"
        elif not features.is_a_share(m.get("name")):
            stage = "hk"
        elif not bars or bars[-1]["date"] != today:
            stage = "no_bar"
        elif row is None:
            stage = "short_history" if len(bars) < features.MIN_BARS else "bad_data"
        elif row["aum_yi"] is None:
            stage = "no_shares"
        elif code not in scored_codes:
            stage = "small_aum"
        else:
            stage = "core_hold" if code in held_codes else "core_pool"
        items.append(_row(code, m, bars, row, stage, ranks.get(code), core8.get(code), quotes.get(code), today))
    items.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, r["code"]))
    return items


def _row(
    code: str,
    meta: dict[str, Any],
    bars: list[dict[str, Any]] | None,
    row: dict[str, Any] | None,
    stage: str,
    rank: int | None,
    core8: dict[str, Any] | None,
    quote: dict[str, Any] | None,
    today: str,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "code": code,
        "name": meta.get("name"),
        "fund_type": meta.get("fund_type"),
        "theme": themes.theme_of(meta.get("name")),
        "stage": stage,
        "stage_text": screen_rank.STAGE_TEXT[stage],
        "last_bar": bars[-1]["date"] if bars else None,
        "bars": len(bars) if bars else 0,
        "rank": rank,
        "core8_rank": core8["core_rank"] if core8 else None,
        "core8_score": core8["core_score"] if core8 else None,
        "core_factors": core8.get("core_factors") if core8 else None,
        "reason": None,
        "reason_text": None,
        "quote": _quote(quote) if str((quote or {}).get("time") or "").startswith(today) else None,
    }
    if row is None or stage in {"non_equity", "hk", "no_bar", "short_history", "bad_data"}:
        return item
    flags = ["shrink_pullback"] if row.get("shrink_pullback") else []
    item["reason"] = reason_json({**row, "baseline_score": row.get("baseline_score")}, flags)
    if stage == "core_hold" and core8:
        held_row = {**row, "core_rank": core8["core_rank"], "core_score": core8["core_score"]}
        item["reason_text"] = core_reason.reason_text(held_row, core8["core_rank"], True)
    elif stage == "core_pool":
        item["reason_text"] = reason_text(row, rank or 0)
    return item
```

<a id="file-backend-pages-daily-nodes-py"></a>

#### `backend/pages/daily/nodes.py`

```python
"""core8 换仓节点与持仓时间线: 节点收益、买卖动作、每只标的的持有区间。

节点收益按混合执行口径结算: 预备排名掉出缓冲带的仓位周四收盘卖出, 完整目标里新买入
和顺延卖出的仓位在周五开盘成交; 连续持有不动。等权、不扣费用, 与日度记录同口径。
节点列表另给两条对照基准: 评分前 10 名等权(看集中到 5 只是否划算)与沪深300 同区间指数
涨跌(看绝对收益里有多少是市场给的), 两者都不含交易成本。
时间线把连续持有合并成一段, 买入价/卖出价用真实成交价(开盘或收盘)。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from pages.daily.review import attribution, execution
from pages.daily.review.execution import load_price_range, price_at
from services.scoring import features
from services.scoring.core import store as core_store
from services.scoring.descriptors import themes

TOP_BENCH_N = 10  # 对照基准: 节点评分前 10 名等权持有, 用来衡量只买 5 只的取舍


def _sell_marks(conn: sqlite3.Connection, start: str | None, end: str | None) -> dict[str, dict[str, str]]:
    """{节点日: {code: close/open}}: 卖出动作由预备排名决定在周四收盘还是周五开盘。"""
    sql = "SELECT signal_date, code, pre_rank FROM fitted_core_pick WHERE action = 'sell'"
    params: list[Any] = []
    if start:
        sql += " AND signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND signal_date <= ?"
        params.append(end)
    marks: dict[str, dict[str, str]] = {}
    for row in conn.execute(sql, params):
        marks.setdefault(row["signal_date"], {})[row["code"]] = execution.sell_at(row["pre_rank"])
    return marks


def _plans(conn: sqlite3.Connection, end: str | None) -> dict[str, Any]:
    """节点链路必须从更早的节点推过来, 状态链才连续。"""
    return execution.plans(core_store.holdings_by_node(conn, end=end), core_store.pre_ranks_by_node(conn, end=end))


def _codes(holdings: dict[str, list[dict[str, Any]]], plans: dict[str, Any]) -> list[str]:
    """区间结算要用到持仓 + 顺延卖出的价格; 周四收盘卖的腿不产生收益, 不必取价。"""
    sold = {c for plan in plans.values() for c in plan["sell_open"]}
    return sorted({p["code"] for items in holdings.values() for p in items} | sold)


def _top_codes(
    conn: sqlite3.Connection,
    start: str | None,
    end: str | None,
    n: int = TOP_BENCH_N,
) -> dict[str, list[str]]:
    """{节点日: 评分前 n 名}: 对照基准按节点当场排名取, 与持仓名单同一时点。"""
    sql = "SELECT signal_date, code FROM fitted_core_pick WHERE core_rank <= ?"
    params: list[Any] = [n]
    if start:
        sql += " AND signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND signal_date <= ?"
        params.append(end)
    sql += " ORDER BY signal_date, core_rank"
    out: dict[str, list[str]] = {}
    for row in conn.execute(sql, params):
        out.setdefault(row["signal_date"], []).append(row["code"])
    return out


def _index_closes(conn: sqlite3.Connection, code: str, start: str, end: str) -> dict[str, float]:
    rows = conn.execute(
        "SELECT date, close FROM index_daily WHERE code = ? AND date BETWEEN ? AND ? AND close IS NOT NULL",
        (code, start, end),
    )
    return {r["date"]: float(r["close"]) for r in rows}


def _equal_weight(
    prices: dict[str, Any],
    codes: list[str],
    start: str | None,
    end: str | None,
) -> float | None:
    """收盘→收盘等权收益; 缺任一端的标的跳过, 一只都算不出就留空。"""
    returns = []
    for code in codes:
        p0, p1 = price_at(prices, code, start), price_at(prices, code, end)
        if p0 and p1:
            returns.append(p1 / p0 - 1)
    return sum(returns) / len(returns) if returns else None


def list_nodes(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    """节点列表: 持仓、买卖动作计数、节点区间收益, 以及前 10 名/沪深300 对照。"""
    nodes = core_store.list_nodes(conn, start, end)
    if not nodes:
        return []
    holdings = core_store.holdings_by_node(conn, start, end)
    counts = core_store.action_counts(conn, start, end)
    plans = _plans(conn, end)
    bench = _top_codes(conn, start, end)
    codes = sorted(set(_codes(holdings, plans)) | {c for items in bench.values() for c in items})
    data_end = max((n["next_rebalance"] or n["signal_date"]) for n in nodes)
    prices = load_price_range(conn, codes, nodes[0]["signal_date"], data_end)
    index = _index_closes(conn, attribution.HS300_CODE, nodes[0]["signal_date"], data_end)
    calendar = features.trading_days(conn)

    out: list[dict[str, Any]] = []
    for node in nodes:
        signal, settle = node["signal_date"], node["next_rebalance"]
        plan = plans.get(signal)
        interval = None
        if plan and settle:
            open_day = execution.next_day(calendar, signal) or settle
            interval = execution.settle(plan, prices, signal, open_day, settle)
        items = holdings.get(signal, [])
        action = counts.get(signal, {})
        index0, index1 = index.get(signal), index.get(settle) if settle else None
        out.append(
            {
                "signal_date": signal,
                "next_rebalance": settle,
                "generated_at": node["generated_at"],
                "rule_version": node["rule_version"],
                "scored": node["scored"],
                "holdings": [{"code": p["code"], "name": p.get("name"), "core_rank": p["core_rank"]} for p in items],
                "counts": {
                    "hold": action.get("hold", 0),
                    "buy": action.get("buy", 0),
                    "sell": action.get("sell", 0),
                },
                "return": (interval or {}).get("mean"),
                "top10_return": _equal_weight(prices, bench.get(signal, []), signal, settle),
                "hs300_return": (index1 / index0 - 1) if index0 and index1 else None,
            }
        )
    return out


def detail(conn: sqlite3.Connection, signal: str) -> dict[str, Any]:
    """单个节点: 持仓/卖出的成交价与区间收益, 以及评分前 20。"""
    node = core_store.get_node(conn, signal)
    if node is None:
        raise ValueError(f"{signal} 不是换仓节点")
    settle = node["next_rebalance"]
    plan = _plans(conn, signal).get(signal) or {"keep": [], "buy": [], "sell_open": [], "sell_close": []}
    picks = node["holdings"] + node["sells"] + node["ranked"]
    codes = sorted({p["code"] for p in picks})
    calendar = features.trading_days(conn)
    open_day = execution.next_day(calendar, signal) or settle
    open_exit = (execution.next_day(calendar, settle) or settle) if settle else None
    load_end = max(d for d in (signal, open_day, settle, open_exit) if d)
    prices = load_price_range(conn, codes, signal, load_end)
    buys = set(plan["buy"])
    # 下一节点顺延卖出的仓位实际出场在次日开盘, 明细按真实成交价展示。
    next_marks = _sell_marks(conn, settle, settle).get(settle, {}) if settle else {}

    def enrich(pick: dict[str, Any]) -> dict[str, Any]:
        row = dict(pick)
        code = pick["code"]
        sell_at = execution.sell_at(pick["pre_rank"]) if pick.get("action") == "sell" else None
        if pick.get("held"):
            entry = price_at(prices, code, open_day, "open") if code in buys else price_at(prices, code, signal)
            if next_marks.get(code) == execution.SELL_OPEN:
                exit_ = price_at(prices, code, open_exit, "open")
            else:
                exit_ = price_at(prices, code, settle)
            ret = exit_ / entry - 1 if entry and exit_ else None
        elif sell_at == "close":
            entry = price_at(prices, code, signal)
            exit_ = None
            ret = 0.0  # 周四收盘已退出, 不再承担后续涨跌
        elif sell_at == "open":
            entry = price_at(prices, code, signal)
            exit_ = price_at(prices, code, open_day, "open")
            ret = exit_ / entry - 1 if entry and exit_ else None
        else:
            entry = price_at(prices, code, signal)
            exit_ = None
            ret = None
        row["theme"] = themes.theme_of(pick.get("name"))
        row["sell_at"] = sell_at
        row["price"] = price_at(prices, code, signal)
        row["entry_price"] = entry if pick.get("held") else None
        row["next_price"] = exit_ if pick.get("held") else None
        row["return"] = ret
        return row

    data = dict(node)
    data["holdings"] = [enrich(p) for p in node["holdings"]]
    data["sells"] = [enrich(p) for p in node["sells"]]
    data["ranked"] = [enrich(p) for p in node["ranked"]]
    if settle:
        data["return"] = execution.settle(plan, prices, signal, open_day or settle, settle)["mean"]
    else:
        data["return"] = None
    return data


def timeline(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    """持仓区间: 连续持有的节点合并成一段, 卖出节点即区间终点。"""
    nodes = core_store.list_nodes(conn, start, end)
    if not nodes:
        return []
    dates = [n["signal_date"] for n in nodes]
    holdings = core_store.holdings_by_node(conn, start, end)
    plans = _plans(conn, end)
    sell_marks = _sell_marks(conn, start, end)
    codes = _codes(holdings, plans)
    data_end = max((n["next_rebalance"] or n["signal_date"]) for n in nodes)
    calendar = features.trading_days(conn)
    prices = load_price_range(conn, codes, dates[0], data_end)

    spells: list[dict[str, Any]] = []
    live: dict[str, dict[str, Any]] = {}
    for date in dates:
        current = {p["code"]: p for p in holdings.get(date, [])}
        for code in [c for c in live if c not in current]:
            spell = live.pop(code)
            spell["exit"] = date
            spells.append(spell)
        for code, pick in current.items():
            opened = live.get(code)
            if opened is None:
                live[code] = {
                    "code": code,
                    "name": pick.get("name"),
                    "theme": themes.theme_of(pick.get("name")),
                    "entry": date,
                    "exit": None,
                    "nodes": 1,
                    "entry_rank": pick["core_rank"],
                    "last_rank": pick["core_rank"],
                }
            else:
                opened["nodes"] += 1
                opened["last_rank"] = pick["core_rank"]
    spells.extend(live.values())

    for spell in spells:
        entry, exit_ = spell["entry"], spell["exit"]
        bought = spell["code"] in set((plans.get(entry) or {}).get("buy", []))
        entry_day = execution.next_day(calendar, entry)
        spell["entry_price"] = (
            price_at(prices, spell["code"], entry_day, "open") if bought else price_at(prices, spell["code"], entry)
        )
        if exit_ is None:
            spell["exit_price"] = None
        elif sell_marks.get(exit_, {}).get(spell["code"]) == execution.SELL_CLOSE:
            spell["exit_price"] = price_at(prices, spell["code"], exit_)
        else:
            spell["exit_price"] = price_at(prices, spell["code"], execution.next_day(calendar, exit_), "open")
        p0, p1 = spell["entry_price"], spell["exit_price"]
        spell["holding"] = exit_ is None
        spell["return"] = p1 / p0 - 1 if p0 and p1 else None
    spells.sort(key=lambda s: (s["entry"], s["code"]))
    return spells
```

<a id="file-backend-pages-daily-review-init-py"></a>

#### `backend/pages/daily/review/__init__.py`

```python
"""每日复盘记录主线: 读写 → 结算规则 → 建日 → 归因。

阅读顺序: store.py → execution.py → build.py → evaluate.py → attribution.py。
"""
```

<a id="file-backend-pages-daily-review-attribution-py"></a>

#### `backend/pages/daily/review/attribution.py`

```python
"""日频归因: 逐日 core8 持仓/基线/股票池/沪深300 的 T+1 收益序列与累计复利。

口径与周度归因一致(逐日等权复利、不扣费用), 额外统计日频版最关心的两个数:
- turnover_avg: core8 持仓相邻交易日重叠度(1 - 交集/两侧较大桶长), 调仓日才跳升;
- rank_ic_mean: 综合分与次日收益的截面相关性, 直接暴露 1 日维度动量是否均值回复。

年线开关与周度归因同口径: 信号日沪深300 收盘站上 MA250 才承受当日 core8 收益,
跌破/未热身时空仓记 0; 严格 `收盘 > MA`, 判定只用信号日及之前的数据。
日频视图按每日判定, 实际执行会有每日申赎摩擦, 视图不扣费、只展示门控的归因效果。
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from bisect import bisect_right
from typing import Any

from pages.daily.review import store

HS300_CODE = "000300"
GATE_WINDOW = 250  # 年线(含当日), 严格 `收盘 > MA` 判定


def _compound(series: list[dict[str, Any]], gates: list[str | None]) -> list[dict[str, Any]]:
    nav = {"core": 1.0, "baseline": 1.0, "universe": 1.0, "hs300": 1.0}
    gated_nav = 1.0
    gated_started = False
    points = []
    for row, gate in zip(series, gates):
        point = {"signal_date": row["signal_date"], "next_signal": row["next_signal"], "gate": gate}
        for key in nav:
            value = row.get(key)
            if value is None:
                point[key] = None
            else:
                nav[key] *= 1 + value
                point[key] = round(nav[key] - 1, 6)
        if gate == "above" and row.get("core") is not None:
            gated_nav *= 1 + row["core"]
            gated_started = True
        # 空仓段沿用最后净值画平线(与周度归因一致), 首个开仓日前为空。
        point["gated"] = round(gated_nav - 1, 6) if gated_started else None
        points.append(point)
    return points


def _hs300_series(conn: sqlite3.Connection, last: str) -> tuple[list[str], list[float]]:
    rows = conn.execute(
        "SELECT date, close FROM index_daily WHERE code = ? AND date <= ? AND close IS NOT NULL ORDER BY date",
        (HS300_CODE, last),
    ).fetchall()
    return [r["date"] for r in rows], [float(r["close"]) for r in rows]


def _moving_average(closes: list[float], window: int) -> list[float | None]:
    """简单移动平均; 前 window-1 个点为 None(不足一个完整窗口)。"""
    out: list[float | None] = []
    total = 0.0
    for i, close in enumerate(closes):
        total += close
        if i >= window:
            total -= closes[i - window]
        out.append(total / window if i >= window - 1 else None)
    return out


def _gate_states(
    dates: list[str],
    closes: list[float],
    days: list[dict[str, Any]],
    window: int = GATE_WINDOW,
) -> list[str | None]:
    """每个信号日收盘相对年线的状态; 年线未热身(不足 window 根)记为 None, 等同不能开仓。"""
    ma = _moving_average(closes, window)
    states: list[str | None] = []
    for day in days:
        index = bisect_right(dates, day["signal_date"]) - 1
        avg = ma[index] if index >= 0 else None
        states.append(None if avg is None else ("above" if closes[index] > avg else "below"))
    return states


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 6) if values else None


def _overall(
    series: list[dict[str, Any]],
    core_picks: list[dict[str, Any]],
    gates: list[str | None] | None = None,
) -> dict[str, Any]:
    settled = [s for s in series if s["core"] is not None]

    def stats(key: str) -> dict[str, Any]:
        vals = [s[key] for s in settled if s[key] is not None]
        return {
            "mean": _mean(vals),
            "positive": sum(v > 0 for v in vals) if vals else None,
        }

    result: dict[str, Any] = {"days": len(settled)}
    for key in ("core", "baseline", "universe"):
        block = stats(key)
        vals = [s[key] for s in settled if s[key] is not None]
        block["cumulative"] = round(math.prod(1 + v for v in vals) - 1, 6) if vals else None
        result[key] = block
    hs300_vals = [s["hs300"] for s in settled if s["hs300"] is not None]
    result["hs300"] = {
        "mean": _mean(hs300_vals),
        "cumulative": round(math.prod(1 + v for v in hs300_vals) - 1, 6) if hs300_vals else None,
        "positive": sum(v > 0 for v in hs300_vals) if hs300_vals else None,
    }
    ics = [s["rank_ic"] for s in settled if s["rank_ic"] is not None]
    result["rank_ic_mean"] = _mean(ics)
    result["rank_ic_positive_days"] = sum(v > 0 for v in ics) if ics else None

    if gates is not None:
        gated = [s["core"] for s, gate in zip(settled, gates) if gate == "above" and s["core"] is not None]
        result["gate_on_days"] = sum(gate == "above" for gate in gates)
        result["gate_off_days"] = sum(gate == "below" for gate in gates)
        result["gated_cumulative"] = round(math.prod(1 + v for v in gated) - 1, 6) if gated else None

    prev: list[str] | None = None
    turnover_sum = 0.0
    turnover_n = 0
    by_day: dict[str, list[str]] = {}
    for pick in core_picks:
        by_day.setdefault(pick["signal_date"], []).append(pick["code"])
    for day in sorted(by_day):
        codes = by_day[day]
        if prev is not None:
            overlap = len(set(codes) & set(prev))
            denom = max(len(codes), len(prev))  # 桶不满时按实际较大的一侧归一
            turnover_sum += 1 - overlap / denom
            turnover_n += 1
        prev = codes
    result["turnover_avg"] = round(turnover_sum / turnover_n, 4) if turnover_n else None
    return result


def build(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    days = store.list_days(conn, start, end)
    series = [
        {
            "signal_date": d["signal_date"],
            "next_signal": d["next_signal"],
            "core": d["core_mean"],
            "baseline": d["baseline_mean"],
            "universe": d["universe_mean"],
            "rank_ic": d["rank_ic"],
            "hs300": (d["index_returns"] or {}).get(HS300_CODE),
        }
        for d in days
    ]
    core_picks = store.all_picks(conn, "core", start, end, require_return=False)
    last = max((d["next_signal"] or d["signal_date"] for d in days), default="")
    dates, closes = _hs300_series(conn, last)
    gates = _gate_states(dates, closes, days)
    return {
        "days": days,
        "cumulative": _compound(series, gates),
        "overall": _overall(series, core_picks, gates),
    }
```

<a id="file-backend-pages-daily-review-build-py"></a>

#### `backend/pages/daily/review/build.py`

```python
"""日频 core8 复盘: 每个交易日取当日有效的换仓节点持仓, 次日收盘结算。

口径与「核心8·缓冲带」卡片同源: 每 5 个交易日换仓一次, 已持有名字排名仍在前 15
就继续持有, 空位按排名补足; 节点日按混合执行结算(周四收盘先卖掉出缓冲带的仓位,
周五开盘补买/顺延卖), 其余交易日仍是收盘→次日收盘。日度记录只是逐日跟踪这套持仓的
T+1 收益, 不做每日重排, 也不再把"趋势内回撤"旧规则桶混进来。

持仓来自 fitted_core_pick(节点是真源), 因此必须先回填换仓节点再重算日度记录。
早于第一个节点的交易日没有持仓, 只记录股票池与基线作为参照。

性能: 行情/份额/指数只全量加载一次, 每个信号日按窗口切片; MACD 状态提供者
全历史只构建一次, 逐日查询; core8 评分不在这里重算, 直接读节点。
"""

from __future__ import annotations

import sqlite3
from bisect import bisect_left, bisect_right
from datetime import datetime
from typing import Any, Callable

from pages.daily.review import execution, store
from pages.daily.review.evaluate import evaluate
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section, slices
from services.scoring.reason import core8 as core_reason
from services.scoring.reason.ranking import reason_json, reason_text

RULE_VERSION = "daily-core8-v1"
DEFAULT_START = "2015-01-05"  # 与 core 节点同起点: 份额数据 2015 年才有, 更早无法算 core8 持仓
BASELINE_TOP = 10
ProgressFn = Callable[[int, int, str], None]


def _baseline_rows(rows: list[dict[str, Any]], n: int = BASELINE_TOP) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda r: -r["baseline_score"])[:n]


def _core_rows(candidates: list[dict[str, Any]], held: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """节点持仓 → 当日特征行; 掉出候选池(规模/行情不满足)的名字当日不展示也不结算。"""
    by_code = {r["code"]: r for r in candidates}
    rows: list[dict[str, Any]] = []
    for pick in held:
        row = by_code.get(pick["code"])
        if row is None:
            continue
        item = dict(row)
        item["core_rank"] = pick["core_rank"]
        item["core_score"] = pick["core_score"]
        # 持仓在节点间延续: 因子拆解沿用换仓当日的截面, 不按当日重算。
        item["core_factors"] = pick.get("factors")
        rows.append(item)
    return rows


def _evaluate(
    conn: sqlite3.Connection,
    signal: str,
    next_signal: str | None,
    candidates: list[dict[str, Any]],
    core_rows: list[dict[str, Any]],
    plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """事后结算; core8 持仓桶与周度 evaluate 共用同一套结算口径。

    节点日改用混合执行价(周四收盘卖 / 周五开盘买), 其余日子仍是收盘→收盘。
    """
    if not next_signal:
        return {"skipped": "暂无下一交易日"}
    if not core_rows:
        return {"skipped": "当日无 core8 持仓"}
    evaluation = evaluate(conn, signal, next_signal, candidates, core_rows)
    if plan is None or not evaluation.get("core_holdings"):
        return evaluation
    # 收盘卖的腿不产生本段收益, 不需要取价; 其余腿都按真实成交价结算。
    codes = sorted({p["code"] for p in core_rows} | set(plan["keep"]) | set(plan["buy"]) | set(plan["sell_open"]))
    prices = execution.load_prices(conn, codes, (signal, next_signal))
    settled = execution.settle(plan, prices, signal, next_signal, next_signal)
    evaluation["core_holdings"] = {k: settled[k] for k in ("n", "mean", "median", "hit_rate")}
    evaluation["core_holdings_picks"] = [
        {"code": p["code"], "name": p.get("name"), "return": settled["returns"].get(p["code"])} for p in core_rows
    ]
    return evaluation


def _pick(
    bucket: str,
    rank: int,
    row: dict[str, Any],
    next_return: float | None,
    reason: dict[str, Any],
    reason_text_value: str,
) -> dict[str, Any]:
    """落库前的统一挑选行: core 与 baseline 两个桶字段完全一致, 只是理由来源不同。"""
    return {
        "bucket": bucket,
        "rank": rank,
        "code": row["code"],
        "name": row["name"],
        "theme": row["theme"],
        "fund_type": row["fund_type"],
        "baseline_score": row["baseline_score"],
        "reason_text": reason_text_value,
        "reason": reason,
        "next_return": next_return,
    }


def _core_picks(core_rows: list[dict[str, Any]], evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    fwd = {p["code"]: p["return"] for p in evaluation.get("core_holdings_picks") or []}
    picks = []
    for rank, row in enumerate(core_rows, 1):
        held_rank = int(row.get("core_rank") or rank)
        picks.append(
            _pick(
                "core",
                rank,
                row,
                fwd.get(row["code"]),
                core_reason.reason_json(row, held_rank, True),
                core_reason.reason_text(row, held_rank, True),
            )
        )
    return picks


def _baseline_picks(candidates: list[dict[str, Any]], evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    fwd = {p["code"]: p["return"] for p in evaluation.get("baseline_top10_picks") or []}
    picks = []
    for rank, row in enumerate(_baseline_rows(candidates, BASELINE_TOP), 1):
        flags = ["shrink_pullback"] if row.get("shrink_pullback") else []
        picks.append(
            _pick("baseline", rank, row, fwd.get(row["code"]), reason_json(row, flags), reason_text(row, rank))
        )
    return picks


def build_day(
    conn: sqlite3.Connection,
    signal: str,
    next_signal: str | None,
    meta: dict[str, dict[str, Any]],
    daily_all: dict[str, list[dict[str, Any]]],
    daily_dates: dict[str, list[str]],
    shares_all: dict[str, list[dict[str, Any]]],
    shares_dates: dict[str, list[str]],
    bench_all: list[dict[str, Any]],
    bench_dates: list[str],
    provider: macd_states.MacdStateProvider,
    codes_with_bar: int,
    min_aum: float,
    held: list[dict[str, Any]],
    plan: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """单个交易日: 切片 → 特征 → 评分 → 读节点持仓 → 事后结算。"""
    sliced_daily, sliced_shares = slices.slice_universe(
        daily_all, daily_dates, shares_all, shares_dates, signal, features.HISTORY_DAYS
    )
    bench_idx = bisect_right(bench_dates, signal)
    bench_bars = bench_all[max(0, bench_idx - features.HISTORY_DAYS) : bench_idx]
    bench_map = {b["date"]: b["close"] for b in bench_bars}

    all_rows = features.build_features(signal, meta, sliced_daily, sliced_shares, bench_map)
    features.attach_macd(all_rows, signal, provider)
    candidates = features.select_candidates(all_rows, min_aum)
    cross_section.enrich(candidates, bench_bars)
    features.score(candidates)

    core_rows = _core_rows(candidates, held)
    evaluation = _evaluate(conn, signal, next_signal, candidates, core_rows, plan)
    summary = {
        "signal_date": signal,
        "next_signal": next_signal,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "rule_version": RULE_VERSION,
        "codes_with_bar": codes_with_bar,
        "codes_with_enough_history": len(all_rows),
        "scored": len(candidates),
        "min_aum_yi": min_aum,
        "shares_available": sum(r["shares_yi"] is not None for r in all_rows),
        "evaluation": evaluation,
    }
    return summary, _core_picks(core_rows, evaluation) + _baseline_picks(candidates, evaluation)


def _held_for_day(
    node_dates: list[str],
    nodes: dict[str, list[dict[str, Any]]],
    signal: str,
) -> list[dict[str, Any]]:
    """换仓间隔期内持仓由上一个节点延续; 节点前没有持仓。"""
    idx = bisect_right(node_dates, signal) - 1
    return nodes[node_dates[idx]] if idx >= 0 else []


def rebuild(
    conn: sqlite3.Connection,
    start_date: str = DEFAULT_START,
    end_date: str | None = None,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """逐日回填 [start_date, end_date]: 整段全量加载一次, 逐日切片评分。"""
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    calendar = features.trading_days(conn)
    end = end_date or calendar[-1]
    days = [d for d in calendar if start_date <= d <= end]
    if not days:
        return {"days": 0}
    nodes = core_store.holdings_by_node(conn, end=end)
    if not nodes:
        raise ValueError("尚无 core8 换仓节点, 请先在日度页执行「回填换仓节点」")
    node_dates = sorted(nodes)
    node_plans = execution.plans(nodes, core_store.pre_ranks_by_node(conn, end=end))
    base = bisect_left(calendar, days[0])
    data_start = calendar[max(0, base - features.HISTORY_DAYS)]
    shares_start = calendar[max(0, base - features.SHARES_HISTORY_DAYS - 5)]
    meta = features.load_meta(conn)
    scope = features.equity_a_share_codes(meta)
    raw_daily = features.load_daily(conn, data_start, end)
    daily_all = {c: b for c, b in raw_daily.items() if c in scope}
    daily_dates = {c: [bar["date"] for bar in bars] for c, bars in daily_all.items()}
    raw_shares = features.load_shares(conn, shares_start, end)
    shares_all = {c: s for c, s in raw_shares.items() if c in scope}
    shares_dates = {c: [bar["date"] for bar in bars] for c, bars in shares_all.items()}
    indices = features.load_index(conn, data_start, end)
    bench_all = indices.get(cross_section.HS300_CODE, [])
    bench_dates = [b["date"] for b in bench_all]
    provider = macd_states.MacdStateProvider.load(conn, end)
    bar_counts = {
        r["date"]: r["n"]
        for r in conn.execute(
            "SELECT date, COUNT(*) AS n FROM etf_daily WHERE date BETWEEN ? AND ? GROUP BY date",
            (days[0], end),
        )
    }
    for i, signal in enumerate(days):
        next_signal = days[i + 1] if i + 1 < len(days) else None
        summary, picks = build_day(
            conn,
            signal,
            next_signal,
            meta,
            daily_all,
            daily_dates,
            shares_all,
            shares_dates,
            bench_all,
            bench_dates,
            provider,
            bar_counts.get(signal, 0),
            min_aum,
            _held_for_day(node_dates, nodes, signal),
            node_plans.get(signal),
        )
        store.replace_day(conn, summary, picks)
        if on_progress:
            on_progress(i + 1, len(days), f"{signal} 评分 {summary['scored']} 只")
    return {"days": len(days), "end": end}
```

<a id="file-backend-pages-daily-review-evaluate-py"></a>

#### `backend/pages/daily/review/evaluate.py`

```python
"""日度复盘的事后评估: 只读取下一交易日收益, 不参与信号日分析输入。

评估口径:
- 入场 = 信号日收盘, 出场 = 下一交易日收盘, close-to-close;
- 基线 = 综合分前 10; 核心 = 信号日有效的 core8 节点持仓(换仓节点之间沿用);
- rank IC 衡量分数与次日收益的截面相关方向, 不衡量收益高低。
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from typing import Any

from services.scoring.ranks import average_ranks


def forward_prices(conn: sqlite3.Connection, date: str) -> dict[str, float]:
    return {
        r["code"]: r["close"]
        for r in conn.execute("SELECT code, close FROM etf_daily WHERE date = ? AND close > 0", (date,))
    }


def _spearman(xs: list[float], ys: list[float]) -> float:
    if len(xs) < 3:
        return 0.0
    rx, ry = average_ranks(xs), average_ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) or 1e-9
    return num / den


def _summary(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "hit_rate": sum(v > 0 for v in values) / len(values),
    }


def evaluate(
    conn: sqlite3.Connection,
    signal: str,
    next_signal: str | None,
    rows: list[dict[str, Any]],
    core_picks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """事后评估: 下一交易日收盘→收盘收益。只用于观察, 不得回灌到信号日分析输入。

    core_picks 是信号日有效的 core8 节点持仓; 不传时核心桶记 0 只样本。
    """
    if not next_signal:
        return {"skipped": "没有下一个交易日"}
    entry = {r["code"]: r["close"] for r in rows}
    exit_ = forward_prices(conn, next_signal)
    fwd = {code: exit_[code] / price - 1 for code, price in entry.items() if exit_.get(code, 0) > 0}
    if not fwd:
        return {"skipped": f"{next_signal} 无行情数据"}
    valid = [r for r in rows if r["code"] in fwd]
    base = sorted(valid, key=lambda r: -r["baseline_score"])[:10]
    core = [r for r in core_picks or [] if r["code"] in fwd]
    picks = [{"code": r["code"], "name": r["name"], "return": fwd[r["code"]]} for r in core]
    base_picks = [{"code": r["code"], "name": r["name"], "return": fwd[r["code"]]} for r in base]
    return {
        "next_signal": next_signal,
        "universe": _summary([fwd[r["code"]] for r in valid]),
        "baseline_top10": _summary([p["return"] for p in base_picks]),
        "baseline_top10_picks": base_picks,
        "core_holdings": _summary([p["return"] for p in picks]),
        "core_holdings_picks": picks,
        "rank_ic_baseline": _spearman(
            [r["baseline_score"] for r in valid],
            [fwd[r["code"]] for r in valid],
        ),
        "index_returns": {
            r["code"]: r["next_close"] / r["close"] - 1
            for r in conn.execute(
                """
                SELECT a.code, a.close, b.close AS next_close
                FROM index_daily a JOIN index_daily b ON b.code = a.code AND b.date = ?
                WHERE a.date = ? AND a.close > 0 AND b.close > 0
                """,
                (next_signal, signal),
            )
        },
        "warning": "事后期望值, 只用于评估, 不得进入信号日分析上下文",
    }
```

<a id="file-backend-pages-daily-review-execution-py"></a>

#### `backend/pages/daily/review/execution.py`

```python
"""core8 节点的混合执行结算: 周四收盘先卖、周五开盘补买/顺延卖。

份额 T+1 才发布, 节点日收盘只能拿到 T-1 份额算出的预备排名; 直接拿它当最终目标会与
完整份额差出约 1 只。约定:
- 节点日 T 收盘: 已持有且预备排名掉出缓冲带(>15)的仓位先卖出(成交价 = T 收盘);
- T+1 凌晨份额落地后用完整排名重算目标, T+1 开盘买入目标里缺的、卖出顺延的;
- 连续持有的仓位不动。

结算按真实成交价: 新买入只承担开盘→收盘, 顺延卖出吃到收盘→次日开盘的跳空。
等权槽位口径: 分母取节点前后的较大仓位槽数, 空槽(现金)记 0, 与日度复利口径一致。
"""

from __future__ import annotations

import sqlite3
import statistics
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from typing import Any

from services.scoring.core import score as core

SELL_CLOSE = "close"
SELL_OPEN = "open"


def sell_at(pre_rank: int | None, buffer: int = core.HOLD_BUFFER_RANK) -> str:
    """预备排名缺失(已掉出候选池)按收盘卖: 周四收盘就能确定它进不了完整目标。"""
    return SELL_CLOSE if pre_rank is None or pre_rank >= buffer else SELL_OPEN


def legs(
    held_prev: Sequence[str],
    target: Sequence[str],
    pre_rank: Mapping[str, int | None],
    buffer: int = core.HOLD_BUFFER_RANK,
) -> dict[str, list[str]]:
    """把一次换仓拆成四条腿: 周四收盘卖 / 周五开盘卖 / 继续持有 / 周五开盘买。"""
    final = set(target)
    close_sells = [c for c in held_prev if sell_at(pre_rank.get(c), buffer) == SELL_CLOSE]
    left = [c for c in held_prev if c not in set(close_sells)]
    left_set = set(left)
    return {
        "sell_close": close_sells,
        "sell_open": [c for c in left if c not in final],
        "keep": [c for c in left if c in final],
        "buy": [c for c in target if c not in left_set],
    }


def remaining_after_close_sells(
    held_prev: Sequence[str],
    pre_rank: Mapping[str, int | None],
    buffer: int = core.HOLD_BUFFER_RANK,
) -> list[str]:
    """周四收盘卖掉掉出缓冲带的仓位后剩下的持仓: 周五开盘再平衡的状态。"""
    return [c for c in held_prev if sell_at(pre_rank.get(c), buffer) == SELL_OPEN]


def plans(
    nodes_by_date: dict[str, list[dict[str, Any]]],
    pre_ranks: dict[str, dict[str, int | None]] | None = None,
    buffer: int = core.HOLD_BUFFER_RANK,
) -> dict[str, Any]:
    """{节点日: 持有名单} → {节点日: 四条腿}; 持仓链按节点顺序推进。

    预备排名要从节点全部动作行取(sell 行也带着它), 只读 hold/buy 会把掉出缓冲带的
    仓位当成缺排名, 一律按周四收盘卖, 与 "预备排名仍在缓冲带就留到周五开盘" 冲突。
    """
    out: dict[str, Any] = {}
    prev: list[str] = []
    for day in sorted(nodes_by_date):
        picked = nodes_by_date[day]
        target = [p["code"] for p in picked]
        pre = (pre_ranks or {}).get(day) or {p["code"]: p.get("pre_rank") for p in picked}
        out[day] = legs(prev, target, pre, buffer)
        prev = target
    return out


def _collect_prices(
    conn: sqlite3.Connection,
    codes: Sequence[str],
    where: str,
    params: Sequence[str],
) -> dict[str, dict[str, dict[str, float | None]]]:
    """{code: {date: {open, close}}}; where 只拼日期条件, 代码条件由这里统一加。"""
    if not codes:
        return {}
    code_marks = ",".join("?" * len(codes))
    rows = conn.execute(
        f"SELECT code, date, open, close FROM etf_daily WHERE code IN ({code_marks}) AND {where}",
        (*codes, *params),
    )
    prices: dict[str, dict[str, dict[str, float | None]]] = {}
    for row in rows:
        prices.setdefault(row["code"], {})[row["date"]] = {"open": row["open"], "close": row["close"]}
    return prices


def load_prices(
    conn: sqlite3.Connection,
    codes: Sequence[str],
    days: Sequence[str],
) -> dict[str, dict[str, dict[str, float | None]]]:
    """{code: {date: {open, close}}}: 只取结算用到的日期, 缺行为空。"""
    if not codes or not days:
        return {}
    day_marks = ",".join("?" * len(days))
    return _collect_prices(conn, codes, f"date IN ({day_marks})", days)


def load_price_range(
    conn: sqlite3.Connection,
    codes: Sequence[str],
    start: str,
    end: str,
) -> dict[str, dict[str, dict[str, float | None]]]:
    """同 load_prices, 但按 [start, end] 区间取(节点列表/时间线一次要读整段)。"""
    return _collect_prices(conn, codes, "date BETWEEN ? AND ?", (start, end))


def price_at(prices: Mapping[str, Any], code: str, day: str | None, field: str = "close") -> float | None:
    """从 load_prices/load_price_range 的嵌套字典取价; 缺日或非正价一律视为缺价。"""
    if day is None:
        return None
    value = ((prices.get(code) or {}).get(day) or {}).get(field)
    return value if isinstance(value, (int, float)) and value > 0 else None


def period_returns(
    plan: dict[str, list[str]],
    prices: dict[str, Any],
    entry_day: str,
    open_day: str,
    exit_day: str,
) -> dict[str, float]:
    """单个区间的每只标的收益; 收盘卖出的仓位在区间起点已退出, 不产生收益。"""
    out: dict[str, float] = {}
    for code in plan["keep"]:
        p0, p1 = price_at(prices, code, entry_day), price_at(prices, code, exit_day)
        if p0 and p1:
            out[code] = p1 / p0 - 1
    for code in plan["buy"]:
        p0, p1 = price_at(prices, code, open_day, "open"), price_at(prices, code, exit_day)
        if p0 and p1:
            out[code] = p1 / p0 - 1
    for code in plan["sell_open"]:
        p0, p1 = price_at(prices, code, entry_day), price_at(prices, code, open_day, "open")
        if p0 and p1:
            out[code] = p1 / p0 - 1
    return out


def settle(
    plan: dict[str, list[str]],
    prices: dict[str, Any],
    entry_day: str,
    open_day: str,
    exit_day: str,
) -> dict[str, Any]:
    """区间等权收益 + 逐只收益; 分母是槽位数, 缺价的腿按现金(0)处理。"""
    returns = period_returns(plan, prices, entry_day, open_day, exit_day)
    slots = max(
        len(plan["keep"]) + len(plan["sell_open"]) + len(plan["sell_close"]),
        len(plan["keep"]) + len(plan["buy"]),
    )
    values = list(returns.values())
    mean = sum(values) / slots if slots else None
    return {
        "n": slots,
        "mean": round(mean, 6) if mean is not None else None,
        "median": round(statistics.median(values), 6) if values else None,
        "hit_rate": sum(v > 0 for v in values) / len(values) if values else None,
        "returns": returns,
    }


def next_day(calendar: Sequence[str], day: str) -> str | None:
    """节点日之后的第一个交易日 = 开盘成交日。"""
    idx = bisect_right(calendar, day)
    return calendar[idx] if idx < len(calendar) else None
```

<a id="file-backend-pages-daily-review-store-py"></a>

#### `backend/pages/daily/review/store.py`

```python
"""日频复盘的持久化: 每个交易日一条汇总 + core8 持仓/基线两组成员逐笔记录。

表结构沿用旧版周度 store.py, 但日频版不存市场状态(regime); 持仓桶是
core8 缓冲带的当日有效持仓(由换仓节点延续), 不再是"趋势内回撤"规则桶。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS fitted_daily_summary (
    signal_date TEXT PRIMARY KEY,
    next_signal TEXT,
    generated_at TEXT,
    rule_version TEXT,
    codes_with_bar INTEGER,
    codes_with_enough_history INTEGER,
    scored INTEGER,
    min_aum_yi REAL,
    shares_available INTEGER,
    universe_mean REAL,
    universe_median REAL,
    universe_hit REAL,
    baseline_mean REAL,
    baseline_median REAL,
    baseline_hit REAL,
    core_mean REAL,
    core_median REAL,
    core_hit REAL,
    rank_ic REAL,
    eval_json TEXT,
    index_returns_json TEXT
);
CREATE TABLE IF NOT EXISTS fitted_daily_pick (
    signal_date TEXT NOT NULL,
    bucket TEXT NOT NULL,
    pick_rank INTEGER NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    theme TEXT,
    fund_type TEXT,
    baseline_score REAL,
    reason_text TEXT,
    reason_json TEXT,
    next_return REAL,
    PRIMARY KEY (signal_date, bucket, pick_rank)
);
"""

EVAL_PICK_KEYS = ("baseline_top10_picks", "core_holdings_picks")

# 旧 daily-v1 的规则桶列改名: SQLite ≥3.25 支持 RENAME COLUMN, 破坏前先判存在。
_RENAMES = (
    ("rule_mean", "core_mean"),
    ("rule_median", "core_median"),
    ("rule_hit", "core_hit"),
)


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(fitted_daily_summary)")}
    with conn:
        for old, new in _RENAMES:
            if old in cols and new not in cols:
                conn.execute(f"ALTER TABLE fitted_daily_summary RENAME COLUMN {old} TO {new}")


def _metric(block: dict[str, Any] | None, key: str) -> float | None:
    if not block:
        return None
    value = block.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def _summary_row(summary: dict[str, Any]) -> tuple:
    evaluation = summary["evaluation"]
    return (
        summary["signal_date"],
        summary.get("next_signal"),
        summary.get("generated_at"),
        summary.get("rule_version"),
        summary.get("codes_with_bar"),
        summary.get("codes_with_enough_history"),
        summary.get("scored"),
        summary.get("min_aum_yi"),
        summary.get("shares_available"),
        _metric(evaluation.get("universe"), "mean"),
        _metric(evaluation.get("universe"), "median"),
        _metric(evaluation.get("universe"), "hit_rate"),
        _metric(evaluation.get("baseline_top10"), "mean"),
        _metric(evaluation.get("baseline_top10"), "median"),
        _metric(evaluation.get("baseline_top10"), "hit_rate"),
        _metric(evaluation.get("core_holdings"), "mean"),
        _metric(evaluation.get("core_holdings"), "median"),
        _metric(evaluation.get("core_holdings"), "hit_rate"),
        evaluation.get("rank_ic_baseline"),
        json.dumps({k: v for k, v in evaluation.items() if k not in EVAL_PICK_KEYS}, ensure_ascii=False),
        json.dumps(evaluation.get("index_returns") or {}, ensure_ascii=False),
    )


SUMMARY_COLUMNS = (
    "signal_date, next_signal, generated_at, rule_version, codes_with_bar, codes_with_enough_history, scored, "
    "min_aum_yi, shares_available, universe_mean, universe_median, universe_hit, baseline_mean, baseline_median, "
    "baseline_hit, core_mean, core_median, core_hit, rank_ic, eval_json, index_returns_json"
)

SUMMARY_SQL = f"INSERT OR REPLACE INTO fitted_daily_summary ({SUMMARY_COLUMNS}) VALUES ({', '.join(['?'] * 21)})"

PICK_SQL = """
INSERT OR REPLACE INTO fitted_daily_pick
    (signal_date, bucket, pick_rank, code, name, theme, fund_type, baseline_score,
     reason_text, reason_json, next_return)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def replace_day(
    conn: sqlite3.Connection,
    summary: dict[str, Any],
    picks: list[dict[str, Any]],
) -> None:
    """整日覆盖: 重复执行同一信号日不会留下旧成员(含旧 rule 桶)。"""
    signal = summary["signal_date"]
    with conn:
        conn.execute(SUMMARY_SQL, _summary_row(summary))
        conn.execute("DELETE FROM fitted_daily_pick WHERE signal_date = ?", (signal,))
        conn.executemany(
            PICK_SQL,
            [
                (
                    signal,
                    p["bucket"],
                    p["rank"],
                    p["code"],
                    p.get("name"),
                    p.get("theme"),
                    p.get("fund_type"),
                    p.get("baseline_score"),
                    p.get("reason_text"),
                    json.dumps(p.get("reason") or {}, ensure_ascii=False),
                    p.get("next_return"),
                )
                for p in picks
            ],
        )


def _decode_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["evaluation"] = json.loads(data.pop("eval_json") or "{}")
    data["index_returns"] = json.loads(data.pop("index_returns_json") or "{}") or {}
    return data


def list_days(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM fitted_daily_summary"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("signal_date >= ?")
        params.append(start)
    if end:
        where.append("signal_date <= ?")
        params.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY signal_date"
    return [_decode_row(r) for r in conn.execute(sql, params)]


def get_day(conn: sqlite3.Connection, signal_date: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM fitted_daily_summary WHERE signal_date = ?", (signal_date,)).fetchone()
    if row is None:
        return None
    data = _decode_row(row)
    picks: dict[str, list[dict[str, Any]]] = {"core": [], "baseline": []}
    for r in conn.execute(
        "SELECT * FROM fitted_daily_pick WHERE signal_date = ? ORDER BY bucket, pick_rank",
        (signal_date,),
    ):
        item = dict(r)
        item["reason"] = json.loads(item.pop("reason_json") or "{}")
        picks.setdefault(item.pop("bucket"), []).append(item)
    data["picks"] = picks
    return data


def all_picks(
    conn: sqlite3.Connection,
    bucket: str,
    start: str | None = None,
    end: str | None = None,
    *,
    require_return: bool = True,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM fitted_daily_pick WHERE bucket = ?"
    if require_return:
        sql += " AND next_return IS NOT NULL"
    params: list[Any] = [bucket]
    if start:
        sql += " AND signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND signal_date <= ?"
        params.append(end)
    sql += " ORDER BY signal_date, pick_rank"
    return [dict(r) for r in conn.execute(sql, params)]
```

<a id="file-backend-pages-daily-router-py"></a>

#### `backend/pages/daily/router.py`

```python
"""日度复盘接口: 每个交易日的 ETF 入选、次日收益与频率对照归因。"""

from __future__ import annotations

import contextlib
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from data.store.database import get_conn
from ops import core_backfill
from ops.background import ProgressFn, TaskBusy, TaskRunner, WorkFn
from pages.daily import nodes
from pages.daily.live import context, preview
from pages.daily.review import attribution, build, store
from pages.daily.screen import cache
from services.scoring.core import store as core_store

router = APIRouter(prefix="/api/dailypick", tags=["dailypick"])

_TASKS = TaskRunner()
RECORDS = "records"
CORE = "core"


class RebuildRequest(BaseModel):
    start_date: Optional[str] = None  # noqa: UP045 — pydantic v2 + py3.9 运行时无法解析 `X | None`
    end_date: Optional[str] = None  # noqa: UP045


def _lite(day: dict[str, Any]) -> dict[str, Any]:
    return {
        "signal_date": day["signal_date"],
        "next_signal": day["next_signal"],
        "scored": day["scored"],
        "universe_mean": day["universe_mean"],
        "universe_hit": day["universe_hit"],
        "baseline_mean": day["baseline_mean"],
        "baseline_hit": day["baseline_hit"],
        "core_mean": day["core_mean"],
        "core_hit": day["core_hit"],
        "rank_ic": day["rank_ic"],
    }


@router.get("/days")
def days(start: Optional[str] = None, end: Optional[str] = None) -> list[dict[str, Any]]:  # noqa: UP045
    conn = get_conn()
    store.ensure_schema(conn)
    return [_lite(d) for d in store.list_days(conn, start, end)]


@router.get("/days/{signal_date}")
def day_detail(signal_date: str) -> dict[str, Any]:
    conn = get_conn()
    store.ensure_schema(conn)
    data = store.get_day(conn, signal_date)
    if data is None:
        raise HTTPException(status_code=404, detail=f"{signal_date} 尚无日度记录, 请先运行重算")
    return data


@router.get("/days/{signal_date}/screen")
def day_screen(signal_date: str) -> dict[str, Any]:
    """筛选漏斗 + 全量排名: 逐级展示当日 ETF 如何在每一级被筛掉, 以及评分明细。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    try:
        return cache.build_cached(conn, signal_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _closed_today(conn: Any) -> dict[str, Any] | None:
    """今日已有收盘记录时返回它(带 live=False 标记), 盘中预演让位正式记录。"""
    today = datetime.now().strftime("%Y-%m-%d")
    existing = store.get_day(conn, today)
    if existing is not None and (existing.get("scored") or 0) > 0:
        return {**existing, "live": False, "reason": "今日已有收盘记录"}
    return None


@router.get("/live")
def live_day() -> dict[str, Any]:
    """今日盘中预演(轻量): 目标持仓 + 当前持仓 + 元信息; 实时现价合成今日K线, 不落库。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    closed = _closed_today(conn)
    if closed is not None:
        return closed
    return preview.build_picks(conn, datetime.now().strftime("%Y-%m-%d"))


@router.get("/live/ranking")
def live_ranking() -> dict[str, Any]:
    """今日全量实时排名(约 3MB): 与收盘筛选同构, 10 分钟一批; 收盘后让位正式快照。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    closed = _closed_today(conn)
    if closed is not None:
        return closed
    return preview.build_ranking(conn, datetime.now().strftime("%Y-%m-%d"))


@router.post("/live/refresh")
def live_refresh() -> dict[str, Any]:
    """手动全量拉取: 清缓存立即重建, 返回实测行情拉取/评分耗时与排名行数。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    closed = _closed_today(conn)
    if closed is not None:
        return {"refreshed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "picks": closed, "ranking_rows": 0}
    return preview.refresh(conn)


@router.get("/attribution")
def daily_attribution(
    start: Optional[str] = None,  # noqa: UP045
    end: Optional[str] = None,  # noqa: UP045
) -> dict[str, Any]:
    conn = get_conn()
    store.ensure_schema(conn)
    return attribution.build(conn, start, end)


def _warm_latest_screen() -> None:
    """重算会换掉 generated_at, 落盘筛选快照随之失效; 收尾顺手预热, 页面左卡打开即出。"""
    with contextlib.suppress(Exception):  # 预热只影响首屏速度, 失败留给页面首次打开时重算
        cache.warm(get_conn())


def _records_work(req: RebuildRequest) -> WorkFn:
    """日度记录重算: 连接必须在后台线程内取(每线程一条 SQLite 连接)。"""

    def work(progress: ProgressFn) -> dict[str, Any]:
        return build.rebuild(
            get_conn(),
            start_date=req.start_date or build.DEFAULT_START,
            end_date=req.end_date or datetime.now().strftime("%Y-%m-%d"),
            on_progress=progress,
        )

    return work


def _core_work(req: RebuildRequest) -> WorkFn:
    """换仓节点回填: 同上, 连接在后台线程内取。"""

    def work(progress: ProgressFn) -> dict[str, Any]:
        return core_backfill.rebuild(
            get_conn(),
            start=req.start_date,
            end=req.end_date or datetime.now().strftime("%Y-%m-%d"),
            on_progress=progress,
        )

    return work


@router.post("/rebuild")
def rebuild(req: RebuildRequest) -> dict[str, Any]:
    try:
        return _TASKS.start(RECORDS, _records_work(req), on_finished=_warm_latest_screen)
    except TaskBusy as error:
        raise HTTPException(status_code=409, detail="日度记录正在重算") from error


@router.get("/status")
def rebuild_status() -> dict[str, Any]:
    return _TASKS.status(RECORDS)


@router.get("/core")
def core_snapshot(date: Optional[str] = None) -> dict[str, Any]:  # noqa: UP045
    """该日所属的换仓节点: 间隔期内沿用上一节点持仓, 不按当日排名重排。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    target = date or datetime.now().strftime("%Y-%m-%d")
    signal = core_store.node_at(conn, target)
    data = core_store.get_node(conn, signal) if signal else None
    if data is None:
        raise HTTPException(status_code=404, detail="尚无 core8 换仓节点, 请先执行「回填换仓节点」")
    closes = context.node_closes(conn, data.get("signal_date"), [p["code"] for p in data["holdings"]])
    holdings = [{**p, "node_close": closes.get(p["code"])} for p in data["holdings"]]
    return {**data, "holdings": holdings, "requested_date": target, "held_codes": [p["code"] for p in holdings]}


@router.get("/nodes")
def node_list(
    start: Optional[str] = None,  # noqa: UP045
    end: Optional[str] = None,  # noqa: UP045
) -> list[dict[str, Any]]:
    """换仓节点列表: 每个节点的持仓、买卖计数与持有到下一节点的等权收益。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    return nodes.list_nodes(conn, start, end)


@router.get("/nodes/{signal}")
def node_detail(signal: str) -> dict[str, Any]:
    """单节点明细: 持仓/卖出/评分前 20 的当日价与区间收益。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    try:
        return nodes.detail(conn, signal)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/timeline")
def holding_timeline(
    start: Optional[str] = None,  # noqa: UP045
    end: Optional[str] = None,  # noqa: UP045
) -> list[dict[str, Any]]:
    """持仓区间: 连续持有的节点合并为一段, 用来核对买入/持有/卖出节奏。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    return nodes.timeline(conn, start, end)


@router.post("/core/rebuild")
def core_rebuild(req: RebuildRequest) -> dict[str, Any]:
    try:
        return _TASKS.start(CORE, _core_work(req), on_finished=_warm_latest_screen)
    except TaskBusy as error:
        raise HTTPException(status_code=409, detail="core8 换仓节点正在回填") from error


@router.get("/core/status")
def core_status() -> dict[str, Any]:
    return _TASKS.status(CORE)
```

<a id="file-backend-pages-daily-screen-init-py"></a>

#### `backend/pages/daily/screen/__init__.py`

```python
"""筛选漏斗: 单日全量排名(rank) → 快照落盘(store) → 页面读取缓存(cache)。"""
```

<a id="file-backend-pages-daily-screen-cache-py"></a>

#### `backend/pages/daily/screen/cache.py`

```python
"""筛选快照的读取入口: 页面只走 build_cached, 不直接触发全量重算。

单日全量筛选约 6 秒、近 4MB JSON; 页面刷新几次就会堆起多个并发重算把后端 CPU 打满。
这里做两件事:
- 落盘快照(screen_store): 命中直接反序列化, 未命中才算并覆盖;
- 单飞锁: 同一信号日的并发请求只放一个线程进 build, 其余等它写完后读快照。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import zlib
from typing import Any, cast

from pages.daily.review import store
from pages.daily.screen import rank
from pages.daily.screen import store as screen_store
from services.scoring import features
from services.scoring.core import store as core_store

_build_locks: dict[str, threading.Lock] = {}
_lock_guard = threading.Lock()


def _lock_for(signal: str) -> threading.Lock:
    with _lock_guard:
        return _build_locks.setdefault(signal, threading.Lock())


def _source_key(conn: sqlite3.Connection, signal: str) -> tuple[str | None, str | None]:
    """快照有效性: 日度记录与所属换仓节点任一重算都会换 generated_at。"""
    day = conn.execute("SELECT generated_at FROM fitted_daily_summary WHERE signal_date = ?", (signal,)).fetchone()
    node = core_store.node_at(conn, signal)
    node_row = (
        conn.execute("SELECT generated_at FROM fitted_core_summary WHERE signal_date = ?", (node,)).fetchone()
        if node
        else None
    )
    return (day["generated_at"] if day else None, node_row["generated_at"] if node_row else None)


def _snapshot(
    conn: sqlite3.Connection,
    signal: str,
    day_generated_at: str | None,
    node_generated_at: str | None,
    min_aum: float,
) -> dict[str, Any] | None:
    row = screen_store.get(conn, signal)
    if row is None or row[0] != day_generated_at or row[1] != node_generated_at or row[2] != min_aum:
        return None
    data = cast(dict[str, Any], json.loads(zlib.decompress(row[3]).decode("utf-8")))
    if data.get("payload_version") != rank.PAYLOAD_VERSION:
        return None
    return data


def latest_signal(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT MAX(signal_date) FROM fitted_daily_summary").fetchone()
    return row[0] if row and row[0] else None


def warm(conn: sqlite3.Connection, signal: str | None = None) -> str | None:
    """预热筛选快照: 记录/节点每重算一次落盘快照就失效, 不预热就要等页面首次打开冷算约 7 秒。"""
    signal = signal or latest_signal(conn)
    if not signal:
        return None
    build_cached(conn, signal)
    return signal


def build_cached(
    conn: sqlite3.Connection,
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    screen_store.ensure_schema(conn)
    day_generated_at, node_generated_at = _source_key(conn, signal)
    hit = _snapshot(conn, signal, day_generated_at, node_generated_at, min_aum)
    if hit is not None:
        return hit
    with _lock_for(signal):
        hit = _snapshot(conn, signal, day_generated_at, node_generated_at, min_aum)
        if hit is not None:
            return hit
        data = rank.build(conn, signal, min_aum)
        payload = zlib.compress(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        screen_store.put(conn, signal, day_generated_at, node_generated_at, min_aum, payload)
        return data
```

<a id="file-backend-pages-daily-screen-rank-py"></a>

#### `backend/pages/daily/screen/rank.py`

```python
"""筛选漏斗与全量排名: 把某个交易日的 ETF 筛选链路逐级摊开供复盘。

生产链路(pages/daily/review/build.py)落 core8 持仓与基线入选, 复盘时看不到
"谁在哪一级被筛掉"和"池内谁强谁弱"。本模块复用同一套特征/评分/规则函数,
把每一步的中间结果全部返回(不落库):
- funnel: 在册 → 指数型-股票 → A股底层 → 信号日有K线 → 历史≥62根 → 有份额
  → 规模≥2亿 → core8 评分池 → 缓冲带持仓; 基线前10 是评分池的并行分支;
- rows: 每只 ETF 到达的最深一级、剔除原因、评分与因子明细。

时点纪律: 行情/份额/基准全部截到 signal_date, 不读信号日之后的数据。
"""

from __future__ import annotations

import sqlite3
import threading
import time
from bisect import bisect_left
from collections import OrderedDict
from typing import Any

from pages.daily.review import build as daily_build
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import score as core
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section, slices, themes
from services.scoring.reason import core8 as core_reason
from services.scoring.reason.ranking import reason_json, reason_text

CACHE_TTL_SEC = 120  # 单日筛选结果含全量行, 重算后才可能变化
CACHE_SLOTS = 3  # 单份全量约 3MB; 只留最近几天, 换日期来回切不必重算
BASELINE_TOP = daily_build.BASELINE_TOP
PAYLOAD_VERSION = 2  # 行结构变更时递增: 旧落盘快照缺字段, 自动失效重算

FUNNEL_STAGES: tuple[tuple[str, str, str], ...] = (
    ("etfs", "在册 ETF", "etfs 清单全部标的（含 QDII/债券/货币等）"),
    ("equity", "指数型-股票", "fund_type = 指数型-股票"),
    ("a_share", "A 股底层", "名称不含 港股/恒生/恒指/香港/H股/沪港深/AH"),
    ("with_bar", "信号日有 K 线", "当日收盘已入库（停牌/未上市/未回填会掉队）"),
    ("history", "历史 ≥62 根", "≥62 根日 K，且近 61 日收盘、近 20 日成交量有效"),
    ("shares", "有份额可算规模", "库内有 ≤ 信号日的份额；规模 = 收盘价 × 份额"),
    ("aum", "规模 ≥2 亿", "aum_yi ≥ min_aum（默认 2 亿）"),
    ("core_pool", "策略评分池", "8 因子截面秩评分：深回撤/超跌/长动量为正，高波动/份额拥挤/放量为负"),
    ("core_hold", "缓冲带持仓", "每 5 个交易日调仓；前 5 名 + 已持有且排名≤15 继续持有"),
)
BASELINE_NOTE = (
    "基线前 10 是评分池的并行分支: 综合分前 10，不做策略过滤（无观点对照锚）。"
    "策略持仓由换仓节点决定，间隔期内沿用上一节点，不按当日排名重排。"
)

STAGE_TEXT: dict[str, str] = {
    "non_equity": "非指数型-股票（QDII/债券/货币等）",
    "hk": "含港股/非 A 股底层",
    "no_bar": "信号日无 K 线",
    "short_history": "历史不足 62 根",
    "bad_data": "数据异常（零价/零量）",
    "no_shares": "无份额数据",
    "small_aum": "规模不足 2 亿",
    "core_pool": "策略评分池·未持有",
    "core_hold": "缓冲带持仓",
}

_guard = threading.Lock()
_cache: OrderedDict[tuple[str, float], tuple[float, dict[str, Any]]] = OrderedDict()


def _cached(key: tuple[str, float]) -> dict[str, Any] | None:
    with _guard:
        hit = _cache.get(key)
        if hit is None or time.time() - hit[0] >= CACHE_TTL_SEC:
            _cache.pop(key, None)
            return None
        _cache.move_to_end(key)
        return hit[1]


def _store(key: tuple[str, float], data: dict[str, Any]) -> dict[str, Any]:
    with _guard:
        _cache[key] = (time.time(), data)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SLOTS:
            _cache.popitem(last=False)
    return data


def _load(conn: sqlite3.Connection, signal: str) -> dict[str, Any]:
    """加载截至信号日的历史上下文; 只读 ≤ signal 的行。"""
    calendar = features.trading_days(conn)
    idx = bisect_left(calendar, signal)
    if idx >= len(calendar) or calendar[idx] != signal:
        raise ValueError(f"{signal} 不是交易日")
    data_start = calendar[max(0, idx - features.HISTORY_DAYS)]
    shares_start = calendar[max(0, idx - slices.SHARES_SLICE_DAYS * 2)]
    daily_all = features.load_daily(conn, data_start, signal)
    shares_all = features.load_shares(conn, shares_start, signal)
    indices = features.load_index(conn, data_start, signal)
    return {
        "meta": features.load_meta(conn),
        "daily_all": daily_all,
        "daily_dates": {code: [bar["date"] for bar in bars] for code, bars in daily_all.items()},
        "shares_all": shares_all,
        "shares_dates": {code: [bar["date"] for bar in bars] for code, bars in shares_all.items()},
        "bench": indices.get(cross_section.HS300_CODE, []),
        "provider": macd_states.MacdStateProvider.load(conn, signal),
    }


def _slice(ctx: dict[str, Any], signal: str) -> tuple[dict[str, Any], dict[str, Any]]:
    return slices.slice_universe(
        ctx["daily_all"],
        ctx["daily_dates"],
        ctx["shares_all"],
        ctx["shares_dates"],
        signal,
        features.HISTORY_DAYS,
    )


def _stage_key(
    meta: dict[str, Any],
    bars: list[dict[str, Any]] | None,
    row: dict[str, Any] | None,
    code: str,
    signal: str,
    scored_codes: set[str],
    held_codes: set[str],
) -> str:
    """该 ETF 在漏斗中到达的最深一级。"""
    if meta.get("fund_type") != features.DOMESTIC_EQUITY:
        return "non_equity"
    if not features.is_a_share(meta.get("name")):
        return "hk"
    if not bars or bars[-1]["date"] != signal:
        return "no_bar"
    if row is None:
        return "short_history" if len(bars) < features.MIN_BARS else "bad_data"
    if row["aum_yi"] is None:
        return "no_shares"
    if code not in scored_codes:
        return "small_aum"
    return "core_hold" if code in held_codes else "core_pool"


def _row(
    code: str,
    meta: dict[str, Any],
    bars: list[dict[str, Any]] | None,
    row: dict[str, Any] | None,
    stage: str,
    rank: int | None,
    core8: dict[str, Any] | None,
    node_close: float | None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "code": code,
        "name": meta.get("name"),
        "fund_type": meta.get("fund_type"),
        "theme": themes.theme_of(meta.get("name")),
        "stage": stage,
        "stage_text": STAGE_TEXT[stage],
        "last_bar": bars[-1]["date"] if bars else None,
        "bars": len(bars) if bars else 0,
        "rank": rank,
        "core8_rank": core8["core_rank"] if core8 else None,
        "core8_score": core8["core_score"] if core8 else None,
        "core_factors": core8.get("core_factors") if core8 else None,
        "node_close": node_close,
        "reason": None,
        "reason_text": None,
    }
    if row is None or stage in {"non_equity", "hk", "no_bar", "short_history", "bad_data"}:
        return item
    flags = ["shrink_pullback"] if row.get("shrink_pullback") else []
    item["reason"] = reason_json({**row, "baseline_score": row.get("baseline_score")}, flags)
    if stage == "core_hold" and core8:
        held_row = {**row, "core_rank": core8["core_rank"], "core_score": core8["core_score"]}
        item["reason_text"] = core_reason.reason_text(held_row, core8["core_rank"], True)
    elif stage == "core_pool":
        item["reason_text"] = reason_text(row, rank or 0)
    return item


def _node_context(
    conn: sqlite3.Connection,
    signal: str,
) -> tuple[str | None, set[str], dict[str, float]]:
    """当日有效的换仓节点: (节点日, 持仓代码, 节点日收盘价)。

    间隔期内沿用上一节点; 今日「节点涨跌」统一以节点日收盘为基准
    (持有=本轮周期收益, 未持有=若节点买入至今)。
    """
    node = core_store.node_at(conn, signal)
    if not node:
        return None, set(), {}
    holdings = (core_store.get_node(conn, node) or {}).get("holdings", [])
    closes = {
        row["code"]: row["close"]
        for row in conn.execute("SELECT code, close FROM etf_daily WHERE date = ?", (node,))
        if row["close"] is not None
    }
    return node, {pick["code"] for pick in holdings}, closes


def build(
    conn: sqlite3.Connection,
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    """单日筛选漏斗 + 全量排名(含被筛掉的标的与原因)。"""
    key = (signal, min_aum)
    hit = _cached(key)
    if hit is not None:
        return hit
    ctx = _load(conn, signal)
    meta = ctx["meta"]
    daily, shares = _slice(ctx, signal)
    bench_map = {bar["date"]: bar["close"] for bar in ctx["bench"]}
    all_rows = features.build_features(signal, meta, daily, shares, bench_map)
    features.attach_macd(all_rows, signal, ctx["provider"])

    equity = [c for c, m in meta.items() if m.get("fund_type") == features.DOMESTIC_EQUITY]
    a_share = [c for c in equity if features.is_a_share(meta[c].get("name"))]
    scope = set(a_share)
    with_bar = [c for c in a_share if ctx["daily_all"].get(c) and ctx["daily_all"][c][-1]["date"] == signal]
    scope_rows = [r for r in all_rows if r["code"] in scope]
    shares_rows = [r for r in scope_rows if r["aum_yi"] is not None]

    candidates = features.select_candidates(all_rows, min_aum)
    cross_section.enrich(candidates, ctx["bench"])
    features.score(candidates)
    core8 = {r["code"]: r for r in core.score_rows(candidates, daily, shares, ctx["provider"], signal)}
    baseline_rows = sorted(candidates, key=lambda r: -r["baseline_score"])
    node, held_codes, node_closes = _node_context(conn, signal)

    counts = {
        "etfs": len(meta),
        "equity": len(equity),
        "a_share": len(a_share),
        "with_bar": len(with_bar),
        "history": len(scope_rows),
        "shares": len(shares_rows),
        "aum": len(candidates),
        "core_pool": len(candidates),
        "core_hold": len(held_codes & {r["code"] for r in candidates}),
    }
    feature_by_code = {r["code"]: r for r in all_rows}
    scored_codes = {r["code"] for r in candidates}
    ranks = {r["code"]: i for i, r in enumerate(baseline_rows, 1)}
    rows: list[dict[str, Any]] = []
    for code, m in meta.items():
        bars = ctx["daily_all"].get(code)
        row = feature_by_code.get(code)
        stage = _stage_key(m, bars, row, code, signal, scored_codes, held_codes)
        rows.append(_row(code, m, bars, row, stage, ranks.get(code), core8.get(code), node_closes.get(code)))
    rows.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, r["code"]))

    data = {
        "payload_version": PAYLOAD_VERSION,
        "signal_date": signal,
        "node_date": node,
        "available": bool(with_bar),
        "reason": None if with_bar else "信号日没有任何指数型-股票 ETF 的收盘 K 线（盘中或尚未回填）",
        "min_aum_yi": min_aum,
        "funnel": [
            {"key": key_, "label": label, "criteria": criteria, "count": counts[key_]}
            for key_, label, criteria in FUNNEL_STAGES
        ],
        "baseline_note": BASELINE_NOTE,
        "core_codes": sorted(held_codes),
        "baseline_codes": [r["code"] for r in baseline_rows[:BASELINE_TOP]],
        "scored": len(candidates),
        "rows": rows,
    }
    return _store(key, data)
```

<a id="file-backend-pages-daily-screen-store-py"></a>

#### `backend/pages/daily/screen/store.py`

```python
"""单日筛选快照落盘: 全量排名一次算 6 秒级、近 4MB, 页面每次打开都重算会把后端拖垮。

快照以「日度记录 generated_at + 所属换仓节点 generated_at + 规模门槛」为有效性键:
任一来源重算后键变化, 下次读取自动重算并覆盖; 行结构升级(PAYLOAD_VERSION)同样视为失效。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS fitted_daily_screen (
    signal_date TEXT PRIMARY KEY,
    day_generated_at TEXT,
    node_generated_at TEXT,
    min_aum_yi REAL,
    generated_at TEXT,
    payload BLOB
);
"""


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def get(conn: sqlite3.Connection, signal: str) -> tuple[str | None, str | None, float | None, bytes] | None:
    row = conn.execute(
        "SELECT day_generated_at, node_generated_at, min_aum_yi, payload "
        "FROM fitted_daily_screen WHERE signal_date = ?",
        (signal,),
    ).fetchone()
    if row is None:
        return None
    return (row["day_generated_at"], row["node_generated_at"], row["min_aum_yi"], row["payload"])


def put(
    conn: sqlite3.Connection,
    signal: str,
    day_generated_at: str | None,
    node_generated_at: str | None,
    min_aum: float,
    payload: bytes,
) -> None:
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_daily_screen "
            "(signal_date, day_generated_at, node_generated_at, min_aum_yi, generated_at, payload) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                signal,
                day_generated_at,
                node_generated_at,
                min_aum,
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                payload,
            ),
        )
```

<a id="file-backend-pages-etf-init-py"></a>

#### `backend/pages/etf/__init__.py`

```python
"""标的清单与详情页: /api/etfs 列表、日/周/月K线、MACD 状态与份额区间。

K线派生指标(周月聚合、MACD、日/周/月状态)在 services/kline, 本页只做读取与组装。
"""
```

<a id="file-backend-pages-etf-router-py"></a>

#### `backend/pages/etf/router.py`

```python
"""清单、K 线与份额查询接口（只读）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from data.fetch import realtime
from data.store import calendar_repo, daily_repo, etf_repo, shares_repo
from services.kline import aggregate
from services.kline import macd as macd_mod
from services.kline import states as state_mod

router = APIRouter(prefix="/api/etfs", tags=["etfs"])

# 周/月K与MACD预热都基于完整日线重采样, 只取最近窗口展示。
MAX_DAILY_ROWS = 6000
MAX_QUOTE_CODES = 100


def _all_bars(code: str) -> list[dict[str, Any]]:
    rows = daily_repo.history(code, MAX_DAILY_ROWS)
    if not rows:
        raise HTTPException(status_code=404, detail=f"{code} 无K线数据")
    return rows


def _period_bars(rows: list[dict[str, Any]], period: str) -> list[dict[str, Any]]:
    return macd_mod.attach(aggregate.resample(rows, period))


@router.get("")
def list_etfs() -> list[dict]:
    """全量清单 + 每只标的 K线/份额覆盖状态。"""
    return etf_repo.list_with_coverage()


def _is_trading_session() -> bool:
    """交易时段判定; 有交易日历时排除法定节假日, 空库退化为纯时钟判断。"""
    if not realtime.is_trading_time():
        return False
    today = datetime.now().strftime("%Y-%m-%d")
    last = calendar_repo.last_trading_day(today)
    return last is None or last == today


@router.get("/quotes")
def etf_quotes(codes: str = Query(default="")) -> dict[str, Any]:
    """批量实时行情(腾讯二级市场现价, 不是 IOPV 参考净值)。"""
    wanted = [code.strip() for code in codes.split(",") if code.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="codes 不能为空")
    if len(wanted) > MAX_QUOTE_CODES:
        raise HTTPException(status_code=400, detail=f"单次最多查询 {MAX_QUOTE_CODES} 只")
    return {
        "as_of": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "is_trading": _is_trading_session(),
        "quotes": realtime.fetch_quotes(wanted),
    }


@router.get("/{code}/history")
def etf_history(code: str, limit: int = Query(default=800, ge=1, le=6000)) -> dict:
    rows = daily_repo.history(code, limit)
    if not rows:
        raise HTTPException(status_code=404, detail=f"{code} 无K线数据")
    return {"code": code, "rows": rows}


def _live_bar(code: str) -> dict[str, Any] | None:
    """用实时行情合成当日未收盘日K; 取不到行情或现价无效返回 None。"""
    quote = realtime.fetch_quotes([code]).get(code)
    if quote is None:
        return None
    stamp = quote.get("time")
    price = quote.get("price")
    if not isinstance(stamp, str) or len(stamp) < 10 or not isinstance(price, float) or price <= 0:
        return None

    def _num(key: str, fallback: float) -> float:
        value = quote.get(key)
        return value if isinstance(value, float) and value > 0 else fallback

    return {
        "date": stamp[:10],
        "open": _num("open", price),
        "close": price,
        "high": _num("high", price),
        "low": _num("low", price),
        "volume": _num("volume", 0.0),
    }


def _with_live_bar(code: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """追加当日实时K线(库里已有当日K线或行情不可用时原样返回)。"""
    bar = _live_bar(code)
    if bar is None or (rows and str(rows[-1]["date"]) >= bar["date"]):
        return rows
    return [*rows, bar]


@router.get("/{code}/kline")
def etf_kline(
    code: str,
    period: str = Query(default="day"),
    limit: int = Query(default=750, ge=1, le=6000),
    live: bool = Query(default=False),
    end: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),  # noqa: UP045 — py3.9 运行时无法解析 `X | None`
) -> dict:
    """指定周期K线 + MACD; MACD 在全历史上计算后再截取展示窗口, 避免窗口起点失真。

    end 给定时只保留该日及之前的行(含 MACD 预热), 供节点展开查看历史节点附近的走势。
    """
    if period not in aggregate.PERIODS:
        raise HTTPException(status_code=400, detail=f"period 仅支持 {aggregate.PERIODS}")
    rows = _all_bars(code)
    if end and end < rows[-1]["date"]:
        live = False
    if live and period == "day":
        rows = _with_live_bar(code, rows)
    if end:
        rows = [r for r in rows if r["date"] <= end]
    bars = _period_bars(rows, period)
    return {
        "code": code,
        "period": period,
        "bars": bars[-limit:],
        "state": state_mod.latest(bars, period),
    }


@router.get("/{code}/macd-states")
def etf_macd_states(code: str) -> dict:
    """当日/当周/当月的 MACD 收敛扩散与水上水下状态(周线跳过未确认的当周)。"""
    rows = _all_bars(code)
    states = {period: state_mod.latest(_period_bars(rows, period), period) for period in aggregate.PERIODS}
    return {"code": code, "states": states}


@router.get("/{code}/shares")
def etf_shares(code: str, limit: int = Query(default=2000, ge=1, le=5000)) -> dict:
    rows = shares_repo.history(code, limit)
    if not rows:
        raise HTTPException(status_code=404, detail=f"{code} 无份额数据")
    return {"code": code, "rows": rows}
```

<a id="file-backend-pages-jobs-init-py"></a>

#### `backend/pages/jobs/__init__.py`

```python
"""数据任务页: 回填任务触发/调度状态/一键准备(/api/data) + 数据就绪度(/api/dataset)。

任务的真正执行在 ops/(后台编排), 本页只提供 HTTP 入口与只读审计。
"""
```

<a id="file-backend-pages-jobs-readiness-py"></a>

#### `backend/pages/jobs/readiness.py`

```python
"""回测数据就绪度：缺口、异常值、份额/指数覆盖与周度网格规模, 并提供 /api/dataset 只读接口。

口径说明:
- 缺口 = 标的[首根,末根]区间内的交易日槽位数 - 实际行数; 停牌也会计入,
  所以"缺口"是待解释项而不是错误项;
- 异常值只做可疑标记: 零/负价格、零成交量、单日涨跌超 30%(疑似除权或坏数据);
- 不做幸存者偏差修复: 已退市标的整体不在库内, 审计只能如实报告在册规模。
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from typing import Any

from fastapi import APIRouter

from data.config import BACKFILL_START_DATE, INDEX_CODES
from data.store import daily_repo, index_repo, shares_repo
from data.store.database import get_conn

_JUMP_THRESHOLD = 0.3  # 单日 |涨跌| 超 30% 基本不是正常 ETF 波动(涨停板最宽 20%)
_TOP_GAPS = 5
_JUMP_SQL = f"""
    SELECT COUNT(*) AS n FROM (
        SELECT close, LAG(close) OVER (PARTITION BY code ORDER BY date) AS prev FROM etf_daily {{where}}
    ) WHERE prev > 0 AND close > 0 AND ABS(close / prev - 1) > {_JUMP_THRESHOLD}
"""


def dataset_summary() -> dict[str, Any]:
    calendar = [r["date"] for r in get_conn().execute("SELECT date FROM trade_calendar ORDER BY date")]
    spans = daily_repo.stats_per_code()
    gaps = _gaps(calendar, spans)
    return {
        "calendar": {
            "days": len(calendar),
            "first": calendar[0] if calendar else None,
            "last": calendar[-1] if calendar else None,
        },
        "daily": _daily_stats(spans),
        "shares": _shares_stats(),
        "share_scale": _share_scale_stats(),
        "index": _index_stats(),
        "gaps": gaps,
        "anomalies": _anomalies(),
        "list_date_missing": (
            get_conn().execute("SELECT COUNT(*) AS n FROM etfs WHERE list_date IS NULL").fetchone()["n"]
        ),
    }


def _daily_stats(spans: dict[str, tuple[str, str, int]]) -> dict[str, Any]:
    firsts = [s[0] for s in spans.values()]
    lasts = [s[1] for s in spans.values()]
    no_data = (
        get_conn()
        .execute("SELECT COUNT(*) AS n FROM etfs e WHERE NOT EXISTS (SELECT 1 FROM etf_daily d WHERE d.code = e.code)")
        .fetchone()["n"]
    )
    return {
        "codes": len(spans),
        "rows": sum(s[2] for s in spans.values()),
        "first": min(firsts) if firsts else None,
        "last": max(lasts) if lasts else None,
        "no_data": no_data,
    }


def _shares_stats() -> dict[str, Any]:
    row = (
        get_conn()
        .execute("SELECT COUNT(DISTINCT code) AS codes, COUNT(*) AS n, MIN(date) AS f, MAX(date) AS l FROM etf_shares")
        .fetchone()
    )
    return {"codes": row["codes"], "rows": row["n"], "first": row["f"], "last": row["l"]}


def _share_scale_stats() -> dict[str, Any]:
    """份额跳变甄别覆盖度: 折算(split)/真实申赎(flow)/待甄别(未入库)。"""
    jumps = shares_repo.jump_candidates()
    methods = {(e["code"], e["date"]): e["method"] for e in shares_repo.scale_events()}
    splits = [j for j in jumps if methods.get((j["code"], j["date"])) == "split"]
    flows = sum(1 for j in jumps if methods.get((j["code"], j["date"])) == "flow")
    return {
        "threshold": shares_repo.JUMP_SCAN_RATIO,
        "jumps": len(jumps),
        "split": len(splits),
        "flow": flows,
        "unverified": len(jumps) - len(splits) - flows,
        "recent_split": [
            {"code": j["code"], "date": j["date"], "ratio": round(j["ratio"], 3)}
            for j in sorted(splits, key=lambda x: x["date"])[-5:]
        ],
    }


def _index_stats() -> dict[str, Any]:
    row = (
        get_conn()
        .execute("SELECT COUNT(DISTINCT code) AS codes, COUNT(*) AS n, MAX(date) AS l FROM index_daily")
        .fetchone()
    )
    return {"configured": len(INDEX_CODES), "codes": row["codes"], "rows": row["n"], "last": row["l"]}


def _gaps(calendar: list[str], spans: dict[str, tuple[str, str, int]]) -> dict[str, Any]:
    """逐标的核对区间内交易日槽位; 返回汇总与缺口最大的几只用例。"""
    total = 0
    affected = 0
    detail: list[dict[str, Any]] = []
    for code, (first, last, rows) in spans.items():
        slots = bisect_right(calendar, last) - bisect_left(calendar, first)
        missing = max(0, slots - rows)
        if missing:
            affected += 1
            total += missing
            detail.append({"code": code, "missing": missing, "first": first, "last": last})
    detail.sort(key=lambda x: -x["missing"])
    return {"codes": affected, "days": total, "top": detail[:_TOP_GAPS]}


def _anomalies() -> dict[str, Any]:
    """全历史与份额起点后的可疑行数。

    2015 前的负价/巨幅跳变集中在 510050/510880, 是腾讯前复权因子失效导致的假价格;
    回测窗口以份额起点(BACKFILL_START_DATE)为界即可规避, 更早历史需改缓存后复权。
    """
    conn = get_conn()
    since = BACKFILL_START_DATE

    def scalar(sql: str, params: tuple[str, ...] = ()) -> int:
        return int(conn.execute(sql, params).fetchone()["n"])

    result: dict[str, Any] = {"since": since}
    for key, cond in (
        ("zero_volume", "volume IS NULL OR volume <= 0"),
        ("bad_close", "close IS NULL OR close <= 0"),
    ):
        result[key] = scalar(f"SELECT COUNT(*) AS n FROM etf_daily WHERE ({cond}) AND date >= ?", (since,))
        result[f"{key}_all"] = scalar(f"SELECT COUNT(*) AS n FROM etf_daily WHERE {cond}")
    result["jump_gt_30pct"] = scalar(_JUMP_SQL.format(where="WHERE date >= ?"), (since,))
    result["jump_gt_30pct_all"] = scalar(_JUMP_SQL.format(where=""))
    return result


def index_coverage() -> list[dict[str, Any]]:
    """配置内的全部指数覆盖(未入库的也列出), 供页面核对。"""
    stats = index_repo.stats_per_code()
    names = {r["code"]: r["name"] for r in get_conn().execute("SELECT code, name FROM indices")}
    return [
        {
            "code": code,
            "name": names.get(code),
            "first": stats.get(code, (None, None, 0))[0],
            "last": stats.get(code, (None, None, 0))[1],
            "rows": stats.get(code, (None, None, 0))[2],
        }
        for code in INDEX_CODES
    ]


router = APIRouter(prefix="/api/dataset", tags=["dataset"])


@router.get("/summary")
def summary() -> dict[str, Any]:
    return dataset_summary()


@router.get("/indices")
def indices() -> list[dict[str, Any]]:
    return index_coverage()
```

<a id="file-backend-pages-jobs-router-py"></a>

#### `backend/pages/jobs/router.py`

```python
"""Jobs 页的 /api/data 出口：后台线程执行回填, 同一任务同时只跑一个实例。

除单个任务外, 提供「一键准备」: 空库按依赖顺序跑通日度复盘所需全部数据。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ops import bootstrap, jobs, scheduler
from ops.background import ProgressFn, TaskBusy, TaskRunner, WorkFn

router = APIRouter(prefix="/api/data", tags=["data"])

_TASKS = TaskRunner()


class JobRequest(BaseModel):
    job: str
    start_date: Optional[str] = None  # noqa: UP045 — pydantic v2 + py3.9 无法在运行时解析 `X | None`
    end_date: Optional[str] = None  # noqa: UP045


def _work(name: str) -> WorkFn:
    def run(progress: ProgressFn) -> dict:
        return jobs.run_job(name, on_progress=progress)

    return run


@router.post("/jobs")
def start_job(req: JobRequest) -> dict:
    if req.job not in jobs.JOB_FNS:
        raise HTTPException(status_code=400, detail=f"未知任务 {req.job}, 可选: {sorted(jobs.JOB_FNS)}")
    if bootstrap.status()["state"] == "running":
        raise HTTPException(status_code=409, detail="一键准备正在运行, 请等待完成后再单独执行任务")
    try:
        _TASKS.start(req.job, _work(req.job))
    except TaskBusy as error:
        raise HTTPException(status_code=409, detail=f"{req.job} 正在运行") from error
    return {"job": req.job, "state": "running"}


@router.get("/jobs")
def list_jobs() -> dict[str, dict[str, Any]]:
    return _TASKS.statuses()


@router.get("/scheduler")
def scheduler_status() -> dict[str, Any]:
    """收盘自动刷新链的状态: 当前阶段、今晚完成的槽位与下次执行时间。"""
    return scheduler.status()


@router.post("/bootstrap")
def start_bootstrap() -> dict[str, Any]:
    """一键准备: 空库也能从零拉齐日度复盘所需数据(幂等, 重复执行只补缺口)。"""
    busy = _TASKS.running_keys()
    if busy:
        raise HTTPException(status_code=409, detail=f"任务 {busy[0]} 正在运行, 请等待完成后再一键准备")
    return bootstrap.start()


@router.get("/bootstrap")
def bootstrap_status() -> dict[str, Any]:
    """一键准备进度: 各阶段状态/进度与整体百分比。"""
    return bootstrap.status()
```

### 14.8 后端 · 脚本与快照清单

<a id="file-backend-scripts-build-seed-py"></a>

#### `backend/scripts/build_seed.py`

```python
"""从本地已有数据库导出预热快照(gzip CSV + manifest)到 backend/seed/。

用法:
    python scripts/build_seed.py [--src ~/.dailyscope/dailyscope.db] [--out seed]

快照含原始数据表(清单/日历/日K/份额/折算/指数)与 fitted_* 派生表(core8 节点 +
日度记录), 派生表按 signal_date 截到日K截止日; 导出后随仓库分发, 新环境一键准备
时先装载再补齐增量。
"""

# ruff: noqa: E402

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ops import seed


def main() -> None:
    parser = argparse.ArgumentParser(description="导出 DailyScope 预热快照")
    parser.add_argument("--src", default=str(Path.home() / ".dailyscope" / "dailyscope.db"))
    parser.add_argument("--out", default=str(seed.SEED_DIR))
    args = parser.parse_args()
    info = seed.build(args.src, Path(args.out))
    rows = sum(t["rows"] for t in info["tables"].values())
    print(f"cutoff={info['cutoff']} tables={len(info['tables'])} rows={rows} -> {args.out}")


if __name__ == "__main__":
    main()
```

<a id="file-backend-seed-manifest-json"></a>

#### `backend/seed/manifest.json`

```json
{
  "generated_at": "2026-11-20 00:48:17",
  "cutoff": "2026-11-19",
  "derived_cutoff": "2026-11-19",
  "tables": {
    "etfs": {
      "rows": 1879,
      "columns": [
        "code",
        "name",
        "fund_type",
        "list_date",
        "track_index",
        "updated_at"
      ],
      "file": "etfs.csv.gz"
    },
    "trade_calendar": {
      "rows": 8797,
      "columns": [
        "date"
      ],
      "file": "trade_calendar.csv.gz"
    },
    "etf_daily": {
      "rows": 1544685,
      "columns": [
        "date",
        "code",
        "open",
        "close",
        "high",
        "low",
        "volume"
      ],
      "file": "etf_daily.csv.gz"
    },
    "etf_shares": {
      "rows": 1513204,
      "columns": [
        "date",
        "code",
        "shares_yi"
      ],
      "file": "etf_shares.csv.gz"
    },
    "etf_share_scale": {
      "rows": 4103,
      "columns": [
        "code",
        "date",
        "ratio",
        "method",
        "detected_at"
      ],
      "file": "etf_share_scale.csv.gz"
    },
    "indices": {
      "rows": 11,
      "columns": [
        "code",
        "name",
        "updated_at"
      ],
      "file": "indices.csv.gz"
    },
    "index_daily": {
      "rows": 54651,
      "columns": [
        "date",
        "code",
        "open",
        "close",
        "high",
        "low",
        "volume",
        "amount_yi",
        "cons_number",
        "pe"
      ],
      "file": "index_daily.csv.gz"
    },
    "fitted_core_summary": {
      "rows": 578,
      "columns": [
        "signal_date",
        "next_rebalance",
        "generated_at",
        "rule_version",
        "scored",
        "min_aum_yi",
        "complete"
      ],
      "file": "fitted_core_summary.csv.gz"
    },
    "fitted_core_pick": {
      "rows": 11873,
      "columns": [
        "signal_date",
        "code",
        "name",
        "core_rank",
        "core_score",
        "held",
        "action",
        "factors_json",
        "pre_rank"
      ],
      "file": "fitted_core_pick.csv.gz"
    },
    "fitted_daily_summary": {
      "rows": 2886,
      "columns": [
        "signal_date",
        "next_signal",
        "generated_at",
        "rule_version",
        "codes_with_bar",
        "codes_with_enough_history",
        "scored",
        "min_aum_yi",
        "shares_available",
        "universe_mean",
        "universe_median",
        "universe_hit",
        "baseline_mean",
        "baseline_median",
        "baseline_hit",
        "core_mean",
        "core_median",
        "core_hit",
        "rank_ic",
        "eval_json",
        "index_returns_json"
      ],
      "file": "fitted_daily_summary.csv.gz"
    },
    "fitted_daily_pick": {
      "rows": 43215,
      "columns": [
        "signal_date",
        "bucket",
        "pick_rank",
        "code",
        "name",
        "theme",
        "fund_type",
        "baseline_score",
        "reason_text",
        "reason_json",
        "next_return"
      ],
      "file": "fitted_daily_pick.csv.gz"
    }
  }
}
```

### 14.9 后端 · 测试 backend/tests/

<a id="file-backend-tests-init-py"></a>

#### `backend/tests/__init__.py`

```python
# 空文件：声明 tests 为包
```

<a id="file-backend-tests-conftest-py"></a>

#### `backend/tests/conftest.py`

```python
"""测试隔离：导入任何 data 模块之前把数据目录指向临时目录；每个测试前清空全部表。"""

from __future__ import annotations

import os
import tempfile

import pytest

os.environ["DAILYSCOPE_HOME"] = tempfile.mkdtemp(prefix="dailyscope-test-")

_TABLES = (
    "etfs",
    "etf_daily",
    "etf_shares",
    "etf_share_scale",
    "trade_calendar",
    "indices",
    "index_daily",
    "fitted_daily_summary",
    "fitted_daily_pick",
    "fitted_daily_screen",
    "fitted_core_summary",
    "fitted_core_pick",
)


@pytest.fixture(autouse=True)
def _fresh_db() -> None:
    from data.store.database import get_conn
    from pages.daily.review.store import ensure_schema as ensure_daily_schema
    from pages.daily.screen.store import ensure_schema as ensure_screen_schema
    from services.scoring.core.store import ensure_schema as ensure_core_schema

    conn = get_conn()
    ensure_daily_schema(conn)
    ensure_core_schema(conn)
    ensure_screen_schema(conn)
    with conn:
        for table in _TABLES:
            conn.execute(f"DELETE FROM {table}")
```

<a id="file-backend-tests-daily-seed-py"></a>

#### `backend/tests/daily_seed.py`

```python
"""日频记录测试的共享种子: 交易日、两只分化 ETF、沪深300 指数与逐日份额。

抽成模块是因为 build_day 的单日测试也要同一份行情/份额口径; 只是测试夹具, 不是被测代码。
现价/开盘按"平开"构造(open = 前一交易日收盘), 新买入与顺延卖出因此可以手算期望。
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from pages.daily.review import build
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import store as core_store


def weekdays(n: int) -> list[str]:
    days: list[str] = []
    cur = date(2024, 1, 1)
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def seed(conn: sqlite3.Connection) -> list[str]:
    """80 个交易日: 两只 A 股 ETF(一涨一跌) + 沪深300 指数逐日 0.1% 上行。"""
    days = weekdays(80)
    with conn:
        conn.executemany(
            "INSERT INTO etfs (code, name, fund_type) VALUES (?, ?, ?)",
            [
                ("510300", "沪深300ETF测试", features.DOMESTIC_EQUITY),
                ("510500", "中证500ETF测试", features.DOMESTIC_EQUITY),
            ],
        )
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
        for i, day in enumerate(days):
            prev_300 = 100 * (1.003 ** (i - 1)) if i else 100
            prev_500 = 100 * (0.998 ** (i - 1)) if i else 100
            conn.execute(
                "INSERT INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
                (day, "510300", prev_300, 100 * (1.003**i), 1_000_000),
            )
            conn.execute(
                "INSERT INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
                (day, "510500", prev_500, 100 * (0.998**i), 1_000_000),
            )
            conn.execute(
                "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                (day, "510300", 10 + i * 0.02),
            )
            conn.execute(
                "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                (day, "510500", 10.0),
            )
            conn.execute(
                "INSERT INTO index_daily (date, code, close) VALUES (?, ?, ?)",
                (day, "000300", 100 * (1.001**i)),
            )
    return days


def seed_core(conn: sqlite3.Connection, node: str, held: tuple[str, ...] = ("510300",)) -> None:
    """换仓节点: 510300 持有, 510500 仅进评分榜; 日度记录只延续 held=1 的仓位。"""
    core_store.ensure_schema(conn)
    picks = [
        {
            "code": "510300",
            "name": "沪深300ETF测试",
            "core_rank": 1,
            "core_score": 0.8,
            "held": "510300" in held,
            "action": "hold",
            "pre_rank": 1,
        },
        {
            "code": "510500",
            "name": "中证500ETF测试",
            "core_rank": 2,
            "core_score": 0.1,
            "held": "510500" in held,
            "action": "rank",
            "pre_rank": 2,
        },
    ]
    core_store.replace_node(
        conn,
        {
            "signal_date": node,
            "next_rebalance": None,
            "generated_at": "2024-01-01 00:00:00",
            "rule_version": "core8-v1",
            "scored": 2,
            "min_aum_yi": features.DEFAULT_MIN_AUM_YI,
        },
        picks,
    )


def rebuild_last3(conn: sqlite3.Connection, days: list[str]) -> dict[str, Any]:
    seed_core(conn, days[-3])
    return build.rebuild(conn, start_date=days[-3], end_date=days[-1])


def build_day(
    conn: sqlite3.Connection,
    days: list[str],
    signal: str,
    next_signal: str | None,
    held: list[dict[str, Any]],
    plan: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """按整段窗口加载一次, 对单个信号日跑 build_day(与 rebuild 同口径的懒加载切片)。"""
    meta = features.load_meta(conn)
    daily = features.load_daily(conn, days[0], days[-1])
    daily_dates = {code: [b["date"] for b in bars] for code, bars in daily.items()}
    shares = features.load_shares(conn, days[0], days[-1])
    shares_dates = {code: [b["date"] for b in bars] for code, bars in shares.items()}
    bench = features.load_index(conn, days[0], days[-1]).get("000300", [])
    provider = macd_states.MacdStateProvider.from_bars(daily)
    return build.build_day(
        conn,
        signal,
        next_signal,
        meta,
        daily,
        daily_dates,
        shares,
        shares_dates,
        bench,
        [b["date"] for b in bench],
        provider,
        len(daily),
        features.DEFAULT_MIN_AUM_YI,
        held,
        plan,
    )
```

<a id="file-backend-tests-test-background-py"></a>

#### `backend/tests/test_background.py`

```python
"""后台任务执行器: 状态流转、同 key 互斥与失败落状态。"""

from __future__ import annotations

import threading

import pytest

from ops.background import ProgressFn, TaskBusy, TaskRunner


def _wait_state(runner: TaskRunner, key: str, state: str) -> dict:
    """等后台线程把状态写到位(任务本身很短, 轮询几十毫秒即可)。"""
    for _ in range(200):
        status = runner.status(key)
        if status["state"] == state:
            return status
        threading.Event().wait(0.01)
    raise AssertionError(f"{key} 未进入 {state}, 当前 {runner.status(key)}")


def test_start_runs_work_and_records_result() -> None:
    runner = TaskRunner()
    finished = threading.Event()

    def work(progress: ProgressFn) -> dict:
        progress(1, 2, "半程")
        return {"days": 3}

    runner.start("records", work, on_finished=finished.set)

    status = _wait_state(runner, "records", "done")
    assert status["result"] == {"days": 3}
    assert finished.wait(1)
    assert runner.is_running("records") is False
    assert runner.status("records")["state"] == "done"


def test_same_key_cannot_run_twice() -> None:
    runner = TaskRunner()
    gate = threading.Event()
    runner.start("records", lambda progress: gate.wait(1) and {"ok": True})

    with pytest.raises(TaskBusy):
        runner.start("records", lambda progress: {"ok": True})

    gate.set()
    assert _wait_state(runner, "records", "done")["result"] == {"ok": True}


def test_failure_is_captured_in_status() -> None:
    runner = TaskRunner()

    def boom(progress: ProgressFn) -> dict:
        raise RuntimeError("数据库被锁")

    runner.start("core", boom)

    status = _wait_state(runner, "core", "failed")
    assert status["error"] == "数据库被锁"
    assert runner.status("unknown") == {"state": "idle"}
```

<a id="file-backend-tests-test-bootstrap-py"></a>

#### `backend/tests/test_bootstrap.py`

```python
"""一键数据准备: 阶段顺序、失败中断与空库刷新链守卫。"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import pytest

from data.store import daily_repo
from data.store.database import get_conn
from ops import bootstrap, refresh_chain


def _noop(stage: str | None, detail: str | None = None) -> None:
    return None


def _progress(done: int, total: int, msg: str) -> None:
    return None


def _seed_days(days: list[str], bars: list[str]) -> None:
    """写交易日历与有行情的日子(节点网格按日历每 5 天一个)。"""
    conn = get_conn()
    conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
    conn.executemany(
        "INSERT INTO etf_daily (date, code, close) VALUES (?, '510300', 1.0)",
        [(d,) for d in bars],
    )
    conn.commit()


def _wait(timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = bootstrap.status()
        if state["state"] != "running":
            return state
        time.sleep(0.01)
    raise AssertionError("一键准备未在超时内结束")


def _stub(monkeypatch: pytest.MonkeyPatch, calls: list[str], gate: threading.Event | None = None) -> None:
    def make(key: str) -> Callable[[object], str]:
        def run(_: object) -> str:
            if gate is not None:
                gate.wait(2)
            calls.append(key)
            return f"{key} 完成"

        return run

    monkeypatch.setattr(bootstrap, "STAGE_FNS", {key: make(key) for key in bootstrap.STAGE_LABELS})


def test_bootstrap_runs_stages_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _stub(monkeypatch, calls)
    bootstrap.start()
    state = _wait()
    assert state["state"] == "done"
    assert calls == list(bootstrap.STAGE_LABELS)
    assert state["percent"] == 100
    assert all(s["state"] == "done" for s in state["stages"])
    assert state["stages"][-1]["detail"] == "records 完成"


def test_bootstrap_stops_at_failed_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_: object) -> str:
        raise RuntimeError("腾讯接口超时")

    stub = {key: boom if key == "daily" else (lambda _: "ok") for key in bootstrap.STAGE_LABELS}
    monkeypatch.setattr(bootstrap, "STAGE_FNS", stub)
    bootstrap.start()
    state = _wait()
    assert state["state"] == "failed"
    assert state["error"] == "腾讯接口超时"
    stages = {s["key"]: s for s in state["stages"]}
    assert stages["etf_list"]["state"] == "done"
    assert stages["daily"]["state"] == "failed"
    assert stages["records"]["state"] == "pending"


def test_bootstrap_keeps_running_instance(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    gate = threading.Event()
    _stub(monkeypatch, calls, gate)
    first = bootstrap.start()
    second = bootstrap.start()  # 第一趟还在跑, 第二次只返回状态
    gate.set()
    assert first["state"] == second["state"] == "running"
    _wait()
    assert calls == list(bootstrap.STAGE_LABELS)


def test_refresh_chain_skips_empty_universe(monkeypatch: pytest.MonkeyPatch) -> None:
    daily_repo.upsert_rows("510300", [{"date": "2026-11-18", "close": 1.0}])

    def fake_calendar() -> dict:
        return {"days": 1}

    def fake_days(conn: object) -> list[str]:
        return ["2026-11-18"]

    monkeypatch.setattr(refresh_chain.raw_jobs, "refresh_calendar", fake_calendar)
    monkeypatch.setattr(refresh_chain.features, "trading_days", fake_days)
    result = refresh_chain.shares_chain(_noop)
    assert "ETF 清单为空" in result["skipped"]


def _store_node(signal: str) -> None:
    conn = get_conn()
    conn.execute("INSERT INTO fitted_core_summary (signal_date) VALUES (?)", (signal,))
    conn.commit()


def test_core_stage_skips_when_snapshot_holds_last_node() -> None:
    days = [f"2015-01-{d:02d}" for d in (5, 6, 7, 8, 9, 12, 13)]
    _seed_days(days, days[:6])  # 最后行情 2015-01-12, 恰好是第二个网格节点
    _store_node("2015-01-12")
    assert bootstrap._core(_progress) == "换仓节点已最新"


def test_core_stage_resumes_after_stored_node(monkeypatch: pytest.MonkeyPatch) -> None:
    days = [f"2015-01-{d:02d}" for d in range(5, 17)]
    _seed_days(days, days)
    _store_node("2015-01-10")
    calls: dict[str, str | None] = {}

    def fake_rebuild(conn: object, start: str | None = None, end: str | None = None, **_: object) -> dict:
        calls.update(start=start, end=end)
        return {"written": 1, "start": start, "end": end}

    monkeypatch.setattr(bootstrap.core_backfill, "rebuild", fake_rebuild)
    detail = bootstrap._core(_progress)
    assert calls == {"start": "2015-01-11", "end": "2015-01-16"}
    assert detail == "1 个换仓节点(2015-01-11 ~ 2015-01-16)"


def test_records_stage_starts_before_first_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    days = [f"2015-01-{d:02d}" for d in range(5, 10)]
    _seed_days(days, days)
    conn = get_conn()
    conn.executemany(
        "INSERT INTO fitted_daily_summary (signal_date) VALUES (?)",
        [(d,) for d in days[:4]],
    )
    conn.commit()
    calls: dict[str, str | None] = {}

    def fake_rebuild(conn: object, start_date: str | None = None, end_date: str | None = None, **_: object) -> dict:
        calls.update(start=start_date, end=end_date)
        return {"days": 2}

    monkeypatch.setattr(bootstrap.build, "rebuild", fake_rebuild)
    detail = bootstrap._records(_progress)
    assert calls == {"start": "2015-01-08", "end": "2015-01-09"}
    assert detail == "2 个交易日(2015-01-08 ~ 2015-01-09)"
```

<a id="file-backend-tests-test-daily-build-day-py"></a>

#### `backend/tests/test_daily_build_day.py`

```python
"""build_day 的单日结算: 盘中缺份额仍能评分、节点日按混合执行价结算。"""

from __future__ import annotations

import pytest

from data.store.database import get_conn
from pages.daily.review import build
from services.kline import states as macd_states
from services.scoring import features
from tests.daily_seed import build_day, seed


def test_build_day_scores_without_same_day_shares() -> None:
    """盘中预选场景: 已合成今日价格 bar, 但份额只到昨日, 评分不能被份额切片拖成空池。"""
    conn = get_conn()
    days = seed(conn)
    today = "2024-04-30"  # 不在种子日历内, 模拟盘中新增交易日

    meta = features.load_meta(conn)
    raw = features.load_daily(conn, days[0], days[-1])
    today_bar = {"date": today, "close": 0.0, "volume": 1_000_000}
    daily = {code: [*bars, {**today_bar, "close": bars[-1]["close"] * 1.003}] for code, bars in raw.items()}
    daily_dates = {code: [b["date"] for b in bars] for code, bars in daily.items()}
    shares = features.load_shares(conn, days[0], days[-1])  # 今日份额未发布
    shares_dates = {code: [b["date"] for b in bars] for code, bars in shares.items()}
    bench = features.load_index(conn, days[0], days[-1]).get("000300", [])
    provider = macd_states.MacdStateProvider.from_bars(daily)
    held = [{"code": "510300", "core_rank": 1, "core_score": 0.8, "held": 1, "action": "hold"}]

    summary, picks = build.build_day(
        conn,
        today,
        None,
        meta,
        daily,
        daily_dates,
        shares,
        shares_dates,
        bench,
        [b["date"] for b in bench],
        provider,
        len(daily),
        features.DEFAULT_MIN_AUM_YI,
        held,
    )

    assert summary["scored"] == 2
    assert summary["shares_available"] == 2
    assert [p["code"] for p in picks if p["bucket"] == "core"] == ["510300"]  # 节点持仓桶
    assert summary["evaluation"].get("skipped")


def test_build_day_node_settles_with_hybrid_plan() -> None:
    """节点日: 持有段收盘→收盘, 新买入开盘→收盘, 顺延卖出收盘→次日开盘, 空槽记 0。"""
    conn = get_conn()
    days = seed(conn)
    held = [
        {"code": "510300", "name": "沪深300ETF测试", "core_rank": 1, "core_score": 0.8, "held": 1, "action": "hold"}
    ]
    signal, next_signal = days[-3], days[-2]

    buy_plan = {"keep": ["510300"], "buy": ["510500"], "sell_open": [], "sell_close": []}
    summary, picks = build_day(conn, days, signal, next_signal, held, buy_plan)

    assert summary["evaluation"]["core_holdings"]["mean"] == pytest.approx((0.003 - 0.002) / 2, abs=1e-6)
    assert {p["code"]: p["next_return"] for p in picks if p["bucket"] == "core"} == {"510300": pytest.approx(0.003)}

    defer_plan = {"keep": ["510300"], "buy": [], "sell_open": ["510500"], "sell_close": []}
    summary, _ = build_day(conn, days, signal, next_signal, held, defer_plan)

    assert summary["evaluation"]["core_holdings"]["mean"] == pytest.approx(0.003 / 2, abs=1e-6)
```

<a id="file-backend-tests-test-daily-core-py"></a>

#### `backend/tests/test_daily_core.py`

```python
"""core8 日频核心分: 秩变换、排名缓冲带换仓、五日锚点、MACD 柱体形状。"""

from __future__ import annotations

import math
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from services.scoring.core import rebalance
from services.scoring.core import score as core

# ---------------------------------------------------------------- rank_z


def test_rank_z_monotonic_bounds_and_ties() -> None:
    z = core.rank_z([float(i) for i in range(20)])
    assert z == sorted(z)
    assert z[0] == pytest.approx(-19 / 21)
    assert z[-1] == pytest.approx(19 / 21)
    assert z == sorted(set(z))  # 无并列时每个值各不相同

    tied = core.rank_z([1.0] * 10 + [2.0] * 10)
    assert tied[0] == tied[9] == pytest.approx(-10 / 21)
    assert tied[10] == tied[19] == pytest.approx(10 / 21)


def test_rank_z_missing_and_small_sample_neutral() -> None:
    assert core.rank_z([1.0, 2.0, 3.0]) == [0.0, 0.0, 0.0]

    z = core.rank_z([float(i) for i in range(19)] + [math.nan])
    assert z == [0.0] * 20, "有效样本不足 20 个时整列中性"

    mixed = core.rank_z([float(i) for i in range(20)] + [math.nan, math.inf])
    assert mixed[20] == 0.0
    assert mixed[21] == 0.0
    assert mixed[0] != 0.0


# ---------------------------------------------------------------- rebalance


def _ranked(n: int = 20) -> list[str]:
    return [f"C{i:02d}" for i in range(n)]


def test_rebalance_keeps_within_buffer_and_fills_gaps() -> None:
    ranked = _ranked()
    target = rebalance.rebalance(["C04", "C19"], ranked)
    assert target == ["C04", "C00", "C01", "C02", "C03"], "第 5 名留仓, 掉出前 15 的换掉并按排名补齐"
    assert len(target) == core.HOLD_TOP


def test_rebalance_buffer_boundary_and_unknown_names() -> None:
    ranked = _ranked()
    kept = rebalance.rebalance(["C14"], ranked)
    assert kept[0] == "C14", "排名 15 以内(0-based 14)继续持有"

    dropped = rebalance.rebalance(["C15"], ranked)
    assert "C15" not in dropped, "排名 16 起卖出"

    unknown = rebalance.rebalance(["NOT_IN_UNIVERSE"], ranked)
    assert unknown == ranked[: core.HOLD_TOP]


def test_rebalance_full_hold_is_stable() -> None:
    ranked = _ranked()
    assert rebalance.rebalance(ranked[:5], ranked) == ranked[:5]


# ---------------------------------------------------------------- 换仓锚点


def _calendar(n: int = 20) -> list[str]:
    start = date(2022, 1, 4)
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


def test_should_rebalance_aligned_to_anchor() -> None:
    calendar = _calendar()
    anchor = calendar[3]
    assert rebalance.should_rebalance(calendar, calendar[3], anchor)
    assert rebalance.should_rebalance(calendar, calendar[8], anchor)
    assert rebalance.should_rebalance(calendar, calendar[13], anchor)
    assert not rebalance.should_rebalance(calendar, calendar[9], anchor)
    assert rebalance.should_rebalance(calendar, calendar[9], anchor, step=1)


def test_next_rebalance_steps_to_next_node() -> None:
    calendar = _calendar()
    anchor = calendar[3]
    assert rebalance.next_rebalance(calendar, calendar[3], anchor) == calendar[8]
    assert rebalance.next_rebalance(calendar, calendar[6], anchor) == calendar[8]
    assert rebalance.next_rebalance(calendar, calendar[18], anchor) is None, "超出日历尾部返回 None"


# ---------------------------------------------------------------- MACD 柱体形状


def _macd_inputs(n: int = 70, cross_at: int | None = None) -> tuple[Any, list[dict[str, Any]], str]:
    """构造 n 根等距 K 线; cross_at 为全序列下标, 该日起 dif 上穿 dea(此前在水下)。"""
    start = date(2024, 1, 1)
    days = [(start + timedelta(days=i)).isoformat() for i in range(n)]
    labels = [int(d.replace("-", "")) for d in days]
    dif: list[float] = []
    dea: list[float] = []
    for i in range(n):
        above = True if cross_at is None else i >= cross_at
        dif.append(0.3 if above else -0.3)
        dea.append(0.0)
    hist = [0.02] * n
    bars = [{"date": d, "close": 10.0, "volume": 1.0} for d in days]
    return SimpleNamespace(labels=labels, dif=dif, dea=dea, hist=hist), bars, days[-1]


def test_macd_shape_hist_norm_and_cross_age() -> None:
    window_pos = 57  # 观察窗第 58 根上穿 -> 距今 2 个交易日
    series, bars, signal = _macd_inputs(cross_at=70 - core.MACD_BARS + window_pos)
    out: dict[str, float] = {}
    core._macd_shape(out, bars, series, signal, 0.2)
    assert out["hist_norm"] == pytest.approx(0.002 / (0.2 / math.sqrt(252)))
    assert out["zero_cross_age"] == pytest.approx(2.0)


def test_macd_shape_no_cross_reports_full_window() -> None:
    series, bars, signal = _macd_inputs()
    out: dict[str, float] = {}
    core._macd_shape(out, bars, series, signal, 0.2)
    assert out["zero_cross_age"] == pytest.approx(float(core.MACD_BARS))


def test_macd_shape_guards_missing_series_and_history() -> None:
    series, bars, signal = _macd_inputs()
    out: dict[str, float] = {}
    core._macd_shape(out, bars, None, signal, 0.2)
    assert out == {}
    core._macd_shape(out, bars, series, "1999-01-01", 0.2)
    assert out == {}, "MACD 序列未覆盖信号日时不出值"

    short_series, short_bars, short_signal = _macd_inputs(n=core.MACD_BARS)
    out = {}
    core._macd_shape(out, short_bars, short_series, short_signal, 0.2)
    assert out == {}, "不足一个观察窗不参与打分"

    out = {}
    core._macd_shape(out, bars, series, signal, 0.0)
    assert out == {}, "无波动率无法归一"


# ---------------------------------------------------------------- describe


def _row(**kwargs: float) -> dict[str, Any]:
    base = {"dd60": -0.1, "r250": 0.2, "vol20": 0.25, "r20": 0.03, "flow_5d": 0.01}
    base.update(kwargs)
    return base


def _bars(n: int) -> list[dict[str, Any]]:
    start = date(2024, 1, 1)
    return [{"date": (start + timedelta(days=i)).isoformat(), "close": 10.0, "volume": 1_000_000.0} for i in range(n)]


def test_describe_insufficient_bars_is_all_nan() -> None:
    out = core.describe(_row(), _bars(1), [], None, "2024-03-01")
    assert set(out) == set(core.CORE_FEATURES)
    assert all(math.isnan(v) for v in out.values())


def test_describe_z20_and_flow_guards() -> None:
    bars = _bars(61)
    flat_shares = [{"date": b["date"], "shares_yi": 10.0} for b in bars[-21:]]
    out = core.describe(_row(), bars, flat_shares, None, bars[-1]["date"])
    assert out["z20"] == pytest.approx(0.03 / (0.25 / math.sqrt(252) * math.sqrt(20)))
    assert out["dd60"] == pytest.approx(-0.1)
    assert out["r250"] == pytest.approx(0.2)
    assert math.isnan(out["amount_z_60"]), "成交额无波动时不给分, 由 rank_z 转中性"
    assert math.isnan(out["flow_z_60"]), "份额增长率无波动时不给分"
    assert math.isnan(out["hist_norm"]), "无 MACD 序列时不参与"


def test_describe_flow_z_with_varying_shares() -> None:
    bars = _bars(61)
    shares = [{"date": b["date"], "shares_yi": 10.0 + i * 0.1} for i, b in enumerate(bars[-21:])]
    out = core.describe(_row(flow_5d=0.06), bars, shares, None, bars[-1]["date"])
    growths = [shares[i]["shares_yi"] / shares[i - 5]["shares_yi"] - 1 for i in range(5, len(shares))]
    expected = (0.06 - sum(growths) / len(growths)) / (
        sum((g - sum(growths) / len(growths)) ** 2 for g in growths) / len(growths)
    ) ** 0.5
    assert out["flow_z_60"] == pytest.approx(expected)


# ---------------------------------------------------------------- 高位高波扣分


def _trend_bars(n: int, last_close: float | None = None) -> list[dict[str, Any]]:
    start = date(2023, 1, 2)
    closes = [1.0 + i for i in range(n)]
    if last_close is not None:
        closes[-1] = last_close
    return [
        {"date": (start + timedelta(days=i)).isoformat(), "close": c, "volume": 1_000_000.0}
        for i, c in enumerate(closes)
    ]


def test_describe_dd250_needs_full_year_and_uses_window_peak() -> None:
    short = core.describe(_row(), _bars(200), [], None, "2024-03-01")
    assert "dd250" not in short, "不足 250 根不出年内高位"

    bars = _trend_bars(300)
    at_high = core.describe(_row(), bars, [], None, bars[-1]["date"])
    assert at_high["dd250"] == pytest.approx(0.0)

    bars = _trend_bars(300, last_close=270.0)
    dipped = core.describe(_row(), bars, [], None, bars[-1]["date"])
    assert dipped["dd250"] == pytest.approx(270.0 / 299.0 - 1), "峰值取窗口内最高收盘(剔除被替换的最新一根)"


def test_high_vol_penalty_is_one_sided_and_needs_both_conditions() -> None:
    assert core.high_vol_penalty({"vol20": 0.30, "dd250": 0.0}) == 0.0, "低波动高位是正常估值抬升"
    assert core.high_vol_penalty({"vol20": 0.60, "dd250": -0.30}) == 0.0, "高位高波以外的深回撤不罚"
    assert core.high_vol_penalty({"vol20": 0.60, "dd250": -0.01}) == pytest.approx(0.10)
    assert core.high_vol_penalty({"vol20": 0.45, "dd250": -0.03}) == pytest.approx(0.10), "边界含等号"
    assert core.high_vol_penalty({"vol20": 0.60, "dd250": -0.05}) == 0.0, "距高点 5% 已不算贴新高"
    assert core.high_vol_penalty({"vol20": math.nan, "dd250": 0.0}) == 0.0
    assert core.high_vol_penalty({"vol20": 0.60}) == 0.0, "缺年内高点数据不罚"


def test_factor_rows_appends_penalty_only_when_bound() -> None:
    bound = core.factor_rows({"vol20": 0.50, "dd250": -0.01}, {})
    assert len(bound) == len(core.CORE_FEATURES) + 1
    row = bound[-1]
    assert row["key"] == "high_vol_penalty"
    assert row["weight"] is None and row["z"] is None
    assert row["contrib"] == pytest.approx(-core.HIGH_VOL_PENALTY)
    assert sum(f["contrib"] for f in bound) == pytest.approx(-core.HIGH_VOL_PENALTY)

    free = core.factor_rows({"vol20": 0.20, "dd250": 0.0}, {})
    assert len(free) == len(core.CORE_FEATURES)
    assert sum(f["contrib"] for f in free) == 0.0
```

<a id="file-backend-tests-test-daily-core-backfill-py"></a>

#### `backend/tests/test_daily_core_backfill.py`

```python
"""core8 缓冲带: 换仓节点回填的间距、持仓动作一致性、幂等与空节点清理。"""

from __future__ import annotations

import math
import sqlite3
from bisect import bisect_left
from datetime import date, timedelta

from data.store.database import get_conn
from ops import core_backfill
from services.scoring import features
from services.scoring.core import score as core
from services.scoring.core import store as core_store

START = date(2021, 8, 2)


def _weekdays(start: date, n: int) -> list[str]:
    days: list[str] = []
    cur = start
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def _seed(conn: sqlite3.Connection, days: list[str], n_etfs: int = 25) -> list[str]:
    """n_etfs 只走势分化的 ETF: 漂移拉开截面、正弦制造短期反转, 保证每日排名会变。"""
    codes = [f"51{i:04d}" for i in range(n_etfs)]
    with conn:
        conn.executemany(
            "INSERT INTO etfs (code, name, fund_type) VALUES (?, ?, ?)",
            [(code, f"测试ETF{i}", features.DOMESTIC_EQUITY) for i, code in enumerate(codes)],
        )
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
        for i, day in enumerate(days):
            for k, code in enumerate(codes):
                drift = -0.002 + 0.00016 * k
                close = 100 * math.exp(drift * i) * (1 + 0.08 * math.sin(i / 6 + k))
                conn.execute(
                    "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, ?, ?, ?)",
                    (day, code, round(close, 4), 1_000_000 + 1_000 * k),
                )
                conn.execute(
                    "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                    (day, code, 10 + 0.02 * ((k * 7) % 5) * i / len(days)),
                )
            conn.execute(
                "INSERT INTO index_daily (date, code, close) VALUES (?, ?, ?)",
                (day, "000300", round(100 * (1 + 0.0005 * i), 4)),
            )
    return codes


def _seed_days(conn: sqlite3.Connection, n: int = 160) -> list[str]:
    days = _weekdays(START, n)
    _seed(conn, days)
    return days


def test_rebuild_writes_every_fifth_trading_day() -> None:
    conn = get_conn()
    days = _seed_days(conn)

    result = core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)

    assert result["written"] == len(nodes) > 0
    dates = [node["signal_date"] for node in nodes]
    position = {day: i for i, day in enumerate(days)}
    # 节点与锚点网格同相位(锚点早于数据窗时, 首个落点顺延到第一个有评分的节点)
    grid0 = bisect_left(days, core.CORE_ANCHOR)
    assert all((position[d] - grid0) % core.REBALANCE_EVERY == 0 for d in dates)
    assert all(position[b] - position[a] == core.REBALANCE_EVERY for a, b in zip(dates, dates[1:]))
    assert dates[-1] <= days[-1]
    assert nodes[0]["rule_version"] == core_backfill.RULE_VERSION
    assert nodes[0]["scored"] == 25
    # 份额已覆盖到最新行情: 每个节点都是完整排名, 且预备排名随 pick 持久化。
    assert all(node["complete"] == 1 for node in nodes)
    missing_pre = conn.execute("SELECT COUNT(*) FROM fitted_core_pick WHERE pre_rank IS NULL").fetchone()[0]
    assert missing_pre == 0


def test_picks_track_buffer_holdings_across_nodes() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)

    held_prev: set[str] = set()
    for index, node in enumerate(nodes):
        data = core_store.get_node(conn, node["signal_date"])
        assert data is not None
        holdings = data["holdings"]
        held = {pick["code"] for pick in holdings}
        assert len(holdings) == core.HOLD_TOP
        assert all(pick["held"] and pick["action"] in {"hold", "buy"} for pick in holdings)
        holds = {pick["code"] for pick in holdings if pick["action"] == "hold"}
        buys = {pick["code"] for pick in holdings if pick["action"] == "buy"}
        assert holds == held & held_prev
        assert buys == held - held_prev
        sells = data["sells"]
        assert all(not pick["held"] and pick["action"] == "sell" for pick in sells)
        assert {pick["code"] for pick in sells} == held_prev - held
        assert data["counts"] == {"hold": len(holds), "buy": len(buys), "sell": len(sells)}
        assert len(data["ranked"]) <= core_backfill.KEEP_TOP
        if index == 0:
            assert buys == held  # 首节点建仓
        held_prev = held


def test_buffer_keeps_ranked_holding_but_sells_dropped_one() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)
    data = core_store.get_node(conn, nodes[-1]["signal_date"])
    assert data is not None

    for pick in data["holdings"]:
        assert pick["core_rank"] <= core.HOLD_BUFFER_RANK
    for pick in data["sells"]:
        assert pick["core_rank"] > core.HOLD_BUFFER_RANK


def test_rebuild_is_idempotent_and_prunes_non_node_rows() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    summary_before = conn.execute("SELECT COUNT(*) FROM fitted_core_summary").fetchone()[0]
    picks_before = conn.execute("SELECT COUNT(*) FROM fitted_core_pick").fetchone()[0]

    core_store.replace_node(
        conn,
        {
            "signal_date": "2022-01-05",  # 交易日, 但不是 5 日换仓节点
            "next_rebalance": None,
            "generated_at": None,
            "rule_version": "bogus",
            "scored": 0,
            "min_aum_yi": 0,
        },
        [],
    )
    core_backfill.rebuild(conn)

    assert conn.execute("SELECT COUNT(*) FROM fitted_core_summary").fetchone()[0] == summary_before
    assert conn.execute("SELECT COUNT(*) FROM fitted_core_pick").fetchone()[0] == picks_before
    assert core_store.node_at(conn, "2022-01-05") != "2022-01-05"


def test_nodes_without_bars_are_skipped_and_stale_rows_pruned() -> None:
    conn = get_conn()
    days = _seed_days(conn)
    future = _weekdays(date(2022, 3, 14), 10)  # 行情结束后仍在日历里, 模拟日历尾部
    with conn:
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in future])
    core_store.replace_node(
        conn,
        {
            "signal_date": future[4],
            "next_rebalance": None,
            "generated_at": None,
            "rule_version": "bogus",
            "scored": 0,
            "min_aum_yi": 0,
        },
        [],
    )

    result = core_backfill.rebuild(conn)
    dates = [node["signal_date"] for node in core_store.list_nodes(conn)]

    assert future[4] not in dates
    assert dates[-1] <= days[-1]
    assert result["written"] == len(dates)


def test_node_at_returns_previous_node_inside_holding_period() -> None:
    conn = get_conn()
    days = _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)
    node = nodes[2]["signal_date"]
    idx = days.index(node)

    assert core_store.node_at(conn, "2000-01-01") is None  # 任何节点之前无持仓
    assert core_store.node_at(conn, node) == node
    assert core_store.node_at(conn, days[idx + core.REBALANCE_EVERY - 1]) == node


def test_rebuild_node_heals_preliminary_node_after_shares_land() -> None:
    """节点日收盘只有 T-1 份额 → 先落预备目标; 份额落地后单节点补算成完整目标。"""
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    node = core_store.list_nodes(conn)[-1]["signal_date"]
    detail = core_store.get_node(conn, node)
    assert detail is not None
    original = {p["code"] for p in detail["holdings"]}
    assert core_store.node_complete(conn, node) is True

    saved = [
        tuple(row)
        for row in conn.execute("SELECT date, code, shares_yi FROM etf_shares WHERE date = ?", (node,)).fetchall()
    ]
    with conn:
        conn.execute("DELETE FROM etf_shares WHERE date = ?", (node,))
    result = core_backfill.rebuild_node(conn, node)

    assert result["written"] is True
    assert core_store.node_complete(conn, node) is False  # 份额只到 T-1, 仍是预备目标

    with conn:
        conn.executemany("INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)", saved)
    core_backfill.rebuild_node(conn, node)

    assert core_store.node_complete(conn, node) is True
    healed = core_store.get_node(conn, node)
    assert healed is not None
    assert {p["code"] for p in healed["holdings"]} == original


def test_rebuild_node_only_touches_target_node() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = [n["signal_date"] for n in core_store.list_nodes(conn)]
    target = nodes[-1]

    def counts(day: str) -> dict[str, int]:
        detail = core_store.get_node(conn, day)
        assert detail is not None
        return dict(detail["counts"])

    before = {d: counts(d) for d in nodes[:-1]}

    core_backfill.rebuild_node(conn, target)

    assert [n["signal_date"] for n in core_store.list_nodes(conn)] == nodes
    assert {d: counts(d) for d in nodes[:-1]} == before


def test_picks_sell_and_top20_sections() -> None:
    scored = [
        {"code": f"S{i:02d}", "name": f"S{i:02d}", "core_rank": i, "core_score": 1.0 - i * 0.01} for i in range(1, 26)
    ]
    picks = core_backfill._picks(scored, ["S01", "S15"], ["S01", "S20"])
    actions = {(pick["code"], pick["action"]) for pick in picks}

    assert ("S01", "hold") in actions
    assert ("S15", "buy") in actions
    assert ("S20", "sell") in actions
    rank_codes = {code for code, action in actions if action == "rank"}
    assert rank_codes == {f"S{i:02d}" for i in range(2, 21)} - {"S15", "S20"}

    rebought = core_backfill._picks(scored, ["S01", "S20"], ["S01", "S20"], {"S01": 1, "S20": 18}, {"S20"})
    actions_by_code = {(pick["code"], pick["action"], pick["pre_rank"]) for pick in rebought}
    # 周四收盘先卖、周五开盘买回: 持仓看着连续, 动作必须是 buy 并且留着预备排名。
    assert ("S20", "buy", 18) in actions_by_code
    assert ("S01", "hold", 1) in actions_by_code
```

<a id="file-backend-tests-test-daily-live-py"></a>

#### `backend/tests/test_daily_live.py`

```python
"""盘中预选: 实时现价合成今日 bar 的字段口径与时点守卫(纯函数, 不触网)。"""

from __future__ import annotations

import pytest

from pages.daily.live import context, preview


def test_synthetic_bar_uses_quote_fields() -> None:
    quote = {"price": 4.03, "open": 4.039, "high": 4.044, "low": 4.018, "volume": 4_241_375.0}

    bar = context.synthetic_bar("2026-11-17", quote)

    assert bar == {
        "date": "2026-11-17",
        "open": 4.039,
        "close": 4.03,
        "high": 4.044,
        "low": 4.018,
        "volume": 4_241_375.0,
    }


def test_synthetic_bar_rejects_halted_quote() -> None:
    assert context.synthetic_bar("2026-11-17", {"price": 0, "volume": 0}) is None
    assert context.synthetic_bar("2026-11-17", {"price": None, "volume": 1.0}) is None


def test_cache_ttl_follows_trading_hours(monkeypatch: pytest.MonkeyPatch) -> None:
    """收盘后行情不再变, 缓存要跨过 60 秒轮询, 否则每分钟重跑一次全市场评分。"""
    monkeypatch.setattr(preview.realtime, "is_trading_time", lambda: True)
    assert preview._ttl() == preview.LIVE_TTL_SEC

    monkeypatch.setattr(preview.realtime, "is_trading_time", lambda: False)
    assert preview._ttl() == preview.LIVE_IDLE_TTL_SEC


def test_quote_bar_requires_today_timestamp() -> None:
    """开盘前行情仍停在昨日收盘, 拼成今日 bar 会让今日与昨日重复。"""
    quote = {"price": 4.03, "volume": 1000.0, "time": "2026-11-17 10:43:52"}

    assert context.quote_bar(quote, "2026-11-17") is not None
    assert context.quote_bar({**quote, "time": "2026-11-14 15:00:00"}, "2026-11-17") is None
    assert context.quote_bar({**quote, "time": None}, "2026-11-17") is None
```

<a id="file-backend-tests-test-daily-nodes-py"></a>

#### `backend/tests/test_daily_nodes.py`

```python
"""换仓节点列表/明细/持仓时间线: 混合执行价、节点收益与持有区间。"""

from __future__ import annotations

import sqlite3

import pytest

from pages.daily import nodes
from services.scoring.core import store as core_store

DAYS = ["2024-01-02", "2024-01-09", "2024-01-16", "2024-01-23"]
# (开盘, 收盘): 开盘价与收盘价必须分开, 否则测不出周四收盘卖与周五开盘买的差别。
PRICES = {
    "510300": [(0.98, 1.00), (1.05, 1.10), (1.15, 1.21), (1.30, 1.331)],
    "510500": [(2.05, 2.00), (1.88, 1.90), (1.80, 1.90), (1.90, 1.90)],
    "159915": [(2.90, 3.00), (3.00, 3.00), (3.25, 3.30), (3.30, 3.30)],
}
GENERATED_AT = "2024-01-01 00:00:00"


def _pick(code: str, rank: int, action: str, pre_rank: int | None = None) -> dict[str, object]:
    return {
        "code": code,
        "name": code,
        "core_rank": rank,
        "core_score": 1.0 - rank * 0.1,
        "held": action in {"hold", "buy"},
        "action": action,
        "pre_rank": pre_rank if pre_rank is not None else rank,
    }


def _node(conn: sqlite3.Connection, index: int, picks: list[dict[str, object]]) -> None:
    core_store.replace_node(
        conn,
        {
            "signal_date": DAYS[index],
            "next_rebalance": DAYS[index + 1],
            "generated_at": GENERATED_AT,
            "rule_version": "core8-v1",
            "scored": len(picks),
            "min_aum_yi": 2.0,
        },
        picks,
    )


def _seed(conn: sqlite3.Connection) -> None:
    core_store.ensure_schema(conn)
    with conn:
        conn.executemany("INSERT OR REPLACE INTO trade_calendar (date) VALUES (?)", [(d,) for d in DAYS])
        for code, bars in PRICES.items():
            conn.executemany(
                "INSERT OR REPLACE INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
                [(day, code, o, c, 1_000_000) for day, (o, c) in zip(DAYS, bars)],
            )
    _node(conn, 0, [_pick("510300", 1, "buy"), _pick("510500", 2, "buy")])
    _node(conn, 1, [_pick("510300", 1, "hold"), _pick("159915", 2, "buy"), _pick("510500", 9, "sell", 9)])
    _node(conn, 2, [_pick("510300", 1, "hold"), _pick("159915", 2, "hold")])


def test_list_nodes_counts_and_returns() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)

    rows = nodes.list_nodes(conn)

    assert [r["signal_date"] for r in rows] == DAYS[:3]
    assert [p["code"] for p in rows[0]["holdings"]] == ["510300", "510500"]
    assert rows[0]["counts"] == {"hold": 0, "buy": 2, "sell": 0}
    assert rows[1]["counts"] == {"hold": 1, "buy": 1, "sell": 1}
    # 首个节点全是新买入: 只承担下一交易日 开盘→收盘。
    assert rows[0]["return"] == pytest.approx((1.10 / 1.05 - 1 + 1.90 / 1.88 - 1) / 2, abs=1e-6)
    # 第二个节点: 持有段收盘→收盘, 新买入 开盘→收盘, 顺延卖出 收盘→次日开盘。
    assert rows[1]["return"] == pytest.approx((1.21 / 1.10 - 1 + 3.30 / 3.25 - 1 + 1.80 / 1.90 - 1) / 2, abs=1e-6)
    assert rows[2]["return"] == pytest.approx((1.331 / 1.21 - 1 + 0.0) / 2, abs=1e-6)


def test_list_nodes_benchmarks_use_top10_and_hs300() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)
    with conn:
        # 排名 11 的标的翻倍: 它只该出现在评分榜, 不能混进前 10 名的对照收益。
        conn.executemany(
            "INSERT OR REPLACE INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
            [(day, "512000", 1.0, close, 1_000_000) for day, close in zip(DAYS, [1.0, 2.0, 2.0, 2.0])],
        )
        # 指数比行情晚一天发布: 末节点只有 ETF 行情, 沪深300 必须留空而不是沿用前值。
        conn.executemany(
            "INSERT OR REPLACE INTO index_daily (date, code, close) VALUES (?, '000300', ?)",
            list(zip(DAYS[:3], [4000.0, 4040.0, 4120.0])),
        )
    _node(conn, 0, [_pick("510300", 1, "buy"), _pick("510500", 2, "buy"), _pick("512000", 11, "rank")])

    rows = nodes.list_nodes(conn)

    assert rows[0]["top10_return"] == pytest.approx(((1.10 / 1.00 - 1) + (1.90 / 2.00 - 1)) / 2, abs=1e-6)
    assert rows[1]["top10_return"] == pytest.approx(
        ((1.21 / 1.10 - 1) + (3.30 / 3.00 - 1) + (1.90 / 1.90 - 1)) / 3, abs=1e-6
    )
    assert rows[0]["hs300_return"] == pytest.approx(4040.0 / 4000.0 - 1, abs=1e-6)
    assert rows[1]["hs300_return"] == pytest.approx(4120.0 / 4040.0 - 1, abs=1e-6)
    # 节点 2 的区间终点是 DAYS[3]: ETF 有价, 指数没有 → 只有指数那一列空着。
    assert rows[2]["top10_return"] == pytest.approx(((1.331 / 1.21 - 1) + 0.0) / 2, abs=1e-6)
    assert rows[2]["hs300_return"] is None


def test_timeline_merges_contiguous_holding() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)

    spells = {(s["code"], s["entry"]): s for s in nodes.timeline(conn)}

    assert set(spells) == {("510300", DAYS[0]), ("510500", DAYS[0]), ("159915", DAYS[1])}
    open_spell = spells[("510300", DAYS[0])]
    assert open_spell["holding"] is True
    assert open_spell["exit"] is None
    assert open_spell["nodes"] == 3
    assert open_spell["return"] is None
    assert open_spell["last_rank"] == 1
    assert open_spell["entry_price"] == pytest.approx(1.05)  # 节点日新买入, 成交在下一交易日开盘

    sold = spells[("510500", DAYS[0])]
    assert sold["exit"] == DAYS[1]
    assert sold["nodes"] == 1
    assert sold["entry_price"] == pytest.approx(1.88)
    assert sold["exit_price"] == pytest.approx(1.80)  # 预备排名仍在缓冲带内, 顺延到次日开盘卖
    assert sold["return"] == pytest.approx(1.80 / 1.88 - 1)

    late = spells[("159915", DAYS[1])]
    assert late["holding"] is True
    assert late["entry_rank"] == 2
    assert late["entry_price"] == pytest.approx(3.25)


def test_detail_enriches_prices_and_rejects_non_node() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)

    data = nodes.detail(conn, DAYS[1])

    assert data["return"] == pytest.approx((1.21 / 1.10 - 1 + 3.30 / 3.25 - 1 + 1.80 / 1.90 - 1) / 2, abs=1e-6)
    holdings = {p["code"]: p for p in data["holdings"]}
    assert holdings["510300"]["price"] == pytest.approx(1.10)
    assert holdings["510300"]["next_price"] == pytest.approx(1.21)
    assert holdings["510300"]["return"] == pytest.approx(0.1)
    assert "theme" in holdings["510300"]
    assert holdings["159915"]["sell_at"] is None
    assert holdings["159915"]["entry_price"] == pytest.approx(3.25)
    assert holdings["159915"]["return"] == pytest.approx(3.30 / 3.25 - 1)
    sells = {p["code"]: p for p in data["sells"]}
    assert sells["510500"]["sell_at"] == "open"
    assert sells["510500"]["price"] == pytest.approx(1.90)
    assert sells["510500"]["next_price"] is None
    assert sells["510500"]["return"] == pytest.approx(1.80 / 1.90 - 1)

    # 上一节点的持仓在下一节点顺延卖出: 明细的出场价也必须用次日开盘, 而不是下一节点收盘。
    first = {p["code"]: p for p in nodes.detail(conn, DAYS[0])["holdings"]}
    assert first["510500"]["next_price"] == pytest.approx(1.80)
    assert first["510500"]["return"] == pytest.approx(1.80 / 1.88 - 1)
    assert first["510300"]["next_price"] == pytest.approx(1.10)
    assert first["510300"]["return"] == pytest.approx(1.10 / 1.05 - 1)

    with pytest.raises(ValueError):
        nodes.detail(conn, "2024-01-05")
```

<a id="file-backend-tests-test-daily-records-py"></a>

#### `backend/tests/test_daily_records.py`

```python
"""日频复盘记录: core8 节点持仓逐日延续、T+1 结算、落库幂等与归因。"""

from __future__ import annotations

import sqlite3

import pytest

from data.store.database import get_conn
from pages.daily.review import attribution, build, store
from services.scoring.descriptors import slices
from tests.daily_seed import rebuild_last3 as _rebuild_last3
from tests.daily_seed import seed as _seed
from tests.daily_seed import weekdays as _weekdays


def test_slice_bars_window_and_missing_signal() -> None:
    dates = _weekdays(10)
    bars = [{"date": d, "close": float(i)} for i, d in enumerate(dates)]

    part = slices.slice_bars(bars, dates, dates[6], 3)
    assert part is not None and [b["date"] for b in part] == dates[4:7]  # 含信号日在内最近 3 根
    assert slices.slice_bars(bars, dates, "2023-12-31", 3) is None  # 非交易日
    head = slices.slice_bars(bars, dates, dates[1], 3)
    assert head is not None and len(head) == 2  # 窗口越界截到最早


def test_slice_points_allows_lagging_shares() -> None:
    """份额 T+1 发布: 信号日没有份额行时仍要取 ≤ 信号日的最后一段。"""
    dates = _weekdays(10)
    bars = [{"date": d, "shares_yi": float(i)} for i, d in enumerate(dates)]

    part = slices.slice_points(bars, dates, dates[7], 3)
    assert part is not None and [b["date"] for b in part] == dates[5:8]
    # 信号日(第 9 天)尚未入库: 宽松切片取到前一交易日为止
    lagging = slices.slice_points(bars, dates[:-1], dates[9], 3)
    assert lagging is not None and [b["date"] for b in lagging] == dates[6:9]
    assert slices.slice_points(bars, dates, "2023-12-31", 3) is None


def test_holdings_carry_until_next_node() -> None:
    """换仓间隔期内沿用上一节点持仓, 节点当日才切换。"""
    days = _weekdays(4)
    first = [{"code": "A"}]
    second = [{"code": "B"}]
    nodes = {days[1]: first, days[3]: second}
    node_dates = sorted(nodes)

    assert build._held_for_day(node_dates, nodes, days[0]) == []  # 节点前无持仓
    assert build._held_for_day(node_dates, nodes, days[1]) == first
    assert build._held_for_day(node_dates, nodes, days[2]) == first
    assert build._held_for_day(node_dates, nodes, days[3]) == second


def test_rebuild_requires_core_nodes() -> None:
    conn = get_conn()
    days = _seed(conn)

    with pytest.raises(ValueError, match="换仓节点"):
        build.rebuild(conn, start_date=days[-3], end_date=days[-1])


def test_rebuild_writes_daily_rows_with_t1_settlement() -> None:
    conn = get_conn()
    days = _seed(conn)

    result = _rebuild_last3(conn, days)

    assert result["days"] == 3
    rows = store.list_days(conn)
    assert [r["signal_date"] for r in rows] == days[-3:]
    assert all(r["rule_version"] == build.RULE_VERSION for r in rows)
    assert all(r["scored"] == 2 for r in rows)

    settled = store.get_day(conn, days[-3])
    assert settled is not None
    core = settled["picks"]["core"]
    assert [p["code"] for p in core] == ["510300"]  # 节点持仓, 每日沿用
    assert "core8_hold" in core[0]["reason"]["flags"]
    assert core[0]["reason_text"].startswith("策略第1")
    assert core[0]["next_return"] == pytest.approx(0.003)  # 信号日收盘 → 次日收盘
    assert settled["evaluation"]["core_holdings"]["mean"] == pytest.approx(0.003)
    assert settled["core_mean"] == pytest.approx(0.003)
    assert "core_holdings_picks" not in settled["evaluation"]  # 逐笔明细已拆到 pick 表

    last = store.get_day(conn, days[-1])
    assert last is not None
    assert last["evaluation"].get("skipped")  # 最后一个信号日无下一交易日
    assert all(p["next_return"] is None for p in last["picks"]["core"])


def test_rebuild_is_idempotent() -> None:
    conn = get_conn()
    days = _seed(conn)

    _rebuild_last3(conn, days)
    _rebuild_last3(conn, days)

    rows = store.list_days(conn)
    assert len(rows) == 3
    n = conn.execute("SELECT COUNT(*) AS n FROM fitted_daily_pick").fetchone()["n"]
    details = [store.get_day(conn, d) for d in days[-3:]]
    assert n == sum(len(r["picks"]["core"]) + len(r["picks"]["baseline"]) for r in details if r)


def test_all_picks_filters_unsettled_returns() -> None:
    conn = get_conn()
    days = _seed(conn)
    _rebuild_last3(conn, days)

    settled = store.all_picks(conn, "core")
    assert [p["signal_date"] for p in settled] == days[-3:-1]
    assert all(p["next_return"] is not None for p in settled)
    with_unsettled = store.all_picks(conn, "core", require_return=False)
    assert [p["signal_date"] for p in with_unsettled] == days[-3:]


def test_migration_renames_legacy_rule_columns() -> None:
    """旧 daily-v1 库的 rule_* 列要能原地改名, 不要求重建整表。"""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE fitted_daily_summary (
            signal_date TEXT PRIMARY KEY, rule_mean REAL, rule_median REAL, rule_hit REAL
        );
        """
    )

    store.ensure_schema(conn)

    cols = {r["name"] for r in conn.execute("PRAGMA table_info(fitted_daily_summary)")}
    assert {"core_mean", "core_median", "core_hit"} <= cols
    assert not {"rule_mean", "rule_median", "rule_hit"} & cols


def test_attribution_overall_has_turnover_hs300_and_compound() -> None:
    conn = get_conn()
    days = _seed(conn)
    _rebuild_last3(conn, days)

    data = attribution.build(conn)

    assert set(data) == {"days", "cumulative", "overall"}
    assert len(data["cumulative"]) == 3
    overall = data["overall"]
    assert overall["days"] == 2  # 只有可结算的信号日进入总体统计
    for key in ("core", "baseline", "universe", "hs300"):
        assert {"mean", "cumulative", "positive"} <= set(overall[key])
    assert overall["core"]["cumulative"] == pytest.approx(1.003**2 - 1)
    assert overall["hs300"]["cumulative"] == pytest.approx(1.001**2 - 1)
    assert overall["turnover_avg"] == 0.0  # 三日持仓由同一节点延续, 日换手为 0

    last_point = data["cumulative"][-1]
    assert last_point["core"] is None  # 未结算日不进累计复利


def test_attribution_turnover_counts_membership_changes() -> None:
    series = [
        {"signal_date": f"2024-01-0{i}", "core": 0.01, "baseline": 0.01, "universe": 0.01, "rank_ic": 0.1, "hs300": 0.0}
        for i in range(1, 4)
    ]
    picks = [
        {"signal_date": "2024-01-01", "code": "A"},
        {"signal_date": "2024-01-01", "code": "B"},
        {"signal_date": "2024-01-02", "code": "A"},
        {"signal_date": "2024-01-02", "code": "C"},
        {"signal_date": "2024-01-03", "code": "C"},
        {"signal_date": "2024-01-03", "code": "D"},
    ]

    overall = attribution._overall(series, picks)

    assert overall["turnover_avg"] == pytest.approx(0.5)  # 每天换掉 2 只中的 1 只


def _gate_days(dates: list[str]) -> list[dict]:
    return [
        {
            "signal_date": dates[5],
            "next_signal": dates[6],
            "core": 0.10,
            "baseline": 0.05,
            "universe": 0.03,
            "rank_ic": 0.1,
            "hs300": 0.01,
        },
        {
            "signal_date": dates[275],
            "next_signal": dates[276],
            "core": -0.20,
            "baseline": 0.0,
            "universe": 0.01,
            "rank_ic": -0.2,
            "hs300": -0.01,
        },
        {
            "signal_date": dates[290],
            "next_signal": dates[291],
            "core": 0.25,
            "baseline": 0.0,
            "universe": 0.0,
            "rank_ic": 0.0,
            "hs300": 0.0,
        },
    ]


def test_gate_states_use_signal_date_close_against_ma250() -> None:
    dates = _weekdays(300)
    closes = [100.0] * 260 + [120.0] * 20 + [90.0] * 20
    days = _gate_days(dates)

    states = attribution._gate_states(dates, closes, days)

    assert states == [None, "above", "below"]  # 年线未热身/站上/跌破


def test_gated_curve_skips_days_when_gate_is_off() -> None:
    days = _gate_days(_weekdays(300))
    points = attribution._compound(days, ["above", "below", "above"])

    assert points[0]["gated"] == pytest.approx(0.10)
    assert points[1]["gated"] == pytest.approx(0.10)  # 开关下方空仓, 不承受 -20%
    assert points[2]["gated"] == pytest.approx(1.10 * 1.25 - 1)
    assert points[2]["core"] == pytest.approx(1.10 * 0.80 * 1.25 - 1)
    assert points[1]["gate"] == "below"


def test_overall_reports_gated_cumulative_and_day_counts() -> None:
    days = _gate_days(_weekdays(300))
    overall = attribution._overall(days, [], ["above", "below", "above"])

    assert overall["gated_cumulative"] == pytest.approx(1.10 * 1.25 - 1)
    assert overall["gate_on_days"] == 2
    assert overall["gate_off_days"] == 1
    assert overall["core"]["cumulative"] == pytest.approx(1.10 * 0.80 * 1.25 - 1)


def test_attribution_gate_keys_none_when_ma_not_warmed_up() -> None:
    """80 根指数日线不足年线热身: 开关全空, 累计曲线无 gated 点, 统计记 0/None。"""
    conn = get_conn()
    days = _seed(conn)
    _rebuild_last3(conn, days)

    data = attribution.build(conn)

    assert all(p["gate"] is None for p in data["cumulative"])
    assert all(p["gated"] is None for p in data["cumulative"])
    assert data["overall"]["gate_on_days"] == 0
    assert data["overall"]["gate_off_days"] == 0
    assert data["overall"]["gated_cumulative"] is None
```

<a id="file-backend-tests-test-daily-screen-py"></a>

#### `backend/tests/test_daily_screen.py`

```python
"""筛选漏斗与全量排名: 每一级剔除原因、阶段归属与评分明细。"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

import pytest

from data.store.database import get_conn
from pages.daily.review import build, store
from pages.daily.screen import rank
from services.scoring import features
from services.scoring.core import store as core_store


@pytest.fixture(autouse=True)
def _clear_screen_cache() -> None:
    rank._cache.clear()


def _weekdays(n: int) -> list[str]:
    days: list[str] = []
    cur = date(2024, 1, 1)
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def _seed(conn: sqlite3.Connection) -> list[str]:
    """8 只标的覆盖漏斗每一级: 通过/规模不足/无份额/停牌/次新/港股/债券。"""
    days = _weekdays(80)
    etfs = [
        ("510300", "沪深300ETF测试", features.DOMESTIC_EQUITY),
        ("510500", "中证500ETF测试", features.DOMESTIC_EQUITY),
        ("512999", "小规模ETF测试", features.DOMESTIC_EQUITY),
        ("513999", "无份额ETF测试", features.DOMESTIC_EQUITY),
        ("512888", "停牌ETF测试", features.DOMESTIC_EQUITY),
        ("159920", "恒生ETF测试", features.DOMESTIC_EQUITY),
        ("511010", "国债ETF测试", "债券型-长债"),
        ("513888", "次新ETF测试", features.DOMESTIC_EQUITY),
    ]
    closes = {
        "510300": lambda i: 100 * (1.003**i),
        "510500": lambda i: 100 * (0.998**i),
        "512999": lambda i: 100 * (1 + 0.001 * i),
        "513999": lambda i: 100 * (1 + 0.0005 * i),
        "512888": lambda i: 100.0,
        "159920": lambda i: 100.0,
        "511010": lambda i: 100.0,
        "513888": lambda i: 50.0,
    }
    shares = {"510300": lambda i: 10 + i * 0.02, "510500": lambda i: 10.0, "512999": lambda i: 0.01}
    with conn:
        conn.executemany("INSERT INTO etfs (code, name, fund_type) VALUES (?, ?, ?)", etfs)
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
        for i, day in enumerate(days):
            for code, close in closes.items():
                if code == "512888" and i == len(days) - 1:
                    continue  # 信号日停牌
                if code == "513888" and i < len(days) - 30:
                    continue  # 次新, 历史不足 62 根
                conn.execute(
                    "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, ?, ?, ?)",
                    (day, code, close(i), 1_000_000),
                )
            for code, value in shares.items():
                conn.execute(
                    "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                    (day, code, value(i)),
                )
            conn.execute(
                "INSERT INTO index_daily (date, code, close) VALUES (?, ?, ?)",
                (day, "000300", 100 * (1.001**i)),
            )
    return days


def _seed_node(conn: sqlite3.Connection, day: str, held: list[str]) -> None:
    """信号日的换仓节点: held 里的名字落在缓冲带持仓, 其余只进评分榜。"""
    core_store.ensure_schema(conn)
    picks = [
        {
            "code": code,
            "name": code,
            "core_rank": rank,
            "core_score": 1.0 - rank * 0.1,
            "held": code in held,
            "action": "hold" if code in held else "rank",
        }
        for rank, code in enumerate(["510300", "510500"], 1)
    ]
    core_store.replace_node(
        conn,
        {
            "signal_date": day,
            "next_rebalance": None,
            "generated_at": "2024-01-01 00:00:00",
            "rule_version": "core8-v1",
            "scored": 2,
            "min_aum_yi": features.DEFAULT_MIN_AUM_YI,
        },
        picks,
    )


def test_funnel_counts_each_stage() -> None:
    conn = get_conn()
    days = _seed(conn)
    _seed_node(conn, days[-1], ["510300"])

    data = rank.build(conn, days[-1])

    assert data["available"] is True
    counts = {stage["key"]: stage["count"] for stage in data["funnel"]}
    assert counts == {
        "etfs": 8,
        "equity": 7,
        "a_share": 6,
        "with_bar": 5,
        "history": 4,
        "shares": 3,
        "aum": 2,
        "core_pool": 2,
        "core_hold": 1,
    }
    sequence = [stage["count"] for stage in data["funnel"]]
    assert sequence == sorted(sequence, reverse=True)  # 漏斗只减不增
    assert [stage["key"] for stage in data["funnel"]][0] == "etfs"


def test_rows_attribute_each_drop_stage() -> None:
    conn = get_conn()
    days = _seed(conn)
    _seed_node(conn, days[-1], ["510300"])

    data = rank.build(conn, days[-1])
    rows = {row["code"]: row for row in data["rows"]}

    assert rows["511010"]["stage"] == "non_equity"
    assert rows["159920"]["stage"] == "hk"
    assert rows["512888"]["stage"] == "no_bar"
    assert rows["512888"]["last_bar"] == days[-2]
    assert rows["513888"]["stage"] == "short_history"
    assert rows["513999"]["stage"] == "no_shares"
    assert rows["512999"]["stage"] == "small_aum"
    assert 0 < rows["512999"]["reason"]["aum_yi"] < 2
    assert rows["510500"]["stage"] == "core_pool"
    assert rows["510500"]["core8_rank"] is not None
    assert rows["510300"]["stage"] == "core_hold"
    assert rows["510300"]["core8_score"] is not None
    assert data["node_date"] == days[-1]  # 节点涨跌基准: 节点日收盘
    assert rows["510300"]["node_close"] == pytest.approx(100 * (1.003 ** (len(days) - 1)))


def test_ranking_and_codes_match_picks() -> None:
    conn = get_conn()
    days = _seed(conn)
    _seed_node(conn, days[-1], ["510300"])

    data = rank.build(conn, days[-1])
    rows = {row["code"]: row for row in data["rows"]}

    assert rows["510300"]["rank"] == 1
    assert rows["510500"]["rank"] == 2
    assert data["core_codes"] == ["510300"]
    assert data["baseline_codes"] == ["510300", "510500"]
    assert rows["510300"]["reason"]["baseline_score"] >= rows["510500"]["reason"]["baseline_score"]
    assert rows["510300"]["reason_text"].startswith("策略")
    assert rows["510500"]["reason_text"].startswith("综合分")

    build.rebuild(conn, start_date=days[-1], end_date=days[-1])
    day = store.get_day(conn, days[-1])
    assert day is not None
    assert [p["code"] for p in day["picks"]["core"]] == data["core_codes"]
    assert [p["code"] for p in day["picks"]["baseline"]] == data["baseline_codes"]


def test_signal_day_without_bars_is_unavailable() -> None:
    conn = get_conn()
    _seed(conn)
    with conn:
        conn.execute("INSERT INTO trade_calendar (date) VALUES ('2024-04-29')")  # 交易日历有、行情无

    data = rank.build(conn, "2024-04-29")

    assert data["available"] is False
    assert "K 线" in data["reason"]
    assert all(row["stage"] in {"non_equity", "hk", "no_bar"} for row in data["rows"])


def test_non_trading_day_raises() -> None:
    conn = get_conn()
    _seed(conn)

    with pytest.raises(ValueError):
        rank.build(conn, "2024-01-06")
```

<a id="file-backend-tests-test-daily-screen-cache-py"></a>

#### `backend/tests/test_daily_screen_cache.py`

```python
"""筛选快照缓存: 命中不重算, 日度记录换 generated_at 后重算。"""

from __future__ import annotations

import sqlite3

import pytest

from pages.daily.screen import cache, rank

SIGNAL = "2024-03-01"


def _day(conn: sqlite3.Connection, generated_at: str) -> None:
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_daily_summary (signal_date, generated_at) VALUES (?, ?)",
            (SIGNAL, generated_at),
        )


def _fake_screen() -> dict[str, object]:
    return {
        "payload_version": rank.PAYLOAD_VERSION,
        "signal_date": SIGNAL,
        "available": True,
        "min_aum_yi": 2.0,
        "funnel": [],
        "rows": [],
    }


def test_snapshot_hit_skips_rebuild(monkeypatch: pytest.MonkeyPatch) -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _day(conn, "2024-03-01 00:00:00")
    calls = {"n": 0}

    def fake_build(conn_: sqlite3.Connection, signal: str, min_aum: float | None = None) -> dict[str, object]:
        calls["n"] += 1
        return _fake_screen()

    monkeypatch.setattr(cache.rank, "build", fake_build)

    first = cache.build_cached(conn, SIGNAL)
    second = cache.build_cached(conn, SIGNAL)

    assert calls["n"] == 1
    assert first == second

    _day(conn, "2024-03-02 00:00:00")
    cache.build_cached(conn, SIGNAL)
    assert calls["n"] == 2


def test_warm_builds_latest_signal(monkeypatch: pytest.MonkeyPatch) -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _day(conn, "2024-03-01 00:00:00")
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_daily_summary (signal_date, generated_at) VALUES ('2024-03-04', 'x')"
        )
    built: list[str] = []

    def fake_build(conn_: sqlite3.Connection, signal: str, min_aum: float | None = None) -> dict[str, object]:
        built.append(signal)
        return {**_fake_screen(), "signal_date": signal}

    monkeypatch.setattr(cache.rank, "build", fake_build)

    assert cache.warm(conn) == "2024-03-04"  # 默认预热最新交易日
    assert cache.warm(conn, SIGNAL) == SIGNAL  # 也可指定日期
    assert built == ["2024-03-04", SIGNAL]


def test_warm_without_records_does_nothing() -> None:
    from data.store.database import get_conn

    assert cache.warm(get_conn()) is None
```

<a id="file-backend-tests-test-dataset-py"></a>

#### `backend/tests/test_dataset.py`

```python
"""数据就绪度审计: 缺口、异常值、份额/指数覆盖。"""

from __future__ import annotations

from data.config import INDEX_CODES
from data.store import calendar_repo, daily_repo, etf_repo, index_repo
from data.store.database import get_conn
from pages.jobs import readiness as audit

CAL = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]


def _seed_calendar(days: list[str]) -> None:
    calendar_repo.replace_all(days)


def _seed_etfs() -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}, {"code": "588000", "name": "科创50ETF"}])


def test_list_date_backfilled_from_first_bar() -> None:
    _seed_etfs()
    daily_repo.upsert_rows("510300", [{"date": "2024-01-03", "close": 1.0}])
    assert etf_repo.backfill_list_dates() == 1
    row = get_conn().execute("SELECT list_date FROM etfs WHERE code='510300'").fetchone()
    assert row["list_date"] == "2024-01-03"
    assert etf_repo.backfill_list_dates() == 0  # 幂等


def test_audit_reports_gaps_and_anomalies() -> None:
    _seed_calendar(CAL)
    daily_repo.upsert_rows(
        "510300",
        [
            {"date": "2024-01-02", "close": 1.0, "volume": 100.0},
            {"date": "2024-01-05", "close": 2.5, "volume": 0.0},
        ],
    )
    summary = audit.dataset_summary()
    assert summary["calendar"]["days"] == 4
    assert summary["daily"]["codes"] == 1 and summary["daily"]["rows"] == 2
    assert summary["gaps"]["codes"] == 1 and summary["gaps"]["days"] == 2  # 缺 01-03、01-04
    assert summary["gaps"]["top"][0]["code"] == "510300"
    assert summary["anomalies"]["zero_volume"] == 1
    assert summary["anomalies"]["jump_gt_30pct"] == 1
    assert summary["index"]["configured"] > 0 and summary["index"]["rows"] == 0


def test_audit_lists_index_coverage_even_when_empty() -> None:
    rows = audit.index_coverage()
    assert len(rows) == len(INDEX_CODES)
    assert all(r["rows"] == 0 for r in rows)


def test_audit_counts_share_scale_fallback() -> None:
    _seed_etfs()
    _seed_calendar(CAL)
    daily_repo.upsert_rows(
        "510300",
        [
            {"date": "2024-01-02", "close": 1.0, "volume": 100.0},
            {"date": "2024-01-03", "close": 1.0, "volume": 100.0},
        ],
    )
    index_repo.upsert_rows("000300", "沪深300", [{"date": "2024-01-02", "close": 4000.0, "open": 4000.0}])
    summary = audit.dataset_summary()
    assert summary["index"]["codes"] == 1 and summary["index"]["rows"] == 1
    assert summary["share_scale"]["jumps"] == 0
```

<a id="file-backend-tests-test-etf-list-py"></a>

#### `backend/tests/test_etf_list.py`

```python
"""fundcode_search 静态清单解析(纯函数, 不触网)。"""

from __future__ import annotations

from data.fetch.etf_list import parse_fundcode_rows

_SAMPLE = (
    'var r = [["510300","HS300ETF","沪深300ETF","指数型-股票","HS300ETF"],'
    '["159915","CYBETF","创业板ETF","指数型-股票","CYBETF"],'
    '["000311","HS300LJ","沪深300ETF联接A","指数型-股票","HS300LJA"],'
    '["511880","HBYJETF","银华日利ETF","货币型-普通货币","HBYJETF"],'
    '["600519","GZMT","贵州茅台","股票型","GZMT"]];'
)


def test_parse_filters_exchange_etf_only() -> None:
    rows = parse_fundcode_rows(_SAMPLE)
    assert [r["code"] for r in rows] == ["510300", "159915", "511880"]
    assert rows[0]["fund_type"] == "指数型-股票"
    assert rows[0]["price"] is None and rows[0]["amount_yi"] is None


def test_parse_garbage_returns_empty() -> None:
    assert parse_fundcode_rows("not json") == []
    assert parse_fundcode_rows("var r = ;") == []
```

<a id="file-backend-tests-test-etf-router-py"></a>

#### `backend/tests/test_etf_router.py`

```python
"""/api/etfs/{code}/kline 的窗口参数: end 截断 + 历史窗口不追加实时bar。"""

from __future__ import annotations

import pytest

from pages.etf import router as etf_router

_ROWS = [
    {"date": "2024-01-02", "open": 1.0, "close": 1.1, "high": 1.2, "low": 0.9, "volume": 100.0},
    {"date": "2024-01-03", "open": 1.1, "close": 1.2, "high": 1.3, "low": 1.0, "volume": 110.0},
    {"date": "2024-01-04", "open": 1.2, "close": 1.3, "high": 1.4, "low": 1.1, "volume": 120.0},
]


def test_kline_end_truncates_window(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(etf_router, "_all_bars", lambda code: [dict(r) for r in _ROWS])
    out = etf_router.etf_kline("510300", period="day", limit=2, live=False, end="2024-01-03")
    assert [b["date"] for b in out["bars"]] == ["2024-01-02", "2024-01-03"]


def test_kline_end_skips_live_bar(monkeypatch: pytest.MonkeyPatch) -> None:
    """历史窗口不能追加当日实时bar, 否则走势图会把今天拼到过去。"""

    def boom(code: str, rows: list[dict]) -> list[dict]:
        raise AssertionError("历史窗口不应调用实时行情")

    monkeypatch.setattr(etf_router, "_all_bars", lambda code: [dict(r) for r in _ROWS])
    monkeypatch.setattr(etf_router, "_with_live_bar", boom)
    out = etf_router.etf_kline("510300", period="day", limit=10, live=True, end="2024-01-03")
    assert out["bars"][-1]["date"] == "2024-01-03"
```

<a id="file-backend-tests-test-execution-py"></a>

#### `backend/tests/test_execution.py`

```python
"""混合执行口径: 周四收盘卖 / 周五开盘买与顺延卖、真实成交价结算与等权槽位。"""

from __future__ import annotations

import pytest

from pages.daily.review import execution


def test_sell_at_splits_by_buffer_rank() -> None:
    assert execution.sell_at(None) == execution.SELL_CLOSE  # 掉出候选池, 收盘就能确定
    assert execution.sell_at(15) == execution.SELL_CLOSE
    assert execution.sell_at(14) == execution.SELL_OPEN


def test_legs_split_one_rebalance_into_four() -> None:
    plan = execution.legs(
        ["A", "B", "C"],
        ["B", "D"],
        {"A": 9, "B": 2, "C": 20},
    )

    assert plan == {
        "sell_close": ["C"],
        "sell_open": ["A"],
        "keep": ["B"],
        "buy": ["D"],
    }
    assert execution.remaining_after_close_sells(["A", "B", "C"], {"A": 9, "B": 2, "C": 20}) == ["A", "B"]


def test_plans_uses_pre_ranks_of_dropped_names() -> None:
    """掉出目标的名字只有 sell 行, 预备排名必须从节点全量 pick 里取, 否则一律误判为收盘卖。"""
    nodes = {"D1": [{"code": "A"}], "D2": [{"code": "B"}]}
    pre: dict[str, dict[str, int | None]] = {"D1": {"A": 1}, "D2": {"A": 20, "B": 2}}

    plans = execution.plans(nodes, pre)

    assert plans["D2"]["sell_close"] == ["A"]
    assert plans["D2"]["sell_open"] == []
    assert plans["D2"]["buy"] == ["B"]

    kept = execution.plans(nodes, {"D1": {"A": 1}, "D2": {"A": 5, "B": 2}})
    assert kept["D2"]["sell_open"] == ["A"]
    assert kept["D2"]["buy"] == ["B"]


def test_plans_falls_back_to_pick_pre_rank() -> None:
    nodes = {"D1": [{"code": "A"}], "D2": [{"code": "B"}]}

    plans = execution.plans(nodes)

    # 节点里没有卖出行的预备排名 → 缺排名按收盘卖, 保守但不会凭空多持有一天。
    assert plans["D2"]["sell_close"] == ["A"]


def _prices() -> dict[str, dict[str, dict[str, float | None]]]:
    return {
        "A": {
            "E": {"open": 9.8, "close": 10.0},
            "O": {"open": 10.5, "close": 11.0},
            "X": {"open": 11.5, "close": 12.0},
        },
        "B": {"O": {"open": 5.0, "close": 5.5}, "X": {"open": 5.8, "close": 6.0}},
        "C": {"E": {"open": 19.5, "close": 20.0}, "O": {"open": 19.0, "close": 19.5}},
        "D": {"E": {"open": 30.0, "close": 30.0}},
    }


PLAN = {"keep": ["A"], "buy": ["B"], "sell_open": ["C"], "sell_close": ["D"]}


def test_settle_uses_real_fills_and_slot_denominator() -> None:
    settled = execution.settle(PLAN, _prices(), "E", "O", "X")

    returns = settled["returns"]
    assert returns["A"] == pytest.approx(12.0 / 10.0 - 1)  # 持有: 收盘 → 收盘
    assert returns["B"] == pytest.approx(6.0 / 5.0 - 1)  # 新买入: 开盘 → 收盘
    assert returns["C"] == pytest.approx(19.0 / 20.0 - 1)  # 顺延卖出: 收盘 → 次日开盘
    assert "D" not in returns  # 周四收盘已退出, 本段不再承担涨跌
    assert settled["n"] == 3  # 槽位数取节点前后较大者
    assert settled["mean"] == pytest.approx((0.2 + 0.2 - 0.05) / 3, abs=1e-6)
    assert settled["hit_rate"] == pytest.approx(2 / 3)


def test_settle_counts_missing_prices_as_cash() -> None:
    prices = _prices()
    del prices["B"]["O"]  # 新买入的标的当日无成交价 → 空槽按现金记 0

    settled = execution.settle(PLAN, prices, "E", "O", "X")

    assert settled["returns"].get("B") is None
    assert settled["n"] == 3
    assert settled["mean"] == pytest.approx(0.15 / 3, abs=1e-6)


def test_settle_all_slots_filled_by_buys() -> None:
    """从空仓建仓: 分母是新买入的槽数, 不能按旧的 0 只算成 0 收益。"""
    settled = execution.settle(
        {"keep": [], "buy": ["A", "B"], "sell_open": [], "sell_close": []},
        _prices(),
        "E",
        "O",
        "X",
    )

    assert settled["n"] == 2
    assert settled["mean"] == pytest.approx(((12.0 / 10.5 - 1) + (6.0 / 5.0 - 1)) / 2, abs=1e-6)


def test_next_day_returns_following_trading_day() -> None:
    calendar = ["2026-11-16", "2026-11-17", "2026-11-18"]

    assert execution.next_day(calendar, "2026-11-16") == "2026-11-17"
    assert execution.next_day(calendar, "2026-11-18") is None
    assert execution.next_day(calendar, "2026-11-15") == "2026-11-16"
```

<a id="file-backend-tests-test-index-kline-py"></a>

#### `backend/tests/test_index_kline.py`

```python
"""中证指数日线解析、假首行剔除、增量回填与写入语义(不触网)。"""

from __future__ import annotations

import pytest

from data.fetch import index_kline
from data.store import index_repo
from data.store.database import get_conn
from ops import jobs


def _row(date: str, close: float, name: str = "沪深300") -> dict:
    return {
        "tradeDate": date,
        "indexNameCn": name,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "tradingVol": 1000.0,
        "tradingValue": 2701.06,
        "consNumber": 300.0,
        "peg": 13.55,
    }


def test_parse_drops_synthetic_first_row() -> None:
    """接口把首行日期改写成请求起点并复制首个交易日数值, 必须剔除。"""
    payload = {"data": [_row("20200101", 4152.24), _row("20200102", 4152.24), _row("20200103", 4144.96)]}
    name, rows = index_kline._parse_rows(payload, "2020-01-01")
    assert name == "沪深300"
    assert [r["date"] for r in rows] == ["2020-01-02", "2020-01-03"]
    assert rows[0]["amount_yi"] == 2701.06 and rows[0]["pe"] == 13.55 and rows[0]["cons_number"] == 300.0


def test_parse_keeps_real_first_trading_day() -> None:
    """请求起点本身就是交易日且数值不同 → 首行是真实数据, 不能丢。"""
    payload = {"data": [_row("20200102", 4152.24), _row("20200103", 4144.96)]}
    _, rows = index_kline._parse_rows(payload, "2020-01-02")
    assert [r["date"] for r in rows] == ["2020-01-02", "2020-01-03"]


def test_parse_skips_missing_close_and_nulls() -> None:
    payload = {
        "data": [
            {"tradeDate": "20200102", "indexNameCn": "科创50", "close": None},
            {"tradeDate": "20200103", "indexNameCn": "科创50", "open": 1.0, "close": 1.1, "high": None, "peg": None},
        ]
    }
    _, rows = index_kline._parse_rows(payload, "2020-01-01")
    assert len(rows) == 1
    assert rows[0]["date"] == "2020-01-03" and rows[0]["high"] is None and rows[0]["pe"] is None


def test_fetch_failure_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise OSError("network down")

    monkeypatch.setattr(index_kline.urllib.request, "urlopen", boom)
    assert index_kline.fetch_index_daily("000300") == (None, [])


def test_repo_upsert_coalesce_and_name() -> None:
    index_repo.upsert_rows("000300", "沪深300", [{"date": "2024-01-02", "open": 1.0, "close": 2.0, "pe": 12.0}])
    index_repo.upsert_rows("000300", None, [{"date": "2024-01-02", "close": 2.5, "pe": None}])
    row = get_conn().execute("SELECT * FROM index_daily WHERE code='000300'").fetchone()
    assert row["open"] == 1.0 and row["close"] == 2.5 and row["pe"] == 12.0
    name = get_conn().execute("SELECT name FROM indices WHERE code='000300'").fetchone()["name"]
    assert name == "沪深300"


def test_backfill_index_is_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    index_repo.upsert_rows("000300", "沪深300", [{"date": "2024-01-02", "close": 1.0}])
    calls: list[tuple[str, str]] = []

    def fake_fetch(code: str, start_date: str, end_date: str | None = None) -> tuple[str | None, list[dict]]:
        calls.append((code, start_date))
        return None, []

    monkeypatch.setattr(jobs, "INDEX_CODES", ("000300", "000905"))
    monkeypatch.setattr(jobs, "INDEX_FETCH_SLEEP_SEC", 0)
    monkeypatch.setattr(jobs.index_fetch, "fetch_index_daily", fake_fetch)
    result = jobs.backfill_index()
    assert calls == [("000300", "2024-01-03"), ("000905", jobs.CSINDEX_START_DATE)]
    assert result == {"indices": 2, "rows": 0}
```

<a id="file-backend-tests-test-jobs-py"></a>

#### `backend/tests/test_jobs.py`

```python
"""回填任务编排的幂等与增量逻辑(拉取函数全部 mock, 不触网)。"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from data.fetch import kline as kline_fetch
from data.store import calendar_repo, daily_repo, etf_repo
from ops import jobs


def business_days(start: str, n: int) -> list[str]:
    """从 start 起连续 n 个工作日(仅用于构造库内历史, 不追求节假日精确)。"""
    d = date.fromisoformat(start)
    out: list[str] = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def test_backfill_daily_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    calls: list[tuple[str, str | None]] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append((code, start_date))
        return [{"date": "2024-01-02", "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1}]

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    result = jobs.backfill_daily()
    assert result["rows"] == 1
    assert calls[0][1] == jobs.KLINE_START_DATE  # 无历史 → 从 2004 全量拉(反向取到上市日即停)
    # 已有历史 → 只按最新日次日增量; 行数少不再当作截断
    jobs.backfill_daily()
    assert calls[1][1] == "2024-01-03"
    assert daily_repo.coverage("510300")["rows"] == 1


def test_backfill_daily_advances_after_full_history(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    days = [f"{y}-{m:02d}-{d:02d}" for y in (2022, 2023, 2024) for m in range(1, 13) for d in range(1, 29)]
    daily_repo.upsert_rows("510300", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == "2024-12-29"  # 已足够长 → 只从最新日次日增量


def test_backfill_daily_extends_truncated_history(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510050", "name": "上证50ETF"}])
    days = business_days("2015-01-05", 700)  # 起点正好停在旧回填下限 → 判定为被截断
    daily_repo.upsert_rows("510050", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == jobs.KLINE_START_DATE  # 从 2004 重拉, 向前补深


def test_backfill_daily_keeps_short_fresh_history_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "159123", "name": "次新ETF"}])
    days = business_days("2025-12-01", 237)  # 上市晚、历史短但完整(预热快照里的典型次新标的)
    calendar_repo.replace_all(days)
    daily_repo.upsert_rows("159123", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == (date.fromisoformat(days[-1]) + timedelta(days=1)).isoformat()


def test_backfill_daily_repairs_interrupted_history(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "512100", "name": "中证1000ETF"}])
    days = business_days("2024-01-01", 260)
    calendar_repo.replace_all(days)
    daily_repo.upsert_rows("512100", [{"date": d, "close": 1.0} for d in days[::5]])  # 历史拉取中途中断
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == jobs.KLINE_START_DATE  # 区间内缺根过多 → 全量重拉修复


def test_backfill_daily_sends_old_listing_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "159901", "name": "深证100ETF"}])
    days = business_days("2010-01-04", 700)  # 2015 前上市且起点不是旧下限 → 正常增量
    daily_repo.upsert_rows("159901", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == (date.fromisoformat(days[-1]) + timedelta(days=1)).isoformat()


def test_final_bar_ready_boundary() -> None:
    assert not jobs.final_bar_ready(datetime(2026, 11, 19, 16, 14))  # noqa: DTZ001 - 与应用内 naive 本地时间一致
    assert jobs.final_bar_ready(datetime(2026, 11, 19, 16, 15))  # noqa: DTZ001


def test_backfill_daily_refreshes_today_after_final_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """当天K线已入库也要重拉: 盘中快照必须被收盘终值覆盖(最后一次落库在16:15之后)。"""
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    today = jobs._today()
    daily_repo.upsert_rows("510300", [{"date": today, "close": 1.0}])
    calls: list[tuple[str | None, str | None]] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append((start_date, end_date))
        return [{"date": today, "open": 1, "close": 1.2, "high": 1.2, "low": 1, "volume": 10}]

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    monkeypatch.setattr(jobs, "final_bar_ready", lambda now=None: True)
    jobs.backfill_daily()
    assert calls == [(today, today)]
    assert daily_repo.history("510300")[-1]["close"] == 1.2


def test_backfill_daily_skips_today_before_final_time(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    today = jobs._today()
    daily_repo.upsert_rows("510300", [{"date": today, "close": 1.0}])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    monkeypatch.setattr(jobs, "final_bar_ready", lambda now=None: False)
    jobs.backfill_daily()
    assert calls == []
    assert daily_repo.history("510300")[-1]["close"] == 1.0


def test_backfill_shares_reruns_recent_days(monkeypatch: pytest.MonkeyPatch) -> None:
    days = business_days("2025-01-02", 5)
    calendar_repo.replace_all(days)
    pulled: list[str] = []

    def fake_shares(day: str) -> dict:
        pulled.append(day)
        return {}

    monkeypatch.setattr(jobs.shares_repo, "existing_dates", lambda: set(days[:-1]))
    monkeypatch.setattr(jobs.shares_repo, "upsert_day", lambda d, got, known: 0)
    monkeypatch.setattr(jobs.shares_fetch, "fetch_shares_for_date", fake_shares)
    jobs.backfill_shares(recent_days=2, end_date=days[-1])
    # 缺失的最后一天 + 强制重拉的最近两天, 去重后按日期序执行
    assert pulled == [days[-2], days[-1]]


def test_refresh_etf_list_empty_keeps_state(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    monkeypatch.setattr(jobs.list_fetch, "fetch_etf_list", lambda: [])
    result = jobs.refresh_etf_list()
    assert result["added"] == 0 and "error" in result
    assert etf_repo.all_codes() == ["510300"]


def test_history_repo_used_by_api() -> None:
    etf_repo.upsert_list([{"code": "588000", "name": "科创50ETF"}])
    daily_repo.upsert_rows("588000", [{"date": "2024-01-02", "close": 1.0}])
    assert daily_repo.history("588000")[0]["close"] == 1.0
```

<a id="file-backend-tests-test-kline-py"></a>

#### `backend/tests/test_kline.py`

```python
"""腾讯K线解析、市场前缀与日期分块的单元测试(不触网)。"""

from __future__ import annotations

import pytest

from data.fetch import kline


def test_market_prefix() -> None:
    assert kline._market_prefix("510300") == "sh"
    assert kline._market_prefix("588000") == "sh"
    assert kline._market_prefix("159915") == "sz"
    with pytest.raises(ValueError):
        kline._market_prefix("600519")


def test_parse_tencent_rows_qfq_and_raw() -> None:
    data = {
        "data": {
            "sh510300": {
                "qfqday": [["2024-01-02", "1.0", "1.1", "1.2", "0.9", "1000"]],
                "day": [["2024-01-02", "2.0", "2.1", "2.2", "1.9", "1000"]],
            }
        }
    }
    rows = kline._parse_tencent_rows("sh510300", data, "qfq")
    assert rows == [{"date": "2024-01-02", "open": 1.0, "close": 1.1, "high": 1.2, "low": 0.9, "volume": 1000.0}]
    raw_rows = kline._parse_tencent_rows("sh510300", data, "bfq")
    assert raw_rows[0]["close"] == 2.1


def test_windows_desc_cover_backwards() -> None:
    windows = kline._iter_windows_desc("2020-01-01", "2024-12-31")
    assert windows[0][1] == "2024-12-31"  # 从最新往前
    assert windows[-1][0] == "2020-01-01"
    for (s1, _e1), (_s2, e2) in zip(windows, windows[1:]):
        assert s1 > e2  # 块间不重叠
    for ws, we in windows:
        assert ws <= we


def test_fetch_kline_stops_at_listing_day(monkeypatch: pytest.MonkeyPatch) -> None:
    """新标的: 最新块不足 limit 且首根晚于窗口起点 → 判定已到上市首日, 不再往前拉。"""
    calls: list[str] = []

    def fake_fetch(symbol: str, urls: tuple[str, ...], fq: str = "qfq") -> list[dict]:
        ws, we = urls[0].split("day,")[1].split(",")[:2]
        calls.append(ws)
        return [{"date": "2025-03-03", "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1}]

    monkeypatch.setattr(kline, "_fetch_tencent", fake_fetch)
    rows = kline.fetch_kline("159001", start_date="2015-01-01", end_date="2026-11-13")
    assert len(calls) == 1  # 首块即停
    assert len(rows) == 1


def test_fetch_kline_range_dedup(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_fetch(symbol: str, urls: tuple[str, ...], fq: str = "qfq") -> list[dict]:
        url = urls[0]
        calls.append(url)
        ws = url.split("day,")[1].split(",")[0]
        we = url.split("day,")[1].split(",")[1]
        return [
            {"date": ws, "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1},
            {"date": we, "open": 2, "close": 2, "high": 2, "low": 2, "volume": 2},
        ]

    monkeypatch.setattr(kline, "_fetch_tencent", fake_fetch)
    rows = kline.fetch_kline("510300", start_date="2020-01-01", end_date="2024-12-31")
    dates = [r["date"] for r in rows]
    assert len(calls) == 3  # 5 年区间按 850 自然日切 3 块
    assert len(dates) == len(set(dates))  # 跨块重叠日期被去重
    assert dates == sorted(dates)


def test_blocked_streak_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """连续失败达阈值即中止本轮, 避免限流期间把上千只标的空跑一遍。"""

    def always_fail(symbol: str, urls: tuple[str, ...], fq: str = "qfq") -> list[dict]:
        kline._streak += 1
        we = urls[0].split("day,")[1].split(",")[1]
        return [{"date": we, "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1}] * kline.RANGE_CHUNK_LIMIT

    monkeypatch.setattr(kline, "_fetch_tencent", always_fail)
    monkeypatch.setattr(kline, "_streak", kline.MAX_CONSECUTIVE_FAIL - 1)
    with pytest.raises(kline.KlineBlocked):
        kline.fetch_kline("510300", start_date="2020-01-01", end_date="2022-12-31")
    monkeypatch.setattr(kline, "_streak", 0)
```

<a id="file-backend-tests-test-kline-states-py"></a>

#### `backend/tests/test_kline_states.py`

```python
"""信号日 MACD 状态: 四象限趋势分、周期权重与月线当月至今口径(防后视镜)。"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

import pytest

from data.store.database import get_conn
from services.kline import aggregate, macd, states
from services.scoring import features


def _state(zone: str, trend: str) -> dict:
    return {"zone": zone, "trend": trend}


def test_trend_score_follows_signed_direction() -> None:
    empty = {"week": None, "month": None}
    # 水上走强满分; 红柱缩短动能衰减不奖不罚; 水下两象限均扣分(绿柱缩短是阴跌中继, 非见底)
    assert states.trend_score({**empty, "day": _state("above", "rising")}) == 0.6
    assert states.trend_score({**empty, "day": _state("above", "falling")}) == 0.0
    assert states.trend_score({**empty, "day": _state("below", "rising")}) == -0.3
    assert states.trend_score({**empty, "day": _state("below", "falling")}) == -0.6
    # 零轴/柱体持平不猜测方向
    assert states.trend_score({**empty, "day": _state("zero", "falling")}) == 0.0
    assert states.trend_score({**empty, "day": _state("above", "flat")}) == 0.0


def test_trend_score_penalizes_zero_cross_reversal() -> None:
    """柱体由 +0.0001 翻到 -0.0021: 绝对值放大, 但方向是转空, 必须扣分。"""
    bars = [
        {"date": "2024-01-01", "dif": 0.008, "dea": 0.0075, "hist": 0.0001},
        {"date": "2024-01-02", "dif": 0.006, "dea": 0.007, "hist": -0.0021},
    ]
    day = macd.state(bars)
    assert day is not None and day["zone"] == "below"
    assert day["trend"] == "falling" and day["flip"] == "dead"
    assert states.trend_score({"day": day, "week": None, "month": None}) == -0.6


def test_period_weight_day_doubles_week() -> None:
    assert states.PERIOD_WEIGHTS["day"] == 2 * states.PERIOD_WEIGHTS["week"]
    assert states.PERIOD_WEIGHTS["week"] > states.PERIOD_WEIGHTS["month"] > 0
    assert round(sum(states.PERIOD_WEIGHTS.values()), 4) == 1.0
    all_bonus = states.trend_score(
        {
            "day": _state("above", "rising"),
            "week": _state("above", "rising"),
            "month": _state("above", "rising"),
        }
    )
    assert all_bonus == round(sum(states.PERIOD_WEIGHTS.values()), 4)


def _month_days(months: int) -> list[list[str]]:
    grouped: dict[tuple[int, int], list[str]] = {}
    day = date(2018, 1, 1)
    while len(grouped) <= months:  # 多走一个月, 保证第 months 个月完整
        if day.weekday() < 5:
            grouped.setdefault((day.year, day.month), []).append(day.isoformat())
        day += timedelta(days=1)
    return list(grouped.values())[:months]


def _seed(conn: sqlite3.Connection) -> tuple[str, str, float, float]:
    """40 个月日线; 信号取最后一个月的周五(周线完整), 信号之后暴跌到月末。"""
    months = _month_days(40)
    last = months[-1]
    signal_offset = max(i for i, day in enumerate(last[:-3]) if date.fromisoformat(day).weekday() == 4)
    base = 100 + (len(months) - 1) * 2
    closes: dict[str, float] = {}
    with conn:
        for index, days in enumerate(months):
            for offset, day in enumerate(days):
                close: float
                if index < len(months) - 1:
                    close = 100 + index * 2
                elif offset <= signal_offset:
                    close = base + offset
                else:
                    close = 1.0
                closes[day] = close
                conn.execute(
                    "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, ?, ?, ?)",
                    (day, "510300", close, 1_000_000),
                )
    signal, month_end = last[signal_offset], last[-1]
    return signal, month_end, closes[signal], closes[month_end]


def test_month_state_uses_month_to_date_close() -> None:
    conn = get_conn()
    signal, month_end, signal_close, month_end_close = _seed(conn)
    full = states.MacdStateProvider.load(conn, month_end)

    at_signal = full.states("510300", signal, signal_close)
    assert at_signal["day"] is not None and at_signal["week"] is not None and at_signal["month"] is not None

    # 用信号日之后的数据重算, 信号日的月线状态必须完全不变
    with conn:
        conn.execute("DELETE FROM etf_daily WHERE date > ?", (signal,))
    truncated = states.MacdStateProvider.load(conn, signal)
    assert truncated.states("510300", signal, signal_close) == at_signal

    # 月末崩溃不得回灌到月中信号: 月末状态必须与信号日不同
    at_month_end = full.states("510300", month_end, month_end_close)
    assert at_month_end["month"] is not None
    assert at_month_end["month"]["hist"] != at_signal["month"]["hist"]


def _weekday_bars(days: int) -> list[tuple[str, float]]:
    """确定性涨跌交替的日线, 末尾对齐到周五, 保证信号周是完整周。"""
    out: list[tuple[str, float]] = []
    day = date(2019, 1, 7)  # 周一
    price = 100.0
    while len(out) < days or day.weekday() != 4:
        if day.weekday() < 5:
            price *= 1.004 if len(out) % 9 < 6 else 0.997
            out.append((day.isoformat(), round(price, 4)))
        day += timedelta(days=1)
    return out


def test_week_state_uses_previous_two_completed_weeks() -> None:
    conn = get_conn()
    bars = _weekday_bars(260)
    with conn:
        conn.executemany(
            "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, '510300', ?, 1000000)",
            bars,
        )
    signal, close = bars[-1]
    provider = states.MacdStateProvider.load(conn, signal)
    week_state = provider.states("510300", signal, close)["week"]

    weeks = macd.attach(aggregate.resample([{"date": d, "close": c} for d, c in bars], "week"))
    assert week_state is not None
    # 信号周(与信号同日收盘)不参与周线判断, 回退到上周 vs 上上周
    assert week_state["date"] == weeks[-2]["date"]
    assert week_state["hist"] == pytest.approx(weeks[-2]["hist"])
    expected = "rising" if weeks[-2]["hist"] > weeks[-3]["hist"] else "falling"
    assert week_state["trend"] == expected
    # 日线仍以信号日收盘为准
    day_state = provider.states("510300", signal, close)["day"]
    assert day_state is not None and day_state["date"] == signal


def test_score_uses_trend_as_main_factor() -> None:
    def row(code: str, trend: float) -> dict:
        return {
            "code": code,
            "r5": 0.01,
            "r20": 0.05,
            "r60": 0.10,
            "vol20": 0.20,
            "flow_5d": 0.0,
            "aum_yi": 10.0,
            "trend_score": trend,
            "macd_states": {},
        }

    rows = [row("510300", -0.5), row("510500", 0.5)]
    features.score(rows)
    first, second = rows
    assert first["core_score"] == second["core_score"] == 0.0
    # 趋势分占 60%: ±0.5 的趋势差直接拉开 ±0.3 的综合分
    assert first["baseline_score"] == -0.3 and second["baseline_score"] == 0.3
```

<a id="file-backend-tests-test-live-rows-py"></a>

#### `backend/tests/test_live_rows.py`

```python
"""盘中实时全量排名行: 与收盘筛选同构的 stage/排序/行情字段语义(纯函数, 不触网)。"""

from __future__ import annotations

from typing import Any

import pytest

from pages.daily.live import rows
from services.scoring import features

TODAY = "2026-11-18"
EQUITY = features.DOMESTIC_EQUITY


def _meta(code: str, name: str, fund_type: str = EQUITY) -> dict[str, Any]:
    return {"name": name, "fund_type": fund_type}


def _bars(last: str, n: int = features.MIN_BARS + 5) -> list[dict[str, Any]]:
    return [{"date": f"2026-10-{i % 28 + 1:02d}"} for i in range(n - 1)] + [{"date": last}]


def _row(code: str, baseline: float, aum: float = 5.0) -> dict[str, Any]:
    return {"code": code, "aum_yi": aum, "baseline_score": baseline, "shares_yi": 3.0}


def _scored(code: str, rank: int) -> dict[str, Any]:
    return {
        "code": code,
        "core_rank": rank,
        "core_score": 0.5,
        "core_factors": [],
        "name": code,
        "theme": "其他",
        "fund_type": EQUITY,
        "baseline_score": 0.0,
    }


@pytest.fixture(autouse=True)
def _stub_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    """reason 组装由 weekly.reasons 单测覆盖, 这里只验证行结构语义。"""
    monkeypatch.setattr(rows, "reason_json", lambda row, flags: {"stub": True})
    monkeypatch.setattr(rows, "reason_text", lambda row, rank: "stub")
    monkeypatch.setattr(rows.core_reason, "reason_text", lambda row, rank, held: "stub")


def test_stages_follow_screen_semantics() -> None:
    meta = {
        "510300": _meta("510300", "沪深300ETF"),
        "512100": _meta("512100", "中证1000ETF"),
        "510880": _meta("510880", "红利ETF"),
        "513100": _meta("513100", "纳指ETF"),
        "511010": _meta("511010", "国债ETF", fund_type="债券型"),
        "520990": _meta("520990", "港股创新药ETF"),
    }
    daily_all = {
        "510300": _bars(TODAY),  # 有今日 bar → 可评分
        "512100": _bars("2026-11-17"),  # 停在昨日 → 今日无 bar
        "510880": _bars(TODAY),
    }
    feature_rows = [_row("510300", 0.9), _row("510880", 0.1, aum=1.0)]  # 510880 规模不足
    candidates = [_row("510300", 0.9)]
    scored = [_scored("510300", 1)]
    held_codes = {"510300"}
    quotes = {"510300": {"price": 4.0, "pct": 0.01, "time": f"{TODAY} 14:00:00"}}

    items = rows.build_rows(meta, daily_all, feature_rows, candidates, scored, held_codes, quotes, TODAY)
    by_code = {r["code"]: r for r in items}

    assert by_code["510300"]["stage"] == "core_hold"
    assert by_code["510300"]["quote"] == {"price": 4.0, "pct": 0.01, "time": f"{TODAY} 14:00:00"}
    assert by_code["512100"]["stage"] == "no_bar"  # 昨日有K线 ≠ 今日有bar
    assert by_code["510880"]["stage"] == "small_aum"
    assert by_code["513100"]["stage"] == "no_bar"  # 有历史但今日未更新, 不会误标 core_pool
    assert by_code["511010"]["stage"] == "non_equity"
    assert by_code["520990"]["stage"] == "hk"


def test_rows_sorted_by_baseline_rank() -> None:
    meta = {"AAA": _meta("AAA", "AETF"), "BBB": _meta("BBB", "BETF"), "CCC": _meta("CCC", "CETF")}
    daily_all = {c: _bars(TODAY) for c in meta}
    feature_rows = [_row("AAA", 0.5), _row("BBB", 0.9), _row("CCC", 0.7)]
    candidates = list(feature_rows)
    scored = [_scored("BBB", 1), _scored("CCC", 2), _scored("AAA", 3)]

    items = rows.build_rows(meta, daily_all, feature_rows, candidates, scored, set(), {}, TODAY)

    assert [r["code"] for r in items] == ["BBB", "CCC", "AAA"]
    assert [r["rank"] for r in items] == [1, 2, 3]
    assert items[0]["stage"] == "core_pool"


def test_stale_quote_not_attached() -> None:
    meta = {"AAA": _meta("AAA", "AETF")}
    daily_all = {"AAA": _bars(TODAY)}
    feature_rows = [_row("AAA", 0.5)]
    stale = {"AAA": {"price": 4.0, "pct": 0.01, "time": "2026-11-17 15:00:00"}}

    items = rows.build_rows(meta, daily_all, feature_rows, feature_rows, [_scored("AAA", 1)], set(), stale, TODAY)

    assert items[0]["quote"] is None
```

<a id="file-backend-tests-test-macd-py"></a>

#### `backend/tests/test_macd.py`

```python
"""周/月K聚合与 MACD 指标: 分组边界、预热期、收敛扩散与水上水下判定。"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from services.kline import aggregate, macd


def _bar(day: str, close: float, open_: float | None = None, volume: float = 10.0) -> dict:
    return {
        "date": day,
        "open": close if open_ is None else open_,
        "close": close,
        "high": close + 1,
        "low": close - 1,
        "volume": volume,
    }


def _series(count: int, start: date = date(2024, 1, 1)) -> list[dict]:
    return [_bar((start + timedelta(days=index)).isoformat(), 1.0 + index * 0.1) for index in range(count)]


def test_resample_week_uses_iso_week_and_last_trading_day() -> None:
    bars = [
        _bar("2020-12-30", 10.0, open_=9.0, volume=1.0),
        _bar("2020-12-31", 11.0, volume=2.0),
        _bar("2021-01-04", 12.0, open_=11.5, volume=3.0),
        _bar("2021-01-08", 13.0, volume=4.0),
    ]
    weekly = aggregate.resample(bars, "week")
    assert [bar["date"] for bar in weekly] == ["2020-12-31", "2021-01-08"]
    assert weekly[0]["open"] == 9.0
    assert weekly[0]["close"] == 11.0
    assert weekly[0]["high"] == 12.0  # 组内最高价
    assert weekly[0]["low"] == 9.0
    assert weekly[0]["volume"] == 3.0
    assert weekly[1]["open"] == 11.5 and weekly[1]["close"] == 13.0


def test_resample_month_and_day() -> None:
    bars = [_bar("2024-01-31", 10.0), _bar("2024-02-01", 11.0), _bar("2024-02-29", 12.0)]
    monthly = aggregate.resample(bars, "month")
    assert [bar["date"] for bar in monthly] == ["2024-01-31", "2024-02-29"]
    assert monthly[1]["open"] == 11.0 and monthly[1]["close"] == 12.0
    assert aggregate.resample(bars, "day") == bars
    with pytest.raises(ValueError):
        aggregate.resample(bars, "quarter")


def test_macd_warmup_hides_unreliable_values() -> None:
    enriched = macd.attach(_series(40))
    assert enriched[macd.SLOW - 2]["dif"] is None
    assert enriched[macd.SLOW - 1]["dif"] is not None
    assert enriched[macd.SLOW - 1]["hist"] is None
    assert enriched[macd.MIN_BARS - 1]["hist"] is None
    assert enriched[macd.MIN_BARS]["hist"] is not None
    assert enriched[-1]["dif"] > 0 and enriched[-1]["dea"] > 0


def test_macd_state_trend_and_zone() -> None:
    def bars(hist: list[float], dif: float, dea: float) -> list[dict]:
        return [
            {"date": f"2024-01-0{index + 1}", "dif": dif, "dea": dea, "hist": value} for index, value in enumerate(hist)
        ]

    rising = macd.state(bars([0.1, 0.3], 0.8, 0.4))
    assert rising is not None
    assert rising["trend"] == "rising" and rising["zone"] == "above" and rising["flip"] is None

    falling = macd.state(bars([0.5, 0.2], 0.8, 0.4))
    assert falling is not None and falling["trend"] == "falling"

    below = macd.state(bars([-0.1, -0.2], -0.5, -0.3))
    assert below is not None and below["trend"] == "falling" and below["zone"] == "below"

    # 定区看柱体符号而非 DIF/DEA: dif>0 而 dea<0 但柱体为正, 仍是水上
    cross = macd.state(bars([0.1, 0.2], 0.3, -0.1))
    assert cross is not None and cross["zone"] == "above"

    zero = macd.state(bars([0.1, 0.0], 0.3, 0.3))
    assert zero is not None and zero["zone"] == "zero" and zero["trend"] == "falling"


def test_macd_state_treats_zero_cross_as_reversal_not_expansion() -> None:
    """柱体由 +0.001 翻到 -0.002: 绝对值放大, 但方向是转空, 必须判走弱/死叉。"""
    bars = [
        {"date": "2024-01-01", "dif": 0.008, "dea": 0.0075, "hist": 0.001},
        {"date": "2024-01-02", "dif": 0.006, "dea": 0.007, "hist": -0.002},
    ]
    state = macd.state(bars)
    assert state is not None
    assert state["zone"] == "below"  # 柱体已翻绿, 按柱体符号属水下
    assert state["trend"] == "falling" and state["flip"] == "dead"

    recovery = macd.state([bars[1], bars[0]])
    assert recovery is not None and recovery["trend"] == "rising" and recovery["flip"] == "golden"


def test_macd_state_requires_two_warm_bars() -> None:
    assert macd.state([]) is None
    assert macd.state([{"date": "2024-01-01", "dif": 0.1, "dea": 0.1, "hist": 0.0}]) is None
    assert macd.state([{"date": "2024-01-01", "hist": None}, {"date": "2024-01-02", "hist": 0.1}]) is None


def test_attach_forward_fills_missing_close() -> None:
    bars = _series(40)
    bars[10]["close"] = None
    enriched = macd.attach(bars)
    # 缺失收盘不产生 NaN 断层, 预热完成后 MACD 仍连续
    assert enriched[macd.MIN_BARS]["hist"] is not None
    assert enriched[-1]["dif"] is not None
```

<a id="file-backend-tests-test-ranks-py"></a>

#### `backend/tests/test_ranks.py`

```python
"""截面秩: 并列取平均、乱序输入与小样本口径。"""

from __future__ import annotations

import math

import pytest

from services.scoring.core.score import rank_z
from services.scoring.ranks import average_ranks


def test_average_ranks_ties_share_mean_rank() -> None:
    assert average_ranks([10.0, 20.0, 20.0, 30.0]) == [1.0, 2.5, 2.5, 4.0]


def test_average_ranks_follows_value_order() -> None:
    assert average_ranks([3.0, 1.0, 2.0]) == [3.0, 1.0, 2.0]


def test_rank_z_is_monotone_and_neutral_for_missing() -> None:
    values = [math.nan] + [float(i) for i in range(20)]

    z = rank_z(values)

    assert z[0] == 0.0
    assert z[1] < z[20]
    assert min(z[1:]) >= -1.0
    assert max(z[1:]) <= 1.0


def test_rank_z_centre_is_zero() -> None:
    z = rank_z([float(i) for i in range(21)])

    assert z[10] == pytest.approx(0.0)
```

<a id="file-backend-tests-test-realtime-py"></a>

#### `backend/tests/test_realtime.py`

```python
"""腾讯实时行情解析、交易时段判定与批量缓存的单元测试(不触网)。"""

from __future__ import annotations

from datetime import datetime

import pytest

from data.fetch import realtime


def _line(**overrides: str) -> str:
    fields = ["0"] * 60
    fields[1] = "沪深300ETF"
    fields[2] = "510300"
    fields[3] = "4.123"
    fields[4] = "4.100"
    fields[5] = "4.105"
    fields[6] = "123456"
    fields[30] = "20261116142109"
    fields[31] = "0.023"
    fields[32] = "0.56"
    fields[33] = "4.130"
    fields[34] = "4.090"
    fields[37] = "50000"
    for key, value in overrides.items():
        fields[int(key)] = value
    return f'v_sh510300="{"~".join(fields)}";'


def test_market_prefix() -> None:
    assert realtime._market_prefix("510300") == "sh"
    assert realtime._market_prefix("588000") == "sh"
    assert realtime._market_prefix("159915") == "sz"
    with pytest.raises(ValueError):
        realtime._market_prefix("600519")


def test_parse_line() -> None:
    parsed = realtime._parse_line(_line())
    assert parsed is not None
    code, quote = parsed
    assert code == "510300"
    assert quote["name"] == "沪深300ETF"
    assert quote["price"] == 4.123
    assert quote["prev_close"] == 4.100
    assert quote["open"] == 4.105
    assert quote["high"] == 4.130
    assert quote["low"] == 4.090
    assert quote["change"] == 0.023
    assert quote["pct"] == pytest.approx(0.0056)  # 腾讯给百分数, 统一转成小数
    assert quote["volume"] == 123456.0
    assert quote["amount_wan"] == 50000.0
    assert quote["time"] == "2026-11-16 14:21:09"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "garbage",
        'v_sh510300="1~2";',  # 字段不足
        _line(**{"3": "0.000"}),  # 停牌/无效: 现价<=0
        _line(**{"3": ""}),
    ],
)
def test_parse_line_rejects_invalid(raw: str) -> None:
    assert realtime._parse_line(raw) is None


@pytest.mark.parametrize(
    ("stamp", "expected"),
    [
        ("2026-11-16 09:14", False),
        ("2026-11-16 09:15", True),
        ("2026-11-16 11:30", False),
        ("2026-11-16 13:00", True),
        ("2026-11-16 14:59", True),
        ("2026-11-16 15:00", False),
        ("2026-11-14 10:00", False),  # 周六
    ],
)
def test_is_trading_time(stamp: str, expected: bool) -> None:
    now = datetime.strptime(stamp, "%Y-%m-%d %H:%M")
    assert realtime.is_trading_time(now) is expected


def test_fetch_quotes_dedupes_and_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_batch(codes: list[str]) -> dict[str, realtime.Quote]:
        calls.append(list(codes))
        return {code: {"price": 1.0} for code in codes}

    monkeypatch.setattr(realtime, "_CACHE", {})
    monkeypatch.setattr(realtime, "_fetch_batch", fake_batch)

    first = realtime.fetch_quotes(["510300", "510300", "159915"])
    assert calls == [["510300", "159915"]]
    assert set(first) == {"510300", "159915"}

    second = realtime.fetch_quotes(["510300", "159915"])
    assert len(calls) == 1  # TTL 内命中缓存, 不重复触网
    assert second == first


def test_fetch_quotes_keeps_stale_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(codes: list[str]) -> dict[str, realtime.Quote]:
        raise RuntimeError("network down")

    monkeypatch.setattr(realtime, "_CACHE", {"510300": (0.0, {"price": 3.0})})
    monkeypatch.setattr(realtime, "_fetch_batch", boom)

    assert realtime.fetch_quotes(["510300"])["510300"]["price"] == 3.0
    assert realtime.fetch_quotes(["159915"]) == {}  # 无缓存时返回空, 不抛错


def _quote(**overrides: float | str | None) -> realtime.Quote:
    quote: realtime.Quote = {
        "time": "2026-11-16 14:25:48",
        "price": 1.05,
        "open": 1.01,
        "high": 1.06,
        "low": 1.0,
        "volume": 123.0,
    }
    quote.update(overrides)
    return quote


def test_with_live_bar_appends_today(monkeypatch: pytest.MonkeyPatch) -> None:
    from pages.etf import router as etfs

    rows = [{"date": "2026-11-13", "open": 1.0, "close": 1.0, "high": 1.0, "low": 1.0, "volume": 1.0}]
    monkeypatch.setattr(etfs.realtime, "fetch_quotes", lambda codes: {"515170": _quote()})

    out = etfs._with_live_bar("515170", rows)
    assert len(out) == 2
    assert out[-1] == {
        "date": "2026-11-16",
        "open": 1.01,
        "close": 1.05,
        "high": 1.06,
        "low": 1.0,
        "volume": 123.0,
    }
    assert etfs._with_live_bar("515170", out) == out  # 库里已有当日K线, 不重复追加


def test_with_live_bar_skips_without_quote(monkeypatch: pytest.MonkeyPatch) -> None:
    from pages.etf import router as etfs

    rows = [{"date": "2026-11-13", "open": 1.0, "close": 1.0, "high": 1.0, "low": 1.0, "volume": 1.0}]
    monkeypatch.setattr(etfs.realtime, "fetch_quotes", lambda codes: {})

    assert etfs._with_live_bar("515170", rows) == rows


def test_live_bar_falls_back_to_price_when_fields_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    from pages.etf import router as etfs

    quote = _quote(open=0.0, high=None, low="bad", volume=0.0)
    monkeypatch.setattr(etfs.realtime, "fetch_quotes", lambda codes: {"515170": quote})

    bar = etfs._live_bar("515170")
    assert bar is not None
    assert bar["open"] == 1.05 and bar["high"] == 1.05 and bar["low"] == 1.05
    assert bar["volume"] == 0.0
```

<a id="file-backend-tests-test-refresh-scheduler-py"></a>

#### `backend/tests/test_refresh_scheduler.py`

```python
"""收盘自动刷新链的调度判定: 槽位是否到期、日度记录从哪天开始重算。"""

from __future__ import annotations

import sqlite3
from datetime import datetime

import pytest

from data.store import calendar_repo
from data.store.database import get_conn
from ops import refresh_chain, scheduler
from services.scoring.core import store as core_store

NODE_DAYS = ["2015-01-05", "2015-01-06", "2015-01-07", "2015-01-08", "2015-01-09", "2015-01-12"]


def _seed_node(conn: sqlite3.Connection, node: str = NODE_DAYS[-1], complete: int = 0) -> None:
    calendar_repo.replace_all(NODE_DAYS)
    core_store.replace_node(
        conn,
        {
            "signal_date": node,
            "next_rebalance": None,
            "generated_at": "x",
            "rule_version": "core8-v1",
            "scored": 0,
            "min_aum_yi": 2.0,
            "complete": bool(complete),
        },
        [],
    )


def _seed_shares(conn: sqlite3.Connection, day: str) -> None:
    with conn:
        conn.execute("INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, '510300', 10)", (day,))


@pytest.fixture(autouse=True)
def _reset_slots() -> None:
    scheduler._DONE.clear()  # noqa: SLF001 - 测试直接复位模块状态
    scheduler._ATTEMPTS.clear()  # noqa: SLF001
    scheduler._COOLDOWN_UNTIL.clear()  # noqa: SLF001


def _at(hour: int, minute: int) -> datetime:
    return datetime(2026, 11, 18, hour, minute)  # noqa: DTZ001 - 与应用内 naive 本地时间一致


def test_due_slot_shares_before_dawn() -> None:
    assert scheduler._due_slot(_at(0, 19)) is None
    assert scheduler._due_slot(_at(0, 20)) == "shares"
    scheduler._DONE["shares"] = "2026-11-18"
    assert scheduler._due_slot(_at(0, 25)) is None


def test_due_slot_close_then_late() -> None:
    scheduler._DONE["shares"] = "2026-11-18"
    assert scheduler._due_slot(_at(18, 29)) is None
    assert scheduler._due_slot(_at(19, 0)) == "close"
    scheduler._DONE["close"] = "2026-11-18"
    assert scheduler._due_slot(_at(19, 0)) is None
    assert scheduler._due_slot(_at(22, 30)) == "late"
    scheduler._DONE["late"] = "2026-11-18"
    assert scheduler._due_slot(_at(23, 0)) is None


def test_records_start_prefers_gap_before_first_missing() -> None:
    conn = get_conn()
    days = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08"]
    calendar_repo.replace_all(days)
    with conn:
        conn.executemany(
            "INSERT INTO fitted_daily_summary (signal_date, generated_at) VALUES (?, ?)",
            [(d, "x") for d in days[:-2]],
        )
    assert refresh_chain.records_start(conn, days, days[-1]) == days[-3]


def test_records_start_recomputes_tail_when_complete() -> None:
    conn = get_conn()
    days = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08"]
    calendar_repo.replace_all(days)
    with conn:
        conn.executemany(
            "INSERT INTO fitted_daily_summary (signal_date, generated_at) VALUES (?, ?)",
            [(d, "x") for d in days],
        )
    assert refresh_chain.records_start(conn, days, days[-1]) == days[-2]


def test_records_start_heals_days_missing_index_returns() -> None:
    conn = get_conn()
    days = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08"]
    calendar_repo.replace_all(days)
    with conn:
        conn.executemany(
            "INSERT INTO fitted_daily_summary (signal_date, next_signal, generated_at, index_returns_json)"
            " VALUES (?, ?, ?, ?)",
            [(d, days[i + 1] if i + 1 < len(days) else None, "x", "{}") for i, d in enumerate(days)],
        )
        conn.executemany(
            "INSERT INTO index_daily (code, date, close) VALUES ('000300', ?, 1.0)",
            [(d,) for d in days],
        )
    # 指数已落库但结算行是空指数收益 → 从最早那天重算(不只最近两天)
    assert refresh_chain.records_start(conn, days, days[-1]) == days[0]


def test_records_start_ignores_days_before_default() -> None:
    conn = get_conn()
    days = ["2014-12-30", "2014-12-31"]
    assert refresh_chain.records_start(conn, days, days[-1]) is None


def test_final_node_needs_rebuild_only_after_final_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """当天本身是换仓节点: 16:15 之后要用收盘终值重算, 之前是盘中快照不动。"""
    conn = get_conn()
    node = NODE_DAYS[-1]
    _seed_node(conn, node)

    monkeypatch.setattr(refresh_chain.raw_jobs, "final_bar_ready", lambda now=None: False)
    assert not refresh_chain._final_node_needs_rebuild(conn, NODE_DAYS, node)  # noqa: SLF001

    monkeypatch.setattr(refresh_chain.raw_jobs, "final_bar_ready", lambda now=None: True)
    assert refresh_chain._final_node_needs_rebuild(conn, NODE_DAYS, node)  # noqa: SLF001
    # 当天不是换仓节点: 节点在上一个换仓日, 与今天的K线无关
    assert not refresh_chain._final_node_needs_rebuild(conn, NODE_DAYS, NODE_DAYS[-2])  # noqa: SLF001


def test_node_to_complete_waits_for_node_day_shares() -> None:
    conn = get_conn()
    node = NODE_DAYS[-1]
    _seed_node(conn, node)
    _seed_shares(conn, NODE_DAYS[-2])

    # 节点日份额还没落地 → 预备目标先撑着, 不重算。
    assert refresh_chain.node_to_complete(conn, NODE_DAYS, node) is None

    _seed_shares(conn, node)

    assert refresh_chain.node_to_complete(conn, NODE_DAYS, node) == node


def test_node_to_complete_skips_complete_node() -> None:
    conn = get_conn()
    node = NODE_DAYS[-1]
    _seed_node(conn, node, complete=1)
    _seed_shares(conn, node)

    assert refresh_chain.node_to_complete(conn, NODE_DAYS, node) is None


def test_node_to_complete_ignores_non_latest_node() -> None:
    conn = get_conn()
    _seed_node(conn, NODE_DAYS[0])  # 库里只有更早的节点, 最新节点还没建
    _seed_shares(conn, NODE_DAYS[-1])

    assert refresh_chain.node_to_complete(conn, NODE_DAYS, NODE_DAYS[-1]) is None


def test_warm_screen_reports_and_swallows_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str | None, str | None]] = []

    def boom(conn: sqlite3.Connection, signal: str | None = None) -> None:
        raise RuntimeError("冷算失败")

    monkeypatch.setattr(refresh_chain.cache, "warm", boom)
    refresh_chain._warm_screen(get_conn(), NODE_DAYS[-1], lambda s, d: events.append((s, d)))  # noqa: SLF001

    assert events[0] == ("screen", f"预热 {NODE_DAYS[-1]} 筛选快照")
    assert "预热失败" in (events[-1][1] or "")


def test_tick_yields_to_running_bootstrap(monkeypatch: pytest.MonkeyPatch) -> None:
    """一键准备运行期间自动链让路; 结束后同一槽位仍会补跑。"""
    from ops import bootstrap

    scheduler._DONE["shares"] = "2026-11-18"  # noqa: SLF001
    calls: list[str] = []

    def fake_chain(slot: str) -> dict:
        calls.append(slot)
        return {}

    monkeypatch.setattr(scheduler, "run_chain", fake_chain)
    monkeypatch.setattr(bootstrap, "status", lambda: {"state": "running"})

    scheduler._tick(_at(19, 0))

    assert calls == []

    monkeypatch.setattr(bootstrap, "status", lambda: {"state": "idle"})
    scheduler._tick(_at(19, 0))

    assert calls == ["close"]
```

<a id="file-backend-tests-test-seed-py"></a>

#### `backend/tests/test_seed.py`

```python
"""预热快照: 导出/装载、数值类型保持、按表跳过与清单缺失降级。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from data.store.database import SCHEMA
from ops import seed
from pages.daily.review.store import ensure_schema as ensure_daily_schema
from services.scoring.core.store import ensure_schema as ensure_core_schema


def _source(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    ensure_core_schema(conn)
    ensure_daily_schema(conn)
    conn.execute("INSERT INTO etfs (code, name, fund_type) VALUES ('510300', '沪深300ETF', 'stock')")
    conn.execute("INSERT INTO trade_calendar (date) VALUES ('2026-11-18')")
    conn.execute(
        "INSERT INTO etf_daily (date, code, open, close, high, low, volume) "
        "VALUES ('2026-11-18', '510300', 4.0, 4.05, 4.1, 3.95, 123456.0)"
    )
    conn.execute("INSERT INTO etf_shares (date, code, shares_yi) VALUES ('2026-11-18', '510300', 12.5)")
    conn.execute(
        "INSERT INTO etf_share_scale (code, date, ratio, method) VALUES ('510300', '2021-05-31', 2.0, 'split')"
    )
    conn.execute("INSERT INTO indices (code, name) VALUES ('000300', '沪深300')")
    conn.execute("INSERT INTO index_daily (date, code, close, pe) VALUES ('2026-11-18', '000300', 4000.5, 12.3)")
    # 派生表: 未来日期的空结算行不得进入快照(否则增量重算会从日历末尾起算)。
    conn.executemany(
        "INSERT INTO fitted_core_summary (signal_date, rule_version) VALUES (?, 'core8-v1')",
        [("2026-11-18",), ("2026-12-31",)],
    )
    conn.execute(
        "INSERT INTO fitted_core_pick (signal_date, code, core_rank, core_score, action) "
        "VALUES ('2026-11-18', '510300', 1, 0.9, 'buy')"
    )
    conn.executemany(
        "INSERT INTO fitted_daily_summary (signal_date, rule_version) VALUES (?, 'daily-core8-v1')",
        [("2026-11-18",), ("2026-12-31",)],
    )
    conn.execute(
        "INSERT INTO fitted_daily_pick (signal_date, bucket, pick_rank, code) "
        "VALUES ('2026-11-18', 'baseline', 1, '510300')"
    )
    conn.commit()
    conn.close()


def _target(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def _built(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    src = tmp_path / "src.db"
    out = tmp_path / "seed"
    _source(src)
    monkeypatch.setattr(seed, "SEED_DIR", out)
    monkeypatch.setattr(seed, "MANIFEST_PATH", out / "manifest.json")
    info = seed.build(src, out)
    assert info["cutoff"] == "2026-11-18"
    return out


def test_build_then_restore_keeps_types(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    out = _built(tmp_path, monkeypatch)
    assert (out / "etf_daily.csv.gz").is_file()
    conn = _target(tmp_path / "target.db")
    result = seed.restore(conn)
    assert result["cutoff"] == "2026-11-18"
    assert result["rows"] == 11
    close = conn.execute("SELECT close FROM etf_daily").fetchone()[0]
    assert isinstance(close, float) and close == pytest.approx(4.05)
    assert conn.execute("SELECT typeof(close) FROM etf_daily").fetchone()[0] == "real"
    assert conn.execute("SELECT shares_yi FROM etf_shares").fetchone()[0] == pytest.approx(12.5)
    assert conn.execute("SELECT pe FROM index_daily").fetchone()[0] == pytest.approx(12.3)


def test_build_restores_derived_tables_without_future_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    seed.restore(conn)  # 空库没有派生表 schema, restore 必须先建表
    for table in ("fitted_core_summary", "fitted_daily_summary"):
        dates = [r[0] for r in conn.execute(f"SELECT signal_date FROM {table} ORDER BY signal_date")]
        assert dates == ["2026-11-18"]
    assert conn.execute("SELECT core_rank FROM fitted_core_pick").fetchone()[0] == 1
    assert conn.execute("SELECT code FROM fitted_daily_pick").fetchone()[0] == "510300"


def test_restore_skips_tables_with_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    conn.execute("INSERT INTO etfs (code, name) VALUES ('159000', '已有标的')")
    conn.commit()
    result = seed.restore(conn)
    assert "etfs" not in result["tables"]
    assert conn.execute("SELECT COUNT(*) FROM etfs").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM etf_daily").fetchone()[0] == 1


def test_restore_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    seed.restore(conn)
    again = seed.restore(conn)
    assert again["skipped"] == "库内已有数据, 无需装载快照"
    assert conn.execute("SELECT COUNT(*) FROM etf_daily").fetchone()[0] == 1


def test_restore_without_manifest_degrades(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seed, "SEED_DIR", tmp_path / "none")
    monkeypatch.setattr(seed, "MANIFEST_PATH", tmp_path / "none" / "manifest.json")
    result = seed.restore(_target(tmp_path / "target.db"))
    assert result["skipped"] == "代码库未附带预热快照, 改为在线全量拉取"


def test_manifest_reports_table_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    info = seed.manifest()
    assert info is not None
    assert info["tables"]["etf_daily"]["rows"] == 1
    assert info["tables"]["fitted_core_summary"]["rows"] == 1
    assert info["tables"]["fitted_daily_pick"]["rows"] == 1
    assert info["derived_cutoff"] == "2026-11-18"
    assert "columns" in info["tables"]["etf_daily"]


def test_restore_degrades_when_snapshot_files_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """只带 manifest 没带 gzip(从文档还原的代码库): 降级在线拉取, 不能抛 FileNotFoundError。"""
    out = _built(tmp_path, monkeypatch)
    (out / "etf_daily.csv.gz").unlink()
    conn = _target(tmp_path / "target.db")
    result = seed.restore(conn)
    assert result["skipped"] == "快照文件缺失(1 个), 改为在线全量拉取"
    assert conn.execute("SELECT COUNT(*) FROM etfs").fetchone()[0] == 0


def test_missing_snapshot_files_ignored_for_tables_with_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    out = _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    seed.restore(conn)
    (out / "etf_daily.csv.gz").unlink()
    again = seed.restore(conn)
    assert again["skipped"] == "库内已有数据, 无需装载快照"
```

<a id="file-backend-tests-test-store-py"></a>

#### `backend/tests/test_store.py`

```python
"""存储层写入语义：COALESCE 不覆盖、覆盖统计、交易日历。"""

from __future__ import annotations

from data.store import calendar_repo, daily_repo, etf_repo, shares_repo
from data.store.database import get_conn


def _seed_etfs() -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}, {"code": "588000", "name": "科创50ETF"}])


def test_upsert_daily_coalesce_not_null() -> None:
    _seed_etfs()
    daily_repo.upsert_rows(
        "510300", [{"date": "2024-01-02", "open": 1.0, "close": 2.0, "high": 2.5, "low": 0.9, "volume": 100.0}]
    )
    # 二次写入缺 close/high/low: 不得把已有值清成 NULL, 同值重复写入不产生新行
    daily_repo.upsert_rows("510300", [{"date": "2024-01-02", "open": 1.1, "volume": None}])
    row = get_conn().execute("SELECT * FROM etf_daily WHERE code='510300' AND date='2024-01-02'").fetchone()
    assert row["open"] == 1.1 and row["close"] == 2.0 and row["high"] == 2.5 and row["volume"] == 100.0
    assert daily_repo.coverage("510300")["rows"] == 1


def test_coverage_and_history_order() -> None:
    _seed_etfs()
    daily_repo.upsert_rows(
        "588000", [{"date": d, "close": float(i)} for i, d in enumerate(["2024-01-02", "2024-01-03"])]
    )
    cov = daily_repo.coverage("588000")
    assert (cov["first_date"], cov["last_date"], cov["rows"]) == ("2024-01-02", "2024-01-03", 2)
    assert [r["date"] for r in daily_repo.history("588000")] == ["2024-01-02", "2024-01-03"]
    assert daily_repo.latest_per_code() == {"588000": "2024-01-03"}
    assert daily_repo.empty_codes(["510300", "588000"]) == ["510300"]


def test_shares_upsert_filters_unknown_codes() -> None:
    _seed_etfs()
    written = shares_repo.upsert_day("2024-01-02", {"510300": 300.0, "999999": 1.0}, set(etf_repo.all_codes()))
    assert written == 1
    assert shares_repo.latest_per_code() == {"510300": "2024-01-02"}


def test_calendar_roundtrip() -> None:
    calendar_repo.replace_all(["2024-01-02", "2024-01-03", "2024-01-04"])
    assert calendar_repo.trading_days_between("2024-01-03", "2024-01-05") == ["2024-01-03", "2024-01-04"]
    assert calendar_repo.last_trading_day("2024-01-05") == "2024-01-04"
    assert calendar_repo.last_trading_day("2024-01-01") is None


def test_etf_list_upsert_merges() -> None:
    assert etf_repo.upsert_list([{"code": "510300", "name": "老名字"}]) == 1
    assert etf_repo.upsert_list([{"code": "510300", "name": "新名字"}, {"code": "588000", "name": "科创50"}]) == 1
    rows = {r["code"]: r["name"] for r in etf_repo.list_with_coverage()}
    assert rows == {"510300": "新名字", "588000": "科创50"}
```

### 14.10 前端 · 入口与构建配置

<a id="file-frontend-eslint-config-js"></a>

#### `frontend/eslint.config.js`

```js
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
```

<a id="file-frontend-index-html"></a>

#### `frontend/index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DailyScope · ETF 日度复盘</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

<a id="file-frontend-package-json"></a>

#### `frontend/package.json`

```json
{
  "name": "dailyscope-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint ."
  },
  "dependencies": {
    "@tanstack/react-query": "^5.17.0",
    "antd": "^5.21.0",
    "echarts": "^5.5.0",
    "echarts-for-react": "^3.0.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.21.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.5",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.2.0",
    "eslint": "^9.39.5",
    "eslint-plugin-react-hooks": "^7.1.1",
    "eslint-plugin-react-refresh": "^0.5.4",
    "globals": "^17.11.0",
    "typescript": "^5.4.0",
    "typescript-eslint": "^8.67.0",
    "vite": "^5.4.0"
  }
}
```

<a id="file-frontend-tsconfig-json"></a>

#### `frontend/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src", "vite.config.ts"]
}
```

<a id="file-frontend-vite-config-ts"></a>

#### `frontend/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8003',
        changeOrigin: true,
      },
    },
  },
});
```

### 14.11 前端 · 应用入口与样式

<a id="file-frontend-src-app-tsx"></a>

#### `frontend/src/App.tsx`

```tsx
import { Layout, Space, Typography } from 'antd';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import DailyReview from './pages/DailyReview';
import EtfDetail from './pages/EtfDetail';
import EtfList from './pages/EtfList';
import Jobs from './pages/Jobs';

const { Header, Content } = Layout;

const NAV_ITEMS = [
  { to: '/daily', label: '日度复盘', match: (path: string) => path === '/daily' },
  { to: '/', label: '标的清单', match: (path: string) => path === '/' || path.startsWith('/etf') },
  { to: '/jobs', label: '数据任务', match: (path: string) => path === '/jobs' },
];

const ACTIVE_STYLE = { color: '#1677ff', fontWeight: 600 };

function HeaderNav() {
  const { pathname } = useLocation();
  return (
    <Space size={16}>
      {NAV_ITEMS.map((item) => (
        <Link key={item.to} to={item.to} style={item.match(pathname) ? ACTIVE_STYLE : undefined}>
          {item.label}
        </Link>
      ))}
    </Space>
  );
}

export default function App() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          whiteSpace: 'nowrap',
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          <Link to="/">DailyScope</Link>
        </Typography.Title>
        <HeaderNav />
        <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
          ETF 日度复盘 · 从零准备数据
        </Typography.Text>
      </Header>
      <Content style={{ padding: 24 }}>
        <Routes>
          <Route path="/" element={<EtfList />} />
          <Route path="/etf/:code" element={<EtfDetail />} />
          <Route path="/daily" element={<DailyReview />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Content>
    </Layout>
  );
}
```

<a id="file-frontend-src-main-tsx"></a>

#### `frontend/src/main.tsx`

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 6 } }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  </React.StrictMode>,
);
```

<a id="file-frontend-src-styles-css"></a>

#### `frontend/src/styles.css`

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
    sans-serif;
  background: #f5f5f5;
  color: rgba(0, 0, 0, 0.88);
}

a {
  color: inherit;
  text-decoration: none;
}

.daily-row-active > td {
  background: #e6f4ff !important;
}
```

### 14.12 前端 · API 层 frontend/src/api/

<a id="file-frontend-src-api-client-ts"></a>

#### `frontend/src/api/client.ts`

```ts
import type {
  BootstrapStatus,
  DailyAttribution,
  DailyCoreNode,
  DailyDetail,
  DailyHoldingSpell,
  DailyLive,
  DailyLiveRanking,
  DailyLiveRefresh,
  DailyNodeDetail,
  DailyNodeRow,
  DailyRow,
  DailyScreen,
  DatasetSummary,
  EtfCoverage,
  IndexCoverage,
  JobsResponse,
  KlinePeriod,
  KlineResponse,
  MacdStatesResponse,
  RealtimeQuotesResponse,
  RebuildStatus,
  SchedulerStatus,
  SharesResponse,
} from './types';

const TIMEOUT_MS = 20000;
/** 全市场筛选/评分首次计算约 10 秒, 与普通查询分档, 避免日期切换被误判为失败。 */
const HEAVY_TIMEOUT_MS = 60000;

async function request<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

function getJson<T>(path: string, timeoutMs?: number): Promise<T> {
  return request<T>(path, undefined, timeoutMs);
}

export const fetchEtfs = () => getJson<EtfCoverage[]>('/api/etfs');

export const fetchShares = (code: string, limit: number) =>
  getJson<SharesResponse>(`/api/etfs/${code}/shares?limit=${limit}`);

export const fetchKline = (code: string, period: KlinePeriod, limit: number, live = false, end?: string | null) =>
  getJson<KlineResponse>(
    `/api/etfs/${code}/kline?period=${period}&limit=${limit}${live ? '&live=1' : ''}${end ? `&end=${end}` : ''}`,
  );

export const fetchMacdStates = (code: string) =>
  getJson<MacdStatesResponse>(`/api/etfs/${code}/macd-states`);

export const fetchQuotes = (codes: string[]) =>
  getJson<RealtimeQuotesResponse>(`/api/etfs/quotes?codes=${encodeURIComponent(codes.join(','))}`);

export const fetchJobs = () => getJson<JobsResponse>('/api/data/jobs');

export const fetchScheduler = () => getJson<SchedulerStatus>('/api/data/scheduler');

export const fetchDatasetSummary = () => getJson<DatasetSummary>('/api/dataset/summary');

export const fetchIndices = () => getJson<IndexCoverage[]>('/api/dataset/indices');

export const startJob = (job: string) =>
  request<{ job: string; state: string }>('/api/data/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job }),
  });

/** 一键准备: 空库按依赖顺序拉齐日度复盘所需的全部数据, 幂等可重跑。 */
export const startBootstrap = () =>
  request<BootstrapStatus>('/api/data/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

export const fetchBootstrap = () => getJson<BootstrapStatus>('/api/data/bootstrap');

function rangeQuery(start?: string, end?: string): string {
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const fetchDailyDays = (start?: string, end?: string) =>
  getJson<DailyRow[]>(`/api/dailypick/days${rangeQuery(start, end)}`);

export const fetchDailyDay = (signalDate: string) => getJson<DailyDetail>(`/api/dailypick/days/${signalDate}`);

export const fetchDailyLive = () => getJson<DailyLive>('/api/dailypick/live');

/** 全量实时排名(约 3MB): 10 分钟一批, 前端配大超时。 */
export const fetchDailyLiveRanking = () => getJson<DailyLiveRanking>('/api/dailypick/live/ranking', HEAVY_TIMEOUT_MS);

/** 手动全量拉取: 服务端清缓存立即重建, 返回实测耗时。 */
export const refreshDailyLive = () =>
  request<DailyLiveRefresh>('/api/dailypick/live/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

export const fetchDailyScreen = (signalDate: string) =>
  getJson<DailyScreen>(`/api/dailypick/days/${signalDate}/screen`, HEAVY_TIMEOUT_MS);

export const fetchDailyNodes = (start?: string, end?: string) =>
  getJson<DailyNodeRow[]>(`/api/dailypick/nodes${rangeQuery(start, end)}`);

export const fetchDailyNode = (signalDate: string) =>
  getJson<DailyNodeDetail>(`/api/dailypick/nodes/${signalDate}`, HEAVY_TIMEOUT_MS);

export const fetchDailyTimeline = (start?: string, end?: string) =>
  getJson<DailyHoldingSpell[]>(`/api/dailypick/timeline${rangeQuery(start, end)}`);

export const fetchDailyAttribution = (start?: string, end?: string) =>
  getJson<DailyAttribution>(`/api/dailypick/attribution${rangeQuery(start, end)}`);

export const fetchDailyStatus = () => getJson<RebuildStatus>('/api/dailypick/status');

export const startDailyRebuild = (startDate?: string, endDate?: string) =>
  request<{ state: string }>('/api/dailypick/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: startDate, end_date: endDate }),
  });

export const fetchDailyCore = (date?: string) =>
  getJson<DailyCoreNode>(`/api/dailypick/core${date ? `?date=${encodeURIComponent(date)}` : ''}`);

export const fetchDailyCoreStatus = () => getJson<RebuildStatus>('/api/dailypick/core/status');

export const startDailyCoreRebuild = (startDate?: string, endDate?: string) =>
  request<{ state: string }>('/api/dailypick/core/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: startDate, end_date: endDate }),
  });
```

<a id="file-frontend-src-api-types-ts"></a>

#### `frontend/src/api/types.ts`

```ts
export type * from './types/etf';
export type * from './types/dataset';
export type * from './types/jobs';
export type * from './types/daily';
export type * from './types/dailyScreen';
export type * from './types/dailyLive';
```

<a id="file-frontend-src-api-types-daily-ts"></a>

#### `frontend/src/api/types/daily.ts`

```ts
import type { KlinePeriod, MacdState } from './etf';

/** 策略分单个因子: 原始值 → 当日全市场截面分位([-1,1]) → 权重 → 贡献。 */
export interface CoreFactor {
  key: string;
  label: string;
  /** pct=百分比 / num=纯数值 / days=天数 */
  kind: 'pct' | 'num' | 'days';
  value: number | null;
  /** 惩罚行没有截面分位与权重(不是加权项), 命中才出现。 */
  z: number | null;
  weight: number | null;
  contrib: number;
}

export interface PickReason {
  flags: string[];
  signals: string[];
  r5: number | null;
  r20: number | null;
  r60: number | null;
  r120: number | null;
  r250: number | null;
  vol20: number | null;
  vol60: number | null;
  dd60: number | null;
  dd20: number | null;
  mdd60: number | null;
  dist_52w_high: number | null;
  dist_52w_low: number | null;
  vol_ratio_5_20: number | null;
  amount_yi_5d: number | null;
  amount_yi_20d: number | null;
  turnover_5d: number | null;
  turnover_20d: number | null;
  shrink_pullback: boolean;
  ma20_dev: number | null;
  ma60_dev: number | null;
  ma120_dev: number | null;
  ma20_slope_5: number | null;
  ma60_slope_20: number | null;
  up_ratio_20: number | null;
  up_ratio_60: number | null;
  downside_vol20: number | null;
  sharpe_20: number | null;
  sharpe_60: number | null;
  /** core8 持仓会带: 节点上的 core8 截面名次与分数。 */
  core8_rank?: number | null;
  core8_score?: number | null;
  /** 策略分 8 因子拆解; 仅日度策略记录带。 */
  core_factors?: CoreFactor[] | null;
  rank_r5: number | null;
  rank_r20: number | null;
  rank_r60: number | null;
  rank_r250: number | null;
  rank_vol20: number | null;
  rank_flow_5d: number | null;
  rank_dist_52w_high: number | null;
  excess_r5: number | null;
  excess_r20: number | null;
  excess_r60: number | null;
  beta60: number | null;
  corr60: number | null;
  alpha60: number | null;
  theme_count: number | null;
  theme_median_r20: number | null;
  theme_rank_r20: number | null;
  theme_excess_r20: number | null;
  shares_yi: number | null;
  shares_raw: number | null;
  flow_5d: number | null;
  flow_5d_raw: number | null;
  flow_suspect: boolean;
  share_split_5d: number;
  aum_yi: number | null;
  core_score: number | null;
  trend_score: number | null;
  macd_states: Record<KlinePeriod, MacdState | null> | null;
  baseline_score: number;
}

export interface DailyPick {
  signal_date: string;
  /** core=信号日有效的 core8 持仓 / baseline=综合分前10。 */
  bucket: 'baseline' | 'core';
  pick_rank: number;
  code: string;
  name: string | null;
  theme: string | null;
  fund_type: string | null;
  baseline_score: number;
  reason_text: string;
  reason: PickReason;
  next_return: number | null;
}

export interface EvalBlock {
  n?: number;
  mean?: number;
  median?: number;
  hit_rate?: number;
}

export interface PickEvaluation {
  skipped?: string;
  warning?: string;
  next_signal?: string;
  universe?: EvalBlock;
  baseline_top10?: EvalBlock;
  core_holdings?: EvalBlock;
  rank_ic_baseline?: number;
}

/** 日度复盘: core8 缓冲带持仓逐日跟踪(节点间延续), 次日收盘结算; 基线前10 作对照锚。 */
export interface DailyRow {
  signal_date: string;
  next_signal: string | null;
  scored: number | null;
  universe_mean: number | null;
  universe_hit: number | null;
  baseline_mean: number | null;
  baseline_hit: number | null;
  core_mean: number | null;
  core_hit: number | null;
  rank_ic: number | null;
}

export interface DailyDetail {
  signal_date: string;
  next_signal: string | null;
  generated_at: string;
  rule_version: string;
  codes_with_bar: number;
  codes_with_enough_history: number;
  scored: number;
  min_aum_yi: number;
  shares_available: number;
  universe_mean: number | null;
  universe_median: number | null;
  universe_hit: number | null;
  baseline_mean: number | null;
  baseline_hit: number | null;
  core_mean: number | null;
  core_hit: number | null;
  rank_ic: number | null;
  evaluation: PickEvaluation;
  index_returns: Record<string, number>;
  picks: { core: DailyPick[]; baseline: DailyPick[] };
}

export interface DailyCumulative {
  signal_date: string;
  next_signal: string | null;
  core: number | null;
  baseline: number | null;
  universe: number | null;
  hs300: number | null;
  /** 年线开关: 信号日沪深300 收盘 > MA250 为 above, 未热身为 null(按空仓)。 */
  gate: 'above' | 'below' | null;
  /** 仅年线上承受当日 core8 收益后的累计净值(空仓段沿用最后净值画平线)。 */
  gated: number | null;
}

export interface DailyOverallBlock {
  mean: number | null;
  cumulative: number | null;
  positive: number | null;
}

export interface DailyOverall {
  days: number;
  core: DailyOverallBlock;
  baseline: DailyOverallBlock;
  universe: DailyOverallBlock;
  hs300: DailyOverallBlock;
  rank_ic_mean: number | null;
  rank_ic_positive_days: number | null;
  /** core8 持仓相邻交易日平均换手(1 - 交集/较大桶长), 只在换仓节点跳升。 */
  turnover_avg: number | null;
  /** 年线开关: 窗口内站上/跌破 MA250 的交易日数(未热身不计入)。 */
  gate_on_days: number | null;
  gate_off_days: number | null;
  /** 仅年线上承受当日 core8 收益的复利累计。 */
  gated_cumulative: number | null;
}

export interface DailyAttribution {
  days: DailyRow[];
  cumulative: DailyCumulative[];
  overall: DailyOverall;
}
```

<a id="file-frontend-src-api-types-dailylive-ts"></a>

#### `frontend/src/api/types/dailyLive.ts`

```ts
import type { DailyPick } from './daily';
import type { DailyScreenRow } from './dailyScreen';

/** 当前持仓行: 来自上一换仓节点的持仓名单, 不含因子拆解(细节在底部全量表)。 */
export interface LiveHeldPick {
  code: string;
  name: string | null;
  core_rank: number;
  core_score: number;
  /** hold=节点继续持有 / buy=节点新买入(卖出名单在下一节点的 action=sell)。 */
  action: 'hold' | 'buy';
  /** 换仓节点日收盘价: 持仓期涨跌幅基准。 */
  node_close?: number | null;
  /** 今日实时排名; null=未进候选池(如规模/类型被筛掉), 等价于跌出缓冲带。 */
  today_rank?: number | null;
}

/** 今日实时 TOP N 行: 只用于对照卡片, 不含因子拆解(细节在底部全量表)。 */
export interface TodayTopPick {
  rank: number;
  code: string;
  name: string | null;
  score: number;
  /** 换仓节点日收盘价: 与持仓共用同一基准, 看本轮周期内 TOP 名的涨跌。 */
  node_close?: number | null;
}

/** 今日盘中预选: 实时现价合成今日K线算出, 不落库; live=false 时只有原因。 */
export interface DailyLive {
  live: boolean;
  reason?: string;
  signal_date: string;
  rule_version?: string;
  generated_at?: string;
  codes_with_bar?: number;
  codes_with_enough_history?: number;
  scored?: number;
  min_aum_yi?: number;
  shares_available?: number;
  /** 行情时间戳(YYYY-MM-DD HH:MM:SS), 说明预选基于哪个时点的价格。 */
  as_of?: string | null;
  is_trading?: boolean;
  last_day?: string;
  /** 今日是否换仓; 非换仓日目标=沿用上一节点持仓(策略忠实语义, 不虚拟调仓)。 */
  rebalance?: boolean;
  next_rebalance?: string | null;
  last_node?: string | null;
  picks?: { core: DailyPick[]; baseline_codes: string[] };
  /** 今日实时排名前 N(默认 10): 左卡「今日 TOP」对照, 与节点持仓并排看。 */
  today_top?: TodayTopPick[];
  /** 买入区边界(前 N 名)与缓冲带边界(已持有排名 ≤ N 继续持有)。 */
  hold_top?: number;
  buffer_rank?: number;
  /** 上一节点持仓(当前持仓卡的右卡数据源); 收盘后由正式节点快照补位。 */
  held?: LiveHeldPick[];
  /** 服务端响应时的 unix 秒, 前端与 as_of 一起算行情新鲜度。 */
  server_now?: number;
  /** 实测耗时(秒): 全量行情冷拉 + 评分重算, 「手动全量拉取」按钮的结果展示。 */
  timing?: { quotes_sec: number; scoring_sec: number };
}

/** 今日全量实时排名: 与收盘筛选同构(行形状同 DailyScreenRow), 交易时段 10 分钟一批。 */
export interface DailyLiveRanking {
  live: boolean;
  reason?: string;
  signal_date: string;
  as_of?: string | null;
  scored?: number;
  server_now?: number;
  rows: DailyScreenRow[];
}

/** 手动全量拉取的结果: picks 是重建后的轻量预演, timing 在 picks 里。 */
export interface DailyLiveRefresh {
  refreshed_at: string;
  picks: DailyLive;
  ranking_rows: number;
}
```

<a id="file-frontend-src-api-types-dailyscreen-ts"></a>

#### `frontend/src/api/types/dailyScreen.ts`

```ts
import type { CoreFactor, PickReason } from './daily';

/** 漏斗一级: count 为该级剩余标的数, 相邻两级之差即被剔除数。 */
export interface DailyScreenStage {
  key: string;
  label: string;
  criteria: string;
  count: number;
}

/** 评分明细: 未进入评分池的行没有分数与截面字段。 */
export type DailyScreenReason = Omit<PickReason, 'baseline_score' | 'trend_score' | 'core_score'> & {
  baseline_score?: number | null;
  trend_score?: number | null;
  core_score?: number | null;
};

/** 行内携带的实时行情快照(现价/涨跌幅/行情时间)。 */
export interface LiveQuote {
  price: number | null;
  pct: number | null;
  time: string | null;
}

export interface DailyScreenRow {
  code: string;
  name: string | null;
  fund_type: string | null;
  theme: string | null;
  /** 该标的最深到达的一级: non_equity/hk/no_bar/short_history/bad_data/no_shares/small_aum/core_pool/core_hold */
  stage: string;
  stage_text: string;
  last_bar: string | null;
  bars: number;
  /** 综合分排名(仅在评分池内), null 表示未到评分级。 */
  rank: number | null;
  /** core8 固定符号公式的截面名次与分数(与「多因子分」不是同一个公式)。 */
  core8_rank: number | null;
  core8_score: number | null;
  /** 所属换仓节点日收盘价: 「节点涨跌」的统一基准(信号日当天即节点日时等于当日收盘)。 */
  node_close?: number | null;
  /** 策略分 8 因子拆解(仅在评分池内)。 */
  core_factors: CoreFactor[] | null;
  reason: DailyScreenReason | null;
  reason_text: string | null;
  /** 实时行情(仅实时排名): 时间戳非当日则为 null, 避免把昨日收盘当现价。 */
  quote?: LiveQuote | null;
}

export interface DailyScreen {
  signal_date: string;
  available: boolean;
  reason: string | null;
  min_aum_yi: number;
  funnel: DailyScreenStage[];
  baseline_note: string;
  core_codes: string[];
  baseline_codes: string[];
  scored: number;
  rows: DailyScreenRow[];
}

/** core8 缓冲带: 一个换仓节点上的持仓/卖出/评分榜。 */
export interface DailyCorePick {
  code: string;
  name: string | null;
  core_rank: number;
  core_score: number;
  held: boolean;
  /** hold=继续持有 / buy=本次买入 / sell=本次卖出 / rank=前20但未持有 */
  action: 'hold' | 'buy' | 'sell' | 'rank';
  /** 换仓节点日收盘价: 持仓期涨跌幅基准。 */
  node_close?: number | null;
  /** 换仓当日的 8 因子拆解; 旧节点重算前为 null。 */
  factors: CoreFactor[] | null;
}

export interface DailyCoreNode {
  signal_date: string;
  /** 下一次换仓日; null 表示已到日历尾部。 */
  next_rebalance: string | null;
  generated_at: string | null;
  rule_version: string;
  scored: number;
  min_aum_yi: number;
  /** 请求的那一天: 间隔期内节点会早于它, 持仓按上一节点延续。 */
  requested_date: string;
  holdings: DailyCorePick[];
  sells: DailyCorePick[];
  ranked: DailyCorePick[];
  counts: { hold: number; buy: number; sell: number };
  held_codes: string[];
}

/** 换仓节点列表行: 一次换仓的持仓、动作计数与持有到下一节点的等权收益。 */
export interface DailyNodeRow {
  signal_date: string;
  next_rebalance: string | null;
  generated_at: string | null;
  rule_version: string;
  scored: number;
  holdings: { code: string; name: string | null; core_rank: number }[];
  counts: { hold: number; buy: number; sell: number };
  /** 信号日收盘 → 下一节点收盘的等权收益; 尚未结算为 null。 */
  return: number | null;
  /** 同一节点评分前 10 名等权、收盘→收盘的区间收益, 不含成本; 缺价或未结算为 null。 */
  top10_return: number | null;
  /** 沪深300 同区间的指数涨跌; 指数尚未发布或未结算为 null。 */
  hs300_return: number | null;
}

/** 节点明细里的标的: 只多了成交价与区间收益, 其余字段与节点持仓同源。 */
export interface DailyNodePick extends DailyCorePick {
  theme: string | null;
  /** 节点日收盘价(信号日收盘, 所有标的都有)。 */
  price: number | null;
  /** 实际入场价: 买入按次日开盘, 继续持有按节点收盘; 非持仓为 null。 */
  entry_price: number | null;
  /** 持仓的出场价: 下一节点收盘。 */
  next_price: number | null;
  /** 卖出时点: close=周四收盘卖, open=周五开盘顺延卖; 非卖出席位为 null。 */
  sell_at: 'close' | 'open' | null;
  return: number | null;
}

export interface DailyNodeDetail {
  signal_date: string;
  next_rebalance: string | null;
  generated_at: string | null;
  rule_version: string;
  scored: number;
  min_aum_yi: number;
  holdings: DailyNodePick[];
  sells: DailyNodePick[];
  ranked: DailyNodePick[];
  counts: { hold: number; buy: number; sell: number };
  return: number | null;
}

/** 持仓区间: 连续持有的节点合并为一段, exit 为首次缺席的节点日。 */
export interface DailyHoldingSpell {
  code: string;
  name: string | null;
  theme: string | null;
  entry: string;
  exit: string | null;
  nodes: number;
  entry_rank: number;
  last_rank: number;
  holding: boolean;
  return: number | null;
  entry_price: number | null;
  exit_price: number | null;
}
```

<a id="file-frontend-src-api-types-dataset-ts"></a>

#### `frontend/src/api/types/dataset.ts`

```ts
export interface DatasetSummary {
  calendar: { days: number; first: string | null; last: string | null };
  daily: { codes: number; rows: number; first: string | null; last: string | null; no_data: number };
  shares: { codes: number; rows: number; first: string | null; last: string | null };
  index: { configured: number; codes: number; rows: number; last: string | null };
  gaps: {
    codes: number;
    days: number;
    top: Array<{ code: string; missing: number; first: string; last: string }>;
  };
  anomalies: {
    since: string;
    zero_volume: number;
    bad_close: number;
    jump_gt_30pct: number;
    zero_volume_all: number;
    bad_close_all: number;
    jump_gt_30pct_all: number;
  };
  share_scale: {
    threshold: number;
    jumps: number;
    split: number;
    flow: number;
    unverified: number;
    recent_split: Array<{ code: string; date: string; ratio: number }>;
  };
  list_date_missing: number;
}

export interface IndexCoverage {
  code: string;
  name: string | null;
  first: string | null;
  last: string | null;
  rows: number;
}
```

<a id="file-frontend-src-api-types-etf-ts"></a>

#### `frontend/src/api/types/etf.ts`

```ts
export interface EtfCoverage {
  code: string;
  name: string;
  fund_type: string | null;
  daily_first: string | null;
  daily_last: string | null;
  daily_rows: number;
  shares_last: string | null;
  shares_rows: number;
}

export interface DailyBar {
  date: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
}

export interface SharesPoint {
  date: string;
  shares_yi: number;
}

export interface SharesResponse {
  code: string;
  rows: SharesPoint[];
}

/** 腾讯实时行情: 二级市场现价, 不是 IOPV 参考净值。pct 为小数(0.0123 = +1.23%)。 */
export interface RealtimeQuote {
  name: string | null;
  price: number | null;
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  pct: number | null;
  volume: number | null;
  amount_wan: number | null;
  time: string | null;
}

export interface RealtimeQuotesResponse {
  as_of: string;
  is_trading: boolean;
  quotes: Record<string, RealtimeQuote>;
}

export type KlinePeriod = 'day' | 'week' | 'month';

export interface KlineBar extends DailyBar {
  dif: number | null;
  dea: number | null;
  hist: number | null;
}

export type MacdTrend = 'rising' | 'falling' | 'flat';
export type MacdFlip = 'golden' | 'dead';
export type MacdZone = 'above' | 'below' | 'zero';

export interface MacdState {
  period: KlinePeriod;
  date: string;
  dif: number;
  dea: number;
  hist: number;
  hist_prev: number;
  trend: MacdTrend;
  flip: MacdFlip | null;
  zone: MacdZone;
}

export interface KlineResponse {
  code: string;
  period: KlinePeriod;
  bars: KlineBar[];
  state: MacdState | null;
}

export interface MacdStatesResponse {
  code: string;
  states: Record<KlinePeriod, MacdState | null>;
}
```

<a id="file-frontend-src-api-types-jobs-ts"></a>

#### `frontend/src/api/types/jobs.ts`

```ts
export type JobState = 'running' | 'done' | 'failed';

export interface JobStatus {
  state: JobState;
  done?: number;
  total?: number;
  msg?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export type JobsResponse = Record<string, JobStatus>;

export type RebuildState = 'idle' | 'running' | 'done' | 'failed';

/** 节点/日度记录重算的进度: 与一次性任务同形, 由后端后台线程写入。 */
export interface RebuildStatus {
  state: RebuildState;
  done?: number;
  total?: number;
  msg?: string;
  result?: Record<string, unknown>;
  error?: string;
}

/** 收盘自动刷新链: 每晚补行情/指数/份额并重算 core8 节点与日度记录。 */
export interface SchedulerStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
  slot: string | null;
  stage: string | null;
  signal_date: string | null;
  started_at: string | null;
  finished_at: string | null;
  detail: string | null;
  next_run: string | null;
  /** 今晚已完成的槽位: {close: '2026-11-18'}。 */
  done: Record<string, string>;
}

export type BootstrapState = 'idle' | 'running' | 'done' | 'failed';

/** 一键准备的单阶段: pending 未开始 / running 进行中 / done 完成 / failed 失败中断。 */
export interface BootstrapStage {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  detail: string | null;
  done: number;
  total: number;
}

/** 一键准备进度: 空库从零拉齐日度复盘所需数据(清单→…→日度记录)。 */
export interface BootstrapStatus {
  state: BootstrapState;
  stage: string | null;
  percent: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  stages: BootstrapStage[];
}
```

### 14.13 前端 · Hooks frontend/src/hooks/

<a id="file-frontend-src-hooks-usedailypick-ts"></a>

#### `frontend/src/hooks/useDailyPick.ts`

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchDailyAttribution,
  fetchDailyCore,
  fetchDailyCoreStatus,
  fetchDailyDay,
  fetchDailyDays,
  fetchDailyLive,
  fetchDailyLiveRanking,
  fetchDailyNode,
  fetchDailyNodes,
  fetchDailyScreen,
  fetchDailyStatus,
  fetchDailyTimeline,
  refreshDailyLive,
  startDailyCoreRebuild,
  startDailyRebuild,
} from '../api/client';

export function useDailyDays() {
  return useQuery({ queryKey: ['daily', 'days'], queryFn: () => fetchDailyDays() });
}

export function useDailyDay(signalDate: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'day', signalDate],
    queryFn: () => fetchDailyDay(signalDate as string),
    enabled: Boolean(signalDate),
  });
}

/** 筛选漏斗 + 全量排名: 首次计算约数秒(后端 120 秒缓存), 同一信号日切回不再重算。 */
export function useDailyScreen(signalDate: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'screen', signalDate],
    queryFn: () => fetchDailyScreen(signalDate as string),
    enabled: Boolean(signalDate),
    staleTime: 120000,
  });
}

/** 今日盘中预选(轻量): 交易时段每分钟一次(与服务端缓存对齐), 现价列由行情接口 15 秒轮询。 */
export function useDailyLive() {
  return useQuery({
    queryKey: ['daily', 'live'],
    queryFn: fetchDailyLive,
    refetchInterval: (query) => (query.state.data?.is_trading ? 60000 : 300000),
    retry: 1,
  });
}

/** 全量实时排名(约 3MB): 交易时段 10 分钟一批(与服务端缓存对齐), 手动刷新后立即重取。 */
export function useDailyLiveRanking(enabled: boolean) {
  return useQuery({
    queryKey: ['daily', 'live-ranking'],
    queryFn: fetchDailyLiveRanking,
    enabled,
    refetchInterval: (query) => (query.state.data?.live ? 600000 : 60000),
    staleTime: 540000,
  });
}

/** 手动全量拉取: 服务端清缓存立即重建; 成功后让预演与排名两个查询失效重取。 */
export function useRefreshDailyLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshDailyLive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['daily', 'live'] });
      queryClient.invalidateQueries({ queryKey: ['daily', 'live-ranking'] });
    },
  });
}

export function useDailyAttribution() {
  return useQuery({ queryKey: ['daily', 'attribution'], queryFn: () => fetchDailyAttribution() });
}

export function useDailyStatus() {
  return useQuery({
    queryKey: ['daily', 'status'],
    queryFn: fetchDailyStatus,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1500 : false),
  });
}

export function useRebuildDaily() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startDailyRebuild(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['daily', 'status'] }),
  });
}

/** 该日所属的 core8 换仓节点: 间隔期内返回上一节点, 不按当日排名重排。 */
export function useDailyCore(date: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'core', date],
    queryFn: () => fetchDailyCore(date),
    enabled: Boolean(date),
    retry: false,
  });
}

export function useDailyCoreStatus() {
  return useQuery({
    queryKey: ['daily', 'core', 'status'],
    queryFn: fetchDailyCoreStatus,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1500 : false),
  });
}

export function useRebuildDailyCore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startDailyCoreRebuild(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['daily', 'core', 'status'] }),
  });
}

/** 换仓节点列表: 节点的持仓/买卖计数在回填完成后才变, 沿用节点重算的失效范围。 */
export function useDailyNodes() {
  return useQuery({ queryKey: ['daily', 'nodes'], queryFn: () => fetchDailyNodes() });
}

/** 节点明细: 持仓/卖出/评分前 20 的价格与区间收益, 纯读节点表与日K。 */
export function useDailyNode(signalDate: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'node', signalDate],
    queryFn: () => fetchDailyNode(signalDate as string),
    enabled: Boolean(signalDate),
    retry: false,
  });
}

export function useDailyTimeline() {
  return useQuery({ queryKey: ['daily', 'timeline'], queryFn: () => fetchDailyTimeline() });
}
```

<a id="file-frontend-src-hooks-usedataset-ts"></a>

#### `frontend/src/hooks/useDataset.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import { fetchDatasetSummary, fetchIndices } from '../api/client';

export function useDatasetSummary() {
  return useQuery({
    queryKey: ['dataset-summary'],
    queryFn: fetchDatasetSummary,
    staleTime: 60_000,
  });
}

export function useIndices() {
  return useQuery({
    queryKey: ['dataset-indices'],
    queryFn: fetchIndices,
    staleTime: 60_000,
  });
}
```

<a id="file-frontend-src-hooks-useetfs-ts"></a>

#### `frontend/src/hooks/useEtfs.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import type { KlinePeriod } from '../api/types';
import { fetchEtfs, fetchKline, fetchMacdStates, fetchShares } from '../api/client';

export function useEtfs(refetchInterval?: number) {
  return useQuery({
    queryKey: ['etfs'],
    queryFn: fetchEtfs,
    staleTime: 60_000,
    refetchInterval,
  });
}

export function useShares(code: string, limit: number) {
  return useQuery({
    queryKey: ['shares', code, limit],
    queryFn: () => fetchShares(code, limit),
    retry: false,
  });
}

/** live=true 时后端会追加当日未收盘K线, 并随行情轮询刷新; end 给定时窗口截止到该日(历史节点回看)。 */
export function useKline(
  code: string,
  period: KlinePeriod,
  limit: number,
  live = false,
  end?: string | null,
) {
  return useQuery({
    queryKey: ['kline', code, period, limit, live, end ?? null],
    queryFn: () => fetchKline(code, period, limit, live, end),
    retry: false,
    refetchInterval: live ? 30_000 : false,
  });
}

export function useMacdStates(code: string) {
  return useQuery({
    queryKey: ['macd-states', code],
    queryFn: () => fetchMacdStates(code),
    retry: false,
  });
}
```

<a id="file-frontend-src-hooks-usejobs-ts"></a>

#### `frontend/src/hooks/useJobs.ts`

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchBootstrap, fetchJobs, fetchScheduler, startBootstrap, startJob } from '../api/client';

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: fetchJobs,
    refetchInterval: 1500,
  });
}

export function useSchedulerStatus() {
  return useQuery({
    queryKey: ['scheduler'],
    queryFn: fetchScheduler,
    refetchInterval: 5000,
  });
}

export function useStartJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

/** 一键准备进度: 跑动时 1.5 秒一轮, 结束后停止轮询。 */
export function useBootstrap() {
  return useQuery({
    queryKey: ['bootstrap'],
    queryFn: fetchBootstrap,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1500 : false),
  });
}

export function useStartBootstrap() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startBootstrap,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
  });
}
```

<a id="file-frontend-src-hooks-usequotes-ts"></a>

#### `frontend/src/hooks/useQuotes.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import { fetchQuotes } from '../api/client';

const POLL_MS = 15000;
const IDLE_POLL_MS = 60000; // 非交易时段低频探测, 开盘后自动切回 15 秒

/**
 * 当周实时行情: 交易时段每 15 秒刷新, 非交易时段降频到 60 秒。
 * 交易时段由后端按交易日历判断, 前端不自行猜时段。
 */
export function useQuotes(codes: string[], enabled: boolean) {
  const unique = Array.from(new Set(codes)).sort();
  return useQuery({
    queryKey: ['quotes', unique.join(',')],
    queryFn: () => fetchQuotes(unique),
    enabled: enabled && unique.length > 0,
    refetchInterval: (query) => (query.state.data?.is_trading ? POLL_MS : IDLE_POLL_MS),
    refetchOnWindowFocus: false,
    staleTime: POLL_MS / 3,
  });
}
```

### 14.14 前端 · 通用 / 图表 / 数据集组件

<a id="file-frontend-src-components-common-format-ts"></a>

#### `frontend/src/components/common/format.ts`

```ts
export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtSignedPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function fmtSignedNum(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

/** 本地时区的今天(YYYY-MM-DD), 与后端交易日口径一致。 */
export function todayStr(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** A 股习惯: 红涨绿跌。 */
export function returnColor(value: number | null | undefined): string | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? '#cf1322' : '#3f8600';
}
```

<a id="file-frontend-src-components-data-bootstrapcard-tsx"></a>

#### `frontend/src/components/data/BootstrapCard.tsx`

```tsx
import { Alert, Button, Card, Progress, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { BootstrapStage } from '../../api/types';
import { useBootstrap, useStartBootstrap } from '../../hooks/useJobs';

const STAGE_TAG: Record<BootstrapStage['state'], { color: string; text: string }> = {
  pending: { color: 'default', text: '待开始' },
  running: { color: 'processing', text: '进行中' },
  done: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
};

const COLUMNS: ColumnsType<BootstrapStage> = [
  { title: '阶段', dataIndex: 'label', width: 110 },
  {
    title: '状态',
    dataIndex: 'state',
    width: 90,
    render: (state: BootstrapStage['state']) => (
      <Tag color={STAGE_TAG[state].color}>{STAGE_TAG[state].text}</Tag>
    ),
  },
  {
    title: '进度 / 结果',
    dataIndex: 'detail',
    render: (detail: string | null, row) =>
      detail ?? (row.total > 0 ? `${row.done} / ${row.total}` : '—'),
  },
];

/** 空库一键准备: 按依赖顺序跑通日度复盘所需全部数据, 失败停在出错阶段, 重跑只补缺口。 */
export default function BootstrapCard() {
  const status = useBootstrap();
  const start = useStartBootstrap();
  const data = status.data;
  const running = data?.state === 'running';
  const percent = data?.percent ?? 0;

  return (
    <Card
      size="small"
      title="一键准备日度复盘数据"
      extra={
        <Space>
          {data && data.state !== 'idle' && (
            <Tag color={running ? 'processing' : data.state === 'done' ? 'success' : 'error'}>
              {running ? '运行中' : data.state === 'done' ? '已完成' : '失败'}
            </Tag>
          )}
          <Button type="primary" loading={start.isPending || running} onClick={() => start.mutate()}>
            {data?.state === 'idle' || data?.state === 'failed' ? '开始准备' : '重新执行'}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          空库也能从这里起步: 先装载代码库自带的预热快照(历史日K/份额/指数基线), 再在线刷新 ETF 清单 →
          交易日历 → 日K 增量 → 指数增量 → 份额增量 → 份额折算甄别 → core8 换仓节点 → 日度记录。
          每步幂等, 中断/限流后重新执行只会补缺失部分。
        </Typography.Text>
        <Progress percent={percent} status={running ? 'active' : data?.state === 'failed' ? 'exception' : undefined} />
        {data?.started_at && (
          <Typography.Text type="secondary">
            开始 {data.started_at}
            {data.finished_at ? ` · 结束 ${data.finished_at}` : ''}
          </Typography.Text>
        )}
        {data?.error && <Alert type="error" showIcon message="准备中断" description={data.error} />}
        {start.isError && <Alert type="error" showIcon message="启动失败" description={String(start.error)} />}
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          columns={COLUMNS}
          dataSource={data?.stages ?? []}
          loading={status.isLoading}
        />
      </Space>
    </Card>
  );
}
```

<a id="file-frontend-src-components-dataset-datasetreadiness-tsx"></a>

#### `frontend/src/components/dataset/DatasetReadiness.tsx`

```tsx
import { Alert, Button, Card, Descriptions, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { IndexCoverage } from '../../api/types';
import { useDatasetSummary, useIndices } from '../../hooks/useDataset';

const COLUMNS: ColumnsType<IndexCoverage> = [
  { title: '代码', dataIndex: 'code', width: 90 },
  { title: '指数', dataIndex: 'name', render: (v: string | null) => v ?? '-' },
  { title: '起始', dataIndex: 'first', width: 110, render: (v: string | null) => v ?? '-' },
  { title: '最新', dataIndex: 'last', width: 110, render: (v: string | null) => v ?? '-' },
  { title: '行数', dataIndex: 'rows', width: 90, render: (v: number) => v.toLocaleString() },
];

const num = (v: number) => v.toLocaleString();

export default function DatasetReadiness() {
  const summary = useDatasetSummary();
  const indices = useIndices();
  const data = summary.data;

  return (
    <Card
      size="small"
      title="回测数据就绪度"
      extra={
        <Button
          size="small"
          loading={summary.isFetching || indices.isFetching}
          onClick={() => {
            summary.refetch();
            indices.refetch();
          }}
        >
          刷新
        </Button>
      }
    >
      {summary.isError && <Alert type="error" showIcon message="就绪度读取失败" description={String(summary.error)} />}
      {data && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions size="small" bordered column={3}>
            <Descriptions.Item label="交易日历">
              {data.calendar.days} 天（{data.calendar.first} ~ {data.calendar.last}）
            </Descriptions.Item>
            <Descriptions.Item label="日K">
              {num(data.daily.rows)} 行 / {data.daily.codes} 只
            </Descriptions.Item>
            <Descriptions.Item label="份额">
              {num(data.shares.rows)} 行 / {data.shares.codes} 只（{data.shares.first} 起）
            </Descriptions.Item>
            <Descriptions.Item label="指数">
              {data.index.codes}/{data.index.configured} 只 · {num(data.index.rows)} 行
            </Descriptions.Item>
            <Descriptions.Item label="份额跳变">
              {num(data.share_scale.jumps)} 笔（折算 {data.share_scale.split} / 申赎 {data.share_scale.flow} / 待甄别{' '}
              {num(data.share_scale.unverified)}）
            </Descriptions.Item>
            <Descriptions.Item label="上市日缺失">{data.list_date_missing}</Descriptions.Item>
          </Descriptions>

          <Alert
            type={data.gaps.codes > 0 ? 'warning' : 'success'}
            showIcon
            message={`区间缺口 ${data.gaps.codes} 只 / ${num(data.gaps.days)} 个交易日（含停牌，需逐只解释）`}
            description={
              data.gaps.top.length
                ? `缺口最大：${data.gaps.top.map((x) => `${x.code}(${x.missing})`).join('、')}`
                : undefined
            }
          />
          <Alert
            type={data.anomalies.jump_gt_30pct > 0 || data.anomalies.bad_close > 0 ? 'warning' : 'success'}
            showIcon
            message={`异常行（${data.anomalies.since} 起）：非正价格 ${num(data.anomalies.bad_close)} · 零成交量 ${num(data.anomalies.zero_volume)} · 单日±30% ${num(data.anomalies.jump_gt_30pct)}`}
            description={`全历史另有非正价格 ${num(data.anomalies.bad_close_all)} · 单日±30% ${num(data.anomalies.jump_gt_30pct_all)}，集中在 510050/510880 的 2015 前区段，是腾讯前复权因子失效的假价格；回测从份额起点开始即可规避`}
          />
          <Alert
            type={data.share_scale.unverified > 0 ? 'warning' : 'success'}
            showIcon
            message={`份额跳变甄别（≥${data.share_scale.threshold} 倍）：折算 ${data.share_scale.split} · 真实申赎 ${data.share_scale.flow} · 待甄别 ${num(data.share_scale.unverified)}（含上市首日无前史、无法判定的跳变）`}
            description={
              data.share_scale.recent_split.length
                ? `最近折算：${data.share_scale.recent_split.map((x) => `${x.code}（${x.date}，×${x.ratio}）`).join('、')}；折算在前复权价上不可见，只能靠未复权/前复权台阶识别，待甄别的跳变不参与资金因子`
                : '尚未记录折算事件，待甄别的跳变不参与资金因子'
            }
          />

          <Table
            size="small"
            rowKey="code"
            pagination={false}
            columns={COLUMNS}
            dataSource={indices.data ?? []}
            loading={indices.isLoading}
          />

          <Typography.Text type="secondary">
            时点口径：信号日只用当日收盘及以前的数据；标的池按上市日截断；已退市标的整体缺失（幸存者偏差），历史截面收益需标注该偏差。
          </Typography.Text>
        </Space>
      )}
    </Card>
  );
}
```

<a id="file-frontend-src-components-kline-macdstatepanel-tsx"></a>

#### `frontend/src/components/kline/MacdStatePanel.tsx`

```tsx
import { Card, Col, Row, Space, Tag, Tooltip, Typography } from 'antd';
import type { KlinePeriod, MacdState, MacdTrend, MacdZone } from '../../api/types';

interface Props {
  states?: Record<KlinePeriod, MacdState | null>;
  loading?: boolean;
}

const PERIODS: Array<{ key: KlinePeriod; label: string }> = [
  { key: 'day', label: '日线' },
  { key: 'week', label: '周线' },
  { key: 'month', label: '月线' },
];

const TREND: Record<MacdTrend, { text: string; color: string; hint: string }> = {
  rising: { text: '走强', color: 'volcano', hint: 'MACD 柱体较上一周期上行，动能增强' },
  falling: { text: '走弱', color: 'cyan', hint: 'MACD 柱体较上一周期下行，动能衰减（含柱体由正翻负的转空）' },
  flat: { text: '走平', color: 'default', hint: 'MACD 柱体与上一周期基本持平' },
};

const FLIP: Record<string, { text: string; color: string }> = {
  golden: { text: '金叉', color: 'red' },
  dead: { text: '死叉', color: 'green' },
};

const ZONE: Record<MacdZone, { text: string; color: string; hint: string }> = {
  above: { text: '水上', color: 'red', hint: '柱体在零轴上方（红柱），多头区域' },
  below: { text: '水下', color: 'green', hint: '柱体在零轴下方（绿柱），空头区域；绿柱缩短只代表本轮下跌动能暂停，常见于阴跌中继' },
  zero: { text: '零轴', color: 'default', hint: '柱体恰在零轴，多空临界' },
};

function signed(value: number, digits = 3): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function PeriodCard({ label, state }: { label: string; state: MacdState | null | undefined }) {
  if (!state) {
    return (
      <Card size="small" title={`${label} MACD`}>
        <Typography.Text type="secondary">预热不足，暂无法判定</Typography.Text>
      </Card>
    );
  }
  const trend = TREND[state.trend];
  const zone = ZONE[state.zone];
  const flip = state.flip ? FLIP[state.flip] : null;
  return (
    <Card size="small" title={`${label} MACD`}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={4} wrap>
          <Tooltip title={trend.hint}>
            <Tag color={trend.color} style={{ marginInlineEnd: 0 }}>
              {trend.text}
            </Tag>
          </Tooltip>
          {flip ? (
            <Tag color={flip.color} style={{ marginInlineEnd: 0 }}>
              {flip.text}
            </Tag>
          ) : null}
          <Tooltip title={zone.hint}>
            <Tag color={zone.color} style={{ marginInlineEnd: 0 }}>
              {zone.text}
            </Tag>
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {state.date}
          </Typography.Text>
        </Space>
        <Typography.Text style={{ fontSize: 13 }}>
          DIF {signed(state.dif)} · DEA {signed(state.dea)} · 柱 {signed(state.hist)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          上一周期柱 {signed(state.hist_prev)}
        </Typography.Text>
      </Space>
    </Card>
  );
}

export default function MacdStatePanel({ states, loading }: Props) {
  return (
    <Card
      size="small"
      title="MACD 周期状态"
      loading={loading}
      extra={
        <Tooltip title="柱体较上一周期上行=走强，下行=走弱；柱体由正翻负属于转空，不能按绝对值判成放大；柱体穿越零轴=金叉/死叉；周线固定比较已收盘的上周与上上周（当周K与当周收盘同日，容易与日线同源）；水上/水下按当根柱体符号判定——红柱=水上、绿柱=水下">
          <Typography.Text type="secondary" style={{ cursor: 'help' }}>
            判定口径
          </Typography.Text>
        </Tooltip>
      }
    >
      <Row gutter={[12, 12]}>
        {PERIODS.map(({ key, label }) => (
          <Col xs={24} md={8} key={key}>
            <PeriodCard label={label} state={states?.[key]} />
          </Col>
        ))}
      </Row>
    </Card>
  );
}
```

<a id="file-frontend-src-components-kline-candleoption-ts"></a>

#### `frontend/src/components/kline/candleOption.ts`

```ts
import type { EChartsOption } from 'echarts';
import type { KlineBar } from '../../api/types';

const UP_COLOR = '#f5222d';
const DOWN_COLOR = '#52c41a';
const DIF_COLOR = '#1677ff';
const DEA_COLOR = '#fa8c16';
const MUTED_COLOR = '#8c8c8c';

function fmtPrice(value: number | null | undefined): string {
  return value == null ? '—' : value.toFixed(3);
}

function fmtValue(value: number | null | undefined, digits: number): string {
  return value == null ? '—' : value.toFixed(digits);
}

function tooltipRow(label: string, value: string, color = '#262626'): string {
  return (
    `<div style="display:flex;justify-content:space-between;gap:20px;line-height:20px">` +
    `<span style="color:${MUTED_COLOR}">${label}</span><span style="color:${color}">${value}</span></div>`
  );
}

/** 蜡烛图 + 成交量 + MACD 三联图; 不足 2 根返回 null 由组件降级展示。 */
export function buildCandleOption(bars: KlineBar[], nodeDate?: string | null): EChartsOption | null {
  const valid = bars.filter((b) => b.open != null && b.close != null && b.high != null && b.low != null);
  if (valid.length < 2) return null;

  const dates = valid.map((b) => b.date);
  const candles = valid.map((b) => [b.open, b.close, b.low, b.high]);
  const volumes = valid.map((b) => b.volume ?? 0);
  const dif = valid.map((b) => b.dif);
  const dea = valid.map((b) => b.dea);
  const hist = valid.map((b) => b.hist);
  const pct = valid.map((bar, i) => {
    const prev = i > 0 ? valid[i - 1].close : null;
    return prev != null && prev !== 0 && bar.close != null ? bar.close / prev - 1 : null;
  });

  return {
    animation: false,
    // confine: 嵌套在表格滚动容器里时, 溢出容器的 tooltip 会被裁剪。
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'cross' },
      formatter: (params: unknown) => {
        const idx = (params as Array<{ dataIndex: number }>)[0]?.dataIndex;
        const bar = idx == null ? undefined : valid[idx];
        if (!bar || idx == null) return '';
        const chg = pct[idx];
        const chgColor = chg == null ? MUTED_COLOR : chg >= 0 ? UP_COLOR : DOWN_COLOR;
        return [
          `<div style="font-weight:600;margin-bottom:4px">${bar.date}</div>`,
          tooltipRow('涨跌幅', chg == null ? '—' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(2)}%`, chgColor),
          tooltipRow('开盘', fmtPrice(bar.open)),
          tooltipRow('收盘', fmtPrice(bar.close)),
          tooltipRow('最高', fmtPrice(bar.high)),
          tooltipRow('最低', fmtPrice(bar.low)),
          tooltipRow('成交量', bar.volume == null ? '—' : bar.volume.toLocaleString()),
          tooltipRow('DIF', fmtValue(bar.dif, 4)),
          tooltipRow('DEA', fmtValue(bar.dea, 4)),
          tooltipRow('MACD', fmtValue(bar.hist, 4)),
        ].join('');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: {
      top: 0,
      left: 64,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { fontSize: 11, color: '#8c8c8c' },
      data: ['DIF', 'DEA', 'MACD'],
    },
    grid: [
      { left: 64, right: 24, top: 28, height: '42%' },
      { left: 64, right: 24, top: '55%', height: '9%' },
      { left: 64, right: 24, top: '68%', height: '18%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        gridIndex: 0,
        boundaryGap: false,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#d9d9d9' } },
      },
      {
        type: 'category',
        data: dates,
        gridIndex: 1,
        boundaryGap: false,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#d9d9d9' } },
      },
      {
        type: 'category',
        data: dates,
        gridIndex: 2,
        boundaryGap: false,
        axisLabel: { color: '#8c8c8c', fontSize: 10 },
        axisLine: { lineStyle: { color: '#d9d9d9' } },
      },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, splitLine: { lineStyle: { color: '#f0f0f0' } } },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
      {
        gridIndex: 2,
        scale: true,
        axisLabel: { fontSize: 10, color: '#8c8c8c' },
        splitLine: { lineStyle: { color: '#f5f5f5' } },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], start: 0, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 6, height: 18 },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: candles,
        itemStyle: {
          color: UP_COLOR,
          color0: DOWN_COLOR,
          borderColor: UP_COLOR,
          borderColor0: DOWN_COLOR,
        },
        // 换仓节点竖线: 始终定义为对象, 无节点时空数组即清除(merge 模式防残留)。
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: MUTED_COLOR, type: 'dashed', width: 1 },
          label: {
            formatter: nodeDate ? `节点 ${nodeDate.slice(5)}` : '',
            position: 'insideEndTop',
            color: MUTED_COLOR,
            fontSize: 10,
          },
          data: nodeDate ? [{ xAxis: nodeDate }] : [],
        },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
        itemStyle: {
          color: (params) => {
            const bar = valid[params.dataIndex];
            return (bar.close ?? 0) >= (bar.open ?? 0) ? UP_COLOR : DOWN_COLOR;
          },
        },
      },
      {
        name: 'MACD',
        type: 'bar',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: hist,
        itemStyle: {
          color: (params) => ((params.value as number | null) ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR,
        },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: '#bfbfbf', type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
      {
        name: 'DIF',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: dif,
        symbol: 'none',
        lineStyle: { width: 1.2, color: DIF_COLOR },
      },
      {
        name: 'DEA',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: dea,
        symbol: 'none',
        lineStyle: { width: 1.2, color: DEA_COLOR },
      },
    ],
  };
}
```

<a id="file-frontend-src-components-kline-sharesoption-ts"></a>

#### `frontend/src/components/kline/sharesOption.ts`

```ts
import type { EChartsOption } from 'echarts';
import type { SharesPoint } from '../../api/types';

const LINE_COLOR = '#1677ff';

export function buildSharesOption(points: SharesPoint[]): EChartsOption | null {
  if (points.length < 2) return null;

  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => `${Number(v).toFixed(2)} 亿份`,
    },
    grid: { left: 64, right: 24, top: 24, bottom: 48 },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.date),
      boundaryGap: false,
      axisLabel: { color: '#8c8c8c' },
    },
    yAxis: {
      scale: true,
      axisLabel: { formatter: '{value} 亿' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8, height: 18 }],
    series: [
      {
        name: '份额',
        type: 'line',
        data: points.map((p) => p.shares_yi),
        showSymbol: false,
        lineStyle: { width: 1.5, color: LINE_COLOR },
        areaStyle: { color: 'rgba(22,119,255,0.08)' },
      },
    ],
  };
}
```

### 14.15 前端 · 日度复盘组件 frontend/src/components/daily/

<a id="file-frontend-src-components-daily-attributionpanel-tsx"></a>

#### `frontend/src/components/daily/AttributionPanel.tsx`

```tsx
import { Card, Col, DatePicker, Row, Segmented, Space, Statistic, Typography } from 'antd';
import dayjs from 'dayjs';
import ReactECharts from 'echarts-for-react';
import { useMemo, useState } from 'react';
import type { DailyAttribution } from '../../api/types';
import { buildDailyBarsOption, buildDailyCumulativeOption } from './attributionOption';
import { buildDailyWindow, summarizeDaily, summarizeGated } from './window';
import { buildGatedOption } from './gatedOption';
import { fmtPct, fmtSignedPct, returnColor } from '../common/format';

interface Props {
  data: DailyAttribution | undefined;
}

type Range = 'all' | 'ytd' | 'since';
type View = 'cumulative' | 'daily' | 'gated';

const RANGE_OPTIONS = [
  { label: '全历史', value: 'all' },
  { label: '今年以来', value: 'ytd' },
  { label: '自选起点', value: 'since' },
];

const VIEW_OPTIONS = [
  { label: '累计走势', value: 'cumulative' },
  { label: '每日涨跌', value: 'daily' },
  { label: '年线开关', value: 'gated' },
];

const VIEW_LABELS: Record<View, string> = {
  cumulative: '日度等权复利',
  daily: '每日涨跌',
  gated: '年线开关净值',
};

function statColor(value: number | null | undefined): string | undefined {
  return value == null ? undefined : returnColor(value);
}

export default function AttributionPanel({ data }: Props) {
  const [range, setRange] = useState<Range>('ytd');
  const [since, setSince] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [view, setView] = useState<View>('cumulative');
  const cumulative = useMemo(() => data?.cumulative ?? [], [data]);
  const year = useMemo(() => {
    const last = cumulative[cumulative.length - 1];
    return last ? Number(last.signal_date.slice(0, 4)) : undefined;
  }, [cumulative]);
  const settledLast = useMemo(() => {
    for (let i = cumulative.length - 1; i >= 0; i -= 1) {
      if (cumulative[i].core != null) return cumulative[i].signal_date;
    }
    return undefined;
  }, [cumulative]);
  const ytdYear = !since && range === 'ytd' ? year : undefined;
  const window = useMemo(() => buildDailyWindow(cumulative, { year: ytdYear, since }), [cumulative, ytdYear, since]);
  const summary = useMemo(() => summarizeDaily(data?.days ?? [], { year: ytdYear, since }), [data, ytdYear, since]);
  const gated = useMemo(() => summarizeGated(window), [window]);
  // 所选日期可能落在非交易日, 展示吸附后的信号日, 保证标题与曲线起点一致。
  const startDate = since ? (window.points[0]?.signal_date ?? since) : null;
  const option = useMemo(() => {
    if (view === 'daily') return buildDailyBarsOption(window);
    if (view === 'gated') return buildGatedOption(window);
    return buildDailyCumulativeOption(window);
  }, [window, view]);

  if (!data || data.days.length === 0) {
    return <Card size="small" title="频率对照归因">暂无带事后收益的日度记录</Card>;
  }

  const rangeLabel = startDate ? `自 ${startDate} 起` : range === 'ytd' ? `${year ?? '-'} 年以来` : '全历史';
  const title = `频率对照归因（${rangeLabel}，${VIEW_LABELS[view]}）`;
  const hs300Cumulative = [...window.points].reverse().find((p) => p.hs300 != null)?.hs300 ?? null;
  const stats =
    view === 'gated'
      ? [
          { title: '评估天数', value: summary.days, color: undefined },
          { title: '开仓 / 空仓', value: `${gated.gateOnDays} / ${gated.gateOffDays}`, color: undefined },
          {
            title: '仅年线上累计',
            value: fmtSignedPct(gated.gatedCumulative),
            color: statColor(gated.gatedCumulative),
          },
          {
            title: '仅年线上回撤',
            value: fmtSignedPct(gated.gatedMaxDrawdown),
            color: statColor(gated.gatedMaxDrawdown),
          },
          {
            title: '每日持有累计',
            value: fmtSignedPct(summary.coreCumulative),
            color: statColor(summary.coreCumulative),
          },
          {
            title: '每日持有回撤',
            value: fmtSignedPct(gated.coreMaxDrawdown),
            color: statColor(gated.coreMaxDrawdown),
          },
        ]
      : [
          { title: '评估天数', value: summary.days, color: undefined },
          { title: '策略累计', value: fmtSignedPct(summary.coreCumulative), color: statColor(summary.coreCumulative) },
          { title: '基线累计', value: fmtSignedPct(summary.baselineCumulative), color: statColor(summary.baselineCumulative) },
          {
            title: '股票池累计',
            value: fmtSignedPct(summary.universeCumulative),
            color: statColor(summary.universeCumulative),
          },
          { title: '沪深300累计', value: fmtSignedPct(hs300Cumulative), color: statColor(hs300Cumulative) },
          { title: 'IC 均值', value: summary.rankIcMean?.toFixed(3) ?? '—', color: statColor(summary.rankIcMean) },
          { title: '策略胜率', value: fmtPct(summary.corePositive, 1), color: undefined },
          { title: '日均换手', value: data.overall.turnover_avg == null ? '—' : fmtPct(data.overall.turnover_avg, 0), color: undefined },
        ];
  const anchorNote = startDate
    ? `，以 ${startDate} 为起点归零`
    : range === 'ytd'
      ? '，年初起点归零（含收益落在本年的跨年结算日）'
      : '';
  const note =
    view === 'daily'
      ? `每日涨跌 = 信号日收盘 → 下一交易日收盘的等权组合收益；策略持仓为柱体，红涨绿跌。${startDate ? ` 仅显示 ${startDate} 起的交易日。` : ''}`
      : view === 'gated'
        ? `仅年线上执行 = 信号日沪深300 收盘 > MA250（严格大于，年线未热身按空仓）的交易日才承受策略持仓当日收益，其余交易日空仓记 0 收益；每日持有 = 不看年线、每个交易日都按当前节点持仓承受当日收益。淡红区为年线下方，回撤为窗口内最大回撤，不扣费用。注意：日频每日判定开关意味着每日申赎，实际执行会有申赎摩擦，本视图只展示门控的归因效果，不是可执行收益。${startDate ? ` 累计与回撤均以 ${startDate} 为起点。` : ''}`
        : `策略持仓 vs 基线 vs 股票池：按每日等权组合收益复利累乘${anchorNote}，不扣手续费与申赎摩擦；日均换手 = 策略持仓相邻交易日被换掉的占比，换仓节点才跳升。`;

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Space size={8} wrap>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              自
            </Typography.Text>
            <DatePicker
              size="small"
              allowClear
              placeholder="选一日"
              style={{ width: 124 }}
              value={startDate ? dayjs(startDate) : null}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              disabledDate={(d) => {
                const day = d.format('YYYY-MM-DD');
                const first = cumulative[0]?.signal_date;
                return (first != null && day < first) || (settledLast != null && day > settledLast);
              }}
              onChange={(d) => {
                setSince(d ? d.format('YYYY-MM-DD') : null);
                setRange(d ? 'since' : 'all');
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              起
            </Typography.Text>
          </Space>
          <Segmented
            size="small"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(v) => {
              const next = v as Range;
              setRange(next);
              if (next === 'since') {
                setPickerOpen(true);
                return;
              }
              setSince(null);
              setPickerOpen(false);
            }}
          />
          <Segmented size="small" options={VIEW_OPTIONS} value={view} onChange={(v) => setView(v as View)} />
        </Space>
      }
    >
      <Row gutter={16}>
        {stats.map((s) => (
          <Col xs={12} sm={8} md={3} key={s.title}>
            <Statistic title={s.title} value={s.value} valueStyle={{ color: s.color, fontSize: 20 }} />
          </Col>
        ))}
      </Row>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {note}
      </Typography.Text>
      {window.points.length === 0 ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 24 }}>
          该区间还没有已结算的日度记录
        </Typography.Paragraph>
      ) : (
        <ReactECharts option={option} style={{ height: view === 'gated' ? 460 : 360 }} notMerge />
      )}
    </Card>
  );
}
```

<a id="file-frontend-src-components-daily-expandedkline-tsx"></a>

#### `frontend/src/components/daily/ExpandedKline.tsx`

```tsx
import { Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useKline } from '../../hooks/useEtfs';
import { buildCandleOption } from '../kline/candleOption';

const WINDOW_BARS = 120;
/** 节点后多看约 4 周, 让节点竖线落在窗口右侧而不是贴边。 */
const TAIL_DAYS = 30;
const DAY_MS = 86_400_000;

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 老节点已超出最近 120 根时, 把窗口截止到节点后 30 个自然日; 新节点仍看实时窗口。 */
function windowEnd(nodeDate?: string | null): string | null {
  if (!nodeDate) return null;
  const endMs = new Date(`${nodeDate}T00:00:00`).getTime() + TAIL_DAYS * DAY_MS;
  return endMs >= new Date(`${fmtDate(Date.now())}T00:00:00`).getTime() ? null : fmtDate(endMs);
}

interface Props {
  code: string;
  /** 换仓节点日: 图上画竖线, 并且窗口围绕该日截取。 */
  nodeDate?: string | null;
}

/** 表格展开行的迷你K线: 近120根日K(+当日实时bar); 展开时才挂载, 不展开不请求。 */
export default function ExpandedKline({ code, nodeDate }: Props) {
  const end = useMemo(() => windowEnd(nodeDate), [nodeDate]);
  const kline = useKline(code, 'day', WINDOW_BARS, end == null, end);
  const option = useMemo(() => buildCandleOption(kline.data?.bars ?? [], nodeDate), [kline.data, nodeDate]);

  if (kline.isLoading) return <Typography.Text type="secondary">K 线加载中…</Typography.Text>;
  if (!option) return <Typography.Text type="secondary">K 线数据不足</Typography.Text>;
  return <ReactECharts option={option} style={{ height: 360 }} notMerge />;
}
```

<a id="file-frontend-src-components-daily-factorbreakdown-tsx"></a>

#### `frontend/src/components/daily/FactorBreakdown.tsx`

```tsx
import { Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CoreFactor } from '../../api/types';
import { returnColor } from '../common/format';
import { factorFormula, fmtContrib, fmtValue, fmtWeight } from './factorFormat';

const columns: ColumnsType<CoreFactor> = [
  { title: '因子', dataIndex: 'label', width: 128 },
  { title: '原始值', width: 96, align: 'right', render: (_, f) => fmtValue(f) },
  {
    title: '截面分位',
    width: 96,
    align: 'right',
    render: (_, f) => (
      <span title="当日全市场截面排名映射到 -1 ~ +1; 缺失记 0(中性), 扣分行无分位">{fmtContrib(f.z)}</span>
    ),
  },
  { title: '权重', width: 76, align: 'right', render: (_, f) => fmtWeight(f.weight) },
  {
    title: '贡献',
    width: 92,
    align: 'right',
    render: (_, f) => <span style={{ color: returnColor(f.contrib) }}>{fmtContrib(f.contrib)}</span>,
  },
];

interface Props {
  factors?: CoreFactor[] | null;
  /** 策略分本身(贡献之和, 保留 6 位小数)。 */
  total?: number | null;
  /** 截面日期: 节点持仓的因子是换仓日截面, 不是当天。 */
  date?: string | null;
  /** 评分池只数, 说明分位是在多大截面上算的。 */
  scored?: number | null;
}

/** 策略分构成: 8 因子原始值 → 截面分位 → 权重 → 贡献, 命中高位高波时另附扣分行。 */
export default function FactorBreakdown({ factors, total, date, scored }: Props) {
  if (!factors || factors.length === 0) {
    return <Typography.Text type="secondary">该记录没有因子拆解(旧节点需重新回填)。</Typography.Text>;
  }
  const sum = factors.reduce((acc, f) => acc + f.contrib, 0);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        策略分 = {factorFormula(factors)}
        {date ? ` · ${date} 截面` : ''}
        {scored ? ` · 评分池 ${scored} 只` : ''}
      </Typography.Text>
      <Table<CoreFactor>
        size="small"
        rowKey="key"
        columns={columns}
        dataSource={factors}
        pagination={false}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <Typography.Text strong>合计</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} />
            <Table.Summary.Cell index={2} />
            <Table.Summary.Cell index={3} />
            <Table.Summary.Cell index={4} align="right">
              <Typography.Text strong>{fmtContrib(total ?? sum)}</Typography.Text>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        分位为当日全市场截面百分位(-1 最弱 / +1 最强), 缺失值记 0 不参与排序; 权重固定, 不随年份调整。
        波动≥45% 且收盘距 250 日高点 3% 以内的名字另扣 0.10, 只减不加。
      </Typography.Text>
    </Space>
  );
}
```

<a id="file-frontend-src-components-daily-historypanel-tsx"></a>

#### `frontend/src/components/daily/HistoryPanel.tsx`

```tsx
import { Alert, Card, Space, Typography } from 'antd';
import { useMemo } from 'react';
import AttributionPanel from './AttributionPanel';
import HistoryTable from './HistoryTable';
import SummaryCards from './SummaryCards';
import TimelineTable from './TimelineTable';
import { useDailyAttribution, useDailyDay, useDailyDays, useDailyTimeline } from '../../hooks/useDailyPick';

/** 滚动历史: 累计净值 + 逐日记录 + 每只 ETF 的持有区间。 */
export default function HistoryPanel() {
  const days = useDailyDays();
  const attribution = useDailyAttribution();
  const timeline = useDailyTimeline();
  const rows = useMemo(() => days.data ?? [], [days.data]);
  const latestSettled = useMemo(
    () => [...rows].reverse().find((d) => d.universe_mean != null || d.core_mean != null),
    [rows],
  );
  const detail = useDailyDay(latestSettled?.signal_date);

  if (days.error) {
    return <Alert type="error" showIcon message="日度记录加载失败" description={String(days.error)} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {detail.data && (
        <Card
          size="small"
          title={`最近结算 · ${detail.data.signal_date}`}
          extra={<Typography.Text type="secondary">次日 {detail.data.next_signal ?? '未收盘'} 结算</Typography.Text>}
        >
          <SummaryCards day={detail.data} />
        </Card>
      )}
      <AttributionPanel data={attribution.data} />
      <TimelineTable spells={timeline.data ?? []} loading={timeline.isLoading} />
      <HistoryTable rows={rows} />
    </Space>
  );
}
```

<a id="file-frontend-src-components-daily-historytable-tsx"></a>

#### `frontend/src/components/daily/HistoryTable.tsx`

```tsx
import { Card, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import type { DailyRow } from '../../api/types';
import { fmtSignedPct, returnColor, todayStr } from '../common/format';

interface Props {
  rows: DailyRow[];
}

const columns: ColumnsType<DailyRow> = [
  { title: '信号日', dataIndex: 'signal_date', width: 110, fixed: 'left' },
  { title: '次日', dataIndex: 'next_signal', width: 110 },
  {
    title: '股票池',
    dataIndex: 'universe_mean',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
  {
    title: '策略持仓',
    dataIndex: 'core_mean',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
  {
    title: '基线前10',
    dataIndex: 'baseline_mean',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
  {
    title: 'Rank IC',
    dataIndex: 'rank_ic',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{v == null ? '—' : v.toFixed(2)}</span>,
  },
  { title: '可评分', dataIndex: 'scored', align: 'right', width: 80 },
];

/** 逐日复盘记录: 只做滚动观察, 日度操作计划看「节点」tab。 */
export default function HistoryTable({ rows }: Props) {
  // 交易日历预铺到年末, 未来日期的行全是空值, 只展示已到达的信号日。
  const reached = useMemo(() => {
    const today = todayStr();
    return rows.filter((d) => d.signal_date <= today).reverse();
  }, [rows]);

  return (
    <Card
      size="small"
      title="逐日记录"
      extra={<Typography.Text type="secondary">信号日收盘 → 次日收盘的等权收益</Typography.Text>}
    >
      <Table<DailyRow>
        size="small"
        rowKey="signal_date"
        columns={columns}
        dataSource={reached}
        pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
        scroll={{ x: 720 }}
      />
    </Card>
  );
}
```

<a id="file-frontend-src-components-daily-holdingcard-tsx"></a>

#### `frontend/src/components/daily/HoldingCard.tsx`

```tsx
import { Card, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import type { LiveHeldPick, RealtimeQuote } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { codeColumn, nameColumn } from './linkColumns';
import { quoteColumns } from './quoteColumns';

interface Props {
  /** 上一节点(或收盘正式节点)的持仓名单。 */
  held: LiveHeldPick[];
  /** 策略实时目标名单: 在册=「拿着」, 不在=「卖出」。收盘后目标=持仓, 全部为拿着。 */
  targetCodes: ReadonlySet<string>;
  /** 持仓所属节点日, 标注在卡片标题。 */
  nodeLabel?: string | null;
  quotes: Record<string, RealtimeQuote> | undefined;
  /** 排名列展示「节点时 → 今日」: 盘中为实时排名, 收盘后为当日收盘快照的策略排名。 */
  rankBounds?: { holdTop: number; bufferRank: number };
  onSelect: (code: string) => void;
}

/** 右卡: 当前持仓 + 节点→今日排名 + 本轮周期涨跌; 只有换仓节点日出现「需卖出」提示。 */
export default function HoldingCard({ held, targetCodes, nodeLabel, quotes, rankBounds, onSelect }: Props) {
  const sold = held.filter((h) => !targetCodes.has(h.code)).length;

  /** 组合本轮收益 = 各持仓「节点收盘 → 现价」的等权平均(缺价的持仓剔除)。 */
  const period = useMemo(() => {
    const rets = held.flatMap((h) => {
      const price = quotes?.[h.code]?.price;
      return h.node_close != null && price != null ? [price / h.node_close - 1] : [];
    });
    return { ret: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null, count: rets.length };
  }, [held, quotes]);

  const columns: ColumnsType<LiveHeldPick> = [
    codeColumn<LiveHeldPick>(),
    nameColumn<LiveHeldPick>(),
    {
      title: rankBounds ? (
        <Tooltip title="节点时排名 → 今日排名（盘中为实时, 收盘后为收盘快照）。跌出缓冲带下次节点会被换出; 今日走弱时重点看这一列">
          排名 节点→今日
        </Tooltip>
      ) : (
        '节点时排名'
      ),
      width: rankBounds ? 150 : 100,
      render: (_, row) => {
        const nodeTag = (
          <Tag color={row.core_rank <= (rankBounds?.holdTop ?? 5) ? 'gold' : 'blue'} style={{ marginInlineEnd: 0 }}>
            {row.core_rank}
          </Tag>
        );
        if (!rankBounds) return nodeTag;
        const today = row.today_rank;
        const color = today == null || today > rankBounds.bufferRank ? 'red' : today <= rankBounds.holdTop ? 'gold' : 'blue';
        return (
          <Space size={4}>
            {nodeTag}
            <Typography.Text type="secondary">→</Typography.Text>
            <Tag color={color} style={{ marginInlineEnd: 0 }}>
              {today ?? '—'}
            </Tag>
          </Space>
        );
      },
    },
    { title: '节点时分', width: 92, align: 'right', render: (_, row) => fmtNum(row.core_score) },
    ...quoteColumns<LiveHeldPick>(quotes),
    {
      title: <Tooltip title="现价相对换仓节点日收盘的涨跌幅 = 持仓期收益">节点涨跌</Tooltip>,
      width: 96,
      align: 'right',
      render: (_, row) => {
        const price = quotes?.[row.code]?.price;
        if (row.node_close == null || price == null) return <Typography.Text type="secondary">—</Typography.Text>;
        const pct = price / row.node_close - 1;
        return <span style={{ color: returnColor(pct) }}>{fmtSignedPct(pct)}</span>;
      },
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          当前持仓
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            截至节点 {nodeLabel ?? '—'}
          </Typography.Text>
        </Space>
      }
      extra={
        <Space size={12}>
          {period.ret != null && (
            <Tooltip
              title={`${period.count}/${held.length} 只有节点收盘与现价; 等权平均 = 节点日等额买入各持仓至今的组合收益`}
            >
              <span style={{ fontSize: 12, color: 'rgba(0, 0, 0, 0.45)' }}>
                本轮等权{' '}
                <span style={{ fontSize: 15, fontWeight: 600, color: returnColor(period.ret) }}>
                  {fmtSignedPct(period.ret)}
                </span>
              </span>
            </Tooltip>
          )}
          {sold > 0 && (
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              节点日需卖出 {sold}
            </Tag>
          )}
        </Space>
      }
    >
      <Table<LiveHeldPick>
        size="small"
        rowKey="code"
        columns={columns}
        dataSource={held}
        pagination={false}
        scroll={{ x: 682 }}
        onRow={(row) => ({ onClick: () => onSelect(row.code), style: { cursor: 'pointer' } })}
      />
    </Card>
  );
}
```

<a id="file-frontend-src-components-daily-liveklinepanel-tsx"></a>

#### `frontend/src/components/daily/LiveKlinePanel.tsx`

```tsx
import { Card, Space, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useKline } from '../../hooks/useEtfs';
import { buildCandleOption } from '../kline/candleOption';

/** 行情时间与服务端相差超过 10 分钟视为失鲜(暂停刷新/休市), 标黄提醒。 */
const STALE_GAP_SEC = 600;
const TICK_MS = 5000;

function gapLabel(asOf: string | null, nowMs: number): { text: string; stale: boolean } {
  if (!asOf) return { text: '行情时间未知', stale: true };
  const asMs = new Date(asOf.replace(' ', 'T')).getTime();
  const gap = Math.max(0, Math.round((nowMs - asMs) / 1000));
  const text = gap >= 120 ? `行情截至 ${asOf.slice(11, 19)} · 距今 ${Math.round(gap / 60)} 分钟` : `行情截至 ${asOf.slice(11, 19)} · 距今 ${gap} 秒`;
  return { text, stale: gap > STALE_GAP_SEC };
}

/** 双卡共用的 K 线面板: 历史日K + 当日实时 bar(后端 live=1 追加), 30 秒随行情刷新。 */
export default function LiveKlinePanel({
  code,
  asOf,
  nodeDate,
  live = true,
}: {
  code: string;
  asOf: string | null;
  /** 换仓节点日: 图上画竖线, 便于对照持仓起点。 */
  nodeDate?: string | null;
  /** false=收盘后快照口径: 没有实时 bar, 不显示行情新鲜度与刷新提示。 */
  live?: boolean;
}) {
  const kline = useKline(code, 'day', 250, true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const option = useMemo(() => buildCandleOption(kline.data?.bars ?? [], nodeDate), [kline.data, nodeDate]);
  const gap = gapLabel(asOf, nowMs);

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          K 线
          <Link to={`/etf/${code}`}>{code}</Link>
        </Space>
      }
      extra={
        <Space size={12} wrap>
          <Typography.Text type={live && gap.stale ? 'warning' : 'secondary'}>
            {live ? gap.text : '收盘数据'}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {live ? '日K + 当日实时 · 30 秒刷新' : '日K（含当日收盘）'}
          </Typography.Text>
        </Space>
      }
    >
      {option ? (
        <ReactECharts option={option} style={{ height: 360 }} notMerge />
      ) : (
        <Typography.Text type="secondary">{kline.isLoading ? 'K 线加载中…' : 'K 线数据不足'}</Typography.Text>
      )}
    </Card>
  );
}
```

<a id="file-frontend-src-components-daily-nodedetailcard-tsx"></a>

#### `frontend/src/components/daily/NodeDetailCard.tsx`

```tsx
import { Alert, Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DailyNodeDetail, DailyNodePick } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { ActionTag } from './actionTag';
import ExpandedKline from './ExpandedKline';
import FactorBreakdown from './FactorBreakdown';
import { codeColumn, nameColumn } from './linkColumns';
import { ruleVersionLabel } from './ruleLabel';

interface Props {
  detail: DailyNodeDetail | undefined;
  loading: boolean;
  error: unknown;
}

const holdingColumns: ColumnsType<DailyNodePick> = [
  codeColumn<DailyNodePick>(86),
  nameColumn<DailyNodePick>(),
  { title: '主题', dataIndex: 'theme', width: 96, render: (v: string | null) => v ?? '—' },
  {
    title: '排名',
    width: 76,
    render: (_, row) => <Tag color={row.core_rank <= 5 ? 'gold' : 'blue'}>{row.core_rank}</Tag>,
  },
  { title: '策略分', width: 90, align: 'right', render: (_, row) => fmtNum(row.core_score) },
  {
    title: '成交价',
    width: 96,
    align: 'right',
    render: (_, row) => fmtNum(row.entry_price ?? row.price, 3),
  },
  { title: '结算价', width: 96, align: 'right', render: (_, row) => fmtNum(row.next_price, 3) },
  {
    title: '区间收益',
    width: 96,
    align: 'right',
    render: (_, row) => <span style={{ color: returnColor(row.return) }}>{fmtSignedPct(row.return)}</span>,
  },
  { title: '动作', width: 104, render: (_, row) => <ActionTag action={row.action} /> },
];

const rankedColumns: ColumnsType<DailyNodePick> = [
  {
    title: '排名',
    width: 70,
    render: (_, row) => <Tag color={row.core_rank <= 5 ? 'gold' : 'default'}>{row.core_rank}</Tag>,
  },
  codeColumn<DailyNodePick>(90),
  nameColumn<DailyNodePick>(),
  { title: '主题', dataIndex: 'theme', width: 100, render: (v: string | null) => v ?? '—' },
  { title: '策略分', width: 92, align: 'right', render: (_, row) => fmtNum(row.core_score) },
  { title: '动作', width: 104, render: (_, row) => (row.action === 'rank' ? '—' : <ActionTag action={row.action} />) },
];

export default function NodeDetailCard({ detail, loading, error }: Props) {
  if (error) {
    return <Alert type="error" showIcon message="节点明细加载失败" description={String(error)} />;
  }
  if (loading) return <Card size="small" loading />;
  if (!detail) return null;

  const held = new Set(detail.holdings.map((p) => p.code));

  return (
    <Card
      size="small"
      title={`换仓节点 ${detail.signal_date}`}
      extra={
        <Space size={8} wrap>
          <Tag color="blue">{ruleVersionLabel(detail.rule_version)}</Tag>
          <Tag>{detail.next_rebalance ? `下次换仓 ${detail.next_rebalance}` : '已到日历尾部'}</Tag>
          <Typography.Text type="secondary">
            评分池 {detail.scored} · 节点等权收益{' '}
            <span style={{ color: returnColor(detail.return) }}>{fmtSignedPct(detail.return)}</span>
          </Typography.Text>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          每 5 个交易日换仓一次：周四收盘先卖出预备排名掉出前 15 的持仓（当天份额只到 T-1），周四份额落地后按完整排名重算，
          周五开盘买足前 5 名、并卖出仍被挤出缓冲带的持仓。买入与顺延卖按次日开盘成交，其余按节点收盘计价；
          收盘卖出当日收益记 0，等权、不扣费用，与日度归因同口径。点行首箭头看该标的 K 线（虚线标节点日）与策略分构成。
        </Typography.Text>

        <Table<DailyNodePick>
          size="small"
          rowKey="code"
          columns={holdingColumns}
          dataSource={detail.holdings}
          pagination={false}
          scroll={{ x: 980 }}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <ExpandedKline code={row.code} nodeDate={detail.signal_date} />
                <FactorBreakdown
                  factors={row.factors}
                  total={row.core_score}
                  date={detail.signal_date}
                  scored={detail.scored}
                />
              </Space>
            ),
          }}
        />

        {detail.sells.length > 0 && (
          <Space size={6} wrap>
            <Typography.Text type="secondary">本次卖出：</Typography.Text>
            {detail.sells.map((p) => (
              <Tag key={p.code} color={p.sell_at === 'open' ? 'orange' : undefined}>
                {p.code} {p.name ?? ''} · 排名 {p.core_rank} · {p.sell_at === 'open' ? '周五开盘卖' : '周四收盘卖'} ·{' '}
                {fmtSignedPct(p.return)}
              </Tag>
            ))}
          </Space>
        )}

        <Typography.Text type="secondary">策略评分前 20</Typography.Text>
        <Table<DailyNodePick>
          size="small"
          rowKey="code"
          columns={rankedColumns}
          dataSource={detail.ranked}
          pagination={false}
          scroll={{ x: 720 }}
          onRow={(row) => ({ style: { background: held.has(row.code) ? '#f0f7ff' : undefined } })}
        />
      </Space>
    </Card>
  );
}
```

<a id="file-frontend-src-components-daily-nodepanel-tsx"></a>

#### `frontend/src/components/daily/NodePanel.tsx`

```tsx
import { Alert, Button, Card, Popconfirm, Progress, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyNodeRow } from '../../api/types';
import { useDailyCoreStatus, useDailyNode, useDailyNodes, useRebuildDailyCore } from '../../hooks/useDailyPick';
import { fmtSignedPct, returnColor } from '../common/format';
import NodeDetailCard from './NodeDetailCard';

const REBALANCE_EVERY = 5;

/** 换仓节点: 每次换仓的完整交易计划(买/继续持有/卖), 默认展开最新节点。 */
export default function NodePanel() {
  const nodes = useDailyNodes();
  const [selected, setSelected] = useState<string>();
  const rows = useMemo(() => [...(nodes.data ?? [])].reverse(), [nodes.data]);
  const active = selected ?? rows[0]?.signal_date;
  const detail = useDailyNode(active);
  const detailRef = useRef<HTMLDivElement>(null);

  // 明细在节点表下方, 点日期后滚过去, 否则看不到选中结果
  const pick = (date: string) => {
    setSelected(date);
    detailRef.current?.scrollIntoView({ block: 'start' });
  };

  const status = useDailyCoreStatus();
  const rebuild = useRebuildDailyCore();
  const queryClient = useQueryClient();
  const running = status.data?.state === 'running';
  const wasRunning = useRef(false);

  useEffect(() => {
    if (wasRunning.current && !running && status.data?.state === 'done') {
      queryClient.invalidateQueries({ queryKey: ['daily', 'core'] });
      queryClient.invalidateQueries({ queryKey: ['daily', 'nodes'] });
      queryClient.invalidateQueries({ queryKey: ['daily', 'node'] });
    }
    wasRunning.current = running;
  }, [running, status.data?.state, queryClient]);

  const columns: ColumnsType<DailyNodeRow> = [
    {
      title: '换仓日',
      dataIndex: 'signal_date',
      width: 120,
      fixed: 'left',
      render: (date: string) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => pick(date)}>
          {date}
        </Button>
      ),
    },
    { title: '下次换仓', dataIndex: 'next_rebalance', width: 110, render: (v: string | null) => v ?? '—' },
    {
      title: '持仓',
      dataIndex: 'holdings',
      render: (items: DailyNodeRow['holdings']) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {items.map((p) => `${p.code}${p.name ? ` ${p.name}` : ''}`).join(' · ')}
        </Typography.Text>
      ),
    },
    {
      title: '动作',
      width: 200,
      render: (_, row) => (
        <Space size={4} wrap>
          <Tag color="red">买 {row.counts.buy}</Tag>
          <Tag color="blue">持 {row.counts.hold}</Tag>
          <Tag>卖 {row.counts.sell}</Tag>
        </Space>
      ),
    },
    {
      title: '节点收益',
      dataIndex: 'return',
      width: 100,
      align: 'right',
      render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
    },
    {
      title: '前10等权',
      dataIndex: 'top10_return',
      width: 100,
      align: 'right',
      render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
    },
    {
      title: '沪深300',
      dataIndex: 'hs300_return',
      width: 100,
      align: 'right',
      render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
    },
    { title: '评分池', dataIndex: 'scored', width: 84, align: 'right' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={`换仓节点 · 每 ${REBALANCE_EVERY} 个交易日一次`}
        extra={
          <Space size={8} wrap>
            <Typography.Text type="secondary">共 {rows.length} 个节点</Typography.Text>
            <Popconfirm
              title="回填全部换仓节点？"
              description="从 2015-01-05 锚点起每 5 个交易日推演一次，历史越长耗时越久（约 5 分钟）。"
              onConfirm={() => rebuild.mutate()}
              disabled={running}
            >
              <Button size="small" loading={rebuild.isPending || running} disabled={running}>
                {running ? '回填中' : '回填节点'}
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            每个节点就是一次完整交易计划：本次买入谁、谁继续持有、谁被卖出。节点之间持仓不变，
            所以「持有中」的日子没有新记录；节点收益按混合执行价结算：周四收盘卖、周五开盘买与顺延卖，
            其余按节点收盘，等权、不扣费用。「前10等权」是同一节点评分前 10 名持有到下一节点的收盘收益，
            「沪深300」是同区间指数涨跌，两者都不含成本，用来对照集中到 5 只划不划算、涨跌里有多少是市场给的。
          </Typography.Text>
          {running && (
            <Progress
              status="active"
              percent={status.data?.total ? Math.floor(((status.data.done ?? 0) / status.data.total) * 100) : 0}
              format={() => `${status.data?.done ?? 0}/${status.data?.total ?? 0}`}
            />
          )}
          {running && <Typography.Text type="secondary">{status.data?.msg}</Typography.Text>}
          {status.data?.state === 'failed' && <Alert type="error" showIcon message={status.data.error} />}
          {nodes.error ? (
            <Alert type="error" showIcon message="节点列表加载失败" description={String(nodes.error)} />
          ) : (
            <Table<DailyNodeRow>
              size="small"
              rowKey="signal_date"
              columns={columns}
              dataSource={rows}
              loading={nodes.isLoading}
              scroll={{ x: 1150 }}
              pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
              rowClassName={(row) => (row.signal_date === active ? 'daily-row-active' : '')}
            />
          )}
        </Space>
      </Card>

      <div ref={detailRef}>
        <NodeDetailCard detail={detail.data} loading={detail.isLoading} error={detail.error} />
      </div>
    </Space>
  );
}
```

<a id="file-frontend-src-components-daily-screenranking-tsx"></a>

#### `frontend/src/components/daily/ScreenRanking.tsx`

```tsx
import { Input, Select, Space, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import type { CoreFactor, DailyScreenRow } from '../../api/types';
import { factorFormula } from './factorFormat';
import ExpandedKline from './ExpandedKline';
import ScreenRowDetail from './ScreenRowDetail';
import { buildScreenColumns, rowBackground } from './screenColumns';
import type { FactorSpec } from './factorFormat';

/** 状态筛选按漏斗深度排序: 缓冲带持仓 → 评分池 → 各级剔除。 */
const STAGE_ORDER = [
  'core_hold',
  'core_pool',
  'small_aum',
  'no_shares',
  'no_bar',
  'short_history',
  'bad_data',
  'hk',
  'non_equity',
];

interface Props {
  rows: DailyScreenRow[];
  loading?: boolean;
  /** core8 缓冲带当前持仓: 行底色 + 名称列标签。 */
  heldCodes?: ReadonlySet<string>;
  /** 这批排名的信号日: 展开后的因子拆解按该日截面计算。 */
  signalDate?: string | null;
  /** 盘中实时排名: 追加现价/涨跌幅列（数据内嵌在行 quote 字段）。 */
  live?: boolean;
}

export default function ScreenRanking({ rows, loading, heldCodes, signalDate, live }: Props) {
  const [keyword, setKeyword] = useState('');
  const [stage, setStage] = useState<string>();
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggle = (code: string) =>
    setExpanded((keys) => (keys.includes(code) ? keys.filter((k) => k !== code) : [...keys, code]));

  // 因子列与公式都取自记录自带的元数据: 后端改权重/改名, 这里自动跟着变。
  // 高位高波扣分不是截面加权项, 只出现在命中标的的拆解里, 不单独占列。
  const template = useMemo<CoreFactor[] | null>(() => {
    for (const row of rows) {
      const factors = row.core_factors?.filter((f) => f.key !== 'high_vol_penalty');
      if (factors?.length) return factors;
    }
    return null;
  }, [rows]);
  const factorSpecs = useMemo<FactorSpec[]>(
    () => (template ?? []).map(({ key, label, weight }) => ({ key, label, weight })),
    [template],
  );

  const columns = useMemo(() => buildScreenColumns(heldCodes, factorSpecs, live), [heldCodes, factorSpecs, live]);

  const stageOptions = useMemo(() => {
    const map = new Map<string, { text: string; count: number }>();
    for (const row of rows) {
      const cur = map.get(row.stage);
      map.set(row.stage, { text: row.stage_text, count: (cur?.count ?? 0) + 1 });
    }
    return STAGE_ORDER.flatMap((key) => {
      const entry = map.get(key);
      return entry ? [{ value: key, label: `${entry.text}（${entry.count}）` }] : [];
    });
  }, [rows]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (stage && row.stage !== stage) return false;
      if (!kw) return true;
      return (
        row.code.includes(kw) ||
        (row.name ?? '').toLowerCase().includes(kw) ||
        (row.theme ?? '').toLowerCase().includes(kw)
      );
    });
  }, [rows, keyword, stage]);

  const scoredCount = rows.filter((row) => row.rank != null).length;
  const baselineCount = rows.filter((row) => row.rank != null && row.rank <= 10).length;
  const heldCount = rows.filter((row) => heldCodes?.has(row.code)).length;

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <Input
          allowClear
          placeholder="搜索代码 / 名称 / 主题"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          style={{ width: 240 }}
        />
        <Select
          allowClear
          placeholder="按筛选状态过滤"
          value={stage}
          onChange={setStage}
          options={stageOptions}
          style={{ width: 260 }}
        />
        <Typography.Text type="secondary">
          全部 {rows.length} 只 · 评分池 {scoredCount} · 策略持仓 {heldCount} · 基线前10 {baselineCount}
        </Typography.Text>
      </Space>
      {template && (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <Typography.Text strong>策略分 = </Typography.Text>
          <Typography.Text code>{factorFormula(template)}</Typography.Text>
        </Typography.Paragraph>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        分位 = 当日评分池内截面排名映射到 −1 ~ +1（缺失记 0），权重固定。默认按策略分降序；表格里每个因子显示
        「原始值 / 加权贡献」，点行或行首箭头可展开完整拆解与门槛数据。综合分只用于生成「基线前10」对照，不参与策略选股。
      </Typography.Text>
      <Table<DailyScreenRow>
        size="small"
        rowKey="code"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        scroll={{ x: 1700 }}
        pagination={{
          defaultPageSize: 50,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (total) => `共 ${total} 只`,
        }}
        expandable={{
          expandedRowKeys: expanded,
          onExpandedRowsChange: (keys) => setExpanded(keys.map(String)),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {live && <ExpandedKline code={row.code} />}
              <ScreenRowDetail row={row} signalDate={signalDate} />
            </Space>
          ),
        }}
        onRow={(row) => ({
          onClick: () => toggle(row.code),
          style: {
            background: rowBackground(row, heldCodes),
            cursor: 'pointer',
          },
        })}
      />
    </Space>
  );
}
```

<a id="file-frontend-src-components-daily-screenrowdetail-tsx"></a>

#### `frontend/src/components/daily/ScreenRowDetail.tsx`

```tsx
import { Alert, Descriptions, Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { DailyScreenReason, DailyScreenRow, KlinePeriod } from '../../api/types';
import { fmtNum, fmtSignedPct } from '../common/format';
import FactorBreakdown from './FactorBreakdown';

const SIGNAL_TEXT: Record<string, string> = {
  rs_strong: '相对强势',
  rs_weak: '相对弱势',
  theme_leader: '主题领涨',
  near_high_52w: '贴近52周高',
  ma_bull: '多头排列',
  ma_bear: '空头排列',
  flow_suspect: '份额待甄别',
  share_split_5d: '含份额折算',
};

const FLAG_TEXT: Record<string, string> = {
  core8_hold: '策略持有',
  shrink_pullback: '缩量回撤',
};

const STAGE_HINT: Record<string, string> = {
  non_equity: '基金类型不是「指数型-股票」（QDII/债券/货币等），不参与 A 股 ETF 日度筛选。',
  hk: '名称含港股/恒生/沪港深等，底层不是 A 股，已整体排除。',
  no_bar: '信号日没有收盘 K 线：停牌、尚未上市或当日未回填。',
  short_history: '有效历史不足 62 根日 K，无法计算 60 日动量与波动。',
  bad_data: '数据异常（零价/零量/关键字段缺失），特征不可用。',
  no_shares: '库内没有 ≤ 信号日的份额，无法估算规模。',
  small_aum: '规模低于 2 亿门槛，未进入评分池；下列指标仅作强弱参考。',
};

const MACD_PERIODS: { key: KlinePeriod; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
];
const ZONE_TEXT: Record<string, string> = { above: '水上', below: '水下', zero: '零轴' };
const TREND_TEXT: Record<string, string> = { rising: '走强', falling: '走弱', flat: '走平' };
const FLIP_TEXT: Record<string, string> = { golden: '金叉', dead: '死叉' };
const ZONE_COLOR: Record<string, string> = { above: 'red', below: 'green', zero: 'default' };

function items(entries: [string, string][], heading: string): ReactNode {
  return (
    <Descriptions size="small" column={{ xs: 2, md: 3 }} bordered title={heading}>
      {entries.map(([label, value]) => (
        <Descriptions.Item key={label} label={label}>
          {value}
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

/** 策略分之外的口径说明数据: 均额/份额/规模是筛选门槛输入, 综合分仅作基线对照。 */
function supporting(r: DailyScreenReason): ReactNode {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {items(
        [
          ['5日均额(亿)', fmtNum(r.amount_yi_5d)],
          ['20日均额(亿)', fmtNum(r.amount_yi_20d)],
          ['5日份额(归一)', fmtSignedPct(r.flow_5d)],
          ['5日折算次数', fmtNum(r.share_split_5d, 0)],
          ['份额(亿)', fmtNum(r.shares_yi, 1)],
          ['规模(亿)', fmtNum(r.aum_yi, 1)],
          ['20日收益', fmtSignedPct(r.r20)],
        ],
        '门槛与量能',
      )}
      {items([['综合分', fmtNum(r.baseline_score)]], '基线对照（不参与策略选股）')}
    </Space>
  );
}

export default function ScreenRowDetail({ row, signalDate }: { row: DailyScreenRow; signalDate?: string | null }) {
  const r = row.reason;
  const hint = STAGE_HINT[row.stage];
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {hint && <Alert type="info" showIcon message={hint} />}
      {row.reason_text && (
        <Typography.Text style={{ display: 'block', whiteSpace: 'normal' }}>{row.reason_text}</Typography.Text>
      )}
      {r && (
        <Space size={6} wrap>
          {(r.signals ?? []).map((signal) => (
            <Tag color="blue" key={signal}>
              {SIGNAL_TEXT[signal] ?? signal}
            </Tag>
          ))}
          {(r.flags ?? []).map((flag) => (
            <Tag color="geekblue" key={flag}>
              {FLAG_TEXT[flag] ?? flag}
            </Tag>
          ))}
          {MACD_PERIODS.map(({ key, label }) => {
            const state = r.macd_states?.[key];
            if (!state) return null;
            return (
              <Tag key={key} color={ZONE_COLOR[state.zone]} title={`判定截至 ${state.date}`}>
                {label}线 {ZONE_TEXT[state.zone]}
                {state.flip ? FLIP_TEXT[state.flip] : TREND_TEXT[state.trend]}
              </Tag>
            );
          })}
        </Space>
      )}
      {row.core_factors ? (
        <FactorBreakdown factors={row.core_factors} total={row.core8_score} date={signalDate} />
      ) : row.core8_rank != null ? (
        <Alert type="info" showIcon message="该行来自旧版快照，重算节点/日度记录后可展开策略分构成。" />
      ) : null}
      {r ? (
        supporting(r)
      ) : (
        <Descriptions size="small" column={3} bordered>
          <Descriptions.Item label="最后K线">{row.last_bar ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="K线根数">{row.bars}</Descriptions.Item>
          <Descriptions.Item label="筛选状态">{row.stage_text}</Descriptions.Item>
        </Descriptions>
      )}
    </Space>
  );
}
```

<a id="file-frontend-src-components-daily-summarycards-tsx"></a>

#### `frontend/src/components/daily/SummaryCards.tsx`

```tsx
import { Card, Col, Row, Statistic, Tag, Typography } from 'antd';
import type { DailyDetail } from '../../api/types';
import { fmtPct, fmtSignedPct, returnColor } from '../common/format';
import { ruleVersionLabel } from './ruleLabel';

interface Props {
  day: DailyDetail;
}

const MIN_SAMPLE = 30;

export default function SummaryCards({ day }: Props) {
  const evalSkipped = Boolean(day.evaluation.skipped);
  const cards = [
    {
      title: '股票池次日均值',
      value: fmtSignedPct(day.universe_mean),
      color: returnColor(day.universe_mean),
      hit: day.universe_hit,
      n: day.evaluation.universe?.n,
    },
    {
      title: '策略持仓 次日均值',
      value: fmtSignedPct(day.core_mean),
      color: returnColor(day.core_mean),
      hit: day.core_hit,
      n: day.evaluation.core_holdings?.n,
    },
    {
      title: '基线前10 次日均值',
      value: fmtSignedPct(day.baseline_mean),
      color: returnColor(day.baseline_mean),
      hit: day.baseline_hit,
      n: day.evaluation.baseline_top10?.n,
    },
    {
      title: 'Rank IC',
      value: day.rank_ic == null ? '—' : day.rank_ic.toFixed(2),
      color: day.rank_ic == null ? undefined : returnColor(day.rank_ic),
      hit: null,
      n: null,
    },
  ];

  return (
    <Row gutter={16}>
      {cards.map((card) => (
        <Col xs={12} md={6} key={card.title}>
          <Card size="small">
            <Statistic title={card.title} value={card.value} valueStyle={{ color: card.color, fontSize: 24 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {card.hit == null ? '截面排序方向' : `命中率 ${fmtPct(card.hit, 1)} · 样本 ${card.n ?? '—'}`}
            </Typography.Text>
            {card.n != null && card.n < MIN_SAMPLE ? (
              <Tag color="warning" style={{ marginInlineStart: 6 }}>
                样本不足
              </Tag>
            ) : null}
          </Card>
        </Col>
      ))}
      <Col span={24} style={{ marginTop: 4 }}>
        <Typography.Text type="secondary">
          信号 {day.signal_date} → 次日 {day.next_signal ?? '未收盘'} 结算 · 当日有K线 {day.codes_with_bar} 只 · 可评分{' '}
          {day.scored} 只 · 有份额 {day.shares_available} 只 · 规则版本 {ruleVersionLabel(day.rule_version)}
          {evalSkipped ? ` · ${day.evaluation.skipped}` : ''}
        </Typography.Text>
      </Col>
    </Row>
  );
}
```

<a id="file-frontend-src-components-daily-timelinetable-tsx"></a>

#### `frontend/src/components/daily/TimelineTable.tsx`

```tsx
import { Card, Input, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import type { DailyHoldingSpell } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { codeColumn, nameColumn } from './linkColumns';

interface Props {
  spells: DailyHoldingSpell[];
  loading?: boolean;
}

type Scope = 'all' | 'holding';

const columns: ColumnsType<DailyHoldingSpell> = [
  codeColumn<DailyHoldingSpell>(86, 'left'),
  nameColumn<DailyHoldingSpell>(130),
  { title: '主题', dataIndex: 'theme', width: 100, render: (v: string | null) => v ?? '—' },
  { title: '买入节点', dataIndex: 'entry', width: 110 },
  {
    title: '卖出节点',
    dataIndex: 'exit',
    width: 110,
    render: (exit: string | null) => (exit ? exit : <Tag color="green">持有中</Tag>),
  },
  { title: '持有节点', dataIndex: 'nodes', width: 90, align: 'right' },
  {
    title: '排名(进→出)',
    width: 128,
    align: 'right',
    render: (_, row) => (
      <span>
        {row.entry_rank} → {row.holding ? '—' : row.last_rank}
      </span>
    ),
  },
  {
    title: '买入价',
    dataIndex: 'entry_price',
    width: 88,
    align: 'right',
    render: (v: number | null) => fmtNum(v, 3),
  },
  {
    title: '卖出价',
    dataIndex: 'exit_price',
    width: 88,
    align: 'right',
    render: (v: number | null) => fmtNum(v, 3),
  },
  {
    title: '区间收益',
    dataIndex: 'return',
    width: 100,
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
];

/** 每只 ETF 的持有区间: 连续持有的节点合并成一段, 卖出节点即区间终点。 */
export default function TimelineTable({ spells, loading }: Props) {
  const [keyword, setKeyword] = useState('');
  const [scope, setScope] = useState<Scope>('all');

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return spells
      .filter((s) => {
        if (scope === 'holding' && !s.holding) return false;
        if (!kw) return true;
        return (
          s.code.includes(kw) ||
          (s.name ?? '').toLowerCase().includes(kw) ||
          (s.theme ?? '').toLowerCase().includes(kw)
        );
      })
      .sort((a, b) => b.entry.localeCompare(a.entry) || a.code.localeCompare(b.code));
  }, [spells, keyword, scope]);

  const holding = spells.filter((s) => s.holding).length;

  return (
    <Card
      size="small"
      title="持仓时间线"
      extra={
        <Typography.Text type="secondary">
          共 {spells.length} 段 · 持有中 {holding} · 一个节点 = 5 个交易日
        </Typography.Text>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap>
          <Input
            allowClear
            placeholder="搜索代码 / 名称 / 主题"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 240 }}
          />
          <Segmented<Scope>
            value={scope}
            onChange={setScope}
            options={[
              { label: '全部', value: 'all' },
              { label: `持有中（${holding}）`, value: 'holding' },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            买入按节点次日开盘、顺延卖按次日开盘、其余按节点收盘计价，等权、不扣费用；持有中的段暂无卖出价。
          </Typography.Text>
        </Space>
        <Table<DailyHoldingSpell>
          size="small"
          rowKey={(row) => `${row.code}-${row.entry}`}
          columns={columns}
          dataSource={filtered}
          loading={loading}
          scroll={{ x: 1060 }}
          pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
        />
      </Space>
    </Card>
  );
}
```

<a id="file-frontend-src-components-daily-todaypanel-tsx"></a>

#### `frontend/src/components/daily/TodayPanel.tsx`

```tsx
import { Alert, Button, Card, Col, Row, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';
import type { DailyScreenRow, LiveHeldPick, TodayTopPick } from '../../api/types';
import {
  useDailyCore,
  useDailyDays,
  useDailyLive,
  useDailyLiveRanking,
  useDailyScreen,
  useRefreshDailyLive,
} from '../../hooks/useDailyPick';
import { useQuotes } from '../../hooks/useQuotes';
import { todayStr } from '../common/format';
import HoldingCard from './HoldingCard';
import LiveKlinePanel from './LiveKlinePanel';
import { HOLD_BUFFER_RANK, HOLD_TOP, TODAY_TOP_N } from './rankBounds';
import ScreenRanking from './ScreenRanking';
import TopRankCard from './TopRankCard';

/**
 * 今日: 上部双卡(TOP 对照 + 当前持仓) → K线面板 → 底部全量排名。
 * 盘中左卡用实时排名; 收盘后实时预演让位正式记录, 左卡改用当日收盘快照的策略排名,
 * 收盘也要能对照「最新 TOP vs 现持仓」, 底部表同理由实时排名切到收盘筛选快照。
 */
export default function TodayPanel() {
  const today = todayStr();
  const live = useDailyLive();
  const liveOn = Boolean(live.data?.live);
  const ranking = useDailyLiveRanking(liveOn);
  const refresh = useRefreshDailyLive();
  const core = useDailyCore(liveOn ? undefined : today);

  const days = useDailyDays();
  const latest = useMemo(() => {
    const rows = days.data ?? [];
    return [...rows].reverse().find((d) => (d.scored ?? 0) > 0 && d.signal_date <= today);
  }, [days.data, today]);
  const screen = useDailyScreen(!liveOn ? latest?.signal_date : undefined);

  /** 收盘快照日的策略排名(升序), 用于左卡 TOP 名单和持仓的「今日名次」。 */
  const closeRanked = useMemo(() => {
    const ranked = (screen.data?.rows ?? []).flatMap((r) =>
      r.core8_rank == null
        ? []
        : [{ code: r.code, name: r.name, rank: r.core8_rank, score: r.core8_score ?? 0, node_close: r.node_close ?? null }],
    );
    return ranked.sort((a, b) => a.rank - b.rank);
  }, [screen.data]);
  const closeRankByCode = useMemo(() => new Map(closeRanked.map((r) => [r.code, r.rank])), [closeRanked]);
  const closeTop = useMemo<TodayTopPick[]>(
    () =>
      closeRanked
        .slice(0, TODAY_TOP_N)
        .map(({ rank, code, name, score, node_close }) => ({ rank, code, name, score, node_close })),
    [closeRanked],
  );

  const picks = useMemo(() => (liveOn ? (live.data?.picks?.core ?? []) : []), [liveOn, live.data]);
  const held: LiveHeldPick[] = useMemo(
    () =>
      liveOn
        ? (live.data?.held ?? [])
        : (core.data?.holdings ?? []).map((p) => ({
            code: p.code,
            name: p.name,
            core_rank: p.core_rank,
            core_score: p.core_score,
            action: p.action === 'buy' ? 'buy' : 'hold',
            node_close: p.node_close ?? null,
            today_rank: closeRankByCode.get(p.code) ?? null,
          })),
    [liveOn, live.data, core.data, closeRankByCode],
  );
  const targetCodes = useMemo(
    () => new Set((liveOn ? picks : (core.data?.holdings ?? [])).map((p) => p.code)),
    [liveOn, picks, core.data],
  );
  const heldCodes = useMemo(() => new Set(held.map((h) => h.code)), [held]);

  const topRows = useMemo<TodayTopPick[]>(
    () => (liveOn ? (live.data?.today_top ?? []) : closeTop),
    [liveOn, live.data, closeTop],
  );
  // 收盘模式下只要知道快照日就先立起左卡(加载态): 等 3.5MB 排名返回再渲染会让右卡先满宽再被挤开。
  const showTop = liveOn ? Boolean(live.data) : Boolean(latest);
  const topLoading = !liveOn && Boolean(latest) && screen.isLoading;
  const holdTop = live.data?.hold_top ?? HOLD_TOP;
  const bufferRank = live.data?.buffer_rank ?? HOLD_BUFFER_RANK;

  const [selected, setSelected] = useState<string | null>(null);
  const selectedCode = selected ?? picks[0]?.code ?? held[0]?.code ?? topRows[0]?.code ?? null;

  const quoteCodes = useMemo(
    () => Array.from(new Set([...picks.map((p) => p.code), ...held.map((h) => h.code), ...topRows.map((t) => t.code)])),
    [picks, held, topRows],
  );
  const quotes = useQuotes(quoteCodes, quoteCodes.length > 0);

  const bottomRows: DailyScreenRow[] | undefined = liveOn ? ranking.data?.rows : screen.data?.rows;
  const timing = refresh.data?.picks?.timing;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!liveOn && live.data?.reason && (
        <Alert type="info" showIcon message={`盘中预演未开启（${live.data.reason}），左卡与底部表使用最近收盘快照。`} />
      )}

      <Row gutter={[16, 16]}>
        {showTop && (
          <Col xs={24} lg={12}>
            <TopRankCard
              mode={liveOn ? 'live' : 'close'}
              top={topRows}
              held={held}
              quotes={quotes.data?.quotes}
              holdTop={holdTop}
              bufferRank={bufferRank}
              asOf={live.data?.as_of}
              snapshotDate={latest?.signal_date}
              nodeDate={liveOn ? live.data?.last_node : core.data?.signal_date}
              rebalance={live.data?.rebalance}
              nextRebalance={live.data?.next_rebalance}
              loading={topLoading}
              onSelect={setSelected}
            />
          </Col>
        )}
        <Col xs={24} lg={showTop ? 12 : 24}>
          <HoldingCard
            held={held}
            targetCodes={targetCodes}
            nodeLabel={liveOn ? live.data?.last_node : core.data?.signal_date}
            quotes={quotes.data?.quotes}
            rankBounds={{ holdTop, bufferRank }}
            onSelect={setSelected}
          />
        </Col>
      </Row>

      {selectedCode && (
        <LiveKlinePanel
          code={selectedCode}
          asOf={live.data?.as_of ?? null}
          nodeDate={liveOn ? (live.data?.last_node ?? null) : (core.data?.signal_date ?? null)}
          live={liveOn}
        />
      )}

      <Card
        size="small"
        title={liveOn ? '今日全量 ETF 实时排名' : `${latest?.signal_date ?? '—'} 全量 ETF 排名（收盘快照）`}
        extra={
          <Space size={12} wrap>
            <Typography.Text type="secondary">
              {liveOn
                ? `每 10 分钟自动刷新 · 行情 ${live.data?.as_of ? live.data.as_of.slice(11, 19) : '—'}`
                : '绿色行=策略持仓 · 浅蓝行=基线前10'}
            </Typography.Text>
            {timing && (
              <Typography.Text type="secondary">
                上次拉取: 行情 {timing.quotes_sec}s + 评分 {timing.scoring_sec}s · {refresh.data?.ranking_rows} 行
              </Typography.Text>
            )}
            <Button size="small" loading={refresh.isPending} onClick={() => refresh.mutate()}>
              手动全量拉取
            </Button>
          </Space>
        }
      >
        {bottomRows ? (
          <ScreenRanking
            rows={bottomRows}
            loading={liveOn ? ranking.isFetching : screen.isFetching}
            heldCodes={heldCodes}
            signalDate={liveOn ? today : (latest?.signal_date ?? null)}
            live={liveOn}
          />
        ) : (
          <Typography.Text type="secondary">
            {liveOn ? '首次计算全量排名约需数秒…' : '排名快照加载中…'}
          </Typography.Text>
        )}
      </Card>
    </Space>
  );
}
```

<a id="file-frontend-src-components-daily-toprankcard-tsx"></a>

#### `frontend/src/components/daily/TopRankCard.tsx`

```tsx
import { Card, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import type { LiveHeldPick, RealtimeQuote, TodayTopPick } from '../../api/types';
import { fmtSignedPct, returnColor } from '../common/format';
import { codeColumn, nameColumn } from './linkColumns';
import { quoteColumns } from './quoteColumns';
import { HOLD_BUFFER_RANK, HOLD_TOP, TODAY_TOP_N } from './rankBounds';

interface Props {
  /** live=盘中实时预演, close=当日收盘快照; 只影响标题与时间标签。 */
  mode: 'live' | 'close';
  /** 榜单名单: 盘中为实时排名前 N, 收盘为快照日的策略排名前 N。 */
  top: TodayTopPick[];
  /** 当前节点持仓, 用于「状态」列与节点涨跌基准。 */
  held: LiveHeldPick[];
  quotes: Record<string, RealtimeQuote> | undefined;
  holdTop?: number;
  bufferRank?: number;
  /** 盘中行情时间戳(YYYY-MM-DD HH:MM:SS)。 */
  asOf?: string | null;
  /** 收盘快照的交易日。 */
  snapshotDate?: string | null;
  /** 换仓节点日: 节点涨跌的基准日。 */
  nodeDate?: string | null;
  rebalance?: boolean;
  nextRebalance?: string | null;
  /** 收盘快照尚未返回: 先占位显示加载态, 避免右卡先满宽再被挤成两列。 */
  loading?: boolean;
  /** 点行切换下方 K 线面板。 */
  onSelect: (code: string) => void;
}

/**
 * 左卡: TOP N 名单, 与右卡的节点持仓并排对照。
 * 盘中看实时排名; 收盘后实时排名消失, 改用当日收盘快照的策略排名, 同样能看出
 * "若今天是节点会买谁"与现持仓的差异。收盘后没有实时行情基准的名单仍用节点收盘价。
 */
export default function TopRankCard({
  mode,
  top,
  held,
  quotes,
  holdTop = HOLD_TOP,
  bufferRank = HOLD_BUFFER_RANK,
  asOf,
  snapshotDate,
  nodeDate,
  rebalance,
  nextRebalance,
  loading,
  onSelect,
}: Props) {
  const heldByCode = useMemo(() => new Map(held.map((h) => [h.code, h])), [held]);

  const topBuyHeld = top.slice(0, holdTop).filter((r) => heldByCode.has(r.code)).length;
  const inBuffer = held.filter((h) => h.today_rank != null && h.today_rank <= bufferRank).length;
  const outCount = held.length - inBuffer;

  const columns: ColumnsType<TodayTopPick> = [
    {
      title: mode === 'live' ? '今日排名' : '排名',
      width: 92,
      render: (_, row) => (
        <Tag color={row.rank <= holdTop ? 'gold' : 'blue'} style={{ marginInlineEnd: 0 }}>
          {row.rank}
        </Tag>
      ),
    },
    codeColumn<TodayTopPick>(),
    nameColumn<TodayTopPick>(),
    ...quoteColumns<TodayTopPick>(quotes),
    {
      title: (
        <Tooltip
          title={`节点日${nodeDate ? `（${nodeDate}）` : ''}收盘 → 现价的涨跌: 持有=本轮持有周期收益, 未持有=若节点买入至今`}
        >
          节点涨跌
        </Tooltip>
      ),
      width: 96,
      align: 'right',
      render: (_, row) => {
        const price = quotes?.[row.code]?.price;
        const base = row.node_close ?? heldByCode.get(row.code)?.node_close ?? null;
        if (base == null || price == null) return <Typography.Text type="secondary">—</Typography.Text>;
        const pct = price / base - 1;
        return <span style={{ color: returnColor(pct) }}>{fmtSignedPct(pct)}</span>;
      },
    },
    {
      title: '状态',
      width: 88,
      render: (_, row) =>
        heldByCode.has(row.code) ? (
          <Tag color="green" style={{ marginInlineEnd: 0 }}>持有</Tag>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>未持有</Typography.Text>
        ),
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          {mode === 'live' ? '今日实时' : '收盘'} TOP{TODAY_TOP_N}
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            买入区 = 前 {holdTop}
          </Typography.Text>
        </Space>
      }
      extra={
        <Space size={8} wrap>
          {mode === 'live' ? (
            <>
              {rebalance ? <Tag color="gold">今日换仓节点</Tag> : <Tag>非换仓日</Tag>}
              {nextRebalance && <Tag>下次换仓 {nextRebalance}</Tag>}
              <Typography.Text type="secondary">行情 {asOf ? asOf.slice(11, 19) : '—'}</Typography.Text>
            </>
          ) : (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              收盘快照 {snapshotDate ?? '—'}
            </Tag>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Table<TodayTopPick>
          size="small"
          rowKey="code"
          loading={loading}
          columns={columns}
          dataSource={top}
          pagination={false}
          scroll={{ x: 600 }}
          onRow={(row) => ({
            onClick: () => onSelect(row.code),
            style: {
              cursor: 'pointer',
              background: heldByCode.has(row.code) ? '#f6ffed' : undefined,
            },
          })}
        />
        {!loading && top.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            TOP{holdTop} 已持有 {topBuyHeld}/{holdTop} · 节点持仓 {inBuffer}/{held.length} 只仍在缓冲带(≤{bufferRank})
            {outCount > 0 && `，${outCount} 只超出`}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}
```

<a id="file-frontend-src-components-daily-actionmeta-ts"></a>

#### `frontend/src/components/daily/actionMeta.ts`

```ts
import type { DailyCorePick } from '../../api/types';

export const ACTION_META: Record<DailyCorePick['action'], { color: string; text: string }> = {
  hold: { color: 'blue', text: '继续持有' },
  buy: { color: 'red', text: '本次买入' },
  sell: { color: 'default', text: '本次卖出' },
  rank: { color: 'default', text: '未持有' },
};
```

<a id="file-frontend-src-components-daily-actiontag-tsx"></a>

#### `frontend/src/components/daily/actionTag.tsx`

```tsx
import { Tag } from 'antd';
import type { DailyCorePick } from '../../api/types';
import { ACTION_META } from './actionMeta';

export function ActionTag({ action }: { action: DailyCorePick['action'] }) {
  const meta = ACTION_META[action];
  return <Tag color={meta.color}>{meta.text}</Tag>;
}
```

<a id="file-frontend-src-components-daily-attributionoption-ts"></a>

#### `frontend/src/components/daily/attributionOption.ts`

```ts
import type { EChartsOption } from 'echarts';
import type { DailySeriesKey, DailyWindow } from './window';

const SERIES: ReadonlyArray<{ key: DailySeriesKey; name: string; color: string }> = [
  { key: 'core', name: '策略持仓', color: '#cf1322' },
  { key: 'baseline', name: '基线前10', color: '#1677ff' },
  { key: 'universe', name: '股票池等权', color: '#8c8c8c' },
  { key: 'hs300', name: '沪深300', color: '#722ed1' },
];

const KEY_BY_NAME = new Map(SERIES.map((s) => [s.name, s.key]));

const UP_COLOR = '#cf1322';
const DOWN_COLOR = '#3f8600';

interface TooltipParam {
  marker: string;
  seriesName: string;
  value: unknown;
  dataIndex: number;
  axisValue: string;
}

function fmtPct(value: unknown): string {
  return typeof value === 'number' ? `${value.toFixed(2)}%` : '—';
}

function fmtSignedPct(value: number | null): string {
  if (value == null) return '—';
  const pct = value * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** 累计视图 tooltip: 每条曲线同时给出窗口内累计值与当日涨跌。 */
function cumulativeTooltip(window: DailyWindow) {
  return (raw: unknown): string => {
    const params = raw as TooltipParam[];
    const first = params[0];
    if (!first) return '';
    const rows = params
      .map((p) => {
        const key = KEY_BY_NAME.get(p.seriesName);
        const daily = key ? window.daily[key][p.dataIndex] : null;
        return `${p.marker}${p.seriesName}&nbsp;&nbsp;累计 <b>${fmtPct(p.value)}</b> · 当日 ${fmtSignedPct(daily)}`;
      })
      .join('<br/>');
    return `<b>${first.axisValue}</b><br/>${rows}`;
  };
}

/** 每日涨跌视图 tooltip。 */
function dailyTooltip() {
  return (raw: unknown): string => {
    const params = raw as TooltipParam[];
    const first = params[0];
    if (!first) return '';
    const rows = params.map((p) => `${p.marker}${p.seriesName}&nbsp;&nbsp;<b>${fmtPct(p.value)}</b>`).join('<br/>');
    return `<b>${first.axisValue}</b><br/>${rows}`;
  };
}

function baseOption(window: DailyWindow): EChartsOption {
  return {
    animation: false,
    legend: { top: 0 },
    grid: { left: 56, right: 24, top: 40, bottom: 48 },
    xAxis: {
      type: 'category',
      data: window.points.map((p) => p.signal_date),
      axisLabel: { color: '#8c8c8c' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: '{value}%', color: '#8c8c8c' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
  };
}

function toPct(value: number | null): number | null {
  return value == null ? null : Number((value * 100).toFixed(2));
}

/** 累计净值曲线(窗口内归零) + 沪深300 同口径基准。 */
export function buildDailyCumulativeOption(window: DailyWindow): EChartsOption {
  return {
    ...baseOption(window),
    tooltip: { trigger: 'axis', formatter: cumulativeTooltip(window) },
    series: SERIES.map((s) => ({
      name: s.name,
      type: 'line' as const,
      showSymbol: false,
      lineStyle: { width: s.key === 'hs300' ? 1.5 : 2, color: s.color },
      itemStyle: { color: s.color },
      data: window.points.map((p) => toPct(p[s.key])),
    })),
  };
}

/** 每日涨跌: 策略持仓柱状(红涨绿跌) + 基线/沪深300 折线, 便于逐日判断幅度。 */
export function buildDailyBarsOption(window: DailyWindow): EChartsOption {
  const line = (name: string, color: string, data: Array<number | null>, dashed = false): Record<string, unknown> => ({
    name,
    type: 'line',
    showSymbol: false,
    lineStyle: { width: 1.5, color, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color },
    data,
  });
  return {
    ...baseOption(window),
    tooltip: { trigger: 'axis', formatter: dailyTooltip() },
    series: [
      {
        name: '策略持仓',
        type: 'bar',
        barMaxWidth: 10,
        color: UP_COLOR,
        data: window.daily.core.map((v) => ({
          value: toPct(v),
          itemStyle: { color: v != null && v < 0 ? DOWN_COLOR : UP_COLOR },
        })),
      },
      line('基线前10', '#1677ff', window.daily.baseline.map(toPct)),
      line('沪深300', '#722ed1', window.daily.hs300.map(toPct), true),
    ],
  };
}
```

<a id="file-frontend-src-components-daily-factorformat-ts"></a>

#### `frontend/src/components/daily/factorFormat.ts`

```ts
import type { CoreFactor } from '../../api/types';

/** 策略分因子列: 标题与权重都取自记录里的因子元数据, 不在前端另写一份。 */
export type FactorSpec = Pick<CoreFactor, 'key' | 'label' | 'weight'>;

export function fmtValue(factor: CoreFactor): string {
  if (factor.value == null) return '—';
  if (factor.kind === 'pct') {
    const sign = factor.value > 0 ? '+' : '';
    return `${sign}${(factor.value * 100).toFixed(1)}%`;
  }
  if (factor.kind === 'days') return `${factor.value.toFixed(0)} 天`;
  const sign = factor.value > 0 ? '+' : '';
  return `${sign}${factor.value.toFixed(2)}`;
}

export function fmtWeight(weight: number | null): string {
  if (weight == null) return '—';
  const sign = weight > 0 ? '+' : '−';
  return `${sign}${Math.abs(weight).toFixed(2)}`;
}

export function fmtContrib(contrib: number | null): string {
  if (contrib == null) return '—';
  const sign = contrib > 0 ? '+' : '';
  return `${sign}${contrib.toFixed(3)}`;
}

/** 公式文本: 加权项写成 0.20×分位(60日回撤), 惩罚行写成 − 0.10(高位高波惩罚)。 */
export function factorFormula(factors: CoreFactor[]): string {
  return factors
    .map((f, i) => {
      const negative = (f.weight ?? f.contrib) < 0;
      const body =
        f.weight == null
          ? `${Math.abs(f.contrib).toFixed(2)}(${f.label})`
          : `${Math.abs(f.weight).toFixed(2)}×分位(${f.label})`;
      if (i === 0) return `${negative ? '− ' : ''}${body}`;
      return `${negative ? '−' : '+'} ${body}`;
    })
    .join(' ');
}
```

<a id="file-frontend-src-components-daily-gatedoption-ts"></a>

#### `frontend/src/components/daily/gatedOption.ts`

```ts
import type { EChartsOption } from 'echarts';
import type { DailyWindow } from './window';
import { drawdowns } from './window';

const GATED_LABEL = '核心8·仅年线上持有';
const CORE_ALL_LABEL = '核心8·每日持有';
const GATED_COLOR = '#cf1322';
const CORE_ALL_COLOR = '#8c8c8c';
const HS300_COLOR = '#722ed1';
const GATE_OFF_FILL = 'rgba(207, 19, 34, 0.06)';
const TOOLTIP_MAX_WIDTH = 480;

interface TooltipParam {
  marker: string;
  seriesName: string;
  seriesIndex: number;
  value: unknown;
  dataIndex: number;
  axisValue: string;
}

type AreaPair = [{ xAxis: string; itemStyle: { color: string } }, { xAxis: string }];

function pctText(value: unknown): string {
  return typeof value === 'number' ? `${value.toFixed(2)}%` : '—';
}

function signedPct(value: number | null): string {
  if (value == null) return '—';
  const pct = value * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function wrap(axisValue: string, body: string): string {
  return `<div style="max-width:${TOOLTIP_MAX_WIDTH}px;white-space:normal"><b>${axisValue}</b><br/>${body}</div>`;
}

function toPct(value: number | null): number | null {
  return value == null ? null : Number((value * 100).toFixed(2));
}

/** 开关下方的连续日区间, 用于上下两格同步铺淡红底色。 */
function gateOffRanges(window: DailyWindow): AreaPair[] {
  const points = window.points;
  const ranges: AreaPair[] = [];
  let i = 0;
  while (i < points.length) {
    if (points[i].gate !== 'below') {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < points.length && points[end + 1].gate === 'below') end += 1;
    const next = points[Math.min(end + 1, points.length - 1)];
    ranges.push([
      { xAxis: points[i].signal_date, itemStyle: { color: GATE_OFF_FILL } },
      { xAxis: next.signal_date },
    ]);
    i = end + 1;
  }
  return ranges;
}

function gateText(gate: 'above' | 'below' | null): string {
  if (gate == null) return '年线未热身（空仓）';
  return gate === 'above' ? '年线上方（开仓）' : '年线下方（空仓）';
}

/** 开关视图 tooltip: 上格累计与当日执行/空仓, 下格回撤, 两格一起给出便于对照。 */
function gatedTooltip(window: DailyWindow) {
  return (raw: unknown): string => {
    const params = raw as TooltipParam[];
    const first = params[0];
    if (!first) return '';
    const point = window.points[first.dataIndex];
    if (!point) return '';
    const fmtRows = (rows: TooltipParam[], label: string): string =>
      rows
        .filter((p) => p.value != null)
        .map((p) => `${p.marker}${p.seriesName}&nbsp;&nbsp;${label} <b>${pctText(p.value)}</b>`)
        .join('<br/>');
    const netRows = fmtRows(
      params.filter((p) => p.seriesIndex < 3),
      '累计',
    );
    const ddRows = fmtRows(
      params.filter((p) => p.seriesIndex >= 3),
      '回撤',
    );
    const applied = window.daily.gated[first.dataIndex] ?? null;
    const coreDay = window.daily.core[first.dataIndex] ?? null;
    const head =
      `${gateText(point.gate)} · 当日执行 ${signedPct(applied)}` +
      `（${CORE_ALL_LABEL} ${signedPct(coreDay)}）`;
    const body = [netRows, ddRows].filter(Boolean).join('<div style="height:6px"></div>');
    return wrap(first.axisValue, `${head}<br/>${body}`);
  };
}

/** 年线开关净值: 上格 core8 持仓的累计收益(仅年线上持有/每日持有/沪深300), 下格各自回撤, 淡红区=年线下方空仓。 */
export function buildGatedOption(window: DailyWindow): EChartsOption {
  const dates = window.points.map((p) => p.signal_date);
  const gated = window.points.map((p) => p.gated);
  const core = window.points.map((p) => p.core);
  const hs300 = window.points.map((p) => p.hs300);
  const areas = gateOffRanges(window);
  const line = (
    name: string,
    color: string,
    gridIndex: 0 | 1,
    data: Array<number | null>,
    width: number,
    dashed = false,
    filled = false,
  ): Record<string, unknown> => ({
    name,
    type: 'line',
    xAxisIndex: gridIndex,
    yAxisIndex: gridIndex,
    showSymbol: false,
    lineStyle: { width, color, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color },
    ...(filled ? { areaStyle: { color, opacity: 0.12 } } : {}),
    data: data.map(toPct),
  });
  const shaded = (series: Record<string, unknown>): Record<string, unknown> => ({
    ...series,
    markArea: { silent: true, itemStyle: { color: GATE_OFF_FILL }, data: areas },
  });
  return {
    animation: false,
    legend: { top: 0, data: [GATED_LABEL, CORE_ALL_LABEL, '沪深300'] },
    tooltip: { trigger: 'axis', confine: true, formatter: gatedTooltip(window) },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 56, right: 24, top: 36, height: '48%' },
      { left: 56, right: 24, top: '64%', height: '22%' },
    ],
    xAxis: [
      { type: 'category', gridIndex: 0, data: dates, axisLabel: { show: false }, axisTick: { show: false } },
      { type: 'category', gridIndex: 1, data: dates, axisLabel: { color: '#8c8c8c' } },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        name: '累计收益',
        scale: true,
        nameTextStyle: { color: '#8c8c8c' },
        axisLabel: { formatter: '{value}%', color: '#8c8c8c' },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
      {
        type: 'value',
        gridIndex: 1,
        name: '回撤',
        max: 0,
        nameTextStyle: { color: '#8c8c8c' },
        axisLabel: { formatter: '{value}%', color: '#8c8c8c' },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1] },
      { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 2 },
    ],
    series: [
      shaded(line(GATED_LABEL, GATED_COLOR, 0, gated, 2)),
      line(CORE_ALL_LABEL, CORE_ALL_COLOR, 0, core, 1.5, true),
      line('沪深300', HS300_COLOR, 0, hs300, 1.5),
      shaded(line(GATED_LABEL, GATED_COLOR, 1, drawdowns(gated), 1.5, false, true)),
      line(CORE_ALL_LABEL, CORE_ALL_COLOR, 1, drawdowns(core), 1.2, true),
      line('沪深300', HS300_COLOR, 1, drawdowns(hs300), 1.2),
    ],
  };
}
```

<a id="file-frontend-src-components-daily-linkcolumns-tsx"></a>

#### `frontend/src/components/daily/linkColumns.tsx`

```tsx
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';

interface Linked {
  code: string;
  name?: string | null;
}

/**
 * 代码/名称两列在日度复盘的多个表格里重复出现, 统一在这里生成:
 * 宽度按各表需要传入, 链接目标始终是标的详情页。
 */
export function codeColumn<T extends { code: string }>(width = 84, fixed?: 'left'): ColumnsType<T>[number] {
  return {
    title: '代码',
    dataIndex: 'code',
    width,
    ...(fixed ? { fixed } : {}),
    render: (code: string) => <Link to={`/etf/${code}`}>{code}</Link>,
  };
}

/** 名称缺失时回退显示代码, 避免表格出现空白单元格。 */
export function nameColumn<T extends Linked>(width?: number): ColumnsType<T>[number] {
  return {
    title: '名称',
    dataIndex: 'name',
    ...(width ? { width } : {}),
    render: (name: string | null | undefined, row: T) => <Link to={`/etf/${row.code}`}>{name ?? row.code}</Link>,
  };
}
```

<a id="file-frontend-src-components-daily-quotecolumns-tsx"></a>

#### `frontend/src/components/daily/quoteColumns.tsx`

```tsx
import { Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { RealtimeQuote } from '../../api/types';
import { fmtSignedPct, returnColor } from '../common/format';

/** 现价/涨跌幅两列: 数据来自 15 秒轮询的行情接口; 未就绪的行显示 —。 */
export function quoteColumns<T extends { code: string }>(
  quotes: Record<string, RealtimeQuote> | undefined,
): ColumnsType<T> {
  return [
    {
      title: '现价',
      width: 84,
      align: 'right',
      render: (_, row) =>
        quotes?.[row.code]?.price != null ? (
          <Typography.Text>{quotes[row.code].price!.toFixed(3)}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '涨跌幅',
      width: 90,
      align: 'right',
      render: (_, row) => {
        const pct = quotes?.[row.code]?.pct;
        return <span style={{ color: returnColor(pct) }}>{fmtSignedPct(pct, 2)}</span>;
      },
    },
  ];
}
```

<a id="file-frontend-src-components-daily-rankbounds-ts"></a>

#### `frontend/src/components/daily/rankBounds.ts`

```ts
/** core8 买入区(前 N 名)与缓冲带(排名 ≤ N 继续持有), 与后端 core.HOLD_TOP / HOLD_BUFFER_RANK 一致。 */
export const HOLD_TOP = 5;
export const HOLD_BUFFER_RANK = 15;

/** 左卡对照名单长度, 与后端 live.TODAY_TOP_N 一致。 */
export const TODAY_TOP_N = 10;
```

<a id="file-frontend-src-components-daily-rulelabel-ts"></a>

#### `frontend/src/components/daily/ruleLabel.ts`

```ts
/** 规则版本保留内部标识(core8-v1), 展示层统一称「策略」。 */
export function ruleVersionLabel(version: string): string {
  const matched = /^(?:daily-)?core8-v(\d+)$/.exec(version);
  return matched ? `策略 v${matched[1]}` : version;
}
```

<a id="file-frontend-src-components-daily-screencolumns-tsx"></a>

#### `frontend/src/components/daily/screenColumns.tsx`

```tsx
import { Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { SortOrder } from 'antd/es/table/interface';
import { Link } from 'react-router-dom';
import type { DailyScreenRow } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { fmtContrib, fmtValue, fmtWeight, type FactorSpec } from './factorFormat';
import { codeColumn } from './linkColumns';

const STAGE_COLOR: Record<string, string> = {
  non_equity: 'default',
  hk: 'default',
  no_bar: 'warning',
  short_history: 'warning',
  bad_data: 'error',
  no_shares: 'warning',
  small_aum: 'orange',
  core_pool: 'cyan',
  core_hold: 'green',
};

// 数值列默认先看最强/最大: 未进入评分池的行(无因子)按 -∞ 排在降序末尾。
const DESC_FIRST: SortOrder[] = ['descend', 'ascend'];
// 名次列反过来: 1 名在前。
const ASC_FIRST: SortOrder[] = ['ascend', 'descend'];

type NumericKey = 'core8_score' | 'core8_rank' | 'r20' | 'flow_5d' | 'aum_yi';

function numOf(row: DailyScreenRow, key: NumericKey): number | null {
  const value = key === 'core8_score' || key === 'core8_rank' ? row[key] : row.reason?.[key];
  return typeof value === 'number' ? value : null;
}

/** 空值(未进评分池/无当日评分)始终排在末尾, 不因升降序跑到最前。 */
function compareNullable(x: number | null, y: number | null, order?: SortOrder): number {
  if (x == null && y == null) return 0;
  if (x == null) return order === 'ascend' ? 1 : -1;
  if (y == null) return order === 'ascend' ? -1 : 1;
  return x - y;
}

function sorter(key: NumericKey) {
  return (a: DailyScreenRow, b: DailyScreenRow, order?: SortOrder) =>
    compareNullable(numOf(a, key), numOf(b, key), order);
}

function Pct({ value, digits = 2 }: { value: number | null | undefined; digits?: number }) {
  return <span style={{ color: returnColor(value) }}>{fmtSignedPct(value, digits)}</span>;
}

function factorColumns(specs: FactorSpec[]): ColumnsType<DailyScreenRow> {
  return specs.map((spec) => ({
    title: spec.label,
    key: `factor-${spec.key}`,
    width: 104,
    align: 'right',
    render: (_, row) => {
      const factor = row.core_factors?.find((f) => f.key === spec.key);
      if (!factor) return <Typography.Text type="secondary">—</Typography.Text>;
      return (
        <div title={`权重 ${fmtWeight(spec.weight)} · 上=原始值, 下=加权贡献`}>
          <div>{fmtValue(factor)}</div>
          <div style={{ fontSize: 12, color: returnColor(factor.contrib) }}>{fmtContrib(factor.contrib)}</div>
        </div>
      );
    },
  }));
}

/** 行底色优先级: core8 持仓 > 基线前10。 */
export function rowBackground(row: DailyScreenRow, heldCodes?: ReadonlySet<string>): string | undefined {
  if (heldCodes?.has(row.code)) return '#f6ffed';
  if (row.rank != null && row.rank <= 10) return '#f0f7ff';
  return undefined;
}

export function buildScreenColumns(
  heldCodes?: ReadonlySet<string>,
  factorSpecs: FactorSpec[] = [],
  live = false,
): ColumnsType<DailyScreenRow> {
  return [
    {
      title: '策略排名',
      width: 100,
      sorter: sorter('core8_rank'),
      sortDirections: ASC_FIRST,
      render: (_, row) => (row.core8_rank == null ? '—' : row.core8_rank),
    },
    ...(live
      ? [
          {
            title: '现价',
            width: 84,
            align: 'right' as const,
            render: (_: unknown, row: DailyScreenRow) =>
              row.quote?.price != null ? row.quote.price.toFixed(3) : '—',
          },
          {
            title: '涨跌幅',
            width: 90,
            align: 'right' as const,
            render: (_: unknown, row: DailyScreenRow) => <Pct value={row.quote?.pct} />,
          },
        ]
      : []),
    codeColumn<DailyScreenRow>(),
    {
      title: '名称 / 筛选状态',
      dataIndex: 'name',
      width: 320,
      render: (_: string | null, row) => (
        <Space size={6} wrap>
          <Typography.Text strong>
            <Link to={`/etf/${row.code}`}>{row.name ?? row.code}</Link>
          </Typography.Text>
          <Tag style={{ marginInlineEnd: 0 }}>{row.theme ?? '其他'}</Tag>
          <Tag color={STAGE_COLOR[row.stage] ?? 'default'} style={{ marginInlineEnd: 0 }}>
            {row.stage_text}
          </Tag>
          {heldCodes?.has(row.code) && row.stage !== 'core_hold' && (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              策略持有
            </Tag>
          )}
          {row.rank != null && row.rank <= 10 && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              基线前10
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '策略分',
      width: 92,
      sorter: sorter('core8_score'),
      sortDirections: DESC_FIRST,
      defaultSortOrder: 'descend',
      render: (_, row) => <Typography.Text strong>{fmtNum(row.core8_score)}</Typography.Text>,
    },
    ...factorColumns(factorSpecs),
    {
      title: '20日',
      width: 84,
      sorter: sorter('r20'),
      sortDirections: DESC_FIRST,
      render: (_, row) => <Pct value={row.reason?.r20} />,
    },
    {
      title: '5日份额',
      width: 96,
      sorter: sorter('flow_5d'),
      sortDirections: DESC_FIRST,
      render: (_, row) => <Pct value={row.reason?.flow_5d} />,
    },
    {
      title: '规模(亿)',
      width: 92,
      sorter: sorter('aum_yi'),
      sortDirections: DESC_FIRST,
      render: (_, row) => fmtNum(row.reason?.aum_yi, 1),
    },
  ];
}
```

<a id="file-frontend-src-components-daily-window-ts"></a>

#### `frontend/src/components/daily/window.ts`

```ts
import type { DailyCumulative } from '../../api/types';

export type DailySeriesKey = 'core' | 'baseline' | 'universe' | 'hs300' | 'gated';

export const DAILY_SERIES_KEYS: DailySeriesKey[] = ['core', 'baseline', 'universe', 'hs300', 'gated'];

export interface DailyWindow {
  points: DailyCumulative[];
  /** 由全历史累计值反推的当日收益, 与累计视图共用同一窗口切片。 */
  daily: Record<DailySeriesKey, Array<number | null>>;
}

export interface DailyWindowSummary {
  days: number;
  coreCumulative: number | null;
  baselineCumulative: number | null;
  universeCumulative: number | null;
  corePositive: number | null;
  rankIcMean: number | null;
}

function emptyDaily(): Record<DailySeriesKey, Array<number | null>> {
  return { core: [], baseline: [], universe: [], hs300: [], gated: [] };
}

function compound(values: number[]): number | null {
  return values.length ? values.reduce((acc, v) => acc * (1 + v), 1) - 1 : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((acc, v) => acc + v, 0) / values.length : null;
}

function dailyReturns(points: DailyCumulative[]): Record<DailySeriesKey, Array<number | null>> {
  const daily = emptyDaily();
  points.forEach((point, i) => {
    for (const key of DAILY_SERIES_KEYS) {
      const cur = point[key];
      const prev = i > 0 ? points[i - 1][key] : null;
      daily[key].push(cur == null || prev == null ? null : (1 + cur) / (1 + prev) - 1);
    }
  });
  return daily;
}

/** 累计值按锚点归一: (1+v)/(1+base)-1, 让窗口起点回到 0。 */
function rebase(value: number | null, base: number | null): number | null {
  if (value == null) return null;
  return base == null ? value : (1 + value) / (1 + base) - 1;
}

export interface DailyWindowOptions {
  year?: number;
  since?: string | null;
}

/** 收益按结算日归属年份: 上年末信号、本年初结算的那一天算本年第一天。 */
function settledYear(point: { signal_date: string; next_signal: string | null }): number {
  return Number((point.next_signal ?? point.signal_date).slice(0, 4));
}

function startIndex(points: DailyCumulative[], opts: DailyWindowOptions): number {
  const { year, since } = opts;
  if (since) return points.findIndex((p) => p.signal_date >= since);
  if (year != null) return points.findIndex((p) => settledYear(p) >= year);
  return 0;
}

/** gated 空仓段会沿用最后净值画平线, 判定"已结算"只看四条真实收益。 */
const SETTLED_KEYS: DailySeriesKey[] = ['core', 'baseline', 'universe', 'hs300'];

/** 末尾未结算的信号日(下一交易日尚未收盘)收益全为空, 不进曲线与统计。 */
function trimUnsettled(points: DailyCumulative[]): DailyCumulative[] {
  let end = points.length;
  while (end > 0 && SETTLED_KEYS.every((key) => points[end - 1][key] == null)) end -= 1;
  return end === points.length ? points : points.slice(0, end);
}

/** 缺省返回全历史; year/since 以起点前一日为零点, 让选中日当天计入窗口。 */
export function buildDailyWindow(points: DailyCumulative[], opts: DailyWindowOptions = {}): DailyWindow {
  const start = startIndex(points, opts);
  if (start < 0) return { points: [], daily: emptyDaily() };
  const daily = dailyReturns(points);
  const anchor = start > 0 ? points[start - 1] : null;
  const windowPoints = trimUnsettled(points.slice(start)).map((point) => ({
    ...point,
    core: rebase(point.core, anchor?.core ?? null),
    baseline: rebase(point.baseline, anchor?.baseline ?? null),
    universe: rebase(point.universe, anchor?.universe ?? null),
    hs300: rebase(point.hs300, anchor?.hs300 ?? null),
    gated: rebase(point.gated, anchor?.gated ?? null),
  }));
  const sliced = emptyDaily();
  for (const key of DAILY_SERIES_KEYS) sliced[key] = daily[key].slice(start, start + windowPoints.length);
  return { points: windowPoints, daily: sliced };
}

/** 统计口径与后端 overall 一致: 每日等权收益复利、胜率按日计, 只算已结算日。 */
export function summarizeDaily(days: DailyRowLike[], opts: DailyWindowOptions = {}): DailyWindowSummary {
  const { year, since } = opts;
  const inRange = since
    ? days.filter((d) => d.signal_date >= since)
    : year == null
      ? days
      : days.filter((d) => settledYear(d) >= year);
  const rows = inRange.filter((d) => d.core_mean != null);
  const values = (key: 'core_mean' | 'baseline_mean' | 'universe_mean'): number[] =>
    rows.map((d) => d[key]).filter((v): v is number => v != null);
  const core = values('core_mean');
  const ic = rows.map((d) => d.rank_ic).filter((v): v is number => v != null);
  return {
    days: rows.length,
    coreCumulative: compound(core),
    baselineCumulative: compound(values('baseline_mean')),
    universeCumulative: compound(values('universe_mean')),
    corePositive: core.length ? core.filter((v) => v > 0).length / core.length : null,
    rankIcMean: mean(ic),
  };
}

interface DailyRowLike {
  signal_date: string;
  next_signal: string | null;
  core_mean: number | null;
  baseline_mean: number | null;
  universe_mean: number | null;
  rank_ic: number | null;
}

/** 由累计收益序列算每日相对历史高点的回撤(小数), 空值不参与但保留位置。 */
export function drawdowns(values: Array<number | null>): Array<number | null> {
  let peak: number | null = null;
  return values.map((v) => {
    if (v == null) return null;
    const equity = 1 + v;
    peak = peak == null ? equity : Math.max(peak, equity);
    return equity / peak - 1;
  });
}

export interface GatedSummary {
  gateOnDays: number;
  gateOffDays: number;
  gatedCumulative: number | null;
  gatedMaxDrawdown: number | null;
  coreMaxDrawdown: number | null;
  hs300MaxDrawdown: number | null;
}

/** 开关视图统计: 窗口内开仓/空仓日数、仅年线上执行累计与三条曲线的最大回撤。 */
export function summarizeGated(window: DailyWindow): GatedSummary {
  const points = window.points;
  return {
    gateOnDays: points.filter((p) => p.gate === 'above').length,
    gateOffDays: points.filter((p) => p.gate === 'below').length,
    gatedCumulative: points[points.length - 1]?.gated ?? null,
    gatedMaxDrawdown: maxDrawdown(points.map((p) => p.gated)),
    coreMaxDrawdown: maxDrawdown(points.map((p) => p.core)),
    hs300MaxDrawdown: maxDrawdown(points.map((p) => p.hs300)),
  };
}

function maxDrawdown(values: Array<number | null>): number | null {
  const valid = drawdowns(values).filter((v): v is number => v != null);
  return valid.length ? Math.min(...valid) : null;
}
```

### 14.16 前端 · 页面 frontend/src/pages/

<a id="file-frontend-src-pages-dailyreview-tsx"></a>

#### `frontend/src/pages/DailyReview.tsx`

```tsx
import { Alert, Button, Card, Popconfirm, Progress, Space, Tabs, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import HistoryPanel from '../components/daily/HistoryPanel';
import NodePanel from '../components/daily/NodePanel';
import TodayPanel from '../components/daily/TodayPanel';
import { useDailyDays, useDailyStatus, useRebuildDaily } from '../hooks/useDailyPick';

type TabKey = 'today' | 'nodes' | 'history';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'nodes', label: '节点' },
  { key: 'history', label: '历史' },
];

export default function DailyReview() {
  const [tab, setTab] = useState<TabKey>('today');
  const days = useDailyDays();
  const status = useDailyStatus();
  const rebuild = useRebuildDaily();
  const queryClient = useQueryClient();
  const running = status.data?.state === 'running';

  useEffect(() => {
    if (status.data?.state !== 'done') return;
    queryClient.invalidateQueries({ queryKey: ['daily'] });
  }, [status.data?.state, queryClient]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space align="baseline" wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              日度复盘
            </Typography.Title>
            <Typography.Text type="secondary">
              策略持仓每 5 个交易日调仓，节点之间持仓不变；「今日」看当下该拿什么，「节点」看每次买卖计划，「历史」看滚动收益
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text type="secondary">共 {days.data?.length ?? 0} 个交易日已记录</Typography.Text>
            <Popconfirm
              title="重算全部日度记录？"
              description="覆盖 2015-01-05 至最新交易日，全量重算约 15 分钟；持仓读取「节点」tab 的换仓结果。"
              onConfirm={() => rebuild.mutate()}
              disabled={running}
            >
              <Button type="primary" loading={rebuild.isPending || running} disabled={running}>
                {running ? '重算中' : '重算全部'}
              </Button>
            </Popconfirm>
          </Space>
          {running && (
            <Progress
              status="active"
              percent={status.data?.total ? Math.floor(((status.data.done ?? 0) / status.data.total) * 100) : 0}
              format={() => `${status.data?.done ?? 0}/${status.data?.total ?? 0}`}
            />
          )}
          {running && <Typography.Text type="secondary">{status.data?.msg}</Typography.Text>}
          {status.data?.state === 'failed' && <Alert type="error" showIcon message={status.data.error} />}
        </Space>
      </Card>

      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as TabKey)}
        items={TABS.map((item) => ({
          key: item.key,
          label: item.label,
          children:
            tab !== item.key ? null : item.key === 'today' ? (
              <TodayPanel />
            ) : item.key === 'nodes' ? (
              <NodePanel />
            ) : (
              <HistoryPanel />
            ),
        }))}
      />
    </Space>
  );
}
```

<a id="file-frontend-src-pages-etfdetail-tsx"></a>

#### `frontend/src/pages/EtfDetail.tsx`

```tsx
import { useMemo, useState } from 'react';
import { Alert, Card, Col, Descriptions, Empty, Row, Segmented, Space, Spin, Statistic, Tag, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { Link, useParams } from 'react-router-dom';
import MacdStatePanel from '../components/kline/MacdStatePanel';
import { buildCandleOption } from '../components/kline/candleOption';
import { buildSharesOption } from '../components/kline/sharesOption';
import { useEtfs, useKline, useMacdStates, useShares } from '../hooks/useEtfs';
import type { DailyBar, KlinePeriod, SharesPoint } from '../api/types';

const PERIOD_OPTIONS: Array<{ label: string; value: KlinePeriod }> = [
  { label: '日K', value: 'day' },
  { label: '周K', value: 'week' },
  { label: '月K', value: 'month' },
];

const PERIOD_LABEL: Record<KlinePeriod, string> = { day: '日', week: '周', month: '月' };

const RANGE_OPTIONS = [
  { label: '1年', value: 0 },
  { label: '3年', value: 1 },
  { label: '6年', value: 2 },
  { label: '全部', value: 3 },
];

// 同一个"年限"在日/周/月K下对应的根数不同。
const RANGE_LIMITS: Record<KlinePeriod, number[]> = {
  day: [250, 750, 1500, 6000],
  week: [52, 156, 312, 1200],
  month: [12, 36, 72, 300],
};

const DAILY_STAT_BARS = 250;

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

function closes(bars: DailyBar[]): number[] {
  return bars.map((b) => b.close).filter((v): v is number => v != null);
}

function periodReturn(values: number[], back: number): number | null {
  if (values.length < 2) return null;
  const last = values[values.length - 1];
  const first = values[Math.max(0, values.length - 1 - back)];
  return first ? last / first - 1 : null;
}

function shareChange(points: SharesPoint[]): number | null {
  if (points.length < 2) return null;
  return points[points.length - 1].shares_yi - points[0].shares_yi;
}

export default function EtfDetail() {
  const { code = '' } = useParams();
  const [period, setPeriod] = useState<KlinePeriod>('day');
  const [rangeIndex, setRangeIndex] = useState(1);
  const { data: etfs } = useEtfs();
  const limit = RANGE_LIMITS[period][rangeIndex];
  const kline = useKline(code, period, limit);
  const daily = useKline(code, 'day', DAILY_STAT_BARS);
  const macdStates = useMacdStates(code);
  const shares = useShares(code, 2000);

  const meta = useMemo(() => (etfs ?? []).find((x) => x.code === code), [etfs, code]);
  const bars = useMemo(() => kline.data?.bars ?? [], [kline.data]);
  const dailyBars = useMemo(() => daily.data?.bars ?? [], [daily.data]);
  const sharePoints = useMemo(() => shares.data?.rows ?? [], [shares.data]);

  const candleOption = useMemo(() => buildCandleOption(bars), [bars]);
  const sharesOption = useMemo(() => buildSharesOption(sharePoints), [sharePoints]);

  const dailyCloses = useMemo(() => closes(dailyBars), [dailyBars]);
  const latestClose = dailyCloses.length ? dailyCloses[dailyCloses.length - 1] : null;
  const ret60 = periodReturn(dailyCloses, 60);
  const chartCloses = useMemo(() => closes(bars), [bars]);
  const retWindow = periodReturn(chartCloses, chartCloses.length - 1);
  const latestShares = sharePoints.length ? sharePoints[sharePoints.length - 1].shares_yi : null;
  const sharesDiff = shareChange(sharePoints);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space align="baseline" wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {meta?.name ?? code}
            </Typography.Title>
            <Tag>{code}</Tag>
            {meta?.fund_type && <Tag color="blue">{meta.fund_type}</Tag>}
            <Link to="/">← 返回清单</Link>
          </Space>
          <Descriptions size="small" column={4}>
            <Descriptions.Item label="K线区间">
              {meta?.daily_first ? `${meta.daily_first} ~ ${meta.daily_last}` : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="K线行数">{meta?.daily_rows.toLocaleString() ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="份额行数">{meta?.shares_rows.toLocaleString() ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="份额截至">{meta?.shares_last ?? '—'}</Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic title="最新收盘" value={latestClose ?? undefined} precision={3} />
          </Card>
        </Col>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic
              title="近60日涨跌"
              value={ret60 == null ? '—' : pct(ret60)}
              valueStyle={{ color: (ret60 ?? 0) >= 0 ? '#f5222d' : '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic
              title="图表区间涨跌"
              value={retWindow == null ? '—' : pct(retWindow)}
              valueStyle={{ color: (retWindow ?? 0) >= 0 ? '#f5222d' : '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic title="最新份额(亿份)" value={latestShares ?? undefined} precision={2} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card size="small">
            <Statistic
              title="区间份额变化(亿)"
              value={sharesDiff == null ? '—' : `${sharesDiff >= 0 ? '+' : ''}${sharesDiff.toFixed(2)}`}
              valueStyle={{ color: (sharesDiff ?? 0) >= 0 ? '#f5222d' : '#52c41a' }}
            />
          </Card>
        </Col>
      </Row>

      <MacdStatePanel states={macdStates.data?.states} loading={macdStates.isLoading} />

      <Card
        size="small"
        title={`${PERIOD_LABEL[period]}K线 · 成交量 · MACD`}
        extra={
          <Space wrap size={8}>
            <Segmented
              options={PERIOD_OPTIONS}
              value={period}
              onChange={(v) => setPeriod(v as KlinePeriod)}
            />
            <Segmented
              options={RANGE_OPTIONS}
              value={rangeIndex}
              onChange={(v) => setRangeIndex(v as number)}
            />
          </Space>
        }
      >
        <Spin spinning={kline.isLoading}>
          {kline.error ? (
            <Alert type="warning" showIcon message="该标的暂无K线数据" description={String(kline.error.message)} />
          ) : candleOption ? (
            <ReactECharts option={candleOption} style={{ height: 560 }} notMerge />
          ) : (
            <Empty description="K线数据不足" />
          )}
        </Spin>
      </Card>

      <Card size="small" title="份额变化（亿份）">
        <Spin spinning={shares.isLoading}>
          {shares.error ? (
            <Alert type="warning" showIcon message="该标的暂无份额数据" description={String(shares.error.message)} />
          ) : sharesOption ? (
            <ReactECharts option={sharesOption} style={{ height: 260 }} notMerge />
          ) : (
            <Empty description="份额数据不足" />
          )}
        </Spin>
      </Card>
    </Space>
  );
}
```

<a id="file-frontend-src-pages-etflist-tsx"></a>

#### `frontend/src/pages/EtfList.tsx`

```tsx
import { useMemo, useState } from 'react';
import { Alert, Card, Col, Empty, Input, Row, Segmented, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import type { EtfCoverage } from '../api/types';
import { useEtfs } from '../hooks/useEtfs';

type StatusFilter = 'all' | 'daily' | 'noDaily' | 'noShares';

const STATUS_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '有K线', value: 'daily' },
  { label: '缺K线', value: 'noDaily' },
  { label: '缺份额', value: 'noShares' },
];

function matchStatus(item: EtfCoverage, status: StatusFilter): boolean {
  if (status === 'daily') return item.daily_rows > 0;
  if (status === 'noDaily') return item.daily_rows === 0;
  if (status === 'noShares') return item.shares_rows === 0;
  return true;
}

const columns: ColumnsType<EtfCoverage> = [
  { title: '代码', dataIndex: 'code', width: 100, fixed: 'left' },
  {
    title: '名称',
    dataIndex: 'name',
    width: 200,
    ellipsis: true,
    render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
  },
  {
    title: '类型',
    dataIndex: 'fund_type',
    width: 130,
    render: (type: string | null) => (type ? <Tag>{type}</Tag> : <Tag color="default">未知</Tag>),
  },
  {
    title: 'K线区间',
    key: 'range',
    width: 200,
    sorter: (a, b) => (a.daily_last ?? '').localeCompare(b.daily_last ?? ''),
    render: (_, r) =>
      r.daily_first ? `${r.daily_first} ~ ${r.daily_last}` : <Typography.Text type="secondary">无数据</Typography.Text>,
  },
  {
    title: 'K线行数',
    dataIndex: 'daily_rows',
    width: 110,
    align: 'right',
    sorter: (a, b) => a.daily_rows - b.daily_rows,
    render: (n: number) => n.toLocaleString(),
  },
  {
    title: '份额截至',
    dataIndex: 'shares_last',
    width: 120,
    render: (d: string | null) => d ?? <Typography.Text type="secondary">无数据</Typography.Text>,
  },
  {
    title: '份额行数',
    dataIndex: 'shares_rows',
    width: 110,
    align: 'right',
    sorter: (a, b) => a.shares_rows - b.shares_rows,
    render: (n: number) => n.toLocaleString(),
  },
];

export default function EtfList() {
  const { data, isLoading, error } = useEtfs();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  // 分页必须受控: 只给 pageSize 初始值会导致每次重渲染回落 50, 用户选 100 看起来"不生效"
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const navigate = useNavigate();

  const stats = useMemo(() => {
    const list = data ?? [];
    return {
      total: list.length,
      withDaily: list.filter((x) => x.daily_rows > 0).length,
      withShares: list.filter((x) => x.shares_rows > 0).length,
      dailyRows: list.reduce((sum, x) => sum + x.daily_rows, 0),
      sharesRows: list.reduce((sum, x) => sum + x.shares_rows, 0),
    };
  }, [data]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (data ?? []).filter(
      (item) =>
        matchStatus(item, status) &&
        (!kw || item.code.includes(kw) || item.name.toLowerCase().includes(kw)),
    );
  }, [data, keyword, status]);

  if (error) {
    return <Alert type="error" showIcon message="清单加载失败" description={String(error)} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="在册标的" value={stats.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已有K线" value={stats.withDaily} suffix={`/ ${stats.total}`} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已有份额" value={stats.withShares} suffix={`/ ${stats.total}`} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="K线 / 份额 行数(万)"
              value={`${(stats.dailyRows / 10000).toFixed(1)} / ${(stats.sharesRows / 10000).toFixed(1)}`}
              valueStyle={{ fontSize: 16, whiteSpace: 'nowrap' }}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索代码或名称"
            style={{ width: 280 }}
            onSearch={setKeyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(1);
            }}
          />
          <Segmented
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v as StatusFilter);
              setPage(1);
            }}
          />
          <Typography.Text type="secondary">共 {filtered.length} 只</Typography.Text>
        </Space>
      </Card>

      <Table<EtfCoverage>
        size="small"
        rowKey="code"
        loading={isLoading}
        columns={columns}
        dataSource={filtered}
        pagination={{
          current: page,
          pageSize,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100', '200'],
          showTotal: (t) => `共 ${t} 只`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize === pageSize ? nextPage : 1);
            setPageSize(nextSize);
          },
        }}
        scroll={{ x: 1000 }}
        onRow={(record) => ({ onClick: () => navigate(`/etf/${record.code}`), style: { cursor: 'pointer' } })}
        locale={{ emptyText: <Empty description="无匹配标的" /> }}
      />
    </Space>
  );
}
```

<a id="file-frontend-src-pages-jobs-tsx"></a>

#### `frontend/src/pages/Jobs.tsx`

```tsx
import { useMemo } from 'react';
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import type { JobStatus } from '../api/types';
import BootstrapCard from '../components/data/BootstrapCard';
import DatasetReadiness from '../components/dataset/DatasetReadiness';
import { useEtfs } from '../hooks/useEtfs';
import { useJobs, useSchedulerStatus, useStartJob } from '../hooks/useJobs';

interface JobMeta {
  key: string;
  title: string;
  desc: string;
}

const JOBS: JobMeta[] = [
  {
    key: 'backfill_daily',
    title: '日K线',
    desc: '全部在册标的日K并发回填；被 2015 旧下限截断的老 ETF 自动向前补深至 2004，新标的取到上市首日即停，其余从最新日次日增量',
  },
  { key: 'backfill_shares', title: '份额', desc: '逐交易日回填全市场 ETF 份额，已覆盖日期跳过' },
  {
    key: 'detect_share_conversions',
    title: '份额折算甄别',
    desc: '比对未复权与前复权收盘台阶，把份额折算从真实申赎里分离并写入 etf_share_scale；已甄别的跳变跳过',
  },
  {
    key: 'backfill_index',
    title: '指数日线',
    desc: '中证官方全历史（含市盈率/成分数，腾讯/新浪只有最近 650~1023 根且不支持中证自编指数），按最新日次日增量',
  },
  { key: 'refresh_etf_list', title: 'ETF 清单', desc: '刷新全市场 ETF 清单快照，新标的自动并入待回填' },
  { key: 'refresh_calendar', title: '交易日历', desc: '刷新交易日历，作为回填进度的事实基准' },
];

const STATE_TAG: Record<string, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  done: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
};

const SCHEDULER_TAG: Record<string, { color: string; text: string }> = {
  idle: { color: 'default', text: '待机' },
  running: { color: 'processing', text: '运行中' },
  done: { color: 'success', text: '已完成' },
  skipped: { color: 'warning', text: '已跳过' },
  failed: { color: 'error', text: '失败' },
};

const STAGE_TEXT: Record<string, string> = {
  starting: '准备中',
  calendar: '交易日历',
  daily: '日K',
  index: '指数日线',
  shares: '份额',
  core: '换仓节点',
  records: '日度记录',
};

function progressOf(status?: JobStatus): number {
  if (!status) return 0;
  if (status.state === 'done') return 100;
  if (status.state === 'failed' || !status.total) return 0;
  return Math.min(100, Math.floor(((status.done ?? 0) / status.total) * 100));
}

function resultText(status: JobStatus): string {
  if (!status.result) return '';
  return Object.entries(status.result)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toLocaleString() : String(v)}`)
    .join(' · ');
}

function JobCard({
  meta,
  status,
  onStart,
  starting,
}: {
  meta: JobMeta;
  status?: JobStatus;
  onStart: () => void;
  starting: boolean;
}) {
  const running = status?.state === 'running';
  const tag = status ? STATE_TAG[status.state] : undefined;

  return (
    <Card
      size="small"
      title={meta.title}
      extra={
        <Space>
          {tag && <Tag color={tag.color}>{tag.text}</Tag>}
          <Button size="small" type="primary" disabled={running || starting} loading={starting} onClick={onStart}>
            启动
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{meta.desc}</Typography.Text>
        <Progress
          percent={progressOf(status)}
          status={running ? 'active' : status?.state === 'failed' ? 'exception' : undefined}
        />
        {running && (
          <Typography.Text>
            {status.done ?? 0} / {status.total ?? 0} · {status.msg ?? '启动中'}
          </Typography.Text>
        )}
        {status?.state === 'done' && <Typography.Text type="success">{resultText(status)}</Typography.Text>}
        {status?.state === 'failed' && <Alert type="error" showIcon message={status.error ?? '任务失败'} />}
      </Space>
    </Card>
  );
}

function fiveYearsAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function SchedulerCard() {
  const { data } = useSchedulerStatus();
  const tag = data ? SCHEDULER_TAG[data.state] : undefined;
  return (
    <Card size="small" title="收盘自动刷新" extra={tag && <Tag color={tag.color}>{tag.text}</Tag>}>
      <Space direction="vertical" size={4}>
        <Typography.Text type="secondary">
          交易日 18:30 补日K/指数/份额并重算节点与日度记录；22:30 再补一次，等中证指数当晚发布；次日 00:20 重拉最近 4 个交易日份额并再结算一次。
        </Typography.Text>
        {data?.stage && <Typography.Text>当前阶段：{STAGE_TEXT[data.stage] ?? data.stage}</Typography.Text>}
        {data?.signal_date && <Typography.Text>最新信号日：{data.signal_date}</Typography.Text>}
        {data?.finished_at && data.detail && (
          <Typography.Text type="secondary">
            上次结果 {data.finished_at} · {data.detail}
          </Typography.Text>
        )}
        {data?.next_run && <Typography.Text type="secondary">下次执行 {data.next_run}</Typography.Text>}
      </Space>
    </Card>
  );
}

export default function Jobs() {
  const jobs = useJobs();
  const start = useStartJob();
  const etfs = useEtfs(5000);

  const stats = useMemo(() => {
    const list = etfs.data ?? [];
    const cutoff = fiveYearsAgo();
    return {
      total: list.length,
      withDaily: list.filter((x) => x.daily_rows > 0).length,
      withShares: list.filter((x) => x.shares_rows > 0).length,
      dailyRows: list.reduce((sum, x) => sum + x.daily_rows, 0),
      fiveYears: list.filter((x) => x.daily_first != null && x.daily_first <= cutoff).length,
      noDaily: list.filter((x) => x.daily_rows === 0).length,
    };
  }, [etfs.data]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <BootstrapCard />
      <SchedulerCard />
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="在册标的" value={stats.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已有K线" value={stats.withDaily} suffix={`/ ${stats.total}`} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已有份额" value={stats.withShares} suffix={`/ ${stats.total}`} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="K线总行数" value={stats.dailyRows.toLocaleString()} />
          </Card>
        </Col>
      </Row>

      {start.isError && <Alert type="error" showIcon message="任务启动失败" description={String(start.error)} />}

      <Typography.Text type="secondary">
        满 5 年历史 {stats.fiveYears} 只 · 上市不足 5 年 {stats.withDaily - stats.fiveYears} 只 · 无K线{' '}
        {stats.noDaily} 只（含尚未上市）
      </Typography.Text>

      <Row gutter={[16, 16]}>
        {JOBS.map((meta) => (
          <Col span={12} key={meta.key}>
            <JobCard
              meta={meta}
              status={jobs.data?.[meta.key]}
              starting={start.isPending && start.variables === meta.key}
              onStart={() => start.mutate(meta.key)}
            />
          </Col>
        ))}
      </Row>

      <Typography.Text type="secondary">
        状态每秒自动刷新
        {jobs.dataUpdatedAt ? `，上次更新 ${new Date(jobs.dataUpdatedAt).toLocaleTimeString()}` : ''}
      </Typography.Text>

      <DatasetReadiness />
    </Space>
  );
}
```
