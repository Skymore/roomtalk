type RoomDiagnosticDetails = Record<string, unknown>;

const writeRoomDiagnostic = (
  scope: 'room-session' | 'room-messages',
  event: string,
  details: RoomDiagnosticDetails,
) => {
  console.info(`[${scope}] ${event}`, {
    timestamp: new Date().toISOString(),
    ...details,
  });
};

export const logRoomSessionDiagnostic = (event: string, details: RoomDiagnosticDetails = {}) => {
  writeRoomDiagnostic('room-session', event, details);
};

export const logRoomMessageDiagnostic = (event: string, details: RoomDiagnosticDetails = {}) => {
  writeRoomDiagnostic('room-messages', event, details);
};
