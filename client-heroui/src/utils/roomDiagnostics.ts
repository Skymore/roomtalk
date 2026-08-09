type RoomDiagnosticDetails = Record<string, unknown>;

export interface RoomDiagnosticRecord extends RoomDiagnosticDetails {
  scope: 'room-session' | 'room-messages';
  event: string;
  timestamp: string;
}

const ROOM_DIAGNOSTIC_SESSION_KEY = 'roomtalk-room-diagnostics-v1';
const MAX_ROOM_DIAGNOSTIC_RECORDS = 250;

const sanitizeRoomDiagnosticValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeRoomDiagnosticValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === 'toolName') {
      sanitized.toolNameLength = typeof item === 'string' ? item.length : 0;
    } else if (key !== 'toolNameLength' || !Object.prototype.hasOwnProperty.call(source, 'toolName')) {
      sanitized[key] = sanitizeRoomDiagnosticValue(item);
    }
  }
  return sanitized;
};

const normalizeStoredRoomDiagnostics = (value: unknown): RoomDiagnosticRecord[] => {
  if (!Array.isArray(value)) return [];
  return (sanitizeRoomDiagnosticValue(value) as RoomDiagnosticRecord[]).slice(-MAX_ROOM_DIAGNOSTIC_RECORDS);
};

const persistRoomDiagnostic = (record: RoomDiagnosticRecord) => {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const parsed = JSON.parse(sessionStorage.getItem(ROOM_DIAGNOSTIC_SESSION_KEY) || '[]');
    const records = normalizeStoredRoomDiagnostics(parsed);
    records.push(sanitizeRoomDiagnosticValue(record) as RoomDiagnosticRecord);
    sessionStorage.setItem(
      ROOM_DIAGNOSTIC_SESSION_KEY,
      JSON.stringify(records.slice(-MAX_ROOM_DIAGNOSTIC_RECORDS)),
    );
  } catch {
    // Diagnostics are best-effort and must never affect room synchronization.
  }
};

export const readRoomDiagnostics = (): RoomDiagnosticRecord[] => {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const parsed = JSON.parse(sessionStorage.getItem(ROOM_DIAGNOSTIC_SESSION_KEY) || '[]');
    const records = normalizeStoredRoomDiagnostics(parsed);
    sessionStorage.setItem(ROOM_DIAGNOSTIC_SESSION_KEY, JSON.stringify(records));
    return records;
  } catch {
    return [];
  }
};

const writeRoomDiagnostic = (
  scope: 'room-session' | 'room-messages',
  event: string,
  details: RoomDiagnosticDetails,
) => {
  const sanitizedDetails = sanitizeRoomDiagnosticValue(details) as RoomDiagnosticDetails;
  const record: RoomDiagnosticRecord = {
    ...sanitizedDetails,
    scope,
    event,
    timestamp: new Date().toISOString(),
  };
  persistRoomDiagnostic(record);
  console.info(`[${scope}] ${event} ${JSON.stringify(record)}`);
};

export const logRoomSessionDiagnostic = (event: string, details: RoomDiagnosticDetails = {}) => {
  writeRoomDiagnostic('room-session', event, details);
};

export const logRoomMessageDiagnostic = (event: string, details: RoomDiagnosticDetails = {}) => {
  writeRoomDiagnostic('room-messages', event, details);
};
