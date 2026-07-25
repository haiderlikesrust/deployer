import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Api } from '../api/client';
import { Button, Field, inputCls, Spinner } from '../components/ui';

function gb(bytes: number | null): string {
  if (bytes == null) return '?';
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function SystemPage() {
  const qc = useQueryClient();
  const system = useQuery({ queryKey: ['system'], queryFn: Api.system.get, refetchInterval: 30000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: Api.settings.get });
  const [retention, setRetention] = useState<string | null>(null);
  const [pruneOut, setPruneOut] = useState<string | null>(null);

  const prune = useMutation({
    mutationFn: Api.system.prune,
    onSuccess: (res) => {
      setPruneOut(res.output || 'nothing to prune');
      qc.invalidateQueries({ queryKey: ['system'] });
    },
  });
  const saveSettings = useMutation({
    mutationFn: () => Api.settings.put({ imageRetention: parseInt(retention ?? '3', 10) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (system.isLoading || settings.isLoading) return <Spinner />;
  const s = system.data;
  const st = settings.data;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-zinc-100">System</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Docker" value={s?.docker.ok ? `v${s.docker.version}` : 'unreachable'} bad={!s?.docker.ok} />
        <Stat label="Disk free" value={gb(s?.diskFreeBytes ?? null)} bad={(s?.diskFreeBytes ?? Infinity) < 2 * 1024 ** 3} />
        <Stat label="Apps" value={String(s?.apps ?? 0)} />
        <Stat label="Containers" value={`${s?.runningContainers ?? 0}/${s?.managedContainers ?? 0} running`} />
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
        <h2 className="mb-3 font-medium text-zinc-200">Instance</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-xs">
          <dt className="text-zinc-500">Base domain</dt>
          <dd className="font-mono text-zinc-300">{s?.baseDomain}</dd>
          <dt className="text-zinc-500">Apps served at</dt>
          <dd className="font-mono text-zinc-300">&lt;app-name&gt;.{s?.baseDomain}</dd>
          <dt className="text-zinc-500">SSL mode</dt>
          <dd className="font-mono text-zinc-300">{s?.sslMode}</dd>
          <dt className="text-zinc-500">Probe mode</dt>
          <dd className="font-mono text-zinc-300">{s?.probeMode}</dd>
        </dl>
        <p className="mt-3 text-xs text-zinc-600">Base domain and SSL mode live in the VPS .env — re-run the installer to change them.</p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-200">Housekeeping</h2>
        <div className="flex items-end gap-3">
          <Field label="Images kept per app" hint="older images beyond this are removed after each deploy">
            <input
              value={retention ?? String(st?.imageRetention ?? 3)}
              onChange={(e) => setRetention(e.target.value.replace(/\D/g, ''))}
              className={`${inputCls} w-24`}
            />
          </Field>
          <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending || retention == null}>
            Save
          </Button>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => prune.mutate()} disabled={prune.isPending}>
            {prune.isPending ? 'Pruning…' : 'Prune dangling images + build cache'}
          </Button>
          {pruneOut && <span className="text-xs text-zinc-500">{pruneOut}</span>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${bad ? 'text-red-400' : 'text-zinc-100'}`}>{value}</div>
    </div>
  );
}
