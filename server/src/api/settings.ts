import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/db.js';
import { notifyChannels, notifyConfigured, notifyEvents, sendNotification, setNotifyEvents } from '../core/notify.js';

export async function settingsRoutes(f: FastifyInstance) {
  f.get('/settings', async () => {
    const channels = notifyChannels();
    return {
      // base domain + ssl mode are static config (compose .env) — shown read-only
      baseDomain: config.baseDomain,
      sslMode: config.sslMode,
      dockerNetwork: config.dockerNetwork,
      imageRetention: parseInt(getSetting('image_retention') ?? String(config.imageRetention), 10),
      letsencryptEmail: getSetting('letsencrypt_email') ?? null,
      notifications: {
        // channel secrets are write-only, like git tokens
        telegramConfigured: !!(channels.telegramToken && channels.telegramChat),
        telegramChat: channels.telegramChat,
        discordConfigured: !!channels.discordWebhook,
        events: notifyEvents(),
      },
    };
  });

  f.put('/settings', async (req, reply) => {
    const body = z
      .object({
        imageRetention: z.number().int().min(0).max(20).optional(),
        letsencryptEmail: z.string().email().nullish(),
        // empty string clears a channel
        telegramToken: z.string().max(200).optional(),
        telegramChat: z.string().max(100).optional(),
        discordWebhook: z
          .string()
          .max(400)
          .refine((s) => s === '' || s.startsWith('https://'), 'must be an https:// webhook URL')
          .optional(),
        notifyEvents: z
          .object({
            deploySuccess: z.boolean().optional(),
            deployFailed: z.boolean().optional(),
            needsEnv: z.boolean().optional(),
            crashLoop: z.boolean().optional(),
            reachability: z.boolean().optional(),
          })
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid input' });
    const d = body.data;

    if (d.imageRetention !== undefined) setSetting('image_retention', String(d.imageRetention));
    if (d.letsencryptEmail !== undefined) setSetting('letsencrypt_email', d.letsencryptEmail ?? '');
    if (d.telegramToken !== undefined) setSetting('notify_telegram_token', d.telegramToken.trim());
    if (d.telegramChat !== undefined) setSetting('notify_telegram_chat', d.telegramChat.trim());
    if (d.discordWebhook !== undefined) setSetting('notify_discord_webhook', d.discordWebhook.trim());
    if (d.notifyEvents) setNotifyEvents(d.notifyEvents);
    return { ok: true };
  });

  f.post('/settings/notify-test', async (_req, reply) => {
    if (!notifyConfigured()) {
      return reply.code(409).send({ error: 'no notification channel configured yet' });
    }
    const result = await sendNotification('🔔 Test notification from deployer — you are wired up.');
    return { ok: result.ok, errors: result.errors };
  });
}
