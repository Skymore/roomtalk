import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logRoomMessageDiagnostic, readRoomDiagnostics } from './roomDiagnostics';

describe('room diagnostics', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('keeps correlation fields in session storage without message content', () => {
    const rawToolName = 'terminal: ROOMTALK_PRIVATE_TOKEN=fake-diagnostic-secret';
    logRoomMessageDiagnostic('event-page-applied', {
      roomId: 'room-1',
      deliveryId: 'delivery-1',
      cursorBefore: 20,
      cursorAfter: 21,
      toolMessages: [{ id: 'result-1', toolCallId: 'call-1', toolName: rawToolName }],
    });

    expect(readRoomDiagnostics()).toEqual([
      expect.objectContaining({
        scope: 'room-messages',
        event: 'event-page-applied',
        roomId: 'room-1',
        deliveryId: 'delivery-1',
        cursorBefore: 20,
        cursorAfter: 21,
        toolMessages: [{
          id: 'result-1',
          toolCallId: 'call-1',
          toolNameLength: rawToolName.length,
        }],
      }),
    ]);
    const persisted = sessionStorage.getItem('roomtalk-room-diagnostics-v1') || '';
    expect(persisted).not.toContain('message content');
    expect(persisted).not.toContain(rawToolName);
    expect(persisted).not.toContain('ROOMTALK_PRIVATE_TOKEN');
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining(
      '[room-messages] event-page-applied {"roomId":"room-1"',
    ));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(rawToolName);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('ROOMTALK_PRIVATE_TOKEN');
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

  it('sanitizes and rewrites legacy diagnostic records before reading or appending', () => {
    const legacyToolName = 'terminal: ROOMTALK_PRIVATE_TOKEN=fake-legacy-diagnostic-secret';
    sessionStorage.setItem('roomtalk-room-diagnostics-v1', JSON.stringify([{
      scope: 'room-messages',
      event: 'event-page-applied',
      timestamp: '2026-08-09T00:00:00.000Z',
      nested: {
        toolMessages: [{
          id: 'legacy-result',
          toolCallId: 'legacy-call',
          toolName: legacyToolName,
        }],
      },
    }]));

    const legacyRecords = readRoomDiagnostics();

    expect(legacyRecords).toEqual([expect.objectContaining({
      nested: {
        toolMessages: [{
          id: 'legacy-result',
          toolCallId: 'legacy-call',
          toolNameLength: legacyToolName.length,
        }],
      },
    })]);
    const afterRead = sessionStorage.getItem('roomtalk-room-diagnostics-v1') || '';
    expect(afterRead).not.toContain(legacyToolName);
    expect(afterRead).not.toContain('ROOMTALK_PRIVATE_TOKEN');

    logRoomMessageDiagnostic('event-notification-received', { roomId: 'room-1' });

    const afterAppend = sessionStorage.getItem('roomtalk-room-diagnostics-v1') || '';
    expect(readRoomDiagnostics()).toHaveLength(2);
    expect(afterAppend).not.toContain(legacyToolName);
    expect(afterAppend).not.toContain('ROOMTALK_PRIVATE_TOKEN');
    const serializedConsole = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(serializedConsole).not.toContain(legacyToolName);
    expect(serializedConsole).not.toContain('ROOMTALK_PRIVATE_TOKEN');
  });
});
