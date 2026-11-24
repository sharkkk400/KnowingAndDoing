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
