// Activity rendering — maps an ActivityRecord to a structured row used by
// the Stream view: a colored dot, a verb-led title, an optional target, and
// a "kind" that picks the dot color. Also exports `isNarrativeStep` which
// classifies activities as visible in the default curated (conversation) view.

// OFF = conversation (curated narrative), ON = audit (full raw/debug view).
export type ActivityMode = 'conversation' | 'audit';

import { formatTimeShort } from './format';
import type { Activity as ActivityRecord } from '@shared/activity';

type ActivityKind = 'tool' | 'lifecycle' | 'failure' | 'output' | 'unknown';

interface ActivityRow {
  title: string;
  target?: string;
  // Un-truncated version of `target` when activityRow's truncate() actually
  // dropped content. The Row primitive uses this to decide whether the
  // click-to-expand affordance is meaningful: a 65-char target that wasn't
  // truncated upstream still might overflow visually on a narrow viewport,
  // but a 100-char target that ends with `…` definitely has hidden content
  // worth revealing. Consumers pass it through; Row owns the gate logic.
  targetFull?: string;
  color: string; // CSS var for the dot
  kind: ActivityKind;
}

const COLOR_TOOL = 'var(--color-activity-tool)';
const COLOR_FAILURE = 'var(--color-health-error)';
const COLOR_WORKING = 'var(--color-health-warn)';
const COLOR_IDLE = 'var(--color-health-ok)';

/**
 * Returns true when an activity step should be shown in the default curated
 * (Conversation) Activity view — i.e. "Show all steps" is OFF. These are
 * the steps that carry narrative value for a first-time reader.
 *
 * Failures always pass (activityIsFailure → true). Everything else is
 * evaluated per-type: meaningful tool completions + lifecycle closures are
 * in; started rows, provider telemetry, session stats, and rate-limit noise
 * are out.
 */
export function isNarrativeStep(activity: ActivityRecord): boolean {
  if (activityIsFailure(activity)) return true;
  if (activity.type === 'memory_coherence.outcome') return true;

  if (activity.type === 'tool.call.started') {
    // Provider runtimes emit recordToolStarted but NOT recordToolCompleted on
    // success; only recordToolFailed exists.
    // Successful file/code/web tool work has only a started record — surface
    // it as the narrative row. Failed calls also have a started row, but the
    // filteredItems dup guard in Stream.tsx suppresses the started when a
    // matching tool.call.failed (same providerToolId) exists, so only the
    // failure row shows.
    //
    // FORWARD-COMPAT: when proper tool.call.completed producer events land
    // (separate backend cleanup), Conversation should key off completed
    // (carries result/duration) and buildActivityFeed should drop the matching
    // started. At that point: remove the `tool.call.started` arm here and
    // add those tools to the `tool.call.completed` arm below. One row per
    // call in both old and new shape.
    //
    // anima.* started rows are dropped upstream in buildActivityFeed (not seen here).
    const payload = activity.payload ?? {};
    const tool = String(payload['providerToolName'] || payload['tool'] || '').toLowerCase();
    const bare = tool.replace(/^(claude|codex|kimi)\./, '');
    return [
      'read',
      'readfile',
      'readmediafile',
      'write',
      'writefile',
      'edit',
      'multiedit',
      'bash',
      'shell',
      'webfetch',
      'fetchurl',
      'websearch',
      'searchweb',
      'grep',
      'glob',
      'ls',
      'todowrite',
      'settodolist',
      'filechange',
      'strreplacefile',
      'agent',
      'skill',
      'taskcreate',
      'taskupdate',
    ].includes(bare);
  }

  if (activity.type === 'tool.call.completed' || activity.type === 'external.effect.completed') {
    const tool = String(activity.payload?.['tool'] ?? '').toLowerCase();
    const effect = String(activity.payload?.['effect'] ?? '').toLowerCase();
    if (
      effect === 'slack.message.send' ||
      effect === 'slack.message.update' ||
      effect === 'slack.file.send' ||
      effect === 'slack.reaction' ||
      effect === 'slack.ask.post'
    )
      return true;
    // anima outbound (message/file/react) → own row types, not steps.
    // anima.message.read + reminder management DO emit completed (CLI tools).
    if (tool === 'anima.message.read') return true;
    if (tool.startsWith('anima.reminder.') && tool !== 'anima.reminder.list') return true;
    // Provider file/code/web tools have no successful completed today;
    // when they do (backend cleanup), add them here and remove from started arm.
    return false;
  }

  if (activity.type === 'runtime.completed') return true; // Idle closure
  if (activity.type === 'runtime.aborted') return true; // Runtime stop/restart
  if (activity.type === 'anima.session.rotate') return true;
  if (activity.type === 'anima.subscription.add' || activity.type === 'anima.subscription.remove')
    return true;

  // agent.text = model output text surfaced as a step (e.g. Codex plain-text
  // responses). Visible in the default conversation narrative, rendered as a
  // single-line truncated Output row identical in style to Ran rows.
  if (activity.type === 'agent.text') return true;

  if (activity.type === 'runtime.event') {
    const eventType = String(activity.payload?.['eventType'] ?? '');
    // Compact events are meaningful lifecycle milestones.
    if (eventType.endsWith('.compact.started')) return true;
    if (eventType.endsWith('.compact.completed')) return true;
    if (eventType.endsWith('.compact.failed')) return true;
    // Session stats, rate limits, model routing, provider telemetry → Audit only.
    return false;
  }

  return false;
}

