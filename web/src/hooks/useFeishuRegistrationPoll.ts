import { useCallback, useEffect, useRef } from 'react';

import { fetchAgentFeishuAppRegistration } from '@/api/agents';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';

const DEFAULT_INTERVAL_MS = 2000;

const ACTIVE_STATES: AgentFeishuRegisterAppStatus['state'][] = [
  'starting',
  'waiting',
  'slow_down',
  'domain_switched',
];

export function isFeishuRegistrationActive(
  registration: AgentFeishuRegisterAppStatus | null | undefined,
): boolean {
  return Boolean(registration && ACTIVE_STATES.includes(registration.state));
}

interface FeishuRegistrationPollOptions {
  agentId: string;
  enabled?: boolean;
  intervalMs?: number;
  isCurrentRun?: () => boolean;
  onError?: (err: unknown) => void;
  onStatus?: (status: AgentFeishuRegisterAppStatus) => void;
  registration?: AgentFeishuRegisterAppStatus | null;
  shouldPoll?: (status: AgentFeishuRegisterAppStatus) => boolean;
}

interface FeishuRegistrationPollUntilOptions {
  agentId?: string;
  isCurrentRun?: () => boolean;
  onStatus?: (status: AgentFeishuRegisterAppStatus) => void;
  shouldContinue: (status: AgentFeishuRegisterAppStatus) => boolean;
}

export function useFeishuRegistrationPoll({
  agentId,
  enabled = true,
  intervalMs = DEFAULT_INTERVAL_MS,
  isCurrentRun,
  onError,
  onStatus,
  registration,
  shouldPoll = isFeishuRegistrationActive,
}: FeishuRegistrationPollOptions) {
  const mountedRef = useRef(false);
  const isCurrentRunRef = useRef(isCurrentRun);
  const onErrorRef = useRef(onError);
  const onStatusRef = useRef(onStatus);
  const shouldPollRef = useRef(shouldPoll);

  useEffect(() => {
    isCurrentRunRef.current = isCurrentRun;
    onErrorRef.current = onError;
    onStatusRef.current = onStatus;
    shouldPollRef.current = shouldPoll;
  }, [isCurrentRun, onError, onStatus, shouldPoll]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = useCallback(
    (check?: () => boolean) => mountedRef.current && (check ? check() : true),
    [],
  );

  const pollUntil = useCallback(
    async (
      initial: AgentFeishuRegisterAppStatus,
      options: FeishuRegistrationPollUntilOptions,
    ): Promise<AgentFeishuRegisterAppStatus | null> => {
      let next = initial;
      while (options.shouldContinue(next)) {
        await delay(intervalMs);
        if (!isCurrent(options.isCurrentRun)) return null;
        next = await fetchAgentFeishuAppRegistration(options.agentId ?? agentId, next.registrationId);
        if (!isCurrent(options.isCurrentRun)) return null;
        options.onStatus?.(next);
      }
      return next;
    },
    [agentId, intervalMs, isCurrent],
  );

  useEffect(() => {
    if (!enabled || !registration?.registrationId || !shouldPollRef.current(registration)) {
      return undefined;
    }

    let stopped = false;
    const timer = window.setInterval(() => {
      void fetchAgentFeishuAppRegistration(agentId, registration.registrationId)
        .then((next) => {
          if (stopped || !isCurrent(isCurrentRunRef.current)) return;
          if (!shouldPollRef.current(next)) {
            stopped = true;
            window.clearInterval(timer);
          }
          onStatusRef.current?.(next);
        })
        .catch((err) => {
          if (stopped || !isCurrent(isCurrentRunRef.current)) return;
          onErrorRef.current?.(err);
        });
    }, intervalMs);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    agentId,
    enabled,
    intervalMs,
    isCurrent,
    registration?.registrationId,
    registration,
  ]);

  return { pollUntil };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
