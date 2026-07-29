import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logRoomMessageDiagnostic, readRoomDiagnostics } from './roomDiagnostics';

describe('room diagnostics', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('keeps correlation fields in session storage without message content', () => {
    logRoomMessageDiagnostic('event-page-applied', {
      roomId: 'room-1',
      deliveryId: 'delivery-1',
      cursorBefore: 20,
      cursorAfter: 21,
      toolMessages: [{ id: 'result-1', toolCallId: 'call-1', toolName: 'file_change' }],
    });

    expect(readRoomDiagnostics()).toEqual([
      expect.objectContaining({
        scope: 'room-messages',
        event: 'event-page-applied',
        roomId: 'room-1',
        deliveryId: 'delivery-1',
        cursorBefore: 20,
        cursorAfter: 21,
      }),
    ]);
    expect(sessionStorage.getItem('roomtalk-room-diagnostics-v1')).not.toContain('message content');
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(
      '[room-messages] event-page-applied {"roomId":"room-1"',
    ));
  });

  it('keeps only the latest bounded diagnostic window', () => {
    for (let index = 0; index < 260; index += 1) {
      logRoomMessageDiagnostic('event-notification-received', { index });
    }

    const records = readRoomDiagnostics();
    expect(records).toHaveLength(250);
    expect(records[0].index).toBe(10);
    expect(records[249].index).toBe(259);
  });
});
