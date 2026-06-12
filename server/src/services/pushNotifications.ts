import webPush from 'web-push';
import { Logger } from '../logger';
import { PushSubscriptionRecord, RoomStore } from '../repositories/store';
import { Message, Room } from '../types';

type PushConfig = {
  enabled: boolean;
  publicKey: string;
  privateKey: string;
  subject: string;
};

type WebPushSendError = Error & {
  statusCode?: number;
};

export const getPushConfig = (env: NodeJS.ProcessEnv = process.env): PushConfig => {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY || '';
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY || '';
  const subject = env.WEB_PUSH_SUBJECT || 'mailto:admin@roomtalk.local';

  return {
    enabled: Boolean(publicKey && privateKey),
    publicKey,
    privateKey,
    subject,
  };
};

export const getPushPublicConfig = () => {
  const config = getPushConfig();
  return {
    enabled: config.enabled,
    publicKey: config.enabled ? config.publicKey : '',
  };
};

const getSenderName = (message: Message) => (
  message.username?.trim() || 'Someone'
);

const getMessagePreview = (message: Message) => {
  if (message.messageType === 'media') {
    const kind = message.mediaAsset?.kind;
    if (kind === 'image') return 'sent an image';
    if (kind === 'video') return 'sent a video';
    if (kind === 'audio') return 'sent an audio message';
    return 'sent a media message';
  }

  const content = message.content.trim().replace(/\s+/g, ' ');
  return content.length > 120 ? `${content.slice(0, 117)}...` : content;
};

const shouldNotifyForMessage = (message: Message) => (
  message.clientId !== 'ai_assistant' &&
  (message.messageType === 'text' || message.messageType === 'media')
);

export const selectPushRecipients = (
  subscriptions: PushSubscriptionRecord[],
  activeBrowserInstanceIds: Set<string>,
  senderClientId: string,
): Map<string, PushSubscriptionRecord> => new Map(
  subscriptions
    .filter(subscription => {
      if (subscription.clientId === senderClientId) {
        return false;
      }
      if (subscription.browserInstanceId && activeBrowserInstanceIds.has(subscription.browserInstanceId)) {
        return false;
      }
      return true;
    })
    .map(subscription => [subscription.endpoint, subscription]),
);

export const notifyRoomMessage = async (params: {
  store: RoomStore;
  room: Room;
  message: Message;
  logger: Logger;
}) => {
  const { store, room, message, logger } = params;
  const config = getPushConfig();
  if (!config.enabled || !shouldNotifyForMessage(message)) {
    return;
  }

  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const [subscriptions, activeBrowserInstanceIds] = await Promise.all([
    store.readPushSubscriptionsByRoom(message.roomId),
    store.getRoomActiveBrowserInstanceIds(message.roomId),
  ]);
  const recipients = selectPushRecipients(subscriptions, new Set(activeBrowserInstanceIds), message.clientId);

  if (recipients.size === 0) {
    return;
  }

  const payload = JSON.stringify({
    type: 'room_message',
    roomId: message.roomId,
    messageId: message.id,
    title: room.name || 'RoomTalk',
    body: `${getSenderName(message)}: ${getMessagePreview(message)}`,
    url: `/?room=${encodeURIComponent(message.roomId)}`,
  });

  await Promise.all([...recipients.values()].map(async subscription => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      }, payload);
    } catch (error) {
      const sendError = error as WebPushSendError;
      if (sendError.statusCode === 404 || sendError.statusCode === 410) {
        logger.info('Removing expired push subscription', {
          statusCode: sendError.statusCode,
          recipientClientId: subscription.clientId,
          endpoint: subscription.endpoint.slice(0, 64),
        });
        await store.deletePushSubscription(subscription.clientId, subscription.endpoint);
        return;
      }
      logger.warn('Failed to send push notification', {
        error,
        roomId: message.roomId,
        messageId: message.id,
        recipientClientId: subscription.clientId,
      });
    }
  }));
};

export const notifyRoomMessageBestEffort = (params: {
  store: RoomStore;
  room: Room;
  message: Message;
  logger: Logger;
}) => {
  void notifyRoomMessage(params).catch(error => {
    params.logger.warn('Push notification dispatch failed', {
      error,
      roomId: params.message.roomId,
      messageId: params.message.id,
    });
  });
};
