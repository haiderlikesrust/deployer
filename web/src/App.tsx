import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Api } from './api/client';
import { useSSE } from './hooks/useSSE';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import AppsList from './pages/AppsList';
import NewApp from './pages/NewApp';
import AppDetail from './pages/AppDetail';
import SystemPage from './pages/System';

export default function App() {
  const qc = useQueryClient();
  const [kicked, setKicked] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: Api.me, retry: false });

  useEffect(() => {
    const onUnauthorized = () => setKicked(true);
    window.addEventListener('deployer:unauthorized', onUnauthorized);
    return () => window.removeEventListener('deployer:unauthorized', onUnauthorized);
  }, []);

  const authed = me.isSuccess && !kicked;

  // one global event stream keeps every view live
  useSSE(authed ? '/api/events' : null, {
    update: (ev: { type: string; appId: number; deploymentId?: number }) => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      qc.invalidateQueries({ queryKey: ['app', ev.appId] });
      qc.invalidateQueries({ queryKey: ['deployments', ev.appId] });
      if (ev.deploymentId) qc.invalidateQueries({ queryKey: ['deployment', ev.deploymentId] });
    },
  });

  if (me.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!authed) {
    return (
      <Login
        onSuccess={() => {
          setKicked(false);
          qc.invalidateQueries();
          me.refetch();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Routes>
          <Route path="/" element={<AppsList />} />
          <Route path="/new" element={<NewApp />} />
          <Route path="/apps/:id" element={<AppDetail />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="*" element={<div className="text-zinc-500">Page not found</div>} />
        </Routes>
      </main>
    </div>
  );
}

function Nav() {
  const loc = useLocation();
  const qc = useQueryClient();
  const tab = (to: string, label: string) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-md px-3 py-1.5 text-sm font-medium ${
          isActive || (to === '/' && loc.pathname.startsWith('/apps'))
            ? 'bg-zinc-800 text-zinc-100'
            : 'text-zinc-400 hover:text-zinc-200'
        }`
      }
    >
      {label}
    </NavLink>
  );
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-2 text-base font-semibold text-zinc-100">
          <span>🚀</span> deployer
        </Link>
        <nav className="flex gap-1">
          {tab('/', 'Apps')}
          {tab('/system', 'System')}
        </nav>
        <div className="ml-auto">
          <button
            onClick={async () => {
              await Api.logout();
              qc.clear();
              window.dispatchEvent(new Event('deployer:unauthorized'));
            }}
            className="text-sm text-zinc-500 hover:text-zinc-300"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
