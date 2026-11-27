import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackTokenValidation, SlackValidateResponse } from '@/api/agents';
import { SlackConnectStepper } from './SlackConnectStepper';

const api = vi.hoisted(() => ({
  connect: vi.fn(),
  validate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/api/agents', () => ({
  connectAgentSlack: api.connect,
  validateAgentSlackTokens: api.validate,
  refreshDashboardData: api.refresh,
}));

const APP_TOKEN = 'xapp-1-A0SYNTHETIC-1234567890-abcdef';
const BOT_TOKEN = 'xoxb-1234567890-1234567890-synthetic';

describe('SlackConnectStepper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      'unknown_token_type',
      'This doesn’t look like a Slack token. App-Level Tokens start with xapp- and Bot User OAuth Tokens start with xoxb-.',
    ],
    [
      'missing_connections_write',
      'This App-Level Token is missing the connections:write scope. Regenerate it under App-Level Tokens with connections:write selected.',
    ],
    [
      'wrong_token_type',
      'That’s a Bot User OAuth Token (xoxb-…). Paste the App-Level Token (xapp-…) here.',
    ],
    [
      'not_bot_token',
      'This isn’t a Bot User OAuth Token. Copy it from OAuth & Permissions in Slack (starts with xoxb-).',
    ],
  ] as const)('renders plain-text %s error with no literal Markdown backticks', async (reason, expected) => {
    api.validate.mockResolvedValue({
      app: { valid: false, expected: 'app', reason: reason as SlackTokenValidation['reason'] },
      connection: { valid: false, reason: 'incomplete' },
    } satisfies SlackValidateResponse);

    render(<SlackConnectStepper agentId="scout" />);
    fireEvent.click(screen.getByRole('button', { name: 'Use an existing app' }));
    const appInput = screen.getByLabelText('App-Level Token');
    fireEvent.change(appInput, { target: { value: APP_TOKEN } });
    fireEvent.blur(appInput);

    const message = await screen.findByText(expected);
    expect(message.textContent).not.toContain('`');
  });

  it('waits until connectAgentSlack completes before showing Connected to workspace', async () => {
    let finishConnect!: () => void;
    api.connect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishConnect = resolve;
      }),
    );
    api.validate.mockImplementation(
      async (_agentId: string, body: { appToken?: string; botToken?: string }): Promise<SlackValidateResponse> => {
        if (body.appToken && body.botToken) {
          return {
            connection: { valid: true, workspaceName: 'Demo workspace', botName: 'scout' },
          };
        }
        if (body.appToken) {
          return {
            app: { valid: true, expected: 'app', workspaceName: 'Demo workspace' },
            connection: { valid: false, reason: 'incomplete' },
          };
        }
        return {
          bot: { valid: true, expected: 'bot', botName: 'scout', workspaceName: 'Demo workspace' },
          connection: { valid: false, reason: 'incomplete' },
        };
      },
    );

    render(<SlackConnectStepper agentId="scout" />);
    fireEvent.click(screen.getByRole('button', { name: 'Use an existing app' }));

    const appInput = screen.getByLabelText('App-Level Token');
    fireEvent.change(appInput, { target: { value: APP_TOKEN } });
    fireEvent.blur(appInput);
    await screen.findByText('Demo workspace');

    const botInput = screen.getByLabelText('Bot User OAuth Token');
    fireEvent.change(botInput, { target: { value: BOT_TOKEN } });
    fireEvent.blur(botInput);

    await screen.findByText('Connecting…');
    expect(screen.queryByText(/Connected to/)).toBeNull();

    await act(async () => {
      finishConnect();
    });
    await waitFor(() => expect(screen.getByText(/Connected to/)).toBeTruthy());
    expect(screen.queryByText('Connecting…')).toBeNull();
  });
});
