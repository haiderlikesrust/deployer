import { useState } from 'react';
import { Api, ApiError } from '../api/client';
import { Button, Field, Input, Logo } from '../components/ui';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center p-4">
      {/* ambient backdrop — one gradient is the whole difference between "form" and "product" */}
      <div
        aria-hidden
        className="fixed inset-0 -z-10 bg-[radial-gradient(60%_45%_at_50%_-5%,#15151b_0%,transparent_70%)]"
      />
      <div
        aria-hidden
        className="fixed inset-x-0 top-0 -z-10 h-px bg-[linear-gradient(90deg,transparent,var(--color-border),transparent)]"
      />

      <form
        onSubmit={submit}
        className="w-full max-w-auth rounded-xl border border-border bg-surface p-7 shadow-lg animate-rise"
      >
        <div className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-surface-2 text-fg mx-auto">
          <Logo className="h-7 w-7" />
        </div>
        <h1 className="mt-4 text-center text-lg font-medium tracking-[-0.01em] text-fg">deployer</h1>
        <p className="mt-1 text-center text-xs text-fg-subtle">paste a repo, get a URL</p>

        <div className="mt-6">
          <Field label="Admin password" htmlFor="admin-password">
            <Input
              id="admin-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10"
            />
          </Field>
        </div>

        {/* fixed slot: a failed login must not push the button down */}
        <div className="mt-2 min-h-[1.125rem] text-xs text-danger-fg" role="alert">
          {error}
        </div>

        <div className="mt-4">
          <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} disabled={password === ''}>
            Sign in
          </Button>
        </div>

        <p className="mt-5 text-center text-2xs text-fg-faint">Set in ADMIN_PASSWORD on the VPS</p>
      </form>
    </div>
  );
}
