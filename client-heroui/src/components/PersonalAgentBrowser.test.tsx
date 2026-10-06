import { Blob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonalAgentBrowserControl, PersonalAgentBrowserVisits } from './PersonalAgentBrowser';
import type { RoomAgentTurn } from '../utils/types';
const api = vi.hoisted(() => ({ actInPersonalBrowser: vi.fn(), takePersonalBrowserControl: vi.fn(), releasePersonalBrowserControl: vi.fn(),
  readPersonalBrowserObservations: vi.fn(), readPersonalBrowserImage: vi.fn(), translate: (key: string) => key }));
vi.mock('../utils/personalAgent', () => api);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: api.translate }) }));
vi.mock('@iconify/react', () => ({ Icon: ({ icon }: { icon: string }) => <span data-icon={icon} /> }));
Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:private-screenshot') });
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
const held = { id: 'control', fence: 7 };
const turn: RoomAgentTurn = { id: 'turn', roomId: 'room', status: 'complete', startedAt: '2026-10-06T10:00:00Z', updatedAt: '2026-10-06T10:01:00Z', backend: 'codex-app-server', assistantName: 'Codex' };
const visit = { id: 'visit', roomId: 'room', turnId: 'turn', url: 'https://example.org/original', title: 'Original source', createdAt: turn.startedAt };
const frame = { session: { id: 'session', roomId: 'room', url: 'https://example.org/current', title: 'Current page', updatedAt: turn.updatedAt }, screenshot: 'actual-jpeg-bytes', viewport: { width: 1280, height: 800 }, closed: false };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const setupControl = () => { api.takePersonalBrowserControl.mockResolvedValue({ control: held }); api.releasePersonalBrowserControl.mockResolvedValue({ released: true }); api.actInPersonalBrowser.mockResolvedValue(frame); };
describe('personal browser view', () => {
  it('hydrates the original source image on replay and labels live takeover with the current page', async () => {
    setupControl(); api.readPersonalBrowserObservations.mockResolvedValue({ observations: [visit], total: 1 }); api.readPersonalBrowserImage.mockResolvedValue(new Blob(['image']));
    render(<PersonalAgentBrowserVisits clientId="owner" turn={turn} canInteract />);
    await screen.findByText(visit.url); await screen.findByAltText('Original source');
    expect(api.readPersonalBrowserObservations).toHaveBeenCalledWith('owner', 'room', 'turn');
    expect(api.readPersonalBrowserImage).toHaveBeenCalledWith('owner', 'visit');
    fireEvent.click(screen.getByRole('button', { name: 'personalBrowserTakeControl' }));
    await screen.findByText('Current page'); expect(screen.getByLabelText('personalBrowserAddress')).toHaveProperty('value', frame.session.url);
    expect(screen.getByText(visit.url)).toBeTruthy(); expect(api.actInPersonalBrowser).toHaveBeenCalledWith('owner', 'room', held, { action: 'read' });
  });
  it('retains typed text after failure and waits for actual control release before returning to chat', async () => {
    setupControl(); const closed = vi.fn();
    render(<PersonalAgentBrowserControl clientId="owner" roomId="room" isOpen onClose={closed} />);
    await screen.findByText('Current page');
    const input = screen.getByLabelText('personalBrowserText');
    api.actInPersonalBrowser.mockRejectedValueOnce(new Error('Action did not finish'));
    fireEvent.change(input, { target: { value: 'Text still here' } }); fireEvent.submit(input.closest('form')!);
    await screen.findByText('Action did not finish'); expect(input).toHaveProperty('value', 'Text still here');
    let release!: () => void;
    api.releasePersonalBrowserControl.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ released: true }); }));
    fireEvent.click(screen.getByRole('button', { name: 'personalBrowserReturn' }));
    await waitFor(() => expect(api.releasePersonalBrowserControl).toHaveBeenCalledWith('owner', 'room', held));
    expect(closed).not.toHaveBeenCalled(); release(); await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });
  it('drops source cards and stops fetching when room access is lost', async () => {
    api.readPersonalBrowserObservations.mockResolvedValue({ observations: [visit], total: 1 }); api.readPersonalBrowserImage.mockResolvedValue(new Blob(['image']));
    const view = render(<PersonalAgentBrowserVisits clientId="owner" turn={turn} canInteract />);
    await screen.findByText(visit.url); api.readPersonalBrowserObservations.mockClear();
    view.rerender(<PersonalAgentBrowserVisits clientId="owner" turn={turn} canInteract={false} />);
    await waitFor(() => expect(screen.queryByTestId('personal-browser-visit')).toBeNull());
    expect(api.readPersonalBrowserObservations).not.toHaveBeenCalled();
  });
  it('releases a control grant arriving after its view has closed', async () => {
    let grant!: () => void;
    api.takePersonalBrowserControl.mockImplementationOnce(() => new Promise(resolve => { grant = () => resolve({ control: held }); }));
    api.releasePersonalBrowserControl.mockResolvedValue({ released: true });
    const view = render(<PersonalAgentBrowserControl clientId="owner" roomId="room" isOpen onClose={() => {}} />);
    view.unmount(); grant(); await waitFor(() => expect(api.releasePersonalBrowserControl).toHaveBeenCalledWith('owner', 'room', held));
    expect(api.actInPersonalBrowser).not.toHaveBeenCalled();
  });
});
