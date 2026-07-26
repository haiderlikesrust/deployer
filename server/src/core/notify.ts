import { getSetting, setSetting } from '../db/db.js';
import { getDeployment, listApps } from '../db/repo.js';
import { inspectContainer } from './docker.js';
import { scrub } from './secrets.js';

/**
 * Push notifications to the operator's phone via Telegram and/or Discord.
 * Both are plain HTTPS POSTs — no SDKs, no queues. Delivery is best-effort:
 * a dead webhook must never affect a deployment.
 */

export interface NotifyEvents {
  deploySuccess: boolean;
  deployFailed: boolean;
  needsEnv: boolean;
  crashLoop: boolean;
  reachability: boolean;
}

const DEFAULT_EVENTS: NotifyEvents = {
  deploySuccess: true,
  deployFailed: true,
  needsEnv: true,
  crashLoop: true,
  reachability: true,
};

export function notifyEvents(): NotifyEvents {
  try {
    const stored = JSON.parse(getSetting('notify_events') ?? '{}');
    return { ...DEFAULT_EVENTS, ...stored };
  } catch {
    return { ...DEFAULT_EVENTS };
  }
}

export function setNotifyEvents(patch: Partial<NotifyEvents>) {
  setSetting('notify_events', JSON.stringify({ ...notifyEvents(), ...patch }));
}

export function notifyChannels() {
  return {
    telegramToken: getSetting('notify_telegram_token') || null,
    telegramChat: getSetting('notify_telegram_chat') || null,
    discordWebhook: getSetting('notify_discord_webhook') || null,
  };
}

export function notifyConfigured(): boolean {
  const c = notifyChannels();
  return !!(c.telegramToken && c.telegramChat) || !!c.discordWebhook;
}

/** Send to every configured channel; returns per-channel errors (for the test button). */
export async function sendNotification(text: string): Promise<{ ok: boolean; errors: string[] }> {
  const c = notifyChannels();
  const clean = scrub(text).slice(0, 1900);
  const errors: string[] = [];
  let sent = false;

  if (c.telegramToken && c.telegramChat) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: c.telegramChat, text: clean, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) errors.push(`telegram: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      else sent = true;
    } catch (e) {
      errors.push(`telegram: ${(e as Error).message}`);
    }
  }

  if (c.discordWebhook) {
    try {
      const res = await fetch(c.discordWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: clean }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok && res.status !== 204) errors.push(`discord: HTTP ${res.status}`);
      else sent = true;
    } catch (e) {
      errors.push(`discord: ${(e as Error).message}`);
    }
  }

  return { ok: sent && errors.length === 0, errors };
}

/** Fire-and-forget, gated on the per-event toggle. */
export function notify(event: keyof NotifyEvents, text: string) {
  if (!notifyConfigured() || !notifyEvents()[event]) return;
  void sendNotification(text).then(({ errors }) => {
    for (const err of errors) console.error(`notification delivery failed: ${err}`);
  });
}

// ---------------------------------------------------------------- crash watcher

const lastRestartCount = new Map<number, number>();
const lastAlertAt = new Map<number, number>();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * `--restart unless-stopped` hides crashes: the container comes right back and
 * the dashboard still says live. Watch restart counts so a crashing bot pings
 * the operator instead of silently burning money.
 */
export function startCrashWatcher() {
  const timer = setInterval(() => void checkOnce(), 60_000);
  timer.unref();
}

export async function checkOnce() {
  for (const app of listApps()) {
    if (!app.active_deployment_id) continue;
    const dep = getDeployment(app.active_deployment_id);
    if (!dep?.container_id) continue;
    let state;
    try {
      state = await inspectContainer(dep.container_id);
    } catch {
      continue;
    }
    if (!state) continue;

    const count = state.restartCount ?? 0;
    const prev = lastRestartCount.get(app.id);
    lastRestartCount.set(app.id, count);
    if (prev == null) continue; // first observation of this container — no baseline yet

    const restartedSinceLastCheck = count > prev;
    if ((restartedSinceLastCheck || state.status === 'restarting') && Date.now() - (lastAlertAt.get(app.id) ?? 0) > ALERT_COOLDOWN_MS) {
      lastAlertAt.set(app.id, Date.now());
      notify(
        'crashLoop',
        `⚠️ ${app.name} restarted unexpectedly (restart count ${count}` +
          (state.exitCode != null ? `, last exit code ${state.exitCode}` : '') +
          (state.oomKilled ? ', OOM-killed — consider raising its memory limit' : '') +
          `). Check its logs in the dashboard.`
      );
    }
  }
}
