import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiFail } from './api';
import { AuthProvider, useAuth } from './auth';
import { Shell, useVisibleViews } from './Shell';
import { ToastProvider } from './ui';
import Login from './pages/Login';
import Products from './pages/Products';
import Stock from './stock/Stock';
import Pos from './pos/Pos';
import SalesDocs from './pages/SalesDocs';
import DocDetail from './pages/DocDetail';
import Returns from './pages/Returns';
import Audit from './pages/Audit';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => n < 2 && !(err instanceof ApiFail && err.status >= 400 && err.status < 500),
      refetchOnWindowFocus: false,
    },
  },
});

function Home() {
  const views = useVisibleViews();
  if (!views[0]) return <div className="card"><div className="empty">บทบาทนี้ยังไม่มีเมนูที่ใช้ได้ในเวอร์ชันนี้</div></div>;
  return <Navigate to={views[0].path} replace />;
}

function Guard({ path, children }: { path: string; children: JSX.Element }) {
  const views = useVisibleViews();
  return views.some((v) => v.path === path) ? children : <Navigate to="/" replace />;
}

function App() {
  const { user, restoring } = useAuth();
  if (restoring) return <div className="lg"><div className="card lgcard"><div className="sk" /><div className="sk" /></div></div>;
  if (!user) return <Login />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/pos" element={<Guard path="/pos"><Pos /></Guard>} />
        <Route path="/sales" element={<Guard path="/sales"><SalesDocs /></Guard>} />
        <Route path="/sales/:no" element={<Guard path="/sales"><DocDetail /></Guard>} />
        <Route path="/returns" element={<Guard path="/returns"><Returns /></Guard>} />
        <Route path="/stock" element={<Guard path="/stock"><Stock /></Guard>} />
        <Route path="/products" element={<Guard path="/products"><Products /></Guard>} />
        <Route path="/audit" element={<Guard path="/audit"><Audit /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
