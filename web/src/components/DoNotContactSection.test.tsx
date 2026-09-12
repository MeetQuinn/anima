import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactWorkspace } from '@shared/do-not-contact';
import { changeContactMember, fetchContactDirectory, fetchContactWorkspaces } from '@/api/do-not-contact';
import DoNotContactSection from './DoNotContactSection';

vi.mock('@/api/do-not-contact', () => ({
  fetchContactWorkspaces: vi.fn(), fetchContactDirectory: vi.fn(), changeContactMember: vi.fn(),
}));
const user = { slackUserId: 'U123', displayName: 'Alex', handle: 'alex' };
let workspaces: ContactWorkspace[];

beforeEach(() => {
  vi.resetAllMocks();
  workspaces = [{ id: 'T123', name: 'Example', memberIds: ['USAVED'], canLookup: true }];
  vi.mocked(fetchContactWorkspaces).mockImplementation(async () => structuredClone(workspaces));
  vi.mocked(fetchContactDirectory).mockResolvedValue({ users: [user, { ...user, slackUserId: 'U456', handle: 'alex2' }] });
  vi.mocked(changeContactMember).mockImplementation(async (id, memberId, action) => {
    const workspace = workspaces.find((w) => w.id === id)!;
    workspace.memberIds = action === 'add' ? [...workspace.memberIds, memberId] : workspace.memberIds.filter((value) => value !== memberId);
    return { ok: true };
  });
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><DoNotContactSection /></QueryClientProvider>);
}
async function openSearch() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
  return screen.findByRole('list', { name: 'Slack search results' });
}

describe('Do-not-contact section', () => {
  it('shows one workspace without a selector or token/source/Fleet concepts', async () => {
    mount();
    await screen.findByText('Example');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(/Applies to all agents in this Anima instance/)).toBeTruthy();
    expect(screen.queryByText(/Fleet|token|via Milo|through Milo|connection source/i)).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Do-not-contact members' })).getAllByText('USAVED').length).toBeGreaterThan(0);
    expect(changeContactMember).not.toHaveBeenCalled();
  });

  it('searches handles, disambiguates same names by IDs, and requires add confirmation', async () => {
    mount();
    const results = await openSearch();
    expect(within(results).getAllByText('Alex')).toHaveLength(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Slack members' }), { target: { value: '@alex2' } });
    expect(within(results).queryByText('U123')).toBeNull();
    fireEvent.click(within(results).getByRole('button', { name: /Alex.*U456/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/All agents in this Anima instance connected to Example/)).toBeTruthy();
    expect(changeContactMember).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add member' }));
    await screen.findByText('Member added. Restriction is active.');
    expect(changeContactMember).toHaveBeenCalledExactlyOnceWith('T123', 'U456', 'add');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancel and Escape never add or remove', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove USAVED' }));
    expect(within(screen.getByRole('dialog')).getByText(/lifts the restriction for all agents/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(changeContactMember).not.toHaveBeenCalled();
  });

  it('allows confirmed removal of an unresolved saved ID and refreshes the list', async () => {
    vi.mocked(fetchContactDirectory).mockRejectedValue(new Error('directory unavailable'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove USAVED' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove member' }));
    await screen.findByText('Member removed. Restriction lifted.');
    expect(changeContactMember).toHaveBeenCalledExactlyOnceWith('T123', 'USAVED', 'remove');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove USAVED' })).toBeNull());
  });

  it('a matched member whose name falls back to the ID keeps its handle and is not reported missing', async () => {
    vi.mocked(fetchContactDirectory).mockResolvedValue({ users: [user, { slackUserId: 'USAVED', displayName: 'USAVED', handle: 'real.person' }] });
    mount();
    const list = await screen.findByRole('list', { name: 'Do-not-contact members' });
    await within(list).findByText('@real.person');
    expect(within(list).queryByText(/Not found in the Slack directory/)).toBeNull();
    expect(within(list).queryByText(/Saved ID/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
  });

  it('a member missing from a loaded directory is kept and reported as not found', async () => {
    mount();
    const list = await screen.findByRole('list', { name: 'Do-not-contact members' });
    await within(list).findByText(/Not found in the Slack directory · still restricted/);
    expect(within(list).getAllByText('USAVED').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
  });

  it('directory failure retains IDs, disables adding, and offers retry', async () => {
    vi.mocked(fetchContactDirectory).mockRejectedValue(new Error('missing_scope'));
    mount();
    await screen.findByText(/Slack directory unavailable. Saved IDs remain restricted/);
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Do-not-contact members' });
    expect(within(list).getByText(/Saved ID · still restricted/)).toBeTruthy();
    expect(within(list).queryByText(/Not found in the Slack directory/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    expect(screen.queryByRole('list', { name: 'Slack search results' })).toBeNull();
    vi.mocked(fetchContactDirectory).mockResolvedValue({ users: [user] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry lookup' }));
    await screen.findByRole('list', { name: 'Slack search results' });
    expect(changeContactMember).not.toHaveBeenCalled();
  });

  it('disconnected workspaces keep their saved IDs without looking up or enabling add', async () => {
    workspaces[0]!.canLookup = false;
    mount();
    const add = await screen.findByRole('button', { name: 'Add member' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(fetchContactDirectory).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
  });

  it('config-load failure is not presented as an empty list', async () => {
    vi.mocked(fetchContactWorkspaces).mockRejectedValue(new Error('invalid config'));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByText('No members on this list.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
  });

  it('switching workspace clears search and never carries users across workspaces', async () => {
    workspaces.push({ id: 'T456', name: 'Second', memberIds: ['UOTHER'], canLookup: true });
    vi.mocked(fetchContactDirectory).mockImplementation(async (id) => ({ users: id === 'T123' ? [user] : [] }));
    mount();
    await openSearch();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Slack members' }), { target: { value: 'Alex' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Slack workspace' }), { target: { value: 'T456' } });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove UOTHER' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove USAVED' })).toBeNull();
    await waitFor(() => expect(fetchContactDirectory).toHaveBeenCalledWith('T456'));
  });

  it('write failure stays in confirmation with no optimistic restriction claim', async () => {
    vi.mocked(changeContactMember).mockRejectedValue(new Error('Could not save configuration'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove USAVED' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove member' }));
    await screen.findByText('Could not save configuration');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
    expect(screen.queryByText('Member removed. Restriction lifted.')).toBeNull();
  });

  it('an in-flight write cannot be submitted twice or dismissed by Escape', async () => {
    let done!: (value: { ok: true }) => void;
    vi.mocked(changeContactMember).mockReturnValue(new Promise((resolve) => { done = resolve; }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove USAVED' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove member' }));
    await screen.findByRole('button', { name: 'Saving…' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
    expect(changeContactMember).toHaveBeenCalledTimes(1);
    done({ ok: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
