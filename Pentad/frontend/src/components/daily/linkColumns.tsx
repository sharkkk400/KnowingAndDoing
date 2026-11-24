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
