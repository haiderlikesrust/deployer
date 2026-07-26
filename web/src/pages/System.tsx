import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Api } from '../api/client';
import {
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CopyButton,
  HardDrive,
  Input,
  KeyValue,
  PageHeader,
  Server,
  SkeletonText,
  StatCard,
  StatCardSkeleton,
  Tooltip,
  formatBytes,
  useToast,
} from '../components/ui';

const LOW_DISK = 2 * 1024 ** 3;

export default function SystemPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const system = useQuery({ queryKey: ['system'], queryFn: Api.system.get, refetchInterval: 30000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: Api.settings.get });
  const [retention, setRetention] = useState<string | null>(null);
  const [pruneOut, setPruneOut] = useState<string | null>(null);

  const prune = useMutation({
    mutationFn: Api.system.prune,
    onSuccess: (res) => {
      const out = res.output?.trim() ?? '';
      setPruneOut(out || 'nothing to prune');
      qc.invalidateQueries({ queryKey: ['system'] });
      toast({ title: out ? 'Prune complete' : 'Nothing to prune', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Prune failed', description: (e as Error).message, variant: 'error' }),
  });

  const saveSettings = useMutation({
    mutationFn: () => Api.settings.put({ imageRetention: parseInt(retention ?? '3', 10) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setRetention(null);
      toast({ title: 'Retention saved', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not save retention', description: (e as Error).message, variant: 'error' }),
  });

  const s = system.data;
  const st = settings.data;
  const dockerOk = !!s?.docker.ok;
  const running = s?.runningContainers ?? 0;
  const managed = s?.managedContainers ?? 0;

  return (
    <div className="max-w-[56rem] space-y-6">
      <PageHeader
        title="System"
        actions={
          s && <span className="text-xs text-fg-faint">Docker, disk and container state, refreshed every 30s</span>
        }
      />

      {system.isPending ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Docker"
            icon={<Server className="h-3.5 w-3.5" />}
            tone={dockerOk ? 'default' : 'danger'}
            value={
              dockerOk ? (
                `v${s?.docker.version}`
              ) : s?.docker.error ? (
                <Tooltip content={s.docker.error} side="bottom">
                  <span>Unreachable</span>
                </Tooltip>
              ) : (
                'Unreachable'
              )
            }
          />
          <StatCard
            label="Disk free"
            icon={<HardDrive className="h-3.5 w-3.5" />}
            value={formatBytes(s?.diskFreeBytes ?? null)}
            tone={(s?.diskFreeBytes ?? Infinity) < LOW_DISK ? 'danger' : 'default'}
            hint="Free on the Docker volume"
          />
          <StatCard label="Apps" icon={<Box className="h-3.5 w-3.5" />} value={String(s?.apps ?? 0)} />
          <StatCard label="Containers" value={`${running}/${managed}`}>
            <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-success transition-ui"
                style={{ width: `${managed ? Math.round((running / managed) * 100) : 0}%` }}
              />
            </div>
          </StatCard>
        </div>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Instance</CardTitle>
          </div>
        </CardHeader>
        <CardBody>
          {system.isPending ? (
            <SkeletonText lines={4} />
          ) : (
            <KeyValue
              rows={[
                { label: 'Base domain', value: s?.baseDomain ?? '—', copy: s?.baseDomain },
                { label: 'Apps served at', value: `<app>.${s?.baseDomain ?? ''}` },
                { label: 'SSL mode', value: s?.sslMode ?? '—' },
                { label: 'Probe mode', value: s?.probeMode ?? '—' },
              ]}
            />
          )}
          <p className="mt-3 text-xs text-fg-faint">
            Base domain and SSL mode live in the VPS .env — re-run the installer to change them.
          </p>
        </CardBody>
      </Card>

      <Card padding="none">
        <CardHeader>
          <div>
            <CardTitle>Housekeeping</CardTitle>
          </div>
        </CardHeader>

        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">Image retention</div>
            <p className="mt-0.5 text-xs text-fg-subtle">
              Older images beyond this count are removed after each deploy.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              mono
              aria-label="Images kept per app"
              value={retention ?? String(st?.imageRetention ?? 3)}
              onChange={(e) => setRetention(e.target.value.replace(/\D/g, ''))}
              className="w-20"
            />
            <Button loading={saveSettings.isPending} disabled={retention == null} onClick={() => saveSettings.mutate()}>
              Save
            </Button>
          </div>
        </div>

        <div className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg">Prune images</div>
              <p className="mt-0.5 text-xs text-fg-subtle">
                Removes dangling images and the Docker build cache. Running containers are untouched.
              </p>
            </div>
            <Button loading={prune.isPending} onClick={() => prune.mutate()}>
              Prune dangling images
            </Button>
          </div>

          {pruneOut && (
            <div className="relative mt-3">
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-bg-subtle p-3 pr-10 font-mono text-xs whitespace-pre-wrap text-fg-muted scroll-thin">
                {pruneOut}
              </pre>
              <span className="absolute top-1.5 right-1.5">
                <CopyButton value={pruneOut} title="Copy prune output" />
              </span>
            </div>
          )}
        </div>
      </Card>

      <NotificationsCard />
    </div>
  );
}

function NotificationsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['settings'], queryFn: Api.settings.get });
  const n = settings.data?.notifications;

  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChat, setTelegramChat] = useState<string | null>(null);
  const [discordWebhook, setDiscordWebhook] = useState('');

  const save = useMutation({
    mutationFn: () =>
      Api.settings.put({
        ...(telegramToken !== '' ? { telegramToken } : {}),
        ...(telegramChat != null ? { telegramChat } : {}),
        ...(discordWebhook !== '' ? { discordWebhook } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setTelegramToken('');
      setTelegramChat(null);
      setDiscordWebhook('');
      toast({ title: 'Notification channels saved', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not save', description: (e as Error).message, variant: 'error' }),
  });

  const toggleEvent = useMutation({
    mutationFn: (patch: Record<string, boolean>) => Api.settings.put({ notifyEvents: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const test = useMutation({
    mutationFn: Api.settings.notifyTest,
    onSuccess: (r) =>
      r.ok
        ? toast({ title: 'Test sent — check your phone', variant: 'success' })
        : toast({ title: 'Delivery problems', description: r.errors.join('; '), variant: 'error' }),
    onError: (e) => toast({ title: 'Test failed', description: (e as Error).message, variant: 'error' }),
  });

  const events: { key: keyof NonNullable<typeof n>['events']; label: string }[] = [
    { key: 'deploySuccess', label: 'Deploy succeeded' },
    { key: 'deployFailed', label: 'Deploy failed' },
    { key: 'needsEnv', label: 'Waiting for env vars' },
    { key: 'crashLoop', label: 'App crash / restart' },
    { key: 'reachability', label: 'App down / recovered' },
  ];

  return (
    <Card padding="none">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <p className="mt-0.5 text-xs text-fg-subtle">Deploys, failures and crashes pushed to Telegram or Discord.</p>
      </CardHeader>
      <CardBody className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="text-xs font-medium text-fg">
              Telegram {n?.telegramConfigured && <span className="ml-1 text-success-fg">✓ configured</span>}
            </div>
            <Input
              mono
              type="password"
              aria-label="Telegram bot token"
              placeholder={n?.telegramConfigured ? 'bot token (unchanged)' : 'bot token from @BotFather'}
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
            />
            <Input
              mono
              aria-label="Telegram chat id"
              placeholder="chat id (message @userinfobot)"
              value={telegramChat ?? n?.telegramChat ?? ''}
              onChange={(e) => setTelegramChat(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium text-fg">
              Discord {n?.discordConfigured && <span className="ml-1 text-success-fg">✓ configured</span>}
            </div>
            <Input
              mono
              type="password"
              aria-label="Discord webhook URL"
              placeholder={n?.discordConfigured ? 'webhook URL (unchanged)' : 'channel → Integrations → Webhooks'}
              value={discordWebhook}
              onChange={(e) => setDiscordWebhook(e.target.value)}
            />
            <p className="text-xs text-fg-faint">Paste an empty value and save to remove a channel.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {events.map(({ key, label }) => (
            <label key={key} className="flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-white"
                checked={n?.events[key] ?? true}
                onChange={(e) => toggleEvent.mutate({ [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={telegramToken === '' && telegramChat == null && discordWebhook === ''}
            onClick={() => save.mutate()}
          >
            Save channels
          </Button>
          <Button loading={test.isPending} disabled={!n?.telegramConfigured && !n?.discordConfigured} onClick={() => test.mutate()}>
            Send test
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
