import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Api, ApiError, type CreateAppInput } from '../api/client';
import { Button, Field, inputCls } from '../components/ui';

function suggestName(repoUrl: string): string {
  const last = repoUrl.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

export default function NewApp() {
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [branch, setBranch] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [type, setType] = useState('');
  const [port, setPort] = useState('');
  const [domain, setDomain] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const create = useMutation({
    mutationFn: (input: CreateAppInput) => Api.apps.create(input),
    onSuccess: ({ app, deploymentId }) => navigate(`/apps/${app.id}?dep=${deploymentId}`),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate({
      repoUrl: repoUrl.trim(),
      name: (nameTouched ? name : suggestName(repoUrl)) || undefined,
      branch: branch.trim() || undefined,
      gitToken: gitToken.trim() || undefined,
      type: type || undefined,
      port: port ? parseInt(port, 10) : undefined,
      domain: domain.trim() || undefined,
    });
  };

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-xl font-semibold text-zinc-100">New app</h1>
      <p className="mb-5 text-sm text-zinc-500">
        Paste a repo. If it has a Dockerfile we use it; otherwise the stack is auto-detected (Node, Python, static). A{' '}
        <code className="text-zinc-400">deploy.yml</code> is optional.
      </p>

      <form onSubmit={submit} className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <Field label="Repository URL" hint="https://github.com/you/repo — private repos need a token (below)">
          <input
            autoFocus
            required
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              if (!nameTouched) setName(suggestName(e.target.value));
            }}
            placeholder="https://github.com/you/your-app"
            className={inputCls}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="App name" hint="becomes the subdomain">
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="my-app"
              className={inputCls}
            />
          </Field>
          <Field label="Branch" hint="empty = default branch">
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className={inputCls} />
          </Field>
        </div>

        <Field label="Git token (for private repos)" hint="a personal access token with read access — stored server-side, never shown again">
          <input type="password" value={gitToken} onChange={(e) => setGitToken(e.target.value)} placeholder="ghp_…" className={inputCls} />
        </Field>

        <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-sm text-zinc-500 hover:text-zinc-300">
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>

        {showAdvanced && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Type">
              <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
                <option value="">auto</option>
                <option value="web">web</option>
                <option value="static">static</option>
                <option value="worker">worker</option>
              </select>
            </Field>
            <Field label="Port">
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="auto" className={inputCls} />
            </Field>
            <Field label="Custom domain">
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" className={inputCls} />
            </Field>
          </div>
        )}

        {create.isError && (
          <p className="text-sm text-red-400">{create.error instanceof ApiError ? create.error.message : 'failed to create app'}</p>
        )}

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={create.isPending || !repoUrl.trim()}>
            {create.isPending ? 'Creating…' : 'Create & deploy'}
          </Button>
        </div>
      </form>
    </div>
  );
}
