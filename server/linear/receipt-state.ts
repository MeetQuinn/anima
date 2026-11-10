import type { LinearReceipt } from '../storage/schema/linear.store.js';

// Every receipt state change goes through these transitions. See the lifecycle on the schema.

/** A request that still owes the person an answer: received, running, or awaiting a reply after its run. */
export function isOpenRequest(r: LinearReceipt): boolean {
  return r.kind === 'request' && (r.state === 'received' || r.state === 'running' || r.state === 'awaiting');
}

/** A request that is still queued or in a run: the runtime may report status for it. */
export function isActiveRequest(r: LinearReceipt): boolean {
  return r.kind === 'request' && (r.state === 'received' || r.state === 'running');
}

/** True when a Stop has reached this receipt's work. */
export function isStopped(r: LinearReceipt): boolean {
  return r.kind === 'stop' || r.state === 'stopping' || r.state === 'stopped';
}

/** True once any Stop signal arrived for the session. */
export function sessionStopped(receipts: Iterable<LinearReceipt>, sessionId: string): boolean {
  for (const r of receipts) if (r.sessionId === sessionId && r.kind === 'stop') return true;
  return false;
}

/** A Stop reaches open requests and linked comments; finished requests keep their outcome. */
export function stopReceipt(r: LinearReceipt): LinearReceipt {
  if (isOpenRequest(r)) return { ...r, state: 'stopping', item: undefined };
  if (r.kind === 'comment' && r.state === 'linked') return { ...r, state: 'stopped' };
  return r;
}

/** A run picked the request up, directly or as an appended follow-up. */
export function startReceipt(r: LinearReceipt, runItemId: string): LinearReceipt {
  return isActiveRequest(r) ? { ...r, state: 'running', runItemId } : r;
}

/** The run that held the request put it back in the queue unseen; the run that picks it up next owns it. */
export function requeueReceipt(r: LinearReceipt): LinearReceipt {
  if (!isActiveRequest(r)) return r;
  const { runItemId: _runItemId, ...rest } = r;
  return { ...rest, state: 'received' };
}

/** The run holding the request ended. Without a reply the request now awaits one; a later turn can answer it. */
export function endRun(r: LinearReceipt): LinearReceipt {
  return isActiveRequest(r) ? { ...r, state: 'awaiting', item: undefined } : { ...r, item: undefined };
}

/** Linear accepted a closing activity that covers this receipt. A thought never closes one. */
export function closeReceipt(r: LinearReceipt, terminal?: 'stopped' | 'failed'): LinearReceipt {
  if (r.kind === 'stop') return { ...r, state: 'confirmed' };
  if (r.state === 'stopping') return { ...r, state: 'stopped', item: undefined };
  if (!isOpenRequest(r)) return r;
  return { ...r, state: terminal ?? 'answered', item: undefined };
}

/** Requests and Stop signals a session activity can cover. */
export function claimable(r: LinearReceipt, terminal?: 'stopped' | 'failed'): boolean {
  // A Stop needs a terminal receipt even when the work came through a comment. This does
  // not grant an ordinary session reply obligation.
  if (terminal === 'stopped') return r.state === 'stopping' || r.kind === 'stop' && r.state !== 'confirmed';
  if (terminal === 'failed') return isOpenRequest(r) || r.state === 'stopping';
  return isOpenRequest(r);
}

/** Requests and linked comments that still get the first "Received" activity. */
export function awaitsAcknowledgement(r: LinearReceipt): boolean {
  return isOpenRequest(r) || r.kind === 'comment' && r.state === 'linked';
}
