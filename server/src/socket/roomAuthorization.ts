import { Message, Room, RoomMember, RoomPermissions, RoomPostingSchedule } from '../types';
import { RoomStore } from '../repositories/store';

export type RoomActor = {
  room: Room;
  member: RoomMember;
  clientId: string;
  role: RoomMember['role'];
};

export type RoomAuthorizationAction =
  | { type: 'message.post'; now?: Date }
  | { type: 'message.edit'; message: Message }
  | { type: 'message.delete'; message: Message }
  | { type: 'room.clearHistory'; confirmation?: string }
  | { type: 'room.manageSettings' }
  | { type: 'room.manageAdmins' }
  | { type: 'room.transferOwnership'; targetClientId: string };

export type RoomAuthorizationResult =
  | { ok: true; actor: RoomActor }
  | {
      ok: false;
      code: 'room_not_found' | 'forbidden' | 'posting_closed' | 'invalid_confirmation';
      message: string;
      actor?: RoomActor;
    };

const WEEKDAY_TO_NUMBER: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const parseMinutes = (value: string): number | null => {
  const match = TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

const isValidTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const getLocalRoomTime = (now: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const weekday = parts.find(part => part.type === 'weekday')?.value || 'Sun';
  const hour = Number(parts.find(part => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value || '0');

  return {
    day: WEEKDAY_TO_NUMBER[weekday] ?? 0,
    minutes: hour * 60 + minute,
  };
};

export function normalizePostingSchedule(value: unknown): RoomPostingSchedule | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as {
    enabled?: unknown;
    timezone?: unknown;
    windows?: unknown;
  };
  const timezone = typeof raw.timezone === 'string' && raw.timezone.trim()
    ? raw.timezone.trim()
    : 'UTC';
  if (!isValidTimezone(timezone)) {
    throw new Error('Invalid timezone');
  }

  const windows = Array.isArray(raw.windows)
    ? raw.windows.slice(0, 14).map(window => {
        const item = window as { days?: unknown; start?: unknown; end?: unknown };
        const days = Array.isArray(item.days)
          ? [...new Set(item.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
          : [];
        const start = typeof item.start === 'string' && TIME_PATTERN.test(item.start) ? item.start : null;
        const end = typeof item.end === 'string' && TIME_PATTERN.test(item.end) ? item.end : null;
        if (days.length === 0 || !start || !end || start === end) {
          return null;
        }
        return { days, start, end };
      }).filter((window): window is RoomPostingSchedule['windows'][number] => !!window)
    : [];

  return {
    enabled: Boolean(raw.enabled),
    timezone,
    windows,
  };
}

export function getPostingAvailability(room: Room, now = new Date()): { allowed: boolean; reason?: string } {
  const schedule = room.postingSchedule;
  if (!schedule?.enabled) {
    return { allowed: true };
  }

  if (!schedule.windows.length) {
    return { allowed: false, reason: 'Posting closed' };
  }

  const { day, minutes } = getLocalRoomTime(now, schedule.timezone || 'UTC');
  const previousDay = (day + 6) % 7;

  const isOpen = schedule.windows.some(window => {
    const start = parseMinutes(window.start);
    const end = parseMinutes(window.end);
    if (start === null || end === null || start === end) {
      return false;
    }

    if (start < end) {
      return window.days.includes(day) && minutes >= start && minutes < end;
    }

    return (
      (window.days.includes(day) && minutes >= start) ||
      (window.days.includes(previousDay) && minutes < end)
    );
  });

  return isOpen
    ? { allowed: true }
    : { allowed: false, reason: 'Posting closed' };
}

export async function getRoomActor(store: RoomStore, roomId: string, clientId: string): Promise<RoomActor | null> {
  const room = await store.getRoomById(roomId);
  if (!room) {
    return null;
  }

  let member = await store.getRoomMember(roomId, clientId);
  if (room.creatorId === clientId && member?.role !== 'owner') {
    member = await store.addRoomMember(roomId, clientId, 'owner', room.createdAt);
  }

  if (!member) {
    return null;
  }

  return {
    room,
    member,
    clientId,
    role: member.role,
  };
}

export async function getRoomMessage(store: RoomStore, roomId: string, messageId: string): Promise<Message | null> {
  const messages = await store.readMessagesByRoom(roomId);
  return messages.find(message => message.id === messageId && message.roomId === roomId) || null;
}

export function buildRoomPermissions(actor: RoomActor | null, roomId: string, clientId: string, room?: Room): RoomPermissions {
  const targetRoom = actor?.room || room;
  const posting = targetRoom ? getPostingAvailability(targetRoom) : { allowed: false, reason: 'Room not found' };
  const isOwner = actor?.role === 'owner';
  const isAdmin = actor?.role === 'admin';

  return {
    roomId,
    clientId,
    role: actor?.role || null,
    canPost: Boolean(actor && posting.allowed),
    canEditAnyMessage: Boolean(isOwner),
    canDeleteAnyMessage: Boolean(isOwner),
    canClearHistory: Boolean(isOwner),
    canManageRoom: Boolean(isOwner || isAdmin),
    canManageAdmins: Boolean(isOwner),
    canTransferOwnership: Boolean(isOwner),
    postingRestrictionReason: posting.allowed ? undefined : posting.reason,
  };
}

export async function authorizeRoomAction(input: {
  store: RoomStore;
  roomId: string;
  clientId: string;
  action: RoomAuthorizationAction;
}): Promise<RoomAuthorizationResult> {
  const actor = await getRoomActor(input.store, input.roomId, input.clientId);
  if (!actor) {
    const room = await input.store.getRoomById(input.roomId);
    return {
      ok: false,
      code: room ? 'forbidden' : 'room_not_found',
      message: room ? 'You are not authorized to access this room' : 'Room not found',
    };
  }

  const isOwner = actor.role === 'owner';
  const isAdmin = actor.role === 'admin';

  switch (input.action.type) {
    case 'message.post': {
      const posting = getPostingAvailability(actor.room, input.action.now);
      return posting.allowed
        ? { ok: true, actor }
        : { ok: false, code: 'posting_closed', message: posting.reason || 'Posting closed', actor };
    }
    case 'message.edit':
    case 'message.delete': {
      if (input.action.message.roomId !== input.roomId) {
        return { ok: false, code: 'forbidden', message: 'Message does not belong to this room', actor };
      }
      if (isOwner || input.action.message.clientId === input.clientId) {
        return { ok: true, actor };
      }
      return { ok: false, code: 'forbidden', message: 'You are not authorized to modify this message', actor };
    }
    case 'room.clearHistory': {
      if (!isOwner) {
        return { ok: false, code: 'forbidden', message: 'Only the room owner can clear history', actor };
      }
      if ((input.action.confirmation || '').trim() !== actor.room.name) {
        return { ok: false, code: 'invalid_confirmation', message: 'Room name confirmation is required', actor };
      }
      return { ok: true, actor };
    }
    case 'room.manageSettings':
      return isOwner || isAdmin
        ? { ok: true, actor }
        : { ok: false, code: 'forbidden', message: 'You are not authorized to manage this room', actor };
    case 'room.manageAdmins':
      return isOwner
        ? { ok: true, actor }
        : { ok: false, code: 'forbidden', message: 'Only the room owner can manage administrators', actor };
    case 'room.transferOwnership':
      return isOwner
        ? { ok: true, actor }
        : { ok: false, code: 'forbidden', message: 'Only the room owner can transfer ownership', actor };
    default:
      return { ok: false, code: 'forbidden', message: 'Unauthorized room action', actor };
  }
}
