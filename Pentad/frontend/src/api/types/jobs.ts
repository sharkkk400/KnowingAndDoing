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
