// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { A2UIPayload } from '../utils/types';
import { A2UIRenderer } from './A2UIRenderer';

const a2uiStyles = readFileSync('src/components/A2UIRenderer.css', 'utf8');

const relativeLuminance = (hex: string) => {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
};

const contrastRatio = (first: string, second: string) => {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
};

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
          {
            id: 'body',
            component: 'Column',
            children: [
              'header',
              'intro',
              'media',
              'tabs',
              'details_modal',
              'divider',
              'cta_row',
            ],
            align: 'stretch',
          },
          { id: 'header', component: 'Row', children: ['status_icon', 'title'], align: 'center' },
          { id: 'status_icon', component: 'Icon', name: 'info' },
          { id: 'title', component: 'Text', text: { path: '/title' }, variant: 'h2' },
          { id: 'intro', component: 'Text', text: 'Official **basic catalog** coverage', variant: 'body' },
          { id: 'media', component: 'Row', children: ['image', 'audio', 'video'], align: 'stretch' },
          {
            id: 'image',
            component: 'Image',
            url: 'https://placehold.co/320x180/png?text=A2UI',
            description: 'A2UI placeholder',
            fit: 'cover',
            variant: 'smallFeature',
          },
          {
            id: 'audio',
            component: 'AudioPlayer',
            url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3',
            description: 'Sample audio',
          },
          {
            id: 'video',
            component: 'Video',
            url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
          },
          {
            id: 'tabs',
            component: 'Tabs',
            tabs: [
              { title: 'Inputs', child: 'inputs' },
              { title: 'Summary', child: 'summary_tab' },
            ],
          },
          {
            id: 'inputs',
            component: 'Column',
            children: ['name', 'ready', 'choice', 'confidence', 'deadline'],
            align: 'stretch',
          },
          { id: 'name', component: 'TextField', label: 'Name', value: { path: '/name' }, variant: 'shortText' },
          { id: 'ready', component: 'CheckBox', label: 'Ready', value: { path: '/ready' } },
          {
            id: 'choice',
            component: 'ChoicePicker',
            label: 'Channel',
            variant: 'mutuallyExclusive',
            options: [
              { label: 'Email', value: 'email' },
              { label: 'Chat', value: 'chat' },
            ],
            value: { path: '/channels' },
            displayStyle: 'chips',
          },
          { id: 'confidence', component: 'Slider', label: 'Confidence', min: 0, max: 100, value: { path: '/confidence' } },
          { id: 'deadline', component: 'DateTimeInput', label: 'Deadline', value: { path: '/deadline' }, enableDate: true, enableTime: true },
          { id: 'summary_tab', component: 'List', children: ['summary_item'], direction: 'vertical' },
          { id: 'summary_item', component: 'Text', text: 'All components process without renderer errors.' },
          { id: 'details_modal', component: 'Modal', trigger: 'details_trigger', content: 'details_content' },
          {
            id: 'details_trigger',
            component: 'Button',
            variant: 'default',
            child: 'details_trigger_text',
            action: {
              event: {
                name: 'open_details',
                context: { surface: 'catalog' },
              },
            },
          },
          { id: 'details_trigger_text', component: 'Text', text: 'Open details' },
          { id: 'details_content', component: 'Card', child: 'details_text' },
          { id: 'details_text', component: 'Text', text: 'Modal details' },
          { id: 'divider', component: 'Divider' },
          { id: 'cta_row', component: 'Row', children: ['cta'], align: 'center', justify: 'end' },
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
          name: 'RoomTalk',
          ready: true,
          channels: ['chat'],
          confidence: 88,
          deadline: '2026-06-13T12:00:00-07:00',
        },
      },
    },
  ],
};

describe('A2UIRenderer', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps generated action labels at WCAG AA contrast in both themes', () => {
    expect(a2uiStyles).toContain('--a2ui-color-primary: #ad5237');
    expect(a2uiStyles).toContain('--a2ui-color-primary-hover: #b55335');
    expect(a2uiStyles).toContain('--a2ui-color-on-primary: #faf9f5');
    expect(a2uiStyles).toContain('--a2ui-color-primary: #d97757');
    expect(a2uiStyles).toContain('--a2ui-color-primary-hover: #df7653');
    expect(a2uiStyles).toContain('--a2ui-color-on-primary: #141413');
    expect(contrastRatio('#ad5237', '#faf9f5')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#b55335', '#faf9f5')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#d97757', '#141413')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#df7653', '#141413')).toBeGreaterThanOrEqual(4.5);
  });

  it('renders the full official A2UI basic catalog and sends actions through the callback', async () => {
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
        // The surface data model snapshot rides along so a follow-up turn knows
        // what the user actually entered/selected in the inputs above.
        dataModel: {
          title: 'A2UI summary',
          name: 'RoomTalk',
          ready: true,
          channels: ['chat'],
          confidence: 88,
        },
      },
    });
  });
});
