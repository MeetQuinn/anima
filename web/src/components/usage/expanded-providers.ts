const EXPANDED_PROVIDERS_KEY = 'anima.usagePanel.expandedProviders';

export function loadExpandedProviders(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_PROVIDERS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) out[key] = true;
    }
    return out;
  } catch {
    return {};
  }
}

export function persistExpandedProviders(map: Record<string, true>): void {
  try {
    window.localStorage.setItem(EXPANDED_PROVIDERS_KEY, JSON.stringify(map));
  } catch {
    // private mode: in-session state still works
  }
}
