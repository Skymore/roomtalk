// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { CodeAgentToolMessage } from './CodeAgentToolMessage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseMessage: Message = {
  id: 'tool-1',
  clientId: 'code_agent_runner',
  content: '',
  roomId: 'room-1',
  timestamp: '2026-05-16T00:00:00.000Z',
  messageType: 'tool_result',
};

describe('CodeAgentToolMessage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders tool call arguments as structured fields instead of raw JSON', () => {
    render(
      <CodeAgentToolMessage
        message={{
          ...baseMessage,
          messageType: 'tool_call',
          toolName: 'Read',
          toolArgs: { file_path: 'README.md' },
        }}
      />
    );

    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText(/README\.md/)).toBeTruthy();

    fireEvent.click(screen.getByText('Read'));

    expect(screen.getByText('toolFile')).toBeTruthy();
    expect(document.body.textContent).toContain('README.md');
    expect(document.body.textContent).not.toContain('"file_path"');
  });

  it('renders writable file content as a highlighted code block', () => {
    render(
      <CodeAgentToolMessage
        message={{
          ...baseMessage,
          messageType: 'tool_call',
          toolName: 'Write',
          toolArgs: {
            file_path: 'hello.py',
            content: '#!/usr/bin/env python3\nprint("Hello, World!")',
          },
        }}
      />
    );

    fireEvent.click(screen.getByText('Write'));

    expect(screen.getByText('toolFile')).toBeTruthy();
    expect(screen.getByText('toolContent')).toBeTruthy();
    expect(document.body.textContent).toContain('hello.py');
    expect(document.body.textContent).toContain('python');
    expect(document.body.textContent).toContain('Hello, World!');
    expect(document.body.textContent).not.toContain('"content"');
  });

  it('renders BackgroundShell as a terminal tool with structured arguments', () => {
    render(
      <CodeAgentToolMessage
        message={{
          ...baseMessage,
          messageType: 'tool_call',
          toolName: 'BackgroundShell',
          toolArgs: {
            action: 'start',
            name: 'flask-app',
            command: 'python3 app.py',
            ports: [5000],
          },
        }}
      />
    );

    expect(screen.getByText('BackgroundShell')).toBeTruthy();
    expect(screen.getByText(/python3 app\.py/)).toBeTruthy();

    fireEvent.click(screen.getByText('BackgroundShell'));

    expect(screen.getByText('toolCommand')).toBeTruthy();
    expect(document.body.textContent).toContain('python3 app.py');
    expect(document.body.textContent).toContain('Ports');
    expect(document.body.textContent).toContain('- 5000');
    expect(document.body.textContent).not.toContain('"command"');
  });

  it('collapses long tool output and expands on demand', () => {
    const output = 'x'.repeat(1201);
    render(
      <CodeAgentToolMessage
        message={{
          ...baseMessage,
          toolName: 'Shell',
          toolOutputPreview: output,
          exitCode: 1,
          isError: true,
        }}
      />
    );

    expect(screen.getByText('Shell')).toBeTruthy();
    expect(screen.queryByText('toolResultFailed')).toBeNull();

    fireEvent.click(screen.getByText('Shell'));

    expect(screen.getByText('toolResultFailed')).toBeTruthy();
    expect(screen.getByText('showMore')).toBeTruthy();
    expect(document.body.textContent).toContain(`${'x'.repeat(1200)}…`);

    fireEvent.click(screen.getByText('showMore'));

    expect(screen.getByText('showLess')).toBeTruthy();
    expect(document.body.textContent).toContain(output);
  });

  it('renders sandbox status messages without output chrome', () => {
    render(
      <CodeAgentToolMessage
        message={{
          ...baseMessage,
          messageType: 'sandbox_status',
          content: 'sandbox ready',
        }}
      />
    );

    expect(screen.getByText('sandbox ready')).toBeTruthy();
    expect(screen.queryByText('sandboxStatusEvent')).toBeNull();
    expect(screen.queryByText('emptyToolOutput')).toBeNull();
  });
});
