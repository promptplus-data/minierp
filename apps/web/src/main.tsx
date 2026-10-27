import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, useRoutes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiFail } from './api';
import { AuthProvider, useAuth } from './auth';
import { Shell } from './Shell';
import { MODULE_ROUTES, useVisibleNav } from './modules';
import { ToastProvider } from './ui';
import Login from './pages/Login';
import Setup from './pages/Setup';
import { useMeta } from './data';
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
  const views = useVisibleNav();
  if (!views[0]) return <div className="card"><div className="empty">บทบาทนี้ยังไม่มีเมนูที่ใช้ได้ในเวอร์ชันนี้</div></div>;
  return <Navigate to={views[0].path} replace />;
}

const ROUTES = [
  { path: '/', element: <Home /> },
  ...MODULE_ROUTES,
  { path: '*', element: <Navigate to="/" replace /> },
];

function AppRoutes() {
  return useRoutes(ROUTES);
}

function App() {
  const { user, restoring } = useAuth();
  const meta = useMeta();
  if (restoring) return <div className="lg"><div className="card lgcard"><div className="sk" /><div className="sk" /></div></div>;
  if (!user) return meta.data?.needsSetup ? <Setup /> : <Login />;
  return (
    <Shell>
      <AppRoutes />
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
