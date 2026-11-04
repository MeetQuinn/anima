import { memo } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronRight, CircleAlert, ExternalLink, MessageCircle, MessageCircleQuestion, MoreHorizontal, Search, SquarePen } from 'lucide-react';
import type { ActivityFeedItem, SurfaceChip } from '@/lib/activity-feed';
import type { MessageGroup } from '@/lib/message-model';
import { clockHM, dateTimeFull } from '@/lib/format';
import { MessageBody, messageGroupRowPropsEqual } from '../conversation/SlackTimeline';

function eventDisplay(item: ActivityFeedItem) {
  const kind = item.kind === 'message-in' ? item.message.linearKind : item.kind === 'message-out' ? item.linearKind : undefined;
  switch (kind) {
    case 'mention': return { label: 'mentioned this agent', Icon: ArrowDownLeft, color: 'text-activity-inbound' };
    case 'session': return { label: 'session message', Icon: MessageCircle, color: 'text-text-muted' };
    case 'session-started': return { label: 'opened a work session', Icon: MessageCircle, color: 'text-text-muted' };
    case 'notification': return { label: 'sent an update', Icon: MessageCircle, color: 'text-text-muted' };
    case 'delegation': return { label: 'delegated', Icon: ArrowDownLeft, color: 'text-activity-inbound' };
    case 'comment': return { label: 'commented', Icon: MessageCircle, color: 'text-activity-inbound' };
    case 'prompt': return { label: 'followed up', Icon: ArrowDownLeft, color: 'text-activity-inbound' };
    case 'thought': return { label: 'progress update', Icon: MoreHorizontal, color: 'text-text-muted' };
    case 'elicitation': return { label: 'asked a question', Icon: MessageCircleQuestion, color: 'text-health-warn-ink' };
    case 'response': return { label: 'sent a result', Icon: ArrowUpRight, color: 'text-health-ok' };
    case 'error': return { label: 'reported an error', Icon: CircleAlert, color: 'text-health-error' };
  }
  return { label: item.kind === 'message-in' ? 'sent a message' : 'replied', Icon: item.kind === 'message-in' ? ArrowDownLeft : ArrowUpRight, color: 'text-text-muted' };
}

export function LinearApiAction({ item, author }: { item: Extract<ActivityFeedItem, { kind: 'linear-api' }>; author: string }) {
  const { api } = item;
  const failed = api.state === 'failed';
  const notSent = api.state === 'not-sent';
  const confirmed = api.state === 'confirmed';
  const query = api.operation === 'query';
  const Icon = failed || notSent || api.state === 'unsuccessful' ? CircleAlert : query ? Search : confirmed ? Check : SquarePen;
  const color = failed || notSent || api.state === 'unsuccessful' ? 'text-health-error' : confirmed ? 'text-health-ok' : 'text-text-muted';
  return <details className="group/api -mt-0.5">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded py-1 text-[13px] marker:content-none hover:text-accent focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} aria-hidden />
      {!api.issueKey && <span className="text-[11px] text-text-subtle">Linear</span>}
      <span className="min-w-0 max-w-full break-words font-medium text-text">{api.label}</span>
      {!api.issueKey && api.issueTitle && <span className="min-w-0 max-w-full break-words text-[12px] text-text-muted">· {api.issueTitle}</span>}
      {api.detail && <span className={`min-w-0 max-w-full break-words text-[12px] ${color}`}>· {api.detail}</span>}
      {failed && <span className="text-[12px] font-medium text-health-error">· {query ? 'Read failed' : 'Failed, outcome unknown'}</span>}
      {notSent && <span className="text-[12px] font-medium text-health-error">· Not sent</span>}
      {api.state === 'unsuccessful' && <span className="text-[12px] font-medium text-health-error">· Reported unsuccessful</span>}
      {api.state === 'unconfirmed' && <span className="text-[12px] text-health-warn-ink">· Change not confirmed</span>}
      <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-[10px] text-text-subtle">Details <ChevronRight className="h-3 w-3 transition-transform group-open/api:rotate-90" aria-hidden /></span>
    </summary>
    <div className="mt-1.5 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-l-2 border-border-soft/70 py-1 pl-3 text-[12px]">
      <span className="text-text-subtle">Actor</span><span className="text-text-muted">{author}</span>
      <span className="text-text-subtle">Operation</span><code className="break-all text-[11px] text-text-muted">{api.operation}{api.fields.length ? ` · ${api.fields.join(', ')}` : ''}</code>
      <span className="text-text-subtle">Result</span><span className={color}>{api.result}</span>
    </div>
  </details>;
}

