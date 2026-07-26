import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { Api, type SseUpdate } from './api/client';
import { useSSE } from './hooks/useSSE';
import { Box, EmptyState, ExternalLink, Logo, Separator, Spinner, ToastProvider, cn } from './components/ui';
import Login from './pages/Login';
import AppsList from './pages/AppsList';
import NewApp from './pages/NewApp';
import AppDetail from './pages/AppDetail';
import SystemPage from './pages/System';

export default function App() {
  // the provider has to sit above every page so `useToast()` resolves everywhere
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const qc = useQueryClient();
  const [kicked, setKicked] = useState(false);
  const [sseDown, setSseDown] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: Api.me, retry: false });
  const loc = useLocation();

  useEffect(() => {
    const onUnauthorized = () => setKicked(true);
    window.addEventListener('deployer:unauthorized', onUnauthorized);
    return () => window.removeEventListener('deployer:unauthorized', onUnauthorized);
  }, []);

  const authed = me.isSuccess && !kicked;

  // one global event stream keeps every view live
  useSSE(
    authed ? '/api/events' : null,
    {
      update: (ev: SseUpdate) => {
        setSseDown(false);
        qc.invalidateQueries({ queryKey: ['apps'] });
        qc.invalidateQueries({ queryKey: ['app', ev.appId] });
        qc.invalidateQueries({ queryKey: ['deployments', ev.appId] });
        // the .env.example schema is re-cached on every resolve, so it can change under us
        qc.invalidateQueries({ queryKey: ['envSchema', ev.appId] });
        if (ev.deploymentId) qc.invalidateQueries({ queryKey: ['deployment', ev.deploymentId] });
      },
    },
    { onOpen: () => setSseDown(false), onError: () => setSseDown(true) }
  );

  if (me.isLoading) {
    return (
      <div className="grid h-screen place-items-center">
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
      <Header sseDown={sseDown} />
      <main className="mx-auto max-w-page px-4 py-8 sm:px-6">
        <div key={loc.pathname} className="animate-rise">
          <Routes>
            <Route path="/" element={<AppsList />} />
            <Route path="/new" element={<NewApp />} />
            <Route path="/apps/:id" element={<AppDetail />} />
            <Route path="/system" element={<SystemPage />} />
            <Route
              path="*"
              element={
                <EmptyState
                  icon={<Box className="h-4 w-4" />}
                  title="Page not found"
                  description="That URL does not match anything in the dashboard."
                  action={{ label: 'Back to apps', to: '/' }}
                />
              }
            />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function Header({ sseDown }: { sseDown: boolean }) {
  const qc = useQueryClient();
  const loc = useLocation();
  const match = useMatch('/apps/:id');
  const appId = match ? Number(match.params.id) : NaN;
  const hasApp = Number.isFinite(appId);

  // shares the cache with AppDetail, so the breadcrumb costs no extra request
  const app = useQuery({
    queryKey: ['app', appId],
    queryFn: () => Api.apps.get(appId),
    enabled: hasApp,
    refetchInterval: 10000,
  });

  const system = useQuery({ queryKey: ['system'], queryFn: Api.system.get, staleTime: 60000 });
  // the scheme has to come from the server — a local or behind-nginx instance is not https
  const docsUrl = system.data?.baseDomain ? `${system.data.publicScheme ?? 'https'}://docs.${system.data.baseDomain}` : null;

  async function signOut() {
    await Api.logout();
    qc.clear();
    window.dispatchEvent(new Event('deployer:unauthorized'));
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/75 backdrop-blur-xl supports-[backdrop-filter]:bg-bg/60">
      <div className="mx-auto flex h-14 max-w-page items-center gap-2 px-4 sm:px-6">
        <Link to="/" className="flex shrink-0 items-center gap-2 rounded-sm text-fg">
          <Logo className="h-5 w-5" />
          <span className="text-sm font-medium">deployer</span>
        </Link>
        {hasApp && app.data && (
          <>
            <span aria-hidden className="hidden text-fg-faint sm:inline">
              /
            </span>
            <span className="hidden max-w-[45vw] truncate text-sm text-fg-muted sm:inline">{app.data.name}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="hidden h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-fg-subtle transition-ui hover:bg-white/[0.05] hover:text-fg sm:inline-flex"
            >
              Docs
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <Separator vertical className="mx-1 hidden sm:inline-block" />
          <button
            type="button"
            onClick={signOut}
            className="inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium text-fg-subtle transition-ui hover:bg-white/[0.05] hover:text-fg"
          >
            Sign out
          </button>
        </div>
      </div>

      <nav className="mx-auto flex h-10 max-w-page items-center gap-1 overflow-x-auto px-4 scroll-thin sm:px-6">
        <NavTab to="/" label="Apps" active={loc.pathname === '/' || loc.pathname.startsWith('/apps') || loc.pathname === '/new'} />
        <NavTab to="/system" label="System" active={loc.pathname.startsWith('/system')} />
      </nav>

      {sseDown && (
        <div className="border-t border-warn-br bg-warn-bg py-1 text-center text-xs text-warn-fg">Reconnecting…</div>
      )}
    </header>
  );
}

function NavTab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <NavLink
      to={to}
      className={cn(
        'relative inline-flex h-10 shrink-0 items-center px-3 text-sm font-medium transition-ui',
        active
          ? 'text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-fg'
          : 'text-fg-subtle hover:text-fg'
      )}
    >
      {label}
    </NavLink>
  );
}
