import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Api, ApiError, type CreateAppInput } from '../api/client';
import {
  Button,
  ButtonLink,
  Card,
  CardFooter,
  ChevronRight,
  Chip,
  Field,
  Input,
  PageHeader,
  SecretInput,
  SectionLabel,
  cn,
  useToast,
} from '../components/ui';

function suggestName(repoUrl: string): string {
  const last = repoUrl.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

const TYPE_OPTIONS: { value: string; title: string; badge?: string; desc: string }[] = [
  {
    value: '',
    title: 'Auto-detect',
    badge: 'recommended',
    desc: 'We look for a web framework. Anything else runs as a background worker.',
  },
  { value: 'web', title: 'Web service', desc: 'Gets a subdomain, HTTPS, and an HTTP health check.' },
  { value: 'static', title: 'Static site', desc: 'Built once, served by nginx.' },
  {
    value: 'worker',
    title: 'Background worker',
    desc: 'Bots, queues, cron jobs. No domain, no HTTP check — just logs and restarts.',
  },
];

export default function NewApp() {
  const navigate = useNavigate();
  const toast = useToast();
  const system = useQuery({ queryKey: ['system'], queryFn: Api.system.get, staleTime: 60000 });
  const baseDomain = system.data?.baseDomain ?? '';

  const [repoUrl, setRepoUrl] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [branch, setBranch] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [type, setType] = useState('');
  const [port, setPort] = useState('');
  const [domain, setDomain] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const effectiveName = (nameTouched ? name : suggestName(repoUrl)) || '';

  const create = useMutation({
    mutationFn: (input: CreateAppInput) => Api.apps.create(input),
    onSuccess: ({ app, deploymentId }) => {
      toast({ title: `Deploying ${app.name}`, variant: 'success' });
      navigate(`/apps/${app.id}?dep=${deploymentId}`);
    },
    onError: (e) => toast({ title: 'Could not create the app', description: (e as Error).message, variant: 'error' }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate({
      repoUrl: repoUrl.trim(),
      name: effectiveName || undefined,
      branch: branch.trim() || undefined,
      gitToken: gitToken.trim() || undefined,
      type: type || undefined,
      port: port ? parseInt(port, 10) : undefined,
      domain: domain.trim() || undefined,
      rootDir: rootDir.trim() || undefined,
    });
  };

  const isWorker = type === 'worker';
  const isStatic = type === 'static';
  const repoError = create.isError ? (create.error instanceof ApiError ? create.error.message : 'failed to create app') : undefined;

  return (
    <div className="mx-auto max-w-narrow">
      <PageHeader
        title="New App"
        description={
          <>
            Paste a repo. If it has a Dockerfile we use it; otherwise the stack is auto-detected (Node, Python, static).
            A <Chip mono size="sm">deploy.yml</Chip> is optional, and a{' '}
            <Chip mono size="sm">.env.example</Chip> is turned into a form you can fill in.
          </>
        }
      />

      <form onSubmit={submit}>
        <Card padding="none">
          {/* --- repository --- */}
          <div className="space-y-4 p-5">
            <SectionLabel>Repository</SectionLabel>
            <Field
              label="Repository URL"
              required
              htmlFor="repo-url"
              hint="Private repos need a token below."
              error={repoError}
            >
              <Input
                id="repo-url"
                autoFocus
                required
                value={repoUrl}
                onChange={(e) => {
                  setRepoUrl(e.target.value);
                  if (!nameTouched) setName(suggestName(e.target.value));
                }}
                placeholder="https://github.com/you/your-app"
                invalid={!!repoError}
                spellCheck={false}
              />
            </Field>
            <Field label="Git token" htmlFor="git-token" hint="Private repos only — stored server-side, never shown again.">
              <SecretInput id="git-token" value={gitToken} onChange={setGitToken} placeholder="ghp_…" />
            </Field>
          </div>

          {/* --- project --- */}
          <div className="space-y-4 border-t border-border-subtle p-5">
            <SectionLabel>Project</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="App name"
                htmlFor="app-name"
                hint={
                  effectiveName && baseDomain && !isWorker ? (
                    <span className="font-mono">
                      {effectiveName}.{baseDomain}
                    </span>
                  ) : (
                    'Becomes the subdomain.'
                  )
                }
              >
                <Input
                  id="app-name"
                  value={nameTouched ? name : effectiveName}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTouched(true);
                  }}
                  placeholder="my-app"
                  suffix={baseDomain && !isWorker ? `.${baseDomain}` : undefined}
                  spellCheck={false}
                />
              </Field>
              <Field label="Branch" htmlFor="branch" hint="Empty = default branch.">
                <Input id="branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" spellCheck={false} />
              </Field>
            </div>
          </div>

          {/* --- type: a deliberate choice, not an "advanced" afterthought --- */}
          <div className="space-y-3 border-t border-border-subtle p-5">
            <SectionLabel>How should it run?</SectionLabel>
            <div role="radiogroup" aria-label="App type" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TYPE_OPTIONS.map((o) => {
                const selected = type === o.value;
                return (
                  <button
                    key={o.value || 'auto'}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setType(o.value)}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-ui',
                      selected
                        ? 'border-border-strong bg-surface-2 shadow-sm'
                        : 'border-border bg-surface hover:border-border-strong hover:bg-surface-2'
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border transition-ui',
                          selected ? 'border-fg' : 'border-border-strong'
                        )}
                      >
                        {selected && <span className="h-1.5 w-1.5 rounded-full bg-fg" />}
                      </span>
                      <span className="text-sm font-medium text-fg">{o.title}</span>
                      {o.badge && (
                        <Chip tone="accent" size="sm" className="ml-auto">
                          {o.badge}
                        </Chip>
                      )}
                    </span>
                    <span className="mt-1.5 block text-xs text-fg-subtle">{o.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* --- advanced --- */}
          <div className="border-t border-border-subtle">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="flex h-11 w-full items-center gap-2 px-5 text-sm text-fg-subtle transition-ui hover:text-fg"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-ui', showAdvanced && 'rotate-90')} />
              Advanced
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-1 gap-3 p-5 pt-0 sm:grid-cols-3">
                <div className="sm:col-span-3">
                  <Field
                    label="Root directory"
                    htmlFor="root-dir"
                    hint="Monorepos: build from this subfolder instead of the repo root."
                  >
                    <Input id="root-dir" value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="apps/web" spellCheck={false} />
                  </Field>
                </div>
                {!isWorker && !isStatic && (
                  <Field label="Port" htmlFor="port" hint="Empty = detected.">
                    <Input
                      id="port"
                      value={port}
                      onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                      placeholder="auto"
                      mono
                    />
                  </Field>
                )}
                {!isWorker && (
                  <div className="sm:col-span-2">
                    <Field label="Custom domain" htmlFor="domain" hint="Empty = the subdomain above.">
                      <Input id="domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" spellCheck={false} />
                    </Field>
                  </div>
                )}
                {isWorker && (
                  <p className="text-xs text-fg-subtle sm:col-span-3">
                    Workers don't receive HTTP traffic — no port, domain, or health check.
                  </p>
                )}
              </div>
            )}
          </div>

          <CardFooter>
            <ButtonLink variant="ghost" to="/">
              Cancel
            </ButtonLink>
            <Button type="submit" variant="primary" size="lg" loading={create.isPending} disabled={!repoUrl.trim()}>
              Create &amp; Deploy
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
