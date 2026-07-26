import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Api, type Service } from '../api/client';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Field,
  Input,
  PageHeader,
  RelativeTime,
  Select,
  Skeleton,
  StatusDot,
  formatBytes,
  useToast,
} from '../components/ui';

const TYPE_META: Record<string, { label: string; icon: string; hint: string }> = {
  postgres: { label: 'PostgreSQL', icon: '🐘', hint: 'DATABASE_URL' },
  redis: { label: 'Redis', icon: '⚡', hint: 'REDIS_URL' },
  mongo: { label: 'MongoDB', icon: '🍃', hint: 'MONGO_URL' },
};

export default function ServicesPage() {
  const services = useQuery({ queryKey: ['services'], queryFn: Api.services.list, refetchInterval: 15000 });
  const [creating, setCreating] = useState(false);

  return (
    <div className="max-w-[56rem] space-y-5">
      <PageHeader
        title="Databases"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New database
          </Button>
        }
      />
      <p className="-mt-2 text-xs text-fg-subtle">
        Managed containers on the private network — never exposed to the internet. Link one to an app and the connection URL is
        injected as an env var on the next deploy. Backed up daily, kept 7 deep.
      </p>

      {creating && <CreateServiceCard onDone={() => setCreating(false)} />}

      {services.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {services.data?.length === 0 && !creating && (
        <EmptyState
          icon={<span className="text-base">🐘</span>}
          title="No databases yet"
          description="Postgres, Redis or MongoDB — one click, one container, zero config."
          action={{ label: 'New database', onClick: () => setCreating(true) }}
        />
      )}

      {services.data?.map((svc) => (
        <ServiceCard key={svc.id} svc={svc} />
      ))}
    </div>
  );
}

