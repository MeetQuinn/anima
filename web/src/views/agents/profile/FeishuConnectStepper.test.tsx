import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuConnectStepper } from './FeishuConnectStepper';

const api = vi.hoisted(() => ({
  connect: vi.fn(),
  refresh: vi.fn(),
  register: vi.fn(),
}));

vi.mock('@/api/agents', () => ({
  connectAgentFeishu: api.connect,
  refreshDashboardData: api.refresh,
  startAgentFeishuAppRegistration: api.register,
}));

describe('FeishuConnectStepper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.connect.mockResolvedValue({});
  });

  it('notes the long-lived connection requirement and reports saved credentials on the existing-app path', async () => {
    render(<FeishuConnectStepper agentId="scout" agentName="Scout" />);

    fireEvent.click(screen.getByRole('button', { name: 'Use an existing app' }));
    expect(
      screen.getByText(
        'Find these under Credentials & Basic Info in the Feishu Developer Console. The app must receive events over a long-lived connection.',
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_synthetic' } });
    fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'secret_synthetic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Feishu app' }));

    await waitFor(() => expect(api.connect).toHaveBeenCalledWith('scout', {
      appId: 'cli_synthetic',
      appSecret: 'secret_synthetic',
    }));
    expect(await screen.findByText('Feishu app saved.')).toBeTruthy();
  });
});
