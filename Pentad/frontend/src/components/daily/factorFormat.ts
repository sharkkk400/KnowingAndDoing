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
