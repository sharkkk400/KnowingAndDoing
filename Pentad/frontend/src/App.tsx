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
