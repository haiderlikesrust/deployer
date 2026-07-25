import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Api } from '../api/client';
import { Spinner, StatusBadge, timeAgo } from '../components/ui';

export default function AppsList() {
  const apps = useQuery({ queryKey: ['apps'], queryFn: Api.apps.list, refetchInterval: 10000 });

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-100">Apps</h1>
        <Link to="/new" className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
          + New app
        </Link>
      </div>

      {apps.isLoading && <Spinner />}
      {apps.isError && <p className="text-red-400">Failed to load apps: {(apps.error as Error).message}</p>}

      {apps.data && apps.data.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-700 p-10 text-center">
          <p className="text-zinc-400">No apps yet.</p>
          <p className="mt-1 text-sm text-zinc-500">
            Hit <span className="text-zinc-300">“New app”</span>, paste a repo URL, and it'll be live in a minute.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {apps.data?.map((app) => (
          <Link
            key={app.id}
            to={`/apps/${app.id}`}
            className="group rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-600"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-100 group-hover:text-white">{app.name}</span>
              <StatusBadge status={app.status} />
            </div>
            <div className="mt-1 truncate text-xs text-zinc-500">{app.repoUrl}</div>
            <div className="mt-3 flex items-center justify-between text-xs">
              {app.type !== 'worker' ? (
                <span
                  className="truncate text-indigo-400 hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(app.url, '_blank');
                  }}
                >
                  {app.effectiveHost}
                </span>
              ) : (
                <span className="text-zinc-500">worker</span>
              )}
              <span className="text-zinc-600">
                {app.lastDeployment ? `deployed ${timeAgo(app.lastDeployment.finishedAt ?? app.lastDeployment.createdAt)}` : 'never deployed'}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