type Props = { group: MessageGroup; agentId: string; agentName?: string; heading?: SurfaceChip };
export const LinearActivityGroup = memo(LinearActivityGroupImpl, (previous: Props, next: Props) =>
  previous.agentName === next.agentName && previous.heading?.issueKey === next.heading?.issueKey
  && previous.heading?.issueTitle === next.heading?.issueTitle && previous.heading?.href === next.heading?.href
  && messageGroupRowPropsEqual(previous, next));

function LinearActivityGroupImpl({ group, agentId, agentName, heading }: Props) {
  const surface = group.surface!;
  return (
    <section aria-label={heading ? `${heading.issueKey}${heading.issueTitle ? ` · ${heading.issueTitle}` : ''}` : undefined} className={`${heading ? 'mt-5 mb-2' : 'my-2'} font-sans`}>
      {heading && <header className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 pl-16 sm:pl-[72px]">
        <span className="text-[10px] text-text-subtle">Linear</span>
        <span className="font-mono text-[12px] font-medium text-text-muted">{heading.issueKey}</span>
        {heading.href ? <a className="inline-flex min-w-0 items-baseline gap-1.5 break-words text-[14px] font-semibold leading-snug text-text underline-offset-2 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent" href={heading.href} target="_blank" rel="noreferrer" aria-label={`Open ${heading.issueKey} in Linear`}>
          <span>{heading.issueTitle ?? 'Open issue'}</span><ExternalLink className="h-3 w-3 shrink-0 self-center text-text-subtle" aria-hidden />
        </a> : heading.issueTitle && <h3 className="min-w-0 break-words text-[14px] font-semibold leading-snug text-text">{heading.issueTitle}</h3>}
      </header>}
      <div>
        {group.items.map(({ item, key }, index) => {
          const { label, Icon, color } = eventDisplay(item);
          const delegation = item.kind === 'message-in' && item.message.linearKind === 'delegation';
          const action = item.kind === 'linear-api';
          return <div key={key} className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 sm:grid-cols-[44px_minmax(0,1fr)]">
            <time dateTime={item.timestamp} title={dateTimeFull(item.timestamp)} className="pt-1 text-right font-mono text-[10px] text-text-subtle">{clockHM(item.timestamp)}</time>
            <div className={`relative min-w-0 border-l border-border-soft pl-4 ${index === group.items.length - 1 ? 'pb-1' : action ? 'pb-3' : 'pb-4'}`}>
              <span aria-hidden className="absolute -left-[3px] top-1.5 h-[5px] w-[5px] rounded-full bg-border-strong ring-[3px] ring-surface" />
              {action ? <LinearApiAction item={item} author={group.author.name} /> : <>
                <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] leading-5">
                  <span className="font-semibold text-text">{group.author.name}</span>
                  <Icon className={`h-3.5 w-3.5 ${color}`} aria-hidden />
                  <span className={color}>{label}{delegation && agentName ? ` to ${agentName}` : ''}</span>
                  {!surface.issueKey && <span className="text-[11px] text-text-subtle">· {surface.issueTitle ?? surface.label}</span>}
                </div>
                <MessageBody item={item} agentId={agentId} />
              </>}
            </div>
          </div>;
        })}
      </div>
    </section>
  );
}
