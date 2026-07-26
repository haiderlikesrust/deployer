import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Api, type App, type Deployment, type EnvVarSpec, type ResolvedConfig } from '../api/client';
import { useSSE } from '../hooks/useSSE';
import {
  AlertTriangle,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Check,
  ChevronRight,
  Chip,
  CommitRef,
  ConfirmDialog,
  CopyButton,
  Duration,
  EmptyState,
  DeploymentRowSkeleton,
  EnvRowSkeleton,
  ExternalLink,
  Field,
  GitBranch,
  IconButton,
  Identicon,
  Info,
  Input,
  KeyValue,
  LogViewer,
  Plus,
  RelativeTime,
  Restart,
  SecretInput,
  SectionLabel,
  Select,
  Skeleton,
  Sparkline,
  formatBytes,
  SourceChip,
  StatusBadge,
  StatusDot,
  Tabs,
  Terminal,
  Textarea,
  X,
  cn,
  detectRequiredEnv,
  formatUptime,
  shortRepo,
  useToast,
} from '../components/ui';

const IN_FLIGHT = ['queued', 'cloning', 'resolving', 'building', 'starting', 'checking'];
const TABS = ['deployments', 'logs', 'environment', 'settings'] as const;
type Tab = (typeof TABS)[number];

export interface DeployHandle {
  run: (opts?: { skipEnvCheck?: boolean }) => void;
  pending: boolean;
}

