import { useState } from 'react';
import { Check, ChevronDown, Clipboard, ExternalLink, Loader2, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import {
  fetchAgentSlackManifestUpdate,
  refreshAgentData,
  upgradeAgentSlackManifest,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { copyTextToClipboard } from '@/lib/clipboard';
import { extractError } from './Primitives';

interface Props {
  agentId: string;
}

export function SlackManifestUpdateCard({ agentId }: Props) {
  const { data } = useQuery({
    queryKey: queryKeys.agentSlackManifestUpdate(agentId),
    queryFn: () => fetchAgentSlackManifestUpdate(agentId),
  });
  const [botToken, setBotToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default: this is a one-time maintenance action, not a status
  // the page should shout about. The single-line notice expands on demand.
  const [open, setOpen] = useState(false);

  if (!data?.needsUpdate) return null;

  async function copyManifestUpdate() {
    if (!data) return;
    setCopyError(null);
    try {
      await copyTextToClipboard(data.manifestUpdateYaml);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setDetailsOpen(true);
      setCopyError('Copy failed. Manifest details are open below so you can copy the full YAML manually.');
    }
  }

  async function saveUpgrade() {
    if (!botToken.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await upgradeAgentSlackManifest(agentId, { botToken: botToken.trim() });
      setBotToken('');
      refreshAgentData(agentId);
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSlackManifestUpdate(agentId) });
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-sm border border-health-warn/30 bg-health-warn-soft">
      {/* One-line notice; the whole row toggles the two-step body. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate font-serif text-[14px] font-semibold text-text">
          Slack app update available
        </span>
        <span className="shrink-0 rounded-sm border border-health-warn/30 px-1.5 py-0.5 font-mono text-[10px] text-health-warn">
          v{data.agentVersion}→v{data.currentVersion}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
      <div className="space-y-4 px-4 pb-4 pt-1">
        <div className="font-serif text-[13px] leading-snug text-text-muted">
          Shortcuts and other new features require a one-time Slack app reinstall.
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="font-sans text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
              Step 1 · Update app manifest
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void copyManifestUpdate()}
                className="inline-flex items-center gap-1 rounded-sm border border-border-soft px-2 py-1 font-sans text-[11px] text-text hover:border-border hover:bg-surface"
              >
                {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy full manifest'}
              </button>
              {data.appManifestUrl && (
                <a
                  href={data.appManifestUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-sans text-[11px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                >
                  Open App Manifest <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
          <div className="font-serif text-[13px] leading-snug text-text-muted">
            Open the Slack app manifest editor, replace its YAML with the copied manifest, then save.
          </div>
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            className="inline-flex items-center gap-1 font-sans text-[11px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted hover:decoration-text-muted/40"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
            {detailsOpen ? 'Hide manifest details' : 'Show manifest details'}
          </button>
          {detailsOpen && (
            <pre className="max-h-52 overflow-auto rounded-sm border border-border-soft bg-surface px-3 py-2 font-mono text-[11px] leading-relaxed text-text-muted">
              {data.manifestUpdateYaml}
            </pre>
          )}
          {copyError && (
            <div className="flex items-start gap-1.5 font-sans text-[12px] text-health-error">
              <X className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{copyError}</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="font-sans text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
              Step 2 · Reinstall and save token
            </div>
            {data.reinstallUrl && (
              <a
                href={data.reinstallUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 font-sans text-[11px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
              >
                Reinstall <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={botToken}
              onChange={(event) => {
                setBotToken(event.target.value);
                setError(null);
              }}
              placeholder="Paste new xoxb-… Bot User OAuth Token"
              className="min-w-0 flex-1 rounded-sm border border-border bg-muted/30 px-3 py-1.5 font-mono text-[12px] text-text placeholder:font-sans placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <Button onClick={() => void saveUpgrade()} disabled={saving || !botToken.trim()}>
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving
                </>
              ) : 'Save'}
            </Button>
          </div>
          {error && (
            <div className="flex items-start gap-1.5 font-sans text-[12px] text-health-error">
              <X className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
