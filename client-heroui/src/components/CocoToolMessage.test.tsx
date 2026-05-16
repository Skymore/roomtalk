// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { CocoToolMessage } from './CocoToolMessage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseMessage: Message = {
  id: 'tool-1',
  clientId: 'coco_runner',
  content: '',
  roomId: 'room-1',
  timestamp: '2026-05-16T00:00:00.000Z',
  messageType: 'tool_result',
};

describe('CocoToolMessage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders tool call arguments as formatted JSON', () => {
    render(
      <CocoToolMessage
        message={{
          ...baseMessage,
          messageType: 'tool_call',
          toolName: 'Read',
          toolArgs: { file_path: 'README.md' },
        }}
      />
    );

    expect(screen.getByText('toolCall')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText(/README\.md/)).toBeTruthy();
  });

  it('collapses long tool output and expands on demand', () => {
    const output = 'x'.repeat(1200);
    render(
      <CocoToolMessage
        message={{
          ...baseMessage,
          toolName: 'Shell',
          toolOutputPreview: output,
          exitCode: 1,
          isError: true,
        }}
      />
    );

    expect(screen.getByText('toolResultFailed')).toBeTruthy();
    expect(screen.getByText('showMore')).toBeTruthy();
    expect(screen.getByText(/xxx\.\.\./)).toBeTruthy();

    fireEvent.click(screen.getByText('showMore'));

    expect(screen.getByText('showLess')).toBeTruthy();
    expect(screen.getByText(output)).toBeTruthy();
  });

  it('renders sandbox status messages without output chrome', () => {
    render(
      <CocoToolMessage
        message={{
          ...baseMessage,
          messageType: 'sandbox_status',
          content: 'sandbox ready',
        }}
      />
    );

    expect(screen.getByText('sandboxStatusEvent')).toBeTruthy();
    expect(screen.getByText('sandbox ready')).toBeTruthy();
    expect(screen.queryByText('emptyToolOutput')).toBeNull();
  });
});

