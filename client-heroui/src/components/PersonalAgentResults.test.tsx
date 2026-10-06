import { Blob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonalAgentResults } from './PersonalAgentResults';
import type { PersonalAgentResult } from '../utils/personalAgent';
import type { RoomAgentTurn } from '../utils/types';

const api = vi.hoisted(() => ({ readPersonalAgentResults: vi.fn(), readPersonalAgentResultFile: vi.fn(), translate: (key: string) => key }));
vi.mock('../utils/personalAgent', () => api);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: api.translate }) }));
vi.mock('@iconify/react', () => ({ Icon: ({ icon }: { icon: string }) => <span data-icon={icon} /> }));
vi.mock('./MarkdownContent', () => ({ MarkdownContent: ({ content }: { content: string }) => <div>{content}</div> }));
const turn: RoomAgentTurn = { id: 'turn', roomId: 'room', status: 'complete', startedAt: '2026-10-06T10:00:00Z', updatedAt: '2026-10-06T10:01:00Z', backend: 'codex-app-server', assistantName: 'Codex' };
const result: PersonalAgentResult = { id: 'saved', roomId: 'room', turnId: 'turn', kind: 'plan', title: 'Confirmed plan', summary: 'Real next steps', filename: 'plan.md', mimeType: 'text/markdown', byteSize: 40, createdAt: turn.startedAt };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('private result cards', () => {
  it('loads saved records on replay and opens the actual persisted plan', async () => {
    api.readPersonalAgentResults.mockResolvedValue({ results: [result], total: 1 });
    api.readPersonalAgentResultFile.mockResolvedValue(new Blob(['# Verified plan\nMonday: confirmed work']));
    render(<PersonalAgentResults clientId="owner" turn={turn} canInteract />);
    await screen.findByText(result.title);
    expect(api.readPersonalAgentResults).toHaveBeenCalledWith('owner', 'room', 'turn');
    fireEvent.click(screen.getByRole('button', { name: 'personalResultOpen' }));
    await screen.findByText(/Monday: confirmed work/);
    expect(api.readPersonalAgentResultFile).toHaveBeenCalledWith('owner', 'saved');
  });
  it('keeps missing files visible as an error and retries saved-record loading', async () => {
    api.readPersonalAgentResults.mockRejectedValueOnce(new Error('Temporary unavailable')).mockResolvedValue({ results: [result], total: 1 });
    api.readPersonalAgentResultFile.mockRejectedValue(new Error('Saved file unavailable'));
    render(<PersonalAgentResults clientId="owner" turn={turn} canInteract />);
    await screen.findByText('Temporary unavailable'); fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await screen.findByText(result.title); fireEvent.click(screen.getByRole('button', { name: 'personalResultOpen' }));
    await screen.findByText('Saved file unavailable'); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('runs a web result in an opaque frame and stops requesting data after access is lost', async () => {
    const web = { ...result, kind: 'web' as const, filename: 'page.html', mimeType: 'text/html' };
    api.readPersonalAgentResults.mockResolvedValue({ results: [web], total: 1 });
    api.readPersonalAgentResultFile.mockResolvedValue(new Blob(['<h1>Actual saved web page</h1><script>document.body.dataset.loaded="yes"</script>']));
    const view = render(<PersonalAgentResults clientId="owner" turn={turn} canInteract />);
    await screen.findByText(result.title); fireEvent.click(screen.getByRole('button', { name: 'personalResultOpen' }));
    await waitFor(() => expect(screen.getByTitle(result.title).getAttribute('srcdoc')).toContain('Actual saved web page'));
    expect(screen.getByTitle(result.title).getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.getByTitle(result.title).getAttribute('srcdoc')).toContain('Content-Security-Policy');
    api.readPersonalAgentResults.mockClear();
    view.rerender(<PersonalAgentResults clientId="owner" turn={turn} canInteract={false} />);
    await waitFor(() => expect(screen.queryByTestId('personal-result-card')).toBeNull());
    expect(api.readPersonalAgentResults).not.toHaveBeenCalled();
  });
});
