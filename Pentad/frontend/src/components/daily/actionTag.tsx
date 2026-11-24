import { Tag } from 'antd';
import type { DailyCorePick } from '../../api/types';
import { ACTION_META } from './actionMeta';

export function ActionTag({ action }: { action: DailyCorePick['action'] }) {
  const meta = ACTION_META[action];
  return <Tag color={meta.color}>{meta.text}</Tag>;
}
