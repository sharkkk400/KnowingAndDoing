/** 规则版本保留内部标识(core8-v1), 展示层统一称「策略」。 */
export function ruleVersionLabel(version: string): string {
  const matched = /^(?:daily-)?core8-v(\d+)$/.exec(version);
  return matched ? `策略 v${matched[1]}` : version;
}