export function activityIsFailure(activity: ActivityRecord): boolean {
  if (activity.type === 'memory_coherence.outcome') {
    return activity.payload?.['outcome'] === 'failed';
  }
  if (
    activity.type === 'runtime.event' &&
    String(activity.payload?.['eventType'] ?? '').endsWith('.failed')
  )
    return true;
  return (
    activity.type.endsWith('.failed') ||
    activity.type === 'runtime.followup_failed' ||
    activity.type === 'runtime.steer_failed'
  );
}

export function activityRow(activity: ActivityRecord): ActivityRow {
  const payload = activity.payload ?? {};
  const tool = String(payload['providerToolName'] || payload['tool'] || '').replace(
    /^claude\./,
    '',
  );
  const normalized = tool.toLowerCase();

  if (activity.type === 'memory_coherence.outcome') {
    return memoryCoherenceOutcomeRow(payload);
  }

  if (activity.type !== 'runtime.event' && activityIsFailure(activity)) {
    const err = pickString(payload, ['summary', 'text', 'error']);
    if (activity.type === 'runtime.failed') {
      return {
        title: payload['failureSource'] === 'provider' ? 'Provider failure' : 'Run failed',
        ...truncatedTarget(err, 200),
        color: COLOR_FAILURE,
        kind: 'failure',
      };
    }
    // Follow-up append failure — always Conversation (removed from HIDDEN_TYPES).
    if (activity.type === 'runtime.followup_failed') {
      return {
        title: 'Follow-up failed',
        ...truncatedTarget(pickString(payload, ['reason', 'error']), 200),
        color: COLOR_FAILURE,
        kind: 'failure',
      };
    }
    const slackFailure = outboundFailureRow(normalized, err);
    if (slackFailure) return slackFailure;
    // For external effects, also try matching by the effect field.
    if (activity.type === 'external.effect.failed') {
      const effectFailure = outboundFailureRow(String(payload['effect'] ?? '').toLowerCase(), err);
      if (effectFailure) return effectFailure;
    }
    // A failed shell drops its most useful detail if we only show the error —
    // lead with the command, append a terse reason (exit code or first line).
    if (normalized === 'bash' || normalized === 'shell') {
      const cmd = stripShellWrapper(pickString(payload, ['command', 'target']));
      if (cmd) {
        const reason = failureReason(err);
        return {
          title: tool ? `Failed: ${tool}` : 'Failed',
          ...truncatedTarget(reason ? `${cmd} · ${reason}` : cmd, 200),
          color: COLOR_FAILURE,
          kind: 'failure',
        };
      }
    }
    const subject = pickString(payload, ['target', 'command']);
    if (subject) {
      const reason = failureReason(err);
      const inline = [subject, reason].filter(Boolean).join(' · ');
      const full = [subject, err].filter(Boolean).join('\n\n');
      return {
        title: tool ? `Failed: ${tool}` : 'Failed',
        ...truncatedTarget(inline, 200),
        ...(full && full !== inline ? { targetFull: full } : {}),
        color: COLOR_FAILURE,
        kind: 'failure',
      };
    }
    return {
      title: tool ? `Failed: ${tool}` : 'Failed',
      ...truncatedTarget(err, 200),
      color: COLOR_FAILURE,
      kind: 'failure',
    };
  }

  if (normalized === 'read' || normalized === 'readfile' || normalized === 'readmediafile')
    return tool_('Read', pickString(payload, ['target']));
  if (normalized === 'write' || normalized === 'writefile')
    return tool_('Wrote', pickString(payload, ['target']));
  if (normalized === 'edit') return tool_('Edited', pickString(payload, ['target']), pickString(payload, ['diff']));
  if (normalized === 'multiedit') return tool_('Edited', pickString(payload, ['target']), pickString(payload, ['diff']));
  if (normalized === 'grep') return tool_('Searched', pickString(payload, ['target']));
  if (normalized === 'glob') return tool_('Listed', pickString(payload, ['target']));
  if (normalized === 'ls') return tool_('Listed', pickString(payload, ['target']));
  if (normalized === 'webfetch' || normalized === 'fetchurl') return tool_('Fetched', pickString(payload, ['target']));
  if (normalized === 'websearch' || normalized === 'searchweb')
    return tool_('Searched', pickString(payload, ['target', 'query']));
  if (normalized === 'todowrite' || normalized === 'settodolist') return tool_('Updated todos');
  if (normalized === 'toolsearch') return tool_('Searched tools', pickString(payload, ['target']));

  if (normalized === 'bash' || normalized === 'shell') {
    const cmd = stripShellWrapper(pickString(payload, ['command', 'target']));
    return {
      title: 'Ran',
      ...truncatedTarget(cmd || normalized, 120),
      color: COLOR_TOOL,
      kind: 'tool',
    };
  }

  const effect = String(payload['effect'] ?? '').toLowerCase();

  if (normalized === 'anima.file.send' || effect === 'slack.file.send') {
    // Count belongs in the title (Sent file / Sent 3 files), not the target —
    // the target column is for the destination identifier.
    const fileCount = payload['fileCount'];
    const ch = pickString(payload, ['channelName']);
    const id = pickString(payload, ['channel']);
    const dest = ch ? `#${ch}` : id || undefined;
    const title =
      typeof fileCount === 'number' && fileCount !== 1 ? `Sent ${fileCount} files` : 'Sent file';
    return { title, target: dest, color: COLOR_TOOL, kind: 'tool' };
  }

  if (normalized === 'anima.message.read') {
    const ch = pickString(payload, ['channelName']);
    const display = pickString(payload, ['channelDisplayName']);
    const id = pickString(payload, ['channelId', 'channel']);
    const count = payload['messageCount'];
    const dest = ch
      ? `#${ch.replace(/^#/, '')}`
      : display
        ? display
        : id || '?';
    const slice = readSliceLabel(payload);
    const countStr = count !== undefined ? `${count} messages` : undefined;
    const target = [dest, slice, countStr].filter(Boolean).join(' · ');
    return {
      title: 'Read messages',
      target,
      color: COLOR_TOOL,
      kind: 'tool',
    };
  }

  if (normalized === 'anima.reminder.schedule') {
    const name = reminderName(payload);
    const dueAt = pickString(payload, ['nextDueAt']);
    const target = dueAt
      ? (name ? `${name} · at ${formatTimeShort(dueAt)}` : `at ${formatTimeShort(dueAt)}`)
      : name;
    return {
      title: 'Scheduled reminder',
      target,
      color: 'var(--color-activity-reminder)',
      kind: 'tool',
    };
  }
  if (normalized === 'anima.reminder.cancel') {
    return {
      title: 'Cancelled reminder',
      target: reminderName(payload),
      color: 'var(--color-activity-reminder)',
      kind: 'tool',
    };
  }
  if (normalized === 'anima.reminder.snooze') {
    // For snooze the actionable info is *when* the agent will wake again —
    // surface the new nextDueAt/snoozedUntil as a "· until <time>" suffix on
    // the reminder name. Short relative format keeps the line scannable.
    const name = reminderName(payload);
    const until = pickString(payload, ['snoozedUntil', 'nextDueAt']);
    const target = name && until ? `${name} · until ${formatTimeShort(until)}` : name;
    return {
      title: 'Snoozed reminder',
      target,
      color: 'var(--color-activity-reminder)',
      kind: 'tool',
    };
  }
  if (normalized === 'anima.reminder.list') {
    return { title: 'Listed reminders', color: 'var(--color-activity-reminder)', kind: 'tool' };
  }
  // anima.reminder.fire is normally consumed by the message-in row for a
  // reminder item (it's wake metadata, not a user-issued action). This
  // fallback only fires for defensive paths where the fire activity is
  // surfaced without an accompanying reminder event.
  if (normalized === 'anima.reminder.fire') {
    return {
      title: 'Reminder fired',
      target: reminderName(payload),
      color: 'var(--color-activity-reminder)',
      kind: 'lifecycle',
    };
  }

  if (activity.type === 'anima.subscription.add') {
    const ch = pickString(payload, ['channelName']);
    const id = pickString(payload, ['channelId']);
    const subKind = pickString(payload, ['kind']);
    const channel = ch ? `#${ch}` : id || undefined;
    const target = channel && subKind ? `${channel} · ${subKind}` : channel;
    return {
      title: 'Subscribed to',
      target,
      color: 'var(--color-activity-subscription)',
      kind: 'tool',
    };
  }
  if (activity.type === 'anima.subscription.remove') {
    const ch = pickString(payload, ['channelName']);
    const id = pickString(payload, ['channelId']);
    return {
      title: 'Unsubscribed from',
      target: ch ? `#${ch}` : id || undefined,
      color: 'var(--color-activity-subscription)',
      kind: 'tool',
    };
  }
  if (activity.type === 'anima.session.rotate') {
    const count = payload['archivedCount'];
    const note = pickString(payload, ['note']);
    const countStr =
      typeof count === 'number'
        ? `Archived ${count} provider session${count === 1 ? '' : 's'}`
        : undefined;
    const target = [countStr, note].filter(Boolean).join(' · ') || undefined;
    return {
      title: 'Session rotated',
      target,
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }

  if (activity.type === 'runtime.started') {
    return {
      title: 'Working',
      target: 'Message received',
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }
  if (activity.type === 'runtime.completed') {
    // Title 'Idle' rendered chrome-upcased = 'IDLE'; the prior 'Available'
    // target was a redundant paraphrase. One signal, not two.
    return { title: 'Idle', color: COLOR_IDLE, kind: 'lifecycle' };
  }
  if (activity.type === 'runtime.aborted') {
    // Reason-aware closure copy in the lifecycle-warn register (warm gold
    // dot, same visual family as `Session rotated` — *not* the failure
    // stack). These are expected user/system events, not bugs: the
    // runtime worker emits `runtime.aborted` on services restart
    // (shutdown), user Stop (user_stop), and idle watchdog
    // (idle_timeout). Visible in both
    // Conversation and Audit modes (user-relevant closure).
    // Plain-language copy (#49): no Unix jargon in the headline.
    const reason = pickString(payload, ['reason']);
    const title =
      reason === 'shutdown'
        ? 'Runtime restarted'
        : reason === 'user_stop'
          ? 'Stopped by user'
          : reason === 'operator_restart'
            ? 'Restarted by operator'
            : reason === 'idle_timeout'
              ? 'Idle timeout'
              : 'Runtime stopped';
    return {
      title,
      target: reason === 'idle_timeout' ? idleTimeoutTarget(payload) : undefined,
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }
  if (activity.type === 'runtime.pending') {
    // Inbound arrived while the agent was mid-item and the runtime queued
    // it. Hidden by default (same default as runtime.started / .output —
    // see activity-feed.ts HIDDEN_TYPES); surfaces in Audit show-all-steps so
    // users can explain why a reply lagged behind a busy item. Copy
    // is intentionally count-free in v1 — the row is the explanation, not
    // a queue-depth indicator.
    return { title: 'Queued behind current item', color: COLOR_TOOL, kind: 'lifecycle' };
  }
  if (activity.type === 'runtime.output') {
    // Hidden by default (HIDDEN_TYPES); only surfaces in Audit show-all.
    // Labeled 'Process output' — it's raw stdout/stderr from the provider
    // child process, not reasoning. Stream label prepended so users can
    // distinguish stdout from stderr. 300-char clamp; expand for full text.
    const stream = pickString(payload, ['stream']);
    const text = String(payload['text'] || '');
    const fullText = stream ? `[${stream}] ${text}` : text;
    return {
      title: 'Process output',
      ...truncatedTarget(fullText, 300),
      color: COLOR_TOOL,
      kind: 'output',
    };
  }
  if (activity.type === 'runtime.followup_appended') {
    // Audit-only (HIDDEN_TYPES); shows when "Show all steps" is on.
    return {
      title: 'Follow-up added to current run',
      ...truncatedTarget(String(payload['text'] || ''), 120),
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }
  if (activity.type === 'external.effect.started') {
    return { title: 'Sending', color: COLOR_TOOL, kind: 'tool' };
  }
  if (activity.type === 'external.effect.completed') {
    if (String(payload['effect'] ?? '').toLowerCase() === 'slack.ask.post') {
      const audience = pickString(payload, ['allowedUserLabel']);
      const title = payload['allowAnyone'] === true
        ? 'Asked anyone'
        : audience
          ? `Asked ${audience}`
          : 'Asked';
      return {
        title,
        ...truncatedTarget(askActivityTarget(payload), 220),
        color: COLOR_TOOL,
        kind: 'tool',
      };
    }
    const label = humanizeIdentifier(String(payload['effect'] ?? 'external.effect'));
    return { title: label, color: COLOR_TOOL, kind: 'tool' };
  }
  if (activity.type === 'external.effect.failed') {
    const err = pickString(payload, ['summary', 'text', 'error']);
    return {
      title: 'External effect failed',
      ...truncatedTarget(err, 200),
      color: COLOR_FAILURE,
      kind: 'failure',
    };
  }
  if (activity.type === 'runtime.event') {
    const eventType = String(payload['eventType'] ?? '');
    if (eventType.endsWith('.compact.started')) {
      return { title: 'Compacting context', color: COLOR_WORKING, kind: 'lifecycle' };
    }
    if (eventType.endsWith('.compact.completed')) {
      return { title: 'Context compacted', color: COLOR_IDLE, kind: 'lifecycle' };
    }
    if (eventType.endsWith('.compact.failed')) {
      return {
        title: 'Compact failed',
        ...truncatedTarget(pickString(payload, ['error']), 160),
        color: COLOR_FAILURE,
        kind: 'failure',
      };
    }
    if (eventType.endsWith('.session.stats')) {
      return {
        title: 'Session stats',
        target: sessionStatsTarget(payload),
        color: COLOR_TOOL,
        kind: 'lifecycle',
      };
    }
    const runtimeRow = runtimeEventRow(eventType, payload);
    if (runtimeRow) return runtimeRow;
  }
  if (activity.type === 'agent.text') {
    return {
      title: 'Output',
      ...truncatedTarget(String(payload['text'] || ''), 280),
      color: COLOR_TOOL,
      kind: 'output',
    };
  }

  // Specific verb mappings for well-known tools not already handled above.
  // Strip provider prefix so codex.fileChange, kimi.StrReplaceFile etc. all match.
  const bare = normalized.replace(/^(claude|codex|kimi|anima)\./, '');
  if (bare === 'filechange' || bare === 'strreplacefile') {
    return tool_('Edited', pickString(payload, ['target']), pickString(payload, ['diff']));
  }
  if (bare === 'agent') return tool_('Delegated to subagent', pickString(payload, ['target', 'description']));
  if (bare === 'skill') return tool_('Ran skill', pickString(payload, ['target', 'name']));
  if (bare === 'taskcreate') return tool_('Created task', pickString(payload, ['target', 'title']));
  if (bare === 'taskupdate') return tool_('Updated task', pickString(payload, ['target', 'title']));

  if (tool) {
    const target = pickString(payload, ['target', 'command']);
    return {
      title: `Used ${humanizeIdentifier(tool)}`,
      target: target || undefined,
      color: COLOR_TOOL,
      kind: 'tool',
    };
  }

  // Unknown activity type — return kind: 'unknown' so StepRow suppresses it
  // entirely rather than rendering an opaque "Recorded activity" placeholder.
  // Raw identifiers belong in persisted audit data, not the default stream.
  return { title: humanizeIdentifier(activity.type), color: COLOR_TOOL, kind: 'unknown' };
}

function memoryCoherenceOutcomeRow(payload: Record<string, unknown>): ActivityRow {
  const outcome = pickString(payload, ['outcome']);
  const summary = pickString(payload, ['summary']);
  const failure = pickString(payload, ['failureReason']);
  const scheduled = pickString(payload, ['scheduledSlotLabel']);
  const delay = typeof payload['delayMs'] === 'number' && payload['delayMs'] > 0
    ? `delayed ${formatDurationMinutes(payload['delayMs'])}`
    : '';
  const target = [summary || failure || scheduled, delay].filter(Boolean).join(' · ');
  if (outcome === 'failed') {
    return {
      title: 'Memory coherence failed',
      ...truncatedTarget(target, 200),
      color: COLOR_FAILURE,
      kind: 'failure',
    };
  }
  if (outcome === 'quiet_skipped') {
    return {
      title: 'Memory coherence checked',
      ...truncatedTarget(target || 'Nothing needed changing', 200),
      color: COLOR_IDLE,
      kind: 'lifecycle',
    };
  }
  return {
    title: 'Memory coherence updated',
    ...truncatedTarget(target, 200),
    color: COLOR_IDLE,
    kind: 'lifecycle',
  };
}

function tool_(title: string, target?: string, targetFull?: string): ActivityRow {
  return {
    title,
    target: target || undefined,
    ...(targetFull && targetFull !== target ? { targetFull } : {}),
    color: COLOR_TOOL,
    kind: 'tool',
  };
}

function outboundFailureRow(tool: string, error: string): ActivityRow | undefined {
  let title: string | undefined;
  if (tool === 'anima.message.send' || tool === 'slack.message.send') title = 'Message failed';
  else if (tool === 'anima.message.update' || tool === 'slack.message.update') title = 'Edit failed';
  else if (tool === 'anima.file.send' || tool === 'slack.file.send') title = 'File upload failed';
  else if (tool === 'anima.message.react' || tool === 'slack.reaction') title = 'Reaction failed';
  else if (tool === 'anima.message.read') title = 'Read failed';
  else if (tool.startsWith('anima.reminder.')) {
    const action = tool.replace('anima.reminder.', '');
    title = `Reminder ${action} failed`;
  }
  if (!title) return undefined;
  return {
    title,
    ...truncatedTarget(error, 200),
    color: COLOR_FAILURE,
    kind: 'failure',
  };
}

function runtimeEventRow(
  eventType: string,
  payload: Record<string, unknown>,
): ActivityRow | undefined {
  if (eventType === 'provider.crash.retry') {
    const attempt = payload['attempt'];
    const maxRetries = payload['maxRetries'];
    const label = typeof attempt === 'number' && typeof maxRetries === 'number'
      ? `Retry ${attempt}/${maxRetries}`
      : 'Retrying';
    const error = pickString(payload, ['error']);
    return {
      title: 'Provider retry',
      ...truncatedTarget([label, error].filter(Boolean).join(' · '), 200),
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }

  if (eventType === 'codex.model.rerouted') {
    const from = pickString(payload, ['fromModel']);
    const to = pickString(payload, ['toModel']);
    const reason = pickString(payload, ['reason']);
    const route = from && to ? `${from} → ${to}` : to || from;
    return {
      title: 'Model rerouted',
      target: [route, reason].filter(Boolean).join(' · ') || undefined,
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }

  if (eventType === 'codex.rate_limits.updated' || eventType === 'claude.rate_limit') {
    const label = pickString(payload, ['limitName', 'rateLimitType', 'status']);
    const reset = rateLimitReset(payload);
    return {
      title: 'Rate limit updated',
      target: [label, reset].filter(Boolean).join(' · ') || undefined,
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }

  if (eventType.startsWith('codex.') && eventType.toLowerCase().includes('warning')) {
    return {
      title: 'Provider warning',
      ...truncatedTarget(pickString(payload, ['message', 'summary', 'details']), 200),
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }

  if (eventType === 'claude.provider.retry' || eventType === 'claude.provider.resume_retry') {
    const reason = pickString(payload, ['reason']);
    const error = pickString(payload, ['error']);
    return {
      title: eventType.endsWith('.resume_retry') ? 'Provider resume retry' : 'Provider retry',
      ...truncatedTarget([reason, error].filter(Boolean).join(' · '), 200),
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }

  if (eventType === 'claude.session.resume_missing') {
    return {
      title: 'Provider session expired',
      target: 'Started a fresh session',
      color: COLOR_WORKING,
      kind: 'lifecycle',
    };
  }

  if (eventType === 'kimi.approval.response') {
    return {
      title: 'Approval answered',
      target: pickString(payload, ['response']),
      color: COLOR_TOOL,
      kind: 'tool',
    };
  }

  if (eventType === 'kimi.step.interrupted') {
    return { title: 'Step interrupted', color: COLOR_WORKING, kind: 'lifecycle' };
  }

  return undefined;
}

function idleTimeoutTarget(payload: Record<string, unknown>): string {
  const timeoutMs = payload['timeoutMs'];
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return 'No provider activity';
  }
  return `${formatDurationMinutes(timeoutMs)} with no provider activity`;
}

function formatDurationMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

// Codex wraps every shell command as `/bin/zsh -lc '<cmd>'` (or `-c` /
// double-quoted). The backend tries to strip this but only handles the
// well-formed case (balanced trailing quote). Recorded data also contains
// pre-fix events with the wrapper intact, so the UI normalizes again.
function stripShellWrapper(cmd: string): string {
  const m = cmd.match(/^\/\S*sh\s+-l?c\s+['"]/);
  if (!m) return cmd;
  return cmd.slice(m[0].length).replace(/['"]\s*$/, '');
}

// Reminder rows display the human-readable title; reminderId is the audit
// fallback when no title is recorded. Returns undefined for a clean
// no-target row instead of a blank string.
function reminderName(payload: Record<string, unknown>): string | undefined {
  return pickString(payload, ['title', 'reminderId']) || undefined;
}

// Read-slice labels tell the user which window the agent pulled from.
// threadTs wins (it's a thread read, not a channel history slice).
// `around` → the pivot message timestamp; `limit` alone → "last N".
function readSliceLabel(payload: Record<string, unknown>): string {
  if (payload['threadTs']) return 'thread';
  const around = pickString(payload, ['around']);
  if (around) return `around ${formatTimeShort(slackTsToIso(around))}`;
  const limit = payload['limit'];
  if (typeof limit === 'number') return `last ${limit}`;
  return '';
}

// Slack timestamps are "<unix-seconds>.<microseconds>" strings.
// Convert to an ISO string so formatTimeShort can parse them correctly.
function slackTsToIso(ts: string): string {
  const secs = Number(ts.split('.')[0]);
  if (!Number.isFinite(secs)) return ts;
  return new Date(secs * 1000).toISOString();
}

function askActivityTarget(payload: Record<string, unknown>): string {
  const question = pickString(payload, ['question', 'target']);
  const labels = Array.isArray(payload['optionLabels'])
    ? payload['optionLabels'].filter((label): label is string => typeof label === 'string' && Boolean(label.trim()))
    : [];
  const options = labels.length ? `[${labels.join(' / ')}]` : '';
  const quotedQuestion = question ? `"${question}"` : '';
  return [quotedQuestion, options].filter(Boolean).join(' - ');
}

// Short, scannable wake-time format for the audit register.
//   • same day  →  `17:00`
//   • next day  →  `tomorrow 17:00`
//   • beyond    →  `May 25 17:00`
// 24h clock to match the timestamp gutter; locale Month/Day to keep date
// disambiguation light without dragging in a full date library.

function humanizeIdentifier(value: string): string {
  const withoutPrefix = value.replace(/^(claude|codex|kimi|anima)[._-]/i, '');
  const words = withoutPrefix
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return 'tool';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function rateLimitReset(payload: Record<string, unknown>): string {
  const direct = pickString(payload, ['resetsAt']);
  if (direct) return `resets ${formatRateLimitReset(direct)}`;
  for (const key of ['primary', 'secondary']) {
    const window = payload[key];
    if (!window || typeof window !== 'object') continue;
    const resetsAt = (window as Record<string, unknown>)['resetsAt'];
    if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
      return `resets ${formatRateLimitReset(resetsAt)}`;
    }
  }
  return '';
}

function formatRateLimitReset(value: string | number): string {
  if (typeof value === 'number') {
    const d = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(d.getTime()) ? String(value) : formatTimeShort(d.toISOString());
  }
  return formatTimeShort(value);
}

function pickString(payload: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function sessionStatsTarget(payload: Record<string, unknown>): string | undefined {
  const parts = [
    pickString(payload, ['model']),
    formatMetric('context', payload['contextWindow']),
    formatMetric('cached', payload['cacheReadInputTokens']),
    formatMetric('output', payload['outputTokens']),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function formatMetric(label: string, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `${label} ${formatCount(value)}`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd() + '…';
}

// Condense a tool-failure error into a short reason for the target tail.
// Prefer a clean exit code; otherwise the first non-empty line, clipped.
function failureReason(err: string): string {
  if (!err) return '';
  const exit = err.match(/exit(?: code)? (\d+)/i);
  if (exit) return `exit ${exit[1]}`;
  const firstLine =
    err
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return truncate(firstLine, 60);
}

// Compute display target + (only when truncation happened) the full text.
// Empty input collapses to no target so we never render an empty secondary.
function truncatedTarget(text: string, max: number): { target?: string; targetFull?: string } {
  if (!text) return {};
  const target = truncate(text, max);
  return target === text ? { target } : { target, targetFull: text };
}
