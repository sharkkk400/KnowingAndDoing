import type { DailyCorePick } from '../../api/types';

export const ACTION_META: Record<DailyCorePick['action'], { color: string; text: string }> = {
  hold: { color: 'blue', text: '继续持有' },
  buy: { color: 'red', text: '本次买入' },
  sell: { color: 'default', text: '本次卖出' },
  rank: { color: 'default', text: '未持有' },
};
