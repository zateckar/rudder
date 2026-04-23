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

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: payload.title,
      message: payload.message,
      severity: payload.severity,
      timestamp: new Date().toISOString(),
    }),
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

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slackPayload),
  });

  if (!res.ok) {
    console.error(`[notifications] Slack "${channelName}" returned ${res.status}: ${await res.text().catch(() => '')}`);
    return false;
  }

  console.log(`[notifications] Slack "${channelName}" sent successfully`);
  return true;
}

function sendEmail(
  channelName: string,
  config: Record<string, any>,
  payload: NotificationPayload,
): boolean {
  // TODO: Implement email sending when SMTP infrastructure is ready
  console.log(`[notifications] EMAIL (not yet implemented) channel "${channelName}":`, {
    to: config.to || '(not configured)',
    subject: payload.title,
    body: payload.message,
    severity: payload.severity,
  });
  return true;
}
