import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactWorkspace } from '@shared/do-not-contact';
import { changeContactMember, fetchContactDirectory, fetchContactWorkspaces } from '@/api/do-not-contact';
import OutreachLimitsPage from './OutreachLimitsPage';

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
  return render(<QueryClientProvider client={client}><OutreachLimitsPage /></QueryClientProvider>);
}
const addIn = (name: string) => screen.findByRole('button', { name: `Add a person to ${name}` });
const membersOf = (name: string) => screen.getByRole('list', { name: `Do-not-contact members · ${name}` });
async function openSearch(name = 'Example') {
  fireEvent.click(await addIn(name));
  return screen.findByRole('list', { name: `Slack search results · ${name}` });
}

describe('Outreach limits page', () => {
  it('states the policy in one sentence, instance-wide, without IDs or token/source/Fleet concepts', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Example' });
    expect(screen.getByText(/Agents will not DM or @mention the people listed here/)).toBeTruthy();
    expect(screen.getByText(/Applies to every agent in this Anima instance, per Slack workspace/)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('T123')).toBeNull();
    expect(screen.queryByText(/Fleet|token|via Milo|through Milo|connection source|per-agent|each agent's own/i)).toBeNull();
    expect(within(membersOf('Example')).getAllByText('USAVED').length).toBeGreaterThan(0);
    expect(changeContactMember).not.toHaveBeenCalled();
  });

  it('stacks every workspace as its own block with a people count and its own add control', async () => {
    workspaces.push({ id: 'T456', name: 'Second', memberIds: [], canLookup: true });
    vi.mocked(fetchContactDirectory).mockImplementation(async (id) => ({ users: id === 'T123' ? [user] : [] }));
    mount();
    await screen.findByRole('heading', { name: 'Second' });
    expect(screen.getByText('1 person')).toBeTruthy();
    expect(screen.getByText('0 people')).toBeTruthy();
    expect(screen.queryByText('T456')).toBeNull();
    expect(screen.getByText('No one listed. Agents may contact anyone in this workspace.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Do-not-contact members · Second' })).toBeNull();

    // Search opens only inside the block whose + was pressed.
    await openSearch('Second');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Search Slack members in Second' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Slack search results · Example' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close search in Second' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a person to Example' })).toBeTruthy();
  });

  it('searches handles, disambiguates same names by IDs, and requires add confirmation', async () => {
    mount();
    const results = await openSearch();
    expect(within(results).getAllByText('Alex')).toHaveLength(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Slack members in Example' }), { target: { value: '@alex2' } });
    expect(within(results).queryByText('U123')).toBeNull();
    fireEvent.click(within(results).getByRole('button', { name: /Alex.*U456/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/All agents in this Anima instance connected to Example/)).toBeTruthy();
    expect(changeContactMember).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add member' }));
    await screen.findByText('Added. Restriction is active.');
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
    await screen.findByText('Removed. Restriction lifted.');
    expect(changeContactMember).toHaveBeenCalledExactlyOnceWith('T123', 'USAVED', 'remove');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove USAVED' })).toBeNull());
  });

  it('a matched member whose name falls back to the ID keeps its handle and is not reported missing', async () => {
    vi.mocked(fetchContactDirectory).mockResolvedValue({ users: [user, { slackUserId: 'USAVED', displayName: 'USAVED', handle: 'real.person' }] });
    mount();
    const list = await screen.findByRole('list', { name: 'Do-not-contact members · Example' });
    await within(list).findByText('@real.person');
    expect(within(list).queryByText(/Not found in the Slack directory/)).toBeNull();
    expect(within(list).queryByText(/Saved ID/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
  });

  it('a member missing from a loaded directory is kept and reported as not found', async () => {
    mount();
    const list = await screen.findByRole('list', { name: 'Do-not-contact members · Example' });
    await within(list).findByText(/Not found in the Slack directory · still restricted/);
    expect(within(list).getAllByText('USAVED').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
  });

  it('directory failure retains IDs, disables adding, and offers retry', async () => {
    vi.mocked(fetchContactDirectory).mockRejectedValue(new Error('missing_scope'));
    mount();
    await screen.findByText(/Slack directory unavailable. Saved IDs remain restricted/);
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
    const list = membersOf('Example');
    expect(within(list).getByText(/Saved ID · still restricted/)).toBeTruthy();
    expect(within(list).queryByText(/Not found in the Slack directory/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a person to Example' }));
    expect(screen.queryByRole('list', { name: 'Slack search results · Example' })).toBeNull();
    vi.mocked(fetchContactDirectory).mockResolvedValue({ users: [user] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry lookup' }));
    await screen.findByRole('list', { name: 'Slack search results · Example' });
    expect(changeContactMember).not.toHaveBeenCalled();
  });

  it('disconnected workspaces keep their saved IDs without looking up or enabling add', async () => {
    workspaces[0]!.canLookup = false;
    mount();
    const add = await addIn('Example');
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(fetchContactDirectory).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
  });

  it('config-load failure is not presented as an empty list', async () => {
    vi.mocked(fetchContactWorkspaces).mockRejectedValue(new Error('invalid config'));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByText(/No one listed/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Add a person to/ })).toBeNull();
  });

  it('each block searches its own directory and never carries users across workspaces', async () => {
    workspaces.push({ id: 'T456', name: 'Second', memberIds: ['UOTHER'], canLookup: true });
    vi.mocked(fetchContactDirectory).mockImplementation(async (id) => ({ users: id === 'T123' ? [user] : [] }));
    mount();
    const first = await openSearch('Example');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Slack members in Example' }), { target: { value: 'Alex' } });
    expect(within(first).getByText('Alex')).toBeTruthy();
    const second = await openSearch('Second');
    expect(within(second).getByText('No matching members.')).toBeTruthy();
    expect(within(second).queryByText('Alex')).toBeNull();
    expect(within(membersOf('Second')).getByText('UOTHER')).toBeTruthy();
    expect(within(membersOf('Example')).getByText('USAVED')).toBeTruthy();
    await waitFor(() => expect(fetchContactDirectory).toHaveBeenCalledWith('T456'));
    // Closing one block's search leaves the other's open.
    fireEvent.click(screen.getByRole('button', { name: 'Close search in Example' }));
    expect(screen.queryByRole('textbox', { name: 'Search Slack members in Example' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Search Slack members in Second' })).toBeTruthy();
  });

  it('write failure stays in confirmation with no optimistic restriction claim', async () => {
    vi.mocked(changeContactMember).mockRejectedValue(new Error('Could not save configuration'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove USAVED' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove member' }));
    await screen.findByText('Could not save configuration');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove USAVED' })).toBeTruthy();
    expect(screen.queryByText('Removed. Restriction lifted.')).toBeNull();
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
