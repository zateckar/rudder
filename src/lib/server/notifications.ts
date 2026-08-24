/**
 * Notification sending service.
 * Dispatches alerts to webhook, Slack, or email channels.
 */

import type { InferSelectModel } from 'drizzle-orm';
import type { notificationChannels } from '$lib/db/schema';

type NotificationChannel = InferSelectModel<typeof notificationChannels>;

interface NotificationPayload {
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

const SEVERITY_COLORS: Record<string, string> = {
  info: '#2196F3',
  warning: '#FF9800',
  critical: '#F44336',
};

const SEVERITY_EMOJI: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

/**
 * How long a channel gets to accept a notification.
 *
 * This is not a nicety. `evaluateAlerts` is awaited inside the metrics
 * collection cycle, and that cycle holds a `running` flag which is released only
 * when the collection *actually* finishes — the four-minute race in `runLoop`
 * reports a hang, it cannot cancel one. `fetch` has no default timeout, so a
 * webhook host that accepts the connection and never answers left this promise
 * pending for the life of the process: metrics collection, reconciliation and
 * alert evaluation all stopped, and the only symptom was "Previous collection
 * still running, skipping this cycle" once a minute.
 *
 * Ten seconds is generous for an endpoint whose whole job is to accept a small
 * JSON body, and it keeps the worst case for a fleet of channels well inside the
 * collection interval.
 */
const SEND_TIMEOUT_MS = 10_000;

/** `fetch` that cannot outlive the collection cycle it runs inside. */
async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
}

/**
 * Send a notification through the given channel.
 * Errors are logged but never thrown — callers should not break on notification failures.
 */
export async function sendNotification(
  channel: NotificationChannel,
  payload: NotificationPayload,
): Promise<boolean> {
  if (!channel.enabled) {
    console.log(`[notifications] Channel "${channel.name}" is disabled, skipping`);
    return false;
  }

  let config: Record<string, any>;
  try {
    config = JSON.parse(channel.config);
  } catch (e) {
    console.error(`[notifications] Invalid config JSON for channel "${channel.name}":`, e);
    return false;
  }

  try {
    switch (channel.type) {
      case 'webhook':
        return await sendWebhook(channel.name, config, payload);
      case 'slack':
        return await sendSlack(channel.name, config, payload);
      case 'email':
        return sendEmail(channel.name, config, payload);
      default:
        console.warn(`[notifications] Unknown channel type "${channel.type}" for "${channel.name}"`);
        return false;
    }
  } catch (e) {
    console.error(`[notifications] Failed to send via channel "${channel.name}" (${channel.type}):`, e);
    return false;
  }
}

async function sendWebhook(
  channelName: string,
  config: Record<string, any>,
  payload: NotificationPayload,
): Promise<boolean> {
  const url = config.url;
  if (!url) {
    console.error(`[notifications] Webhook channel "${channelName}" has no URL configured`);
    return false;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.headers || {}),
  };

  const res = await postJson(url, headers, {
    title: payload.title,
    message: payload.message,
    severity: payload.severity,
    timestamp: new Date().toISOString(),
  });

  if (!res.ok) {
    console.error(`[notifications] Webhook "${channelName}" returned ${res.status}: ${await res.text().catch(() => '')}`);
    return false;
  }

  console.log(`[notifications] Webhook "${channelName}" sent successfully`);
  return true;
}

async function sendSlack(
  channelName: string,
  config: Record<string, any>,
  payload: NotificationPayload,
): Promise<boolean> {
  const webhookUrl = config.webhookUrl;
  if (!webhookUrl) {
    console.error(`[notifications] Slack channel "${channelName}" has no webhookUrl configured`);
    return false;
  }

  const color = SEVERITY_COLORS[payload.severity] || SEVERITY_COLORS.info;
  const emoji = SEVERITY_EMOJI[payload.severity] || '';

  const slackPayload = {
    text: `${emoji} *${payload.title}*`,
    attachments: [
      {
        color,
        text: payload.message,
        footer: `Rudder Alert • ${payload.severity.toUpperCase()}`,
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  const res = await postJson(
    webhookUrl,
    { 'Content-Type': 'application/json' },
    slackPayload,
  );

  if (!res.ok) {
    console.error(`[notifications] Slack "${channelName}" returned ${res.status}: ${await res.text().catch(() => '')}`);
    return false;
  }

  console.log(`[notifications] Slack "${channelName}" sent successfully`);
  return true;
}

/**
 * Email is not implemented, and says so.
 *
 * This used to log the message and return `true`, so an alert routed to an email
 * channel was recorded as delivered and reported as sent. The one thing a
 * notification channel must never do is claim to have notified someone: an
 * operator who configures email alerts and sees them succeed has no reason to go
 * looking, and finds out during the incident the alert was for.
 *
 * Returning false is not the whole fix — the channel type should not be
 * offerable until there is an SMTP path behind it, which is why
 * `/api/notifications` now refuses to create one — but it is what makes the
 * existing rows honest.
 */
function sendEmail(
  channelName: string,
  config: Record<string, any>,
  payload: NotificationPayload,
): boolean {
  console.error(
    `[notifications] Channel "${channelName}" is an email channel, and Rudder cannot send ` +
      `email — there is no SMTP support yet. "${payload.title}" was NOT delivered to ` +
      `${config.to || '(no recipient configured)'}. Route this rule to a webhook or Slack channel.`,
  );
  return false;
}
