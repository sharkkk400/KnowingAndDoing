/** core8 买入区(前 N 名)与缓冲带(排名 ≤ N 继续持有), 与后端 core.HOLD_TOP / HOLD_BUFFER_RANK 一致。 */
export const HOLD_TOP = 5;
export const HOLD_BUFFER_RANK = 15;

/** 左卡对照名单长度, 与后端 live.TODAY_TOP_N 一致。 */
export const TODAY_TOP_N = 10;
