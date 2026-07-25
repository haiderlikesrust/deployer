import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Api, ApiError, type App, type Deployment } from '../api/client';
import { useSSE } from '../hooks/useSSE';
import { Button, ConfirmDialog, Field, inputCls, LogViewer, Spinner, StatusBadge, timeAgo } from '../components/ui';

const IN_FLIGHT = ['queued', 'cloning', 'resolving', 'building', 'starting', 'checking'];
const TABS = ['deployments', 'logs', 'environment', 'settings'] as const;
type Tab = (typeof TABS)[number];

export default function AppDetail() {
  const { id } = useParams();
  const appId = Number(id);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'deployments') as Tab;

  const app = useQuery({ queryKey: ['app', appId], queryFn: () => Api.apps.get(appId), refetchInterval: 10000 });
  const qc = useQueryClient();
  const deploy = useMutation({
    mutationFn: () => Api.apps.deploy(appId),
    onSuccess: ({ deploymentId }) => {
      qc.invalidateQueries({ queryKey: ['deployments', appId] });
      setParams({ tab: 'deployments', dep: String(deploymentId) });
    },
  });
  const action = useMutation({
    mutationFn: (a: 'start' | 'stop' | 'restart') => Api.apps.action(appId, a),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app', appId] }),
  });

  if (app.isLoading) return <Spinner />;
  if (app.isError || !app.data) return <p className="text-red-400">App not found.</p>;
  const a = app.data;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-zinc-100">{a.name}</h1>
        <StatusBadge status={a.status} />
        {a.type !== 'worker' && (
          <a href={a.url} target="_blank" rel="noreferrer" className="text-sm text-indigo-400 hover:underline">
            {a.effectiveHost} ↗
          </a>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="primary" onClick={() => deploy.mutate()} disabled={deploy.isPending || a.status === 'deploying'}>
            {a.status === 'deploying' ? 'Deploying…' : 'Deploy'}
          </Button>
          {a.status === 'live' && <Button onClick={() => action.mutate('restart')}>Restart</Button>}
          {a.status === 'live' && <Button onClick={() => action.mutate('stop')}>Stop</Button>}
          {a.status === 'stopped' && <Button onClick={() => action.mutate('start')}>Start</Button>}
        </div>
      </div>
      <p className="mb-4 truncate text-xs text-zinc-500">
        {a.repoUrl}
        {a.branch ? ` @ ${a.branch}` : ''}
      </p>

      <div className="mb-4 flex gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setParams(t === 'deployments' ? { tab: t } : { tab: t }, { replace: true })}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${
              tab === t ? 'border-indigo-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'deployments' && <DeploymentsTab app={a} />}
      {tab === 'logs' && <RuntimeLogsTab app={a} />}
      {tab === 'environment' && <EnvTab app={a} />}
      {tab === 'settings' && <SettingsTab app={a} />}
    </div>
  );
}

// ---------------- deployments ----------------

function DeploymentsTab({ app }: { app: App }) {
  const [params, setParams] = useSearchParams();
  const deployments = useQuery({
    queryKey: ['deployments', app.id],
    queryFn: () => Api.deployments.list(app.id),
    refetchInterval: 5000,
  });

  const selectedId = params.get('dep') ? Number(params.get('dep')) : deployments.data?.[0]?.id ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-1">
        {deployments.isLoading && <Spinner />}
        {deployments.data?.length === 0 && <p className="text-sm text-zinc-500">No deployments yet.</p>}
        {deployments.data?.map((d) => (
          <button
            key={d.id}
            onClick={() => setParams({ tab: 'deployments', dep: String(d.id) }, { replace: true })}
            className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
              selectedId === d.id ? 'border-indigo-600 bg-indigo-950/30' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-600'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-200">#{d.id}</span>
              <StatusBadge status={d.status} />
            </div>
            <div className="mt-1 truncate text-xs text-zinc-500">
              {d.commitSha ? `${d.commitSha.slice(0, 7)} — ${d.commitMsg ?? ''}` : d.trigger}
            </div>
            <div className="text-xs text-zinc-600">{timeAgo(d.createdAt)}</div>
          </button>
        ))}
      </div>
      <div>{selectedId ? <DeploymentPane key={selectedId} deploymentId={selectedId} /> : <p className="text-sm text-zinc-500">Select a deployment.</p>}</div>
    </div>
  );
}

