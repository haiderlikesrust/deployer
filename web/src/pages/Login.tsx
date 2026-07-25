import { useState } from 'react';
import { Api, ApiError } from '../api/client';
import { Button, inputCls } from '../components/ui';

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
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-3xl">🚀</div>
          <h1 className="mt-2 text-lg font-semibold text-zinc-100">deployer</h1>
          <p className="text-sm text-zinc-500">paste a repo, get a URL</p>
        </div>
        <input
          type="password"
          autoFocus
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
        />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-4">
          <Button type="submit" variant="primary" disabled={busy || password === ''}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </div>
  );
}
