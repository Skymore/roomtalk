// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2UIPayload } from '../utils/types';
import { A2UIRenderer } from './A2UIRenderer';

const payload: A2UIPayload = {
  format: 'a2ui',
  version: 'v0.9',
  messages: [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId: 'surface-1',
        catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json',
      },
    },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'surface-1',
        components: [
          { id: 'root', component: 'Card', child: 'body' },
          { id: 'body', component: 'Column', children: ['title', 'cta'] },
          { id: 'title', component: 'Text', text: { path: '/title' }, variant: 'h2' },
          {
            id: 'cta',
            component: 'Button',
            variant: 'primary',
            child: 'cta_text',
            action: {
              event: {
                name: 'create_task',
                context: { title: 'Implement A2UI' },
              },
            },
          },
          { id: 'cta_text', component: 'Text', text: 'Create task' },
        ],
      },
    },
    {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'surface-1',
        path: '/',
        value: {
          title: 'A2UI summary',
        },
      },
    },
  ],
};

describe('A2UIRenderer', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders official A2UI components and sends actions through the callback', async () => {
    const onAction = vi.fn();
    render(
      <A2UIRenderer
        payload={payload}
        roomId="room-1"
        messageId="message-1"
        onAction={onAction}
      />,
    );

    expect(await screen.findByText('A2UI summary')).toBeTruthy();

    fireEvent.click(screen.getByText('Create task'));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toMatchObject({
      name: 'create_task',
      surfaceId: 'surface-1',
      sourceComponentId: 'cta',
      context: {
        title: 'Implement A2UI',
        roomId: 'room-1',
        messageId: 'message-1',
      },
    });
  });
});
