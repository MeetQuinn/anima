import { useEffect, useReducer, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

export function useFeishuOnboardingBanners(input: {
  agentId: string | undefined;
  feishuConnKey: string | undefined;
  connectedPlatform: 'feishu' | 'slack' | undefined;
}) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const landingState = location.state as
    | { onboardingConnected?: 'feishu' | 'slack'; feishuGreetingBanner?: boolean }
    | null;
  const justConnectedFeishu = landingState?.onboardingConnected === 'feishu';
  const landingWantsBanner = justConnectedFeishu && landingState?.feishuGreetingBanner === true;
  const previewHelloBanner = import.meta.env.DEV && searchParams.get('_previewHelloBanner') === '1';
  const [, forceHelloRerender] = useReducer((n: number) => n + 1, 0);
  const landingProcessedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!justConnectedFeishu) return;
    if (landingProcessedRef.current === location.key) return;
    if (!input.agentId || !input.feishuConnKey) return;
    try {
      localStorage.setItem(`feishu-recommended-scopes-armed:${input.agentId}`, input.feishuConnKey);
    } catch {
      /* localStorage unavailable */
    }
    if (landingWantsBanner) {
      try {
        localStorage.setItem(`feishu-hello-armed:${input.agentId}`, input.feishuConnKey);
      } catch {
        /* localStorage unavailable */
      }
    }
    landingProcessedRef.current = location.key;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [
    justConnectedFeishu,
    landingWantsBanner,
    location.key,
    location.pathname,
    location.search,
    input.agentId,
    input.feishuConnKey,
    navigate,
  ]);

  const helloPersisted = (() => {
    if (!input.agentId || !input.feishuConnKey) return { armed: false, dismissed: false };
    try {
      return {
        armed: localStorage.getItem(`feishu-hello-armed:${input.agentId}`) === input.feishuConnKey,
        dismissed:
          localStorage.getItem(`feishu-hello-dismissed:${input.agentId}`) === input.feishuConnKey,
      };
    } catch {
      return { armed: false, dismissed: false };
    }
  })();
  const recommendedPermissionsPersisted = (() => {
    if (!input.agentId || !input.feishuConnKey) return { armed: false, dismissed: false };
    try {
      return {
        armed:
          localStorage.getItem(`feishu-recommended-scopes-armed:${input.agentId}`) ===
          input.feishuConnKey,
        dismissed:
          localStorage.getItem(`feishu-recommended-scopes-dismissed:${input.agentId}`) ===
          input.feishuConnKey,
      };
    } catch {
      return { armed: false, dismissed: false };
    }
  })();

  function dismissHelloBanner() {
    if (input.agentId && input.feishuConnKey) {
      try {
        localStorage.setItem(`feishu-hello-dismissed:${input.agentId}`, input.feishuConnKey);
      } catch {
        /* localStorage unavailable */
      }
    }
    forceHelloRerender();
  }

  function dismissRecommendedPermissionsBanner() {
    if (input.agentId && input.feishuConnKey) {
      try {
        localStorage.setItem(
          `feishu-recommended-scopes-dismissed:${input.agentId}`,
          input.feishuConnKey,
        );
      } catch {
        /* localStorage unavailable */
      }
    }
    forceHelloRerender();
  }

  const showHelloBanner =
    previewHelloBanner ||
    ((landingWantsBanner || helloPersisted.armed) && !helloPersisted.dismissed);

  const shouldCheckRecommendedPermissions = Boolean(
    input.agentId &&
      recommendedPermissionsPersisted.armed &&
      !recommendedPermissionsPersisted.dismissed &&
      input.connectedPlatform === 'feishu',
  );

  return {
    recommendedPermissionsPersisted,
    dismissHelloBanner,
    dismissRecommendedPermissionsBanner,
    showHelloBanner,
    shouldCheckRecommendedPermissions,
  };
}
