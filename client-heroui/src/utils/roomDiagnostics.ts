type RoomDiagnosticDetails = Record<string, unknown>;

export interface RoomDiagnosticRecord extends RoomDiagnosticDetails {
  scope: 'room-session' | 'room-messages';
  event: string;
  timestamp: string;
}

const ROOM_DIAGNOSTIC_SESSION_KEY = 'roomtalk-room-diagnostics-v1';
const MAX_ROOM_DIAGNOSTIC_RECORDS = 250;

const persistRoomDiagnostic = (record: RoomDiagnosticRecord) => {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const parsed = JSON.parse(sessionStorage.getItem(ROOM_DIAGNOSTIC_SESSION_KEY) || '[]');
    const records = Array.isArray(parsed) ? parsed : [];
    records.push(record);
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
    return Array.isArray(parsed) ? parsed as RoomDiagnosticRecord[] : [];
  } catch {
    return [];
  }
};

const writeRoomDiagnostic = (
  scope: 'room-session' | 'room-messages',
  event: string,
  details: RoomDiagnosticDetails,
) => {
  const record: RoomDiagnosticRecord = {
    ...details,
    scope,
    event,
    timestamp: new Date().toISOString(),
  };
  persistRoomDiagnostic(record);
  console.info(`[${scope}] ${event}`, record);
};

export const logRoomSessionDiagnostic = (event: string, details: RoomDiagnosticDetails = {}) => {
  writeRoomDiagnostic('room-session', event, details);
};

export const logRoomMessageDiagnostic = (event: string, details: RoomDiagnosticDetails = {}) => {
  writeRoomDiagnostic('room-messages', event, details);
};
