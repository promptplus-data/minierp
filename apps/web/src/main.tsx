import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, matchRoutes, useLocation, useRoutes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiFail } from './api';
import { AuthProvider, useAuth } from './auth';
import { Shell } from './Shell';
import { MODULE_ROUTES, ModuleWraps, PUBLIC_ROUTES, useVisibleNav } from './modules';
import { ToastProvider } from './ui';
import { TouchProvider } from './touch';
import { ErrorHost } from './errors';
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
  // module routes first: the reports module owns '/' (home dashboard); Home below only redirects when none does
  ...MODULE_ROUTES,
  { path: '/', element: <Home /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

function AppRoutes() {
  return useRoutes(ROUTES);
}

function PublicRoutes() {
  return useRoutes(PUBLIC_ROUTES);
}

function App() {
  const { user, restoring } = useAuth();
  const meta = useMeta();
  const loc = useLocation();
  if (matchRoutes(PUBLIC_ROUTES, loc)) return <PublicRoutes />;
  if (restoring) return <div className="lg"><div className="card lgcard" role="status" aria-label="กำลังโหลด"><div className="sk" /><div className="sk" /></div></div>;
  if (!user) return meta.data?.needsSetup ? <Setup /> : <Login />;
  return (
    <Shell>
      <ModuleWraps>
        <AppRoutes />
      </ModuleWraps>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <TouchProvider>
        <ToastProvider>
          <ErrorHost>
            <BrowserRouter>
              <AuthProvider>
                <App />
              </AuthProvider>
            </BrowserRouter>
          </ErrorHost>
        </ToastProvider>
      </TouchProvider>
    </QueryClientProvider>
  </StrictMode>,
);
