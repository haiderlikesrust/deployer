import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Api, type App } from '../api/client';
import {
  AlertTriangle,
  AppCardSkeleton,
  Box,
  Button,
  ButtonLink,
  Card,
  Chip,
  EmptyState,
  ExternalLink,
  GitBranch,
  Identicon,
  Input,
  PageHeader,
  Plus,
  RelativeTime,
  Search,
  StatusBadge,
  shortRepo,
} from '../components/ui';

export default function AppsList() {
  const apps = useQuery({ queryKey: ['apps'], queryFn: Api.apps.list, refetchInterval: 10000 });
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // `/` and ⌘K jump to the filter, the way every list view worth using does
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const list = apps.data ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((a) => a.name.toLowerCase().includes(needle) || a.repoUrl.toLowerCase().includes(needle));
  }, [list, q]);

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            Apps
            {apps.data && <Chip tone="neutral">{list.length}</Chip>}
          </span>
        }
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
              <Input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search apps"
                aria-label="Search apps"
                spellCheck={false}
                className="w-[220px] pl-8"
              />
            </div>
            <ButtonLink variant="primary" to="/new" icon={<Plus className="h-3.5 w-3.5" />}>
              New App
            </ButtonLink>
          </>
        }
      />

      {apps.isError && (
        <Card tone="danger" padding="md">
          <div className="flex flex-wrap items-center gap-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-danger-fg" />
            <span className="min-w-0 text-sm text-danger-fg">
              Could not load apps — {(apps.error as Error).message}
            </span>
            <Button variant="secondary" className="ml-auto" onClick={() => apps.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {apps.isPending && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <AppCardSkeleton key={i} />
          ))}
        </div>
      )}

      {apps.data && list.length === 0 && (
        <EmptyState
          icon={<Box className="h-4 w-4" />}
          title="No apps yet"
          description="Paste a Git repo URL and deployer clones it, detects the stack, builds an image, and routes traffic with TLS."
          action={{ label: 'Deploy your first app', to: '/new' }}
        />
      )}

      {apps.data && list.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon={<Search className="h-4 w-4" />}
          title="No matches"
          description={`Nothing matches “${q.trim()}”. Try the repo owner or a shorter fragment.`}
          secondaryAction={{ label: 'Clear search', onClick: () => setQ('') }}
        />
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}

function AppCard({ app }: { app: App }) {
  const last = app.lastDeployment;
  const deployedAt = last?.finishedAt ?? last?.createdAt ?? null;
  const missing = app.envStatus && !app.envStatus.satisfied ? app.envStatus.missingCount : 0;

  return (
    <Card interactive as={Link} to={`/apps/${app.id}`} className="card-interactive min-w-0 p-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Identicon name={app.name} size="md" />
        <span className="min-w-0 truncate text-sm font-medium text-fg group-hover:text-white">{app.name}</span>
        <StatusBadge status={app.status} className="ml-auto" />
      </div>

      <div className="mt-2 flex h-5 min-w-0 items-center gap-1.5">
        {app.isWorker ? (
          <WorkerLine app={app} />
        ) : app.effectiveHost ? (
          <HostLink host={app.effectiveHost} url={app.url} />
        ) : (
          <span className="text-xs text-fg-faint">No URL yet</span>
        )}
        {missing > 0 && (
          <Chip tone="info" size="sm" className="ml-auto">
            {missing} var{missing === 1 ? '' : 's'} needed
          </Chip>
        )}
      </div>

      <div className="-mx-4 mt-3 border-t border-border-subtle" />

      <div className="flex min-w-0 items-center gap-2 pt-3 text-xs text-fg-subtle">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
        <span className="min-w-0 truncate font-mono">{shortRepo(app.repoUrl)}</span>
        {app.branch && (
          <Chip mono size="sm" className="hidden sm:inline-flex">
            {app.branch}
          </Chip>
        )}
        <span className="ml-auto shrink-0">
          {deployedAt ? <RelativeTime iso={deployedAt} /> : <span className="text-fg-faint">Never deployed</span>}
        </span>
      </div>
    </Card>
  );
}

/** A real focusable control so keyboard users reach the deployed URL without opening the app. */
function HostLink({ host, url }: { host: string; url: string | null }) {
  const open = () => {
    if (url) window.open(url, '_blank', 'noreferrer');
  };
  return (
    <span
      role="link"
      tabIndex={0}
      title={url ?? host}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        open();
      }}
      className="inline-flex min-w-0 items-center gap-1 rounded-sm font-mono text-xs text-accent-fg hover:underline"
    >
      <span className="min-w-0 truncate">{host}</span>
      <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-ui group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100" />
    </span>
  );
}

/**
 * Workers have no URL, so the card shows whether the process is up. `/api/apps`
 * deliberately carries no per-container detail — one `docker ps` covers the whole
 * list, and an inspect per app on a 10s poll is not worth uptime on a card. The
 * detail page has the container and shows uptime and restarts there.
 */
function WorkerLine({ app }: { app: App }) {
  const label = app.status === 'live' ? 'running' : app.status === 'deploying' ? 'starting' : 'not running';
  return (
    <>
      <Chip tone="neutral" size="sm">
        worker
      </Chip>
      <span className="min-w-0 truncate font-mono text-xs text-fg-subtle">{label}</span>
    </>
  );
}