export default function AppDetail() {
  const { id } = useParams();
  const appId = Number(id);
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const app = useQuery({ queryKey: ['app', appId], queryFn: () => Api.apps.get(appId), refetchInterval: 10000 });
  const a = app.data;

  const [optimistic, setOptimistic] = useState<string | null>(null);

  const deploy = useMutation({
    mutationFn: (opts: { skipEnvCheck?: boolean } = {}) => Api.apps.deploy(appId, opts),
    onSuccess: ({ deploymentId }) => {
      // an optimistic queued row means the history never looks empty after a click
      qc.setQueryData<Deployment[]>(['deployments', appId], (old) => {
        if (!old || old.some((d) => d.id === deploymentId)) return old;
        const stub: Deployment = {
          id: deploymentId,
          appId,
          status: 'queued',
          failedStage: null,
          error: null,
          trigger: 'manual',
          commitSha: null,
          commitMsg: null,
          imageTag: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
          config: null,
          envMissing: null,
          envSchema: null,
        };
        return [stub, ...old];
      });
      qc.invalidateQueries({ queryKey: ['deployments', appId] });
      qc.invalidateQueries({ queryKey: ['app', appId] });
      setParams({ tab: 'deployments', dep: String(deploymentId) });
      toast({ title: 'Deployment queued', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not start the deployment', description: (e as Error).message, variant: 'error' }),
  });

  const action = useMutation({
    mutationFn: (act: 'start' | 'stop' | 'restart') => Api.apps.action(appId, act),
    onMutate: (act) => {
      setOptimistic(act === 'stop' ? 'stopped' : 'live');
    },
    onError: (e) => {
      setOptimistic(null);
      toast({ title: 'Action failed', description: (e as Error).message, variant: 'error' });
    },
    onSuccess: (_r, act) => {
      toast({ title: act === 'stop' ? 'Container stopped' : act === 'start' ? 'Container started' : 'Container restarted', variant: 'success' });
    },
    onSettled: () => {
      setOptimistic(null);
      qc.invalidateQueries({ queryKey: ['app', appId] });
    },
  });

  const isWorker = !!a?.isWorker;
  const rawTab = params.get('tab');
  const defaultTab: Tab = isWorker && a?.status === 'live' ? 'logs' : 'deployments';
  const tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : defaultTab;

  // a deployment that stopped at needs_env is waiting on the user — land them where they can act
  const autoSwitched = useRef(false);
  useEffect(() => {
    if (autoSwitched.current || !a) return;
    if (rawTab) {
      autoSwitched.current = true;
      return;
    }
    if (a.lastDeployment?.status === 'needs_env') {
      autoSwitched.current = true;
      setParams({ tab: 'environment' }, { replace: true });
    }
  }, [a, rawTab, setParams]);

  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });

  if (app.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (app.isError || !a) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-4 w-4" />}
        title="App not found"
        description="It may have been deleted, or the id in the URL is wrong."
        action={{ label: 'Back to apps', to: '/' }}
      />
    );
  }

  const status = optimistic ?? a.status;
  const deployHandle: DeployHandle = { run: (opts) => deploy.mutate(opts ?? {}), pending: deploy.isPending };
  const container = a.container ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Identicon name={a.name} size="lg" />
        <h1 className="max-w-full truncate text-xl font-semibold tracking-[-0.02em] text-fg">{a.name}</h1>
        <StatusBadge status={status} />
        <div className="ml-auto flex flex-1 flex-wrap items-center gap-2 sm:flex-none">
          <Button
            variant="primary"
            className="max-sm:flex-1"
            loading={deploy.isPending || status === 'deploying'}
            onClick={() => deployHandle.run()}
          >
            Deploy
          </Button>
          {status === 'live' && (
            <>
              <Button
                className="max-sm:flex-1"
                icon={<Restart className="h-3.5 w-3.5" />}
                loading={action.isPending && action.variables === 'restart'}
                onClick={() => action.mutate('restart')}
              >
                Restart
              </Button>
              <Button
                className="max-sm:flex-1"
                loading={action.isPending && action.variables === 'stop'}
                onClick={() => action.mutate('stop')}
              >
                Stop
              </Button>
            </>
          )}
          {status === 'stopped' && (
            <Button
              className="max-sm:flex-1"
              loading={action.isPending && action.variables === 'start'}
              onClick={() => action.mutate('start')}
            >
              Start
            </Button>
          )}
          {!isWorker && a.url && (
            <ButtonLink
              href={a.url}
              target="_blank"
              className="max-sm:flex-1"
              iconRight={<ExternalLink className="h-3.5 w-3.5" />}
            >
              Visit
            </ButtonLink>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {isWorker ? (
          <span className="flex min-w-0 items-center gap-2">
            <Chip tone="neutral" size="sm">
              worker
            </Chip>
            <Terminal className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <ProcessLine container={container} status={status} />
            <button
              type="button"
              onClick={() => setTab('logs')}
              className="rounded-sm text-xs text-accent-fg underline-offset-2 hover:underline"
            >
              View logs
            </button>
          </span>
        ) : a.effectiveHost ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <a
              href={a.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate font-mono text-accent-fg underline-offset-2 hover:underline"
            >
              {a.effectiveHost}
            </a>
            <CopyButton value={a.url ?? a.effectiveHost} title="Copy URL" />
          </span>
        ) : null}

        <span className="flex min-w-0 items-center gap-1.5 text-fg-subtle">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
          <a
            href={a.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate font-mono underline-offset-2 hover:text-fg hover:underline"
          >
            {shortRepo(a.repoUrl)}
          </a>
          {a.branch && (
            <Chip mono size="sm">
              {a.branch}
            </Chip>
          )}
        </span>

        {a.lastDeployment && (
          <span className="flex items-center gap-1.5 text-fg-subtle">
            Deployed <RelativeTime iso={a.lastDeployment.finishedAt ?? a.lastDeployment.createdAt} />
          </span>
        )}
      </div>

      {a.httpUp === false && status === 'live' && (
        <Card tone="warn" padding="sm" className="mt-4">
          <span className="flex items-center gap-2 text-xs text-warn-fg">
            <AlertTriangle className="h-3.5 w-3.5" />
            The container is running but the app is not answering — check the logs.
          </span>
        </Card>
      )}

      {status === 'live' && <MetricsStrip app={a} />}

      {/* once the variables are filled in the banner has nothing left to ask for */}
      {a.lastDeployment?.status === 'needs_env' && !a.envStatus?.satisfied && (
        <NeedsEnvBanner app={a} deploy={deployHandle} onFillIn={() => setTab('environment')} className="mt-5" />
      )}

      <Tabs
        className="mt-6"
        ariaLabel="App sections"
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        items={[
          { value: 'deployments', label: 'Deployments' },
          { value: 'logs', label: isWorker ? 'Process logs' : 'Logs' },
          {
            value: 'environment',
            label: 'Environment',
            count: a.envStatus && !a.envStatus.satisfied ? a.envStatus.missingCount : undefined,
          },
          { value: 'settings', label: 'Settings' },
        ]}
      />

      <div className="mt-5">
        {tab === 'deployments' && <DeploymentsTab app={a} deploy={deployHandle} />}
        {tab === 'logs' && <RuntimeLogsTab app={a} deploy={deployHandle} status={status} />}
        {tab === 'environment' && <EnvTab app={a} deploy={deployHandle} />}
        {tab === 'settings' && <SettingsTab app={a} onDeleted={() => navigate('/')} />}
      </div>
    </div>
  );
}

function ProcessLine({ container, status }: { container: App['container']; status: string }) {
  if (!container) {
    return <span className="font-mono text-xs text-fg-subtle">{status === 'live' ? 'running' : 'not running'}</span>;
  }
  if (container.running) {
    const bits = [formatUptime(container.startedAt) ?? 'running'];
    if (container.restartCount > 0) bits.push(`${container.restartCount} restart${container.restartCount === 1 ? '' : 's'}`);
    return (
      <span
        className={cn('font-mono text-xs', container.restartCount > 0 ? 'text-warn-fg' : 'text-fg-subtle')}
      >
        running · {bits.join(' · ')}
      </span>
    );
  }
  return (
    <span className="font-mono text-xs text-danger-fg">
      {container.oomKilled ? 'out of memory' : 'exited'}
      {container.exitCode != null ? ` (code ${container.exitCode})` : ''}
      {container.finishedAt ? ' · ' : ''}
      {container.finishedAt && <RelativeTime iso={container.finishedAt} />}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * needs_env — informational, never a failure
 * ------------------------------------------------------------------ */

function NeedsEnvBanner({
  app,
  deploy,
  onFillIn,
  className,
}: {
  app: App;
  deploy: DeployHandle;
  onFillIn: () => void;
  className?: string;
}) {
  const missing = app.envStatus?.missingCount ?? app.lastDeployment?.envMissingCount ?? 0;
  const file = app.envStatus?.file ?? '.env.example';
  return (
    <Card tone="info" padding="md" className={className}>
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-info-fg" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">This app needs its environment variables</div>
          <p className="mt-1 text-xs text-fg-subtle">
            <span className="font-mono">{file}</span> lists {missing} required variable{missing === 1 ? '' : 's'} that
            are not set yet. Nothing was built.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" onClick={onFillIn}>
              Fill them in
            </Button>
            <Button variant="ghost" loading={deploy.pending} onClick={() => deploy.run({ skipEnvCheck: true })}>
              Deploy anyway
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * deployments
 * ------------------------------------------------------------------ */

function DeploymentsTab({ app, deploy }: { app: App; deploy: DeployHandle }) {
  const [params, setParams] = useSearchParams();
  const deployments = useQuery({
    queryKey: ['deployments', app.id],
    queryFn: () => Api.deployments.list(app.id),
    refetchInterval: 5000,
  });

  const list = deployments.data ?? [];
  const selectedId = params.get('dep') ? Number(params.get('dep')) : (list[0]?.id ?? null);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card padding="none" className="max-h-72 overflow-auto scroll-thin lg:max-h-[calc(100vh-19rem)]">
        {deployments.isPending && (
          <div className="divide-y divide-border-subtle">
            {Array.from({ length: 5 }, (_, i) => (
              <DeploymentRowSkeleton key={i} />
            ))}
          </div>
        )}

        {deployments.data && list.length === 0 && (
          <div className="p-6 text-center">
            <p className="text-sm font-medium text-fg">No deployments yet</p>
            <p className="mt-1 text-xs text-fg-subtle">Push a commit or deploy the current HEAD.</p>
            <div className="mt-4">
              <Button variant="primary" loading={deploy.pending} onClick={() => deploy.run()}>
                Deploy now
              </Button>
            </div>
          </div>
        )}

        <div className="divide-y divide-border-subtle">
          {list.map((d) => {
            const selected = selectedId === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setParams({ tab: 'deployments', dep: String(d.id) }, { replace: true })}
                className={cn(
                  'relative w-full px-3 py-2.5 text-left transition-ui hover:bg-white/[0.03]',
                  selected &&
                    'bg-white/[0.045] before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-fg'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusBadge status={d.status} size="sm" />
                  <span className="font-mono text-xs text-fg-subtle">#{d.id}</span>
                  <Duration from={d.startedAt ?? d.createdAt} to={d.finishedAt} className="ml-auto text-xs" />
                </div>
                <div className="mt-1.5 min-w-0">
                  <CommitRef sha={d.commitSha} msg={d.commitMsg} trigger={d.trigger} />
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2">
                  {d.commitSha && (
                    <Chip size="sm" tone="neutral">
                      {d.trigger}
                    </Chip>
                  )}
                  <RelativeTime iso={d.createdAt} className="ml-auto text-xs text-fg-faint" />
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="min-w-0">
        {selectedId ? (
          <DeploymentPane
            key={selectedId}
            deploymentId={selectedId}
            deploy={deploy}
            activeDeploymentId={app.activeDeploymentId}
            onRollback={(newId) => setParams({ tab: 'deployments', dep: String(newId) }, { replace: true })}
          />
        ) : (
          !deployments.isPending && <p className="text-sm text-fg-subtle">Select a deployment to see its output.</p>
        )}
      </div>
    </div>
  );
}

function DeploymentPane({
  deploymentId,
  deploy,
  activeDeploymentId,
  onRollback,
}: {
  deploymentId: number;
  deploy: DeployHandle;
  activeDeploymentId: number | null;
  onRollback: (newDeploymentId: number) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const dep = useQuery({ queryKey: ['deployment', deploymentId], queryFn: () => Api.deployments.get(deploymentId) });
  const [lines, setLines] = useState<string[]>([]);
  const [showConfig, setShowConfig] = useState(false);
  const status = dep.data?.status;
  const inFlight = !!status && IN_FLIGHT.includes(status);
  const streamedRef = useRef(false);

  // live stream while in flight (replay + follow); static fetch once finished
  useSSE(inFlight ? `/api/deployments/${deploymentId}/logstream` : null, {
    log: (d: { text: string }) => {
      streamedRef.current = true;
      setLines((prev) => [...prev, d.text]);
    },
    end: (_d, es) => {
      es.close();
      qc.invalidateQueries({ queryKey: ['deployment', deploymentId] });
      qc.invalidateQueries({ queryKey: ['deployments'] });
    },
  });

  useEffect(() => {
    if (!inFlight && status && !streamedRef.current) {
      Api.deployments.log(deploymentId).then((text) => setLines(text ? text.split('\n') : []));
    }
  }, [inFlight, status, deploymentId]);

  const cancel = useMutation({
    mutationFn: () => Api.deployments.cancel(deploymentId),
    onSuccess: () => toast({ title: 'Deployment canceled', variant: 'info' }),
    onError: (e) => toast({ title: 'Could not cancel', description: (e as Error).message, variant: 'error' }),
  });

  const [confirmRollback, setConfirmRollback] = useState(false);
  const rollback = useMutation({
    mutationFn: () => Api.deployments.rollback(deploymentId),
    onSuccess: ({ deploymentId: newId }) => {
      qc.invalidateQueries({ queryKey: ['deployments'] });
      toast({ title: 'Rollback queued', description: 'Re-running the retained image — no rebuild needed.', variant: 'success' });
      onRollback(newId);
    },
    onError: (e) => toast({ title: 'Could not roll back', description: (e as Error).message, variant: 'error' }),
  });

  const d = dep.data;
  const needsEnv = d?.status === 'needs_env';
  const missing = useMemo(() => (needsEnv ? detectRequiredEnv(d) : []), [needsEnv, d]);
  const canRollback = !!d?.imageTag && !inFlight && !needsEnv && deploymentId !== activeDeploymentId;

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-fg">Deployment #{deploymentId}</span>
        {d && <StatusBadge status={d.status} />}
        {d && <Duration from={d.startedAt ?? d.createdAt} to={d.finishedAt} className="text-xs" />}
        {d?.imageTag && (
          <span className="flex min-w-0 items-center gap-1">
            <Chip mono size="sm" title={d.imageTag} className="max-w-[16rem] truncate">
              {d.imageTag}
            </Chip>
            <CopyButton value={d.imageTag} title="Copy image tag" />
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {d?.config && (
            <Button variant="ghost" size="sm" onClick={() => setShowConfig((v) => !v)}>
              <ChevronRight className={cn('h-3.5 w-3.5 transition-ui', showConfig && 'rotate-90')} />
              Resolved config
            </Button>
          )}
          {canRollback && (
            <Button variant="ghost" size="sm" loading={rollback.isPending} onClick={() => setConfirmRollback(true)}>
              <Restart className="h-3.5 w-3.5" />
              Rollback
            </Button>
          )}
          {inFlight && (
            <Button variant="danger" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmRollback}
        title={`Roll back to deployment #${deploymentId}?`}
        body={`Traffic switches to the retained image ${d?.imageTag ?? ''} after it passes its health check — the current version keeps serving until then. No rebuild happens.`}
        confirmLabel="Roll back"
        onConfirm={() => {
          setConfirmRollback(false);
          rollback.mutate();
        }}
        onCancel={() => setConfirmRollback(false)}
      />

      {needsEnv && (
        <Card tone="info" padding="md" className="mb-3">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-info-fg" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg">Waiting for environment variables</div>
              <p className="mt-1 text-xs text-fg-subtle">
                Nothing was built or changed. Fill these in on the Environment tab and deploy again.
              </p>
              {missing.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {missing.map((m) => (
                    <li key={m.key} className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs">
                      <span className="font-mono text-fg">{m.key}</span>
                      {m.description && <span className="min-w-0 text-fg-subtle">{m.description}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3">
                <Button variant="ghost" size="sm" loading={deploy.pending} onClick={() => deploy.run({ skipEnvCheck: true })}>
                  Deploy anyway
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {!needsEnv && d && (d.failedStage || d.error) && (
        <Card tone="danger" padding="sm" className="mb-3">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-danger-fg">
                Failed at
                {d.failedStage && (
                  <Chip tone="danger" size="sm">
                    {d.failedStage}
                  </Chip>
                )}
              </div>
              {d.error && <p className="mt-1.5 font-mono text-xs break-all text-fg-muted">{d.error}</p>}
            </div>
            {d.error && <CopyButton value={d.error} title="Copy error" />}
          </div>
        </Card>
      )}

      {showConfig && d?.config && <ConfigPanel config={d.config} className="mb-3" />}

      <LogViewer
        lines={lines}
        live={inFlight}
        filename={`deploy-${deploymentId}.log`}
        ariaLabel={`Build log for deployment ${deploymentId}`}
        className="h-[clamp(320px,calc(100vh-24rem),640px)]"
      />
    </div>
  );
}

function ConfigPanel({ config, className }: { config: ResolvedConfig; className?: string }) {
  const rows = [
    { key: 'type', value: config.type as string | number | null, source: config.sources.type },
    { key: 'builder', value: config.builder, source: undefined },
    { key: 'port', value: config.containerPort, source: config.sources.port },
    { key: 'domain', value: config.domainHost, source: config.sources.domain },
    { key: 'build', value: config.buildCmd, source: config.sources.build },
    { key: 'start', value: config.startCmd, source: config.sources.start },
    { key: 'health', value: config.healthPath, source: config.sources.health },
    { key: 'dockerfile', value: config.dockerfilePath, source: config.sources.dockerfile },
  ].filter((r) => r.value != null && r.value !== '');

  return (
    <Card padding="none" className={className}>
      {config.typeReason && (
        <div className="border-b border-border-subtle px-4 py-3">
          <SectionLabel>Why {config.type}</SectionLabel>
          <p className="mt-1.5 text-xs text-fg-muted">{config.typeReason}</p>
          {config.webEvidence && (
            <p className="mt-1 font-mono text-xs text-fg-subtle">evidence: {config.webEvidence}</p>
          )}
        </div>
      )}
      <CardBody>
        <KeyValue
          rows={rows.map((r) => ({
            label: r.key,
            value: String(r.value),
            copy: String(r.value),
            chip: <SourceChip source={r.source ?? 'auto'} />,
          }))}
        />
        {config.notes.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-border-subtle pt-3">
            {config.notes.map((n, i) => (
              <li key={i} className="flex gap-2 text-xs text-fg-subtle">
                <span aria-hidden className="text-fg-faint">
                  •
                </span>
                <span className="min-w-0">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * runtime logs
 * ------------------------------------------------------------------ */

function RuntimeLogsTab({ app, deploy, status }: { app: App; deploy: DeployHandle; status: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [query, setQuery] = useState('');
  const canStream = !!app.activeDeploymentId;
  const action = useMutation({ mutationFn: () => Api.apps.action(app.id, 'restart') });

  useSSE(canStream && mode === 'live' ? `/api/apps/${app.id}/logs/stream` : null, {
    log: (d: { text: string }) =>
      setLines((prev) => (prev.length > 5000 ? [...prev.slice(-4000), d.text] : [...prev, d.text])),
    end: (_d, es) => es.close(),
  });

  const history = useQuery({
    queryKey: ['logs-history', app.id, query],
    queryFn: () => Api.apps.logsHistory(app.id, query),
    enabled: mode === 'history',
    placeholderData: (prev) => prev,
  });

  if (!canStream) {
    return (
      <EmptyState
        icon={<Terminal className="h-4 w-4" />}
        title="No running container"
        description="Deploy this app to start streaming its output."
        action={{ label: 'Deploy', onClick: () => deploy.run(), loading: deploy.pending }}
      />
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs
          ariaLabel="Log mode"
          value={mode}
          onChange={(v) => setMode(v as 'live' | 'history')}
          items={[
            { value: 'live', label: 'Live' },
            { value: 'history', label: 'History' },
          ]}
        />
        {mode === 'live' ? (
          <span className="flex items-center gap-2 text-xs text-fg-subtle">
            <StatusDot status="live" />
            Following container logs · last 200 lines
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Input
              aria-label="Search log history"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search collected logs… (empty = newest first)"
              className="max-w-72"
            />
            {history.data && (
              <span className="text-xs text-fg-faint">
                {history.data.lines.length} line(s) · {formatBytes(history.data.scannedBytes)} scanned
              </span>
            )}
          </span>
        )}
        {app.isWorker && (
          <span className="flex items-center gap-2">
            <Chip tone={app.container?.running ? 'success' : 'neutral'} size="sm">
              {app.container?.running ? 'running' : 'exited'}
            </Chip>
            <ProcessLine container={app.container ?? null} status={status} />
            <Button
              variant="ghost"
              size="sm"
              icon={<Restart className="h-3.5 w-3.5" />}
              loading={action.isPending}
              onClick={() => action.mutate()}
            >
              Restart
            </Button>
          </span>
        )}
      </div>
      <LogViewer
        lines={mode === 'live' ? lines : (history.data?.lines ?? [])}
        live={mode === 'live'}
        filename={`${app.name}.log`}
        ariaLabel={`Runtime logs for ${app.name}`}
        onClear={mode === 'live' ? () => setLines([]) : undefined}
        className="h-[clamp(360px,calc(100vh-20rem),720px)]"
      />
    </div>
  );
}

/** Live CPU/memory strip for the app header — 30s docker-stats samples. */
function MetricsStrip({ app }: { app: App }) {
  const metrics = useQuery({
    queryKey: ['metrics', app.id],
    queryFn: () => Api.apps.metrics(app.id, '1h'),
    refetchInterval: 30_000,
  });
  const points = metrics.data?.points ?? [];
  if (points.length < 2) return null;
  const cpu = points.map((p) => p.cpuPct);
  const mem = points.map((p) => p.memBytes);
  const lastCpu = cpu[cpu.length - 1];
  const lastMem = mem[mem.length - 1];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-2">
      <span className="flex items-center gap-2.5">
        <Sparkline values={cpu} />
        <span className="text-xs text-fg-subtle">
          CPU <span className="tnum font-medium text-fg">{lastCpu.toFixed(1)}%</span>
        </span>
      </span>
      <span className="flex items-center gap-2.5">
        <Sparkline values={mem} stroke="var(--color-success-fg)" />
        <span className="text-xs text-fg-subtle">
          Mem <span className="tnum font-medium text-fg">{formatBytes(lastMem)}</span>
          {app.memoryLimit && <span className="text-fg-faint"> / {app.memoryLimit}</span>}
        </span>
      </span>
      <span className="text-2xs text-fg-faint">last hour</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * environment
 * ------------------------------------------------------------------ */

interface EnvRow {
  key: string;
  value: string;
}

function EnvTab({ app, deploy }: { app: App; deploy: DeployHandle }) {
  const qc = useQueryClient();
  const toast = useToast();
  const env = useQuery({ queryKey: ['env', app.id], queryFn: () => Api.env.get(app.id) });
  const schemaQ = useQuery({ queryKey: ['envSchema', app.id], queryFn: () => Api.apps.envSchema(app.id) });

  const [rows, setRows] = useState<EnvRow[] | null>(null);
  const [mode, setMode] = useState<'rows' | 'env'>('rows');
  const [bulkText, setBulkText] = useState('');
  const [showOptional, setShowOptional] = useState(false);

  const server = env.data ?? [];
  const current = rows ?? server;
  const dirty = rows !== null;
  const schema = schemaQ.data?.schema ?? null;
  const skipEnvCheck = schemaQ.data?.skipEnvCheck ?? app.skipEnvCheck;

  const setValue = (key: string, value: string) =>
    setRows((prev) => {
      const base = prev ?? server;
      const i = base.findIndex((r) => r.key === key);
      if (i === -1) return [...base, { key, value }];
      return base.map((r, j) => (j === i ? { ...r, value } : r));
    });

  const valueOf = (key: string) => current.find((r) => r.key === key)?.value ?? '';

  const save = useMutation({
    mutationFn: (vars: EnvRow[]) => Api.env.put(app.id, vars),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['env', app.id] });
      qc.invalidateQueries({ queryKey: ['envSchema', app.id] });
      qc.invalidateQueries({ queryKey: ['app', app.id] });
      setRows(null);
      toast({
        title: 'Environment saved',
        description: res.envSatisfied ? undefined : `${res.missingKeys.length} required variable(s) still unset.`,
        variant: 'success',
        action: res.redeployRequired ? { label: 'Redeploy', onClick: () => deploy.run() } : undefined,
      });
    },
    onError: (e) => toast({ title: 'Could not save', description: (e as Error).message, variant: 'error' }),
  });

  const toggleSkip = useMutation({
    mutationFn: (next: boolean) => Api.apps.patch(app.id, { skipEnvCheck: next }),
    onSuccess: (_r, next) => {
      qc.invalidateQueries({ queryKey: ['app', app.id] });
      qc.invalidateQueries({ queryKey: ['envSchema', app.id] });
      toast({ title: next ? 'We will stop asking for this app' : 'Env check re-enabled', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not update', description: (e as Error).message, variant: 'error' }),
  });

  const applyBulk = () => {
    const parsed: EnvRow[] = [];
    for (const line of bulkText.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      parsed.push({ key: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim().replace(/^["']|["']$/g, '') });
    }
    setRows(parsed);
    setMode('rows');
  };

  const schemaKeys = useMemo(() => new Set(schema?.vars.map((v) => v.key) ?? []), [schema]);
  const extraIdx = current.map((r, i) => (schemaKeys.has(r.key) ? -1 : i)).filter((i) => i >= 0);
  const requiredVars = schema?.vars.filter((v) => v.required) ?? [];
  const optionalVars = schema?.vars.filter((v) => !v.required) ?? [];
  const missingKeys = requiredVars.filter((v) => valueOf(v.key) === '').map((v) => v.key);
  const satisfied = missingKeys.length === 0;

  if (env.isPending || schemaQ.isPending) {
    return (
      <div className="max-w-form space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <EnvRowSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-form space-y-4">
      {schema && (
        <Card padding="none">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>This repo expects these variables</CardTitle>
              <CardDescription>
                {requiredVars.length - missingKeys.length} of {requiredVars.length} required variables set — from{' '}
                <span className="font-mono">{schema.file}</span>
                {schemaQ.data?.detectedAt && (
                  <>
                    , detected <RelativeTime iso={schemaQ.data.detectedAt} />
                  </>
                )}
                .
              </CardDescription>
            </div>
            {satisfied && (
              <Chip tone="success" size="sm">
                all set
              </Chip>
            )}
          </CardHeader>

          <CardBody className="space-y-4">
            {requiredVars.length === 0 && (
              <p className="text-xs text-fg-subtle">
                Nothing is strictly required — every variable in {schema.file} has a usable default.
              </p>
            )}
            {groupVars(requiredVars).map(([group, vars]) => (
              <div key={group ?? '_'} className="space-y-3">
                {group && <SectionLabel>{group}</SectionLabel>}
                {vars.map((v, i) => (
                  <SchemaField
                    key={v.key}
                    spec={v}
                    value={valueOf(v.key)}
                    missing={valueOf(v.key) === ''}
                    autoFocus={i === 0 && group === null && missingKeys[0] === v.key}
                    onChange={(val) => setValue(v.key, val)}
                  />
                ))}
              </div>
            ))}

            {optionalVars.length > 0 && (
              <div className="border-t border-border-subtle pt-3">
                <button
                  type="button"
                  onClick={() => setShowOptional((v) => !v)}
                  aria-expanded={showOptional}
                  className="flex items-center gap-2 text-xs text-fg-subtle transition-ui hover:text-fg"
                >
                  <ChevronRight className={cn('h-3.5 w-3.5 transition-ui', showOptional && 'rotate-90')} />
                  {showOptional ? 'Hide' : 'Show'} {optionalVars.length} optional variable
                  {optionalVars.length === 1 ? '' : 's'}
                </button>
                {showOptional && (
                  <div className="mt-3 space-y-4">
                    {groupVars(optionalVars).map(([group, vars]) => (
                      <div key={group ?? '_'} className="space-y-3">
                        {group && <SectionLabel>{group}</SectionLabel>}
                        {vars.map((v) => (
                          <SchemaField
                            key={v.key}
                            spec={v}
                            value={valueOf(v.key)}
                            missing={false}
                            onChange={(val) => setValue(v.key, val)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardBody>

          <CardFooter>
            <div className="mr-auto min-w-0">
              <SkipToggle
                checked={skipEnvCheck}
                pending={toggleSkip.isPending}
                onChange={(next) => toggleSkip.mutate(next)}
              />
            </div>
            {satisfied && app.lastDeployment?.status === 'needs_env' && !dirty && (
              <Button variant="primary" loading={deploy.pending} onClick={() => deploy.run()}>
                Deploy now
              </Button>
            )}
          </CardFooter>
        </Card>
      )}

      <Card padding="none">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>{schema ? 'Extra variables' : 'Environment Variables'}</CardTitle>
            <CardDescription>
              {schema
                ? `Anything not declared in ${schema.file}. Injected into the container at deploy time.`
                : 'Injected into the container at deploy time. PORT is set automatically.'}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-md border border-border p-0.5">
            <SegButton active={mode === 'rows'} onClick={() => setMode('rows')}>
              Rows
            </SegButton>
            <SegButton
              active={mode === 'env'}
              onClick={() => {
                setBulkText(current.map((r) => `${r.key}=${r.value}`).join('\n'));
                setMode('env');
              }}
            >
              .env
            </SegButton>
          </div>
        </CardHeader>

        <CardBody className="space-y-2">
          {!schema && schemaQ.data && (
            <p className="text-xs text-fg-faint">No .env.example found in this repo.</p>
          )}

          {mode === 'env' ? (
            <div>
              <Textarea
                mono
                rows={14}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={'KEY=value\nANOTHER=value'}
              />
              <p className="mt-1.5 text-xs text-fg-subtle"># comments and quoted values are handled.</p>
              <div className="mt-2 flex justify-end">
                <Button onClick={applyBulk}>Apply</Button>
              </div>
            </div>
          ) : (
            <>
              {(schema ? extraIdx : current.map((_, i) => i)).map((i) => {
                const row = current[i]!;
                return (
                  <div
                    key={i}
                    className="group grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-2 sm:grid-cols-[minmax(120px,200px)_minmax(0,1fr)_2rem]"
                  >
                    <Input
                      mono
                      value={row.key}
                      placeholder="KEY"
                      spellCheck={false}
                      aria-label="Variable name"
                      onChange={(e) => setRows(current.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    />
                    <div className="max-sm:col-span-2">
                      <SecretInput
                        mono
                        value={row.value}
                        placeholder="value"
                        onChange={(v) => setRows(current.map((r, j) => (j === i ? { ...r, value: v } : r)))}
                      />
                    </div>
                    <IconButton
                      title={`Remove ${row.key || 'variable'}`}
                      size="sm"
                      className="opacity-0 transition-ui group-hover:opacity-100 group-focus-within:opacity-100 max-sm:h-10 max-sm:opacity-100"
                      onClick={() => setRows(current.filter((_, j) => j !== i))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                );
              })}
              {(schema ? extraIdx.length : current.length) === 0 && (
                <p className="text-xs text-fg-faint">None yet.</p>
              )}
              <Button
                variant="ghost"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setRows([...current, { key: '', value: '' }])}
              >
                Add Variable
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      {dirty && (
        <div className="sticky bottom-4 flex items-center gap-3 rounded-lg border border-border-strong bg-surface-3/90 px-4 py-2.5 shadow-lg backdrop-blur animate-pop">
          <span className="text-xs text-fg-subtle">Unsaved changes</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={() => setRows(null)}>
              Discard
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => save.mutate(current.filter((r) => r.key.trim() !== ''))}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function groupVars(vars: EnvVarSpec[]): [string | null, EnvVarSpec[]][] {
  const out: [string | null, EnvVarSpec[]][] = [];
  for (const v of vars) {
    const g = v.group ?? null;
    const last = out.find(([name]) => name === g);
    if (last) last[1].push(v);
    else out.push([g, [v]]);
  }
  // ungrouped first, then file order
  return out.sort((a, b) => (a[0] === null ? -1 : b[0] === null ? 1 : 0));
}

function SchemaField({
  spec,
  value,
  missing,
  autoFocus,
  onChange,
}: {
  spec: EnvVarSpec;
  value: string;
  missing: boolean;
  autoFocus?: boolean;
  onChange: (v: string) => void;
}) {
  const set = value !== '';
  return (
    <div className={cn('border-l-2 pl-3', missing ? 'border-danger-br' : set ? 'border-success-br' : 'border-border')}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-fg">{spec.key}</span>
        {spec.required && (
          <span aria-label="required" className="text-fg-faint">
            *
          </span>
        )}
        {set && <Check className="h-3.5 w-3.5 text-success-fg" />}
        {spec.commentedOut && <span className="text-2xs text-fg-faint">(commented out in the example file)</span>}
      </div>
      {spec.secret ? (
        <SecretInput
          mono
          autoFocus={autoFocus}
          value={value}
          placeholder={spec.example ?? ''}
          onChange={onChange}
          invalid={missing}
        />
      ) : (
        <Input
          mono
          autoFocus={autoFocus}
          value={value}
          placeholder={spec.example ?? ''}
          spellCheck={false}
          invalid={missing}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {spec.description && <p className="mt-1.5 text-xs text-fg-subtle">{spec.description}</p>}
    </div>
  );
}

function SkipToggle({
  checked,
  pending,
  onChange,
}: {
  checked: boolean;
  pending: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={pending}
      onClick={() => onChange(!checked)}
      className="flex min-w-0 items-center gap-2 text-left text-xs text-fg-subtle transition-ui hover:text-fg"
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-ui',
          checked ? 'border-border-strong bg-accent/60' : 'border-border bg-surface-2'
        )}
      >
        <span
          className={cn(
            'absolute h-2.5 w-2.5 rounded-full bg-fg transition-ui',
            checked ? 'left-[15px]' : 'left-[3px]'
          )}
        />
      </span>
      <span className="min-w-0">Skip the .env.example check — deploy even when required variables are missing</span>
    </button>
  );
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-6 rounded-sm px-2 text-xs font-medium transition-ui',
        active ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg'
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

function SettingsTab({ app, onDeleted }: { app: App; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const deployments = useQuery({
    queryKey: ['deployments', app.id],
    queryFn: () => Api.deployments.list(app.id),
    refetchInterval: 5000,
  });
  const cfg = deployments.data?.find((d) => d.config)?.config ?? null;

  const initial = useMemo(
    () => ({
      repoUrl: app.repoUrl,
      branch: app.branch,
      type: app.type ?? '',
      port: app.port ? String(app.port) : '',
      domain: app.domain ?? '',
      buildCmd: app.buildCmd ?? '',
      startCmd: app.startCmd ?? '',
      healthPath: app.healthPath ?? '',
      dockerfilePath: app.dockerfilePath ?? '',
      rootDir: app.rootDir ?? '',
      memoryLimit: app.memoryLimit ?? '',
      releaseCmd: app.releaseCmd ?? '',
      volumes: (app.volumes ?? []).map((v) => ({ ...v })),
      gitToken: '',
    }),
    [app]
  );

  const [form, setForm] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const isWorker = (form.type || app.effectiveType) === 'worker';

  const set = (k: Exclude<keyof typeof form, 'volumes'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const setVolume = (i: number, key: 'name' | 'path', value: string) =>
    setForm({ ...form, volumes: form.volumes.map((v, j) => (j === i ? { ...v, [key]: value } : v)) });

  const save = useMutation({
    mutationFn: () =>
      Api.apps.patch(app.id, {
        repoUrl: form.repoUrl.trim(),
        branch: form.branch.trim(),
        type: form.type || null,
        port: form.port ? parseInt(form.port, 10) : null,
        domain: form.domain.trim() || null,
        buildCmd: form.buildCmd.trim() || null,
        startCmd: form.startCmd.trim() || null,
        healthPath: form.healthPath.trim() || null,
        dockerfilePath: form.dockerfilePath.trim() || null,
        rootDir: form.rootDir.trim() || null,
        memoryLimit: form.memoryLimit.trim() || null,
        releaseCmd: form.releaseCmd.trim() || null,
        volumes: form.volumes.filter((v) => v.name.trim() && v.path.trim()),
        ...(form.gitToken.trim() !== '' ? { gitToken: form.gitToken.trim() } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', app.id] });
      setForm((f) => ({ ...f, gitToken: '' }));
      toast({
        title: 'Settings saved — applies on the next deploy',
        variant: 'success',
        action: { label: 'Deploy now', onClick: () => Api.apps.deploy(app.id, {}).then(() => qc.invalidateQueries({ queryKey: ['deployments', app.id] })) },
      });
    },
    onError: (e) => toast({ title: 'Could not save settings', description: (e as Error).message, variant: 'error' }),
  });

  const remove = useMutation({
    mutationFn: () => Api.apps.remove(app.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      toast({ title: `${app.name} deleted`, variant: 'success' });
      onDeleted();
    },
    onError: (e) => toast({ title: 'Could not delete', description: (e as Error).message, variant: 'error' }),
  });

  const autoHint = (v: string | null | undefined) => (v ? `auto: ${v}` : undefined);

  return (
    <div className="max-w-form space-y-4">
      <Card padding="none">
        <CardHeader>
          <div>
            <CardTitle>Source</CardTitle>
            <CardDescription>Where the code comes from.</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Repository URL" htmlFor="s-repo">
              <Input id="s-repo" value={form.repoUrl} onChange={set('repoUrl')} spellCheck={false} />
            </Field>
          </div>
          <Field label="Branch" htmlFor="s-branch" hint="Empty = default branch.">
            <Input id="s-branch" value={form.branch} onChange={set('branch')} spellCheck={false} />
          </Field>
          <Field label="Root directory" htmlFor="s-root" hint="Monorepos: build from this subfolder.">
            <Input id="s-root" value={form.rootDir} onChange={set('rootDir')} placeholder="apps/web" spellCheck={false} />
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="Git token"
              hint={app.hasGitToken ? 'A token is set — enter a new one to replace it.' : 'For private repos.'}
            >
              <SecretInput
                value={form.gitToken}
                isSet={app.hasGitToken}
                onChange={(v) => setForm({ ...form, gitToken: v })}
                placeholder="ghp_…"
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card padding="none">
        <CardHeader>
          <div>
            <CardTitle>Build &amp; Run</CardTitle>
            <CardDescription>Overrides for what detection resolved on the last deploy.</CardDescription>
          </div>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
          <Field
            label="Type"
            htmlFor="s-type"
            hint={app.type ? 'Explicitly set in the dashboard.' : `Auto-detection decides — currently ${app.effectiveType ?? 'unresolved'}.`}
          >
            <Select id="s-type" value={form.type} onChange={set('type')}>
              <option value="">
                {app.effectiveType && !app.type ? `auto (detected: ${app.effectiveType})` : 'auto'}
              </option>
              <option value="web">web</option>
              <option value="static">static</option>
              <option value="worker">worker</option>
            </Select>
          </Field>
          <Field label="Memory limit" htmlFor="s-mem" hint="e.g. 512m — empty = unlimited.">
            <Input id="s-mem" mono value={form.memoryLimit} onChange={set('memoryLimit')} placeholder="512m" />
          </Field>
          <Field label="Build command" htmlFor="s-build" hint={autoHint(cfg?.buildCmd) ?? 'Overrides the detected build.'}>
            <Input id="s-build" mono value={form.buildCmd} onChange={set('buildCmd')} placeholder={cfg?.buildCmd ?? 'npm run build'} spellCheck={false} />
          </Field>
          <Field label="Start command" htmlFor="s-start" hint={autoHint(cfg?.startCmd) ?? 'Overrides the detected start.'}>
            <Input id="s-start" mono value={form.startCmd} onChange={set('startCmd')} placeholder={cfg?.startCmd ?? 'node dist/server.js'} spellCheck={false} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Dockerfile path" htmlFor="s-dockerfile" hint="Force a specific Dockerfile.">
              <Input id="s-dockerfile" mono value={form.dockerfilePath} onChange={set('dockerfilePath')} placeholder={cfg?.dockerfilePath ?? 'docker/Dockerfile.prod'} spellCheck={false} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card padding="none">
        <CardHeader>
          <div>
            <CardTitle>Networking</CardTitle>
            <CardDescription>How traffic reaches the container.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {isWorker ? (
            <p className="text-xs text-fg-subtle">
              Workers don't receive HTTP traffic — no port, domain, or health check.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
              <Field label="Port" htmlFor="s-port" hint={cfg ? `auto: ${cfg.containerPort}` : 'Container port.'}>
                <Input
                  id="s-port"
                  mono
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })}
                  placeholder={cfg ? String(cfg.containerPort) : 'auto'}
                />
              </Field>
              <Field label="Health check path" htmlFor="s-health" hint="Enables zero-downtime traffic gating.">
                <Input id="s-health" mono value={form.healthPath} onChange={set('healthPath')} placeholder={cfg?.healthPath ?? '/healthz'} spellCheck={false} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Custom domain" htmlFor="s-domain" hint={`Empty = ${app.name}.<base domain>`}>
                  <Input id="s-domain" mono value={form.domain} onChange={set('domain')} placeholder="app.example.com" spellCheck={false} />
                </Field>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card padding="none">
        <CardHeader>
          <CardTitle>Data &amp; releases</CardTitle>
          <CardDescription>Persistent storage and the migration step that runs before every swap.</CardDescription>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="Release command" htmlFor="s-release" hint="Runs in a one-off container after build, before traffic switches. Non-zero exit = deploy stopped, current version untouched.">
            <Input id="s-release" mono value={form.releaseCmd} onChange={set('releaseCmd')} placeholder="npx prisma migrate deploy" spellCheck={false} />
          </Field>

          <div>
            <SectionLabel>Persistent volumes</SectionLabel>
            <p className="mt-1 mb-2 text-xs text-fg-subtle">
              Named volumes that survive deploys. Apps with volumes swap stop-then-start (brief downtime) so two containers never
              share the data. Deleted with the app.
            </p>
            <div className="space-y-2">
              {form.volumes.map((v, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    mono
                    aria-label={`Volume ${i + 1} name`}
                    value={v.name}
                    onChange={(e) => setVolume(i, 'name', e.target.value.toLowerCase())}
                    placeholder="data"
                    className="w-40"
                  />
                  <Input
                    mono
                    aria-label={`Volume ${i + 1} mount path`}
                    value={v.path}
                    onChange={(e) => setVolume(i, 'path', e.target.value)}
                    placeholder="/app/data"
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setForm({ ...form, volumes: form.volumes.filter((_, j) => j !== i) })}
                    title="Remove volume"
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, volumes: [...form.volumes, { name: '', path: '' }] })}>
                <Plus className="h-3.5 w-3.5" /> Add volume
              </Button>
            </div>
          </div>

          {(app.services?.length ?? 0) > 0 && (
            <div>
              <SectionLabel>Linked databases</SectionLabel>
              <div className="mt-2 flex flex-wrap gap-2">
                {app.services!.map((s) => (
                  <Chip key={s.serviceId} size="sm">
                    {s.name} <span className="font-mono text-fg-faint">→ {s.envKey}</span>
                  </Chip>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-fg-faint">Managed on the Databases page — URLs are injected on deploy.</p>
            </div>
          )}
        </CardBody>
      </Card>

      <WebhookCard app={app} />

      {!app.parentAppId && (
        <Card padding="md">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 accent-white"
              checked={!!app.previewBranches}
              onChange={(e) =>
                Api.apps.patch(app.id, { previewBranches: e.target.checked }).then(() => {
                  qc.invalidateQueries({ queryKey: ['app', app.id] });
                  toast({ title: e.target.checked ? 'Preview deploys enabled' : 'Preview deploys disabled', variant: 'success' });
                })
              }
            />
            <span className="min-w-0">
              <span className="text-sm font-medium text-fg">Preview deploys for other branches</span>
              <span className="mt-0.5 block text-xs text-fg-subtle">
                A push to any other branch spawns <span className="font-mono">{app.name}-&lt;branch&gt;</span> with this app's settings and env.
                Volumes and databases are never shared. Deleting the branch removes the preview.
              </span>
            </span>
          </label>
        </Card>
      )}

      <Card tone="danger" padding="md">
        <h3 className="text-sm font-medium text-danger-fg">Danger zone</h3>
        <p className="mt-1 text-xs text-fg-subtle">
          Removes the app, its container, images, build logs, and env vars. The repo is untouched.
        </p>
        <div className="mt-3">
          <Button variant="danger" loading={remove.isPending} onClick={() => setConfirmDelete(true)}>
            Delete app
          </Button>
        </div>
      </Card>

      {dirty && (
        <div className="sticky bottom-4 flex items-center gap-3 rounded-lg border border-border-strong bg-surface-3/90 px-4 py-2.5 shadow-lg backdrop-blur animate-pop">
          <span className="text-xs text-fg-subtle">Unsaved changes</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={() => setForm(initial)}>
              Discard
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        tone="danger"
        title={`Delete ${app.name}?`}
        body="This stops and removes the running container, all images, deployment history, and env vars. It cannot be undone."
        confirmLabel="Delete app"
        requireTypeToConfirm={app.name}
        loading={remove.isPending}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function WebhookCard({ app }: { app: App }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);
  const regenerate = useMutation({
    mutationFn: () => Api.apps.regenerateWebhook(app.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', app.id] });
      toast({ title: 'Webhook secret regenerated', description: 'Update it in your GitHub webhook settings.', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not regenerate', description: (e as Error).message, variant: 'error' }),
  });

  const wh = app.webhook;
  if (!wh) return null;

  return (
    <Card padding="none">
      <CardHeader>
        <CardTitle>Push to deploy</CardTitle>
        <CardDescription>Every push to {app.branch || 'the default branch'} deploys automatically.</CardDescription>
      </CardHeader>
      <CardBody className="space-y-4">
        <div>
          <SectionLabel>GitHub webhook</SectionLabel>
          <p className="mt-1 text-xs text-fg-subtle">
            Repo → Settings → Webhooks → Add webhook. Content type <span className="font-mono text-fg-muted">application/json</span>, event{' '}
            <span className="font-mono text-fg-muted">push</span>.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[5rem_1fr]">
            <span className="text-xs text-fg-faint sm:pt-1.5">Payload URL</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <Chip mono size="sm" className="min-w-0 truncate" title={wh.githubUrl}>
                {wh.githubUrl}
              </Chip>
              <CopyButton value={wh.githubUrl} title="Copy payload URL" />
            </span>
            <span className="text-xs text-fg-faint sm:pt-1.5">Secret</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <Chip mono size="sm" className="min-w-0 truncate">
                {revealed ? wh.secret : '••••••••••••••••'}
              </Chip>
              <Button variant="ghost" size="sm" onClick={() => setRevealed((v) => !v)}>
                {revealed ? 'Hide' : 'Reveal'}
              </Button>
              <CopyButton value={wh.secret} title="Copy secret" />
            </span>
          </div>
        </div>
        <div>
          <SectionLabel>Anything else (CI, cron, curl)</SectionLabel>
          <p className="mt-1 text-xs text-fg-subtle">A plain POST to this URL triggers a deploy — the secret is in the path.</p>
          <span className="mt-2 flex min-w-0 items-center gap-1.5">
            <Chip mono size="sm" className="min-w-0 truncate" title={revealed ? wh.genericUrl : undefined}>
              {revealed ? wh.genericUrl : wh.genericUrl.replace(wh.secret, '••••••••')}
            </Chip>
            <CopyButton value={wh.genericUrl} title="Copy deploy URL" />
          </span>
        </div>
      </CardBody>
      <CardFooter>
        <p className="text-xs text-fg-faint">Regenerating invalidates the old secret everywhere.</p>
        <Button variant="ghost" size="sm" loading={regenerate.isPending} onClick={() => regenerate.mutate()} className="ml-auto">
          Regenerate secret
        </Button>
      </CardFooter>
    </Card>
  );
}