function DeploymentPane({ deploymentId }: { deploymentId: number }) {
  const qc = useQueryClient();
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

  const cancel = useMutation({ mutationFn: () => Api.deployments.cancel(deploymentId) });
  const d = dep.data;

  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-sm font-medium text-zinc-200">Deployment #{deploymentId}</span>
        {d && <StatusBadge status={d.status} />}
        {d?.failedStage && <span className="text-xs text-red-400">failed at: {d.failedStage}</span>}
        <div className="ml-auto flex items-center gap-2">
          {d?.config && (
            <button onClick={() => setShowConfig(!showConfig)} className="text-xs text-zinc-500 hover:text-zinc-300">
              {showConfig ? 'hide config' : 'resolved config'}
            </button>
          )}
          {inFlight && (
            <Button variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {showConfig && d?.config && <ConfigPanel config={d.config} />}
      <LogViewer lines={lines} className="h-[480px]" />
    </div>
  );
}

function ConfigPanel({ config }: { config: NonNullable<Deployment['config']> }) {
  const srcBadge = (s?: string) =>
    s === 'ui' ? (
      <span className="rounded bg-indigo-900/60 px-1.5 text-[10px] text-indigo-300">dashboard</span>
    ) : s === 'yml' ? (
      <span className="rounded bg-amber-900/60 px-1.5 text-[10px] text-amber-300">deploy.yml</span>
    ) : (
      <span className="rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">auto</span>
    );
  const rows: [string, string | number | null, string | undefined][] = [
    ['type', config.type, config.sources.type],
    ['builder', config.builder, undefined],
    ['port', config.containerPort, config.sources.port],
    ['domain', config.domainHost, config.sources.domain],
    ['build', config.buildCmd, config.sources.build],
    ['start', config.startCmd, config.sources.start],
    ['health', config.healthPath, config.sources.health],
    ['dockerfile', config.dockerfilePath, config.sources.dockerfile],
  ];
  return (
    <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
      <table className="w-full text-xs">
        <tbody>
          {rows
            .filter(([, v]) => v != null)
            .map(([k, v, s]) => (
              <tr key={k} className="border-b border-zinc-800/60 last:border-0">
                <td className="py-1 pr-3 font-medium text-zinc-400">{k}</td>
                <td className="py-1 pr-3 font-mono text-zinc-200">{String(v)}</td>
                <td className="py-1 text-right">{srcBadge(s)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- runtime logs ----------------

function RuntimeLogsTab({ app }: { app: App }) {
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const canStream = !!app.activeDeploymentId;

  useSSE(canStream ? `/api/apps/${app.id}/logs/stream` : null, {
    log: (d: { text: string }) => setLines((prev) => (prev.length > 5000 ? [...prev.slice(-4000), d.text] : [...prev, d.text])),
    end: (_d, es) => es.close(),
  });

  useEffect(() => {
    if (!canStream) setErr('No active container — deploy first.');
  }, [canStream]);

  if (err) return <p className="text-sm text-zinc-500">{err}</p>;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-zinc-500">Following container logs (last 200 lines + live)</p>
        <Button variant="ghost" onClick={() => setLines([])}>
          Clear
        </Button>
      </div>
      <LogViewer lines={lines} className="h-[520px]" />
    </div>
  );
}

// ---------------- environment ----------------

function EnvTab({ app }: { app: App }) {
  const qc = useQueryClient();
  const env = useQuery({ queryKey: ['env', app.id], queryFn: () => Api.env.get(app.id) });
  const [rows, setRows] = useState<{ key: string; value: string }[] | null>(null);
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  const current = rows ?? env.data ?? [];

  const save = useMutation({
    mutationFn: (vars: { key: string; value: string }[]) => Api.env.put(app.id, vars),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['env', app.id] });
      setRows(null);
      setNotice(res.redeployRequired ? 'Saved — redeploy to apply.' : 'Saved.');
      setTimeout(() => setNotice(null), 4000);
    },
  });

  const applyBulk = () => {
    const parsed: { key: string; value: string }[] = [];
    for (const line of bulkText.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      parsed.push({ key: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim().replace(/^["']|["']$/g, '') });
    }
    setRows(parsed);
    setBulk(false);
  };

  if (env.isLoading) return <Spinner />;

  return (
    <div className="max-w-2xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-zinc-500">Injected into the container at deploy time. PORT is set automatically.</p>
        <button
          onClick={() => {
            setBulkText(current.map((r) => `${r.key}=${r.value}`).join('\n'));
            setBulk(!bulk);
          }}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          {bulk ? 'row editor' : 'bulk edit (.env paste)'}
        </button>
      </div>

      {bulk ? (
        <div>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={12}
            placeholder={'KEY=value\nANOTHER=value'}
            className={`${inputCls} font-mono`}
          />
          <div className="mt-2 flex justify-end">
            <Button onClick={applyBulk}>Apply</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {current.map((row, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={row.key}
                onChange={(e) => setRows(current.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                placeholder="KEY"
                className={`${inputCls} w-52 font-mono`}
              />
              <input
                value={row.value}
                type={revealed.has(i) ? 'text' : 'password'}
                onFocus={() => setRevealed(new Set([...revealed, i]))}
                onChange={(e) => setRows(current.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                placeholder="value"
                className={`${inputCls} flex-1 font-mono`}
              />
              <Button variant="ghost" onClick={() => setRows(current.filter((_, j) => j !== i))} title="remove">
                ✕
              </Button>
            </div>
          ))}
          <Button variant="ghost" onClick={() => setRows([...current, { key: '', value: '' }])}>
            + add variable
          </Button>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-3">
        {notice && <span className="text-sm text-emerald-400">{notice}</span>}
        {save.isError && <span className="text-sm text-red-400">{(save.error as ApiError).message}</span>}
        <Button
          variant="primary"
          disabled={save.isPending || rows == null}
          onClick={() => save.mutate(current.filter((r) => r.key.trim() !== ''))}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------------- settings ----------------

function SettingsTab({ app }: { app: App }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
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
    gitToken: '',
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

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
        ...(form.gitToken.trim() !== '' ? { gitToken: form.gitToken.trim() } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', app.id] });
      setForm((f) => ({ ...f, gitToken: '' }));
      setNotice('Saved — settings apply on the next deploy.');
      setTimeout(() => setNotice(null), 4000);
    },
  });

  const remove = useMutation({
    mutationFn: () => Api.apps.remove(app.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      navigate('/');
    },
  });

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="Repository URL">
            <input value={form.repoUrl} onChange={set('repoUrl')} className={inputCls} />
          </Field>
        </div>
        <Field label="Branch" hint="empty = default branch">
          <input value={form.branch} onChange={set('branch')} className={inputCls} />
        </Field>
        <Field label="Type" hint="auto-detected when empty">
          <select value={form.type} onChange={set('type')} className={inputCls}>
            <option value="">auto</option>
            <option value="web">web</option>
            <option value="static">static</option>
            <option value="worker">worker</option>
          </select>
        </Field>
        <Field label="Port" hint="container port, when detection guesses wrong">
          <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })} className={inputCls} />
        </Field>
        <Field label="Custom domain" hint={`empty = ${app.name}.<base domain>`}>
          <input value={form.domain} onChange={set('domain')} placeholder="app.example.com" className={inputCls} />
        </Field>
        <Field label="Build command" hint="overrides auto-detected build">
          <input value={form.buildCmd} onChange={set('buildCmd')} placeholder="npm run build" className={inputCls} />
        </Field>
        <Field label="Start command" hint="overrides auto-detected start">
          <input value={form.startCmd} onChange={set('startCmd')} placeholder="node dist/server.js" className={inputCls} />
        </Field>
        <Field label="Health check path" hint="enables zero-downtime traffic gating">
          <input value={form.healthPath} onChange={set('healthPath')} placeholder="/healthz" className={inputCls} />
        </Field>
        <Field label="Dockerfile path" hint="force a specific Dockerfile">
          <input value={form.dockerfilePath} onChange={set('dockerfilePath')} placeholder="docker/Dockerfile.prod" className={inputCls} />
        </Field>
        <Field label="Root directory" hint="monorepos: build from this subfolder">
          <input value={form.rootDir} onChange={set('rootDir')} placeholder="apps/web" className={inputCls} />
        </Field>
        <Field label="Memory limit" hint="e.g. 512m — empty = unlimited">
          <input value={form.memoryLimit} onChange={set('memoryLimit')} placeholder="512m" className={inputCls} />
        </Field>
        <Field label="Git token" hint={app.hasGitToken ? 'a token is set — enter a new one to replace it' : 'for private repos'}>
          <input type="password" value={form.gitToken} onChange={set('gitToken')} placeholder={app.hasGitToken ? '••••••••' : 'ghp_…'} className={inputCls} />
        </Field>
      </div>

      <div className="flex items-center justify-end gap-3">
        {notice && <span className="text-sm text-emerald-400">{notice}</span>}
        {save.isError && <span className="text-sm text-red-400">{(save.error as ApiError).message}</span>}
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save settings
        </Button>
      </div>

      <div className="mt-8 rounded-lg border border-red-900/50 bg-red-950/20 p-4">
        <h3 className="text-sm font-semibold text-red-300">Danger zone</h3>
        <p className="mt-1 text-xs text-zinc-500">Removes the app, its container, images, build logs, and env vars. The repo is untouched.</p>
        <div className="mt-3">
          <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete app'}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${app.name}?`}
        body="This stops and removes the running container, all images, deployment history, and env vars. It cannot be undone."
        confirmLabel="Delete app"
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