function CreateServiceCard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState('postgres');

  const create = useMutation({
    mutationFn: () => Api.services.create({ name: name.trim(), type }),
    onSuccess: (svc) => {
      qc.invalidateQueries({ queryKey: ['services'] });
      toast({ title: `${TYPE_META[svc.type].label} '${svc.name}' is starting`, variant: 'success' });
      onDone();
    },
    onError: (e) => toast({ title: 'Could not create database', description: (e as Error).message, variant: 'error' }),
  });

  return (
    <Card padding="md" className="animate-pop">
      <div className="grid gap-3 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
        <Field label="Name" htmlFor="svc-name" hint="short slug — becomes the hostname on the private network">
          <Input id="svc-name" mono autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="main-db" />
        </Field>
        <Field label="Type" htmlFor="svc-type">
          <Select id="svc-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="postgres">PostgreSQL 16</option>
            <option value="redis">Redis 7</option>
            <option value="mongo">MongoDB 7</option>
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
            Create
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ServiceCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['service', svc.id], queryFn: () => Api.services.get(svc.id) });
  const apps = useQuery({ queryKey: ['apps'], queryFn: Api.apps.list });
  const [revealUrl, setRevealUrl] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkAppId, setLinkAppId] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['services'] });
    qc.invalidateQueries({ queryKey: ['service', svc.id] });
  };

  const backup = useMutation({
    mutationFn: () => Api.services.backup(svc.id),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Backup created', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Backup failed', description: (e as Error).message, variant: 'error' }),
  });
  const link = useMutation({
    mutationFn: (appId: number) => Api.services.link(svc.id, appId),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['apps'] });
      setLinkAppId('');
      toast({ title: 'Linked — redeploy the app to inject the URL', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not link', description: (e as Error).message, variant: 'error' }),
  });
  const unlink = useMutation({
    mutationFn: (appId: number) => Api.services.unlink(svc.id, appId),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Unlinked — takes effect on next deploy', variant: 'info' });
    },
  });
  const start = useMutation({
    mutationFn: () => Api.services.start(svc.id),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Database starting', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not start', description: (e as Error).message, variant: 'error' }),
  });
  const remove = useMutation({
    mutationFn: () => Api.services.remove(svc.id, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] });
      toast({ title: `${svc.name} deleted`, variant: 'info' });
    },
    onError: (e) => toast({ title: 'Could not delete', description: (e as Error).message, variant: 'error' }),
  });

  const meta = TYPE_META[svc.type];
  const unlinkedApps = (apps.data ?? []).filter((a) => !svc.links.some((l) => l.appId === a.id));
  const backups = detail.data?.backups ?? [];

  return (
    <Card padding="none">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="text-lg" aria-hidden>
            {meta.icon}
          </span>
          <CardTitle className="min-w-0 truncate">{svc.name}</CardTitle>
          <Chip size="sm" tone="neutral">
            {meta.label} {svc.version}
          </Chip>
          <span className="flex items-center gap-1.5 text-xs">
            <StatusDot status={svc.running ? 'live' : 'stopped'} />
            {svc.running ? 'running' : svc.status}
          </span>
          <div className="ml-auto flex gap-2">
            {!svc.running && (
              <Button size="sm" loading={start.isPending} onClick={() => start.mutate()}>
                Start
              </Button>
            )}
            <Button size="sm" loading={backup.isPending} onClick={() => backup.mutate()}>
              Back up now
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div>
          <div className="mb-1 text-2xs font-medium tracking-wide text-fg-faint uppercase">Connection URL</div>
          <div className="flex min-w-0 items-center gap-1.5">
            <Chip mono size="sm" className="min-w-0 truncate" title={revealUrl ? svc.url : undefined}>
              {revealUrl ? svc.url : svc.url.replace(/:[^:@/]+@/, ':••••••@')}
            </Chip>
            <Button variant="ghost" size="sm" onClick={() => setRevealUrl((v) => !v)}>
              {revealUrl ? 'Hide' : 'Reveal'}
            </Button>
            <CopyButton value={svc.url} title="Copy connection URL" />
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-2xs font-medium tracking-wide text-fg-faint uppercase">Linked apps</div>
          <div className="flex flex-wrap items-center gap-2">
            {svc.links.map((l) => (
              <span key={l.appId} className="flex items-center gap-1">
                <Chip size="sm">
                  {l.appName} <span className="font-mono text-fg-faint">← {l.envKey}</span>
                </Chip>
                <Button variant="ghost" size="sm" onClick={() => unlink.mutate(l.appId)} title={`Unlink ${l.appName}`}>
                  ✕
                </Button>
              </span>
            ))}
            {svc.links.length === 0 && <span className="text-xs text-fg-faint">none — link an app to inject {meta.hint}</span>}
            {unlinkedApps.length > 0 && (
              <span className="flex items-center gap-1.5">
                <Select aria-label="App to link" value={linkAppId} onChange={(e) => setLinkAppId(e.target.value)} className="h-7 text-xs">
                  <option value="">link an app…</option>
                  {unlinkedApps.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                {linkAppId && (
                  <Button size="sm" loading={link.isPending} onClick={() => link.mutate(Number(linkAppId))}>
                    Link
                  </Button>
                )}
              </span>
            )}
          </div>
        </div>

        {backups.length > 0 && (
          <div>
            <div className="mb-1.5 text-2xs font-medium tracking-wide text-fg-faint uppercase">Backups</div>
            <ul className="space-y-1">
              {backups.slice(0, 5).map((b) => (
                <li key={b.file} className="flex items-center gap-3 text-xs">
                  <a className="font-mono text-accent-fg hover:underline" href={Api.services.backupUrl(svc.id, b.file)}>
                    {b.file}
                  </a>
                  <span className="text-fg-faint">{formatBytes(b.sizeBytes)}</span>
                  <RelativeTime iso={b.createdAt} className="ml-auto text-fg-faint" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${svc.name}?`}
        body="The container AND its data volume are removed. Linked apps lose their injected connection URL on next deploy. Download a backup first if the data matters."
        confirmLabel="Delete database"
        requireTypeToConfirm={svc.name}
        loading={remove.isPending}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Card>
  );
}
