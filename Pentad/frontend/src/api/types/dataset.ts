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
