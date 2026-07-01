// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODE_AGENT_CHAT_INLINE_CHIP_CLASS_NAME,
  CODE_AGENT_CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  CODE_AGENT_COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from './codeAgentComposerInlineChip';
import {
  CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME,
  CODE_AGENT_FILE_TAG_CHIP_CLASS_NAME,
  CodeAgentFileTagChipContent,
} from './CodeAgentFileTagChip';

describe('CodeAgentFileTagChip', () => {
  afterEach(() => {
    cleanup();
    document.getElementById('roomtalk-pierre-file-icon-sprite')?.remove();
  });

  it('reuses T3-style inline chip classes for file chips', () => {
    expect(CODE_AGENT_FILE_TAG_CHIP_CLASS_NAME).toBe(CODE_AGENT_COMPOSER_INLINE_CHIP_CLASS_NAME);
    expect(CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME).toBe(CODE_AGENT_CHAT_INLINE_CHIP_CLASS_NAME);
  });

  it('renders T3-style chat and composer file chip content', () => {
    render(
      <>
        <span data-testid="chat-chip">
          <CodeAgentFileTagChipContent
            path="package.json"
            label="package.json"
            theme="light"
            selectable
          />
        </span>
        <span data-testid="composer-chip">
          <CodeAgentFileTagChipContent
            path="src/App.tsx"
            label="App.tsx"
            theme="dark"
          />
        </span>
      </>,
    );

    const chatLabel = screen.getByText('package.json');
    const composerLabel = screen.getByText('App.tsx');
    expect(chatLabel.className).toBe(CODE_AGENT_CHAT_INLINE_CHIP_LABEL_CLASS_NAME);
    expect(composerLabel.className).toBe(CODE_AGENT_COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME);
    expect(screen.getByTestId('chat-chip').querySelector('[data-pierre-icon]')?.classList.toString())
      .toContain(CODE_AGENT_COMPOSER_INLINE_CHIP_ICON_CLASS_NAME.split(' ')[0]);
  });
});
