import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_TABS,
  DEFAULT_TAB,
  buildPath,
  buildKbPath,
  buildKbRawPath,
  parseLocation,
  parseKbPath,
  reconcileLocation,
  type ReconcileSnapshot,
} from '../../shared/url-routes.js';

// ---------------------------------------------------------------------------
// parseLocation
// ---------------------------------------------------------------------------

test('parseLocation: bare `/` yields nulls', () => {
  assert.deepEqual(parseLocation('/'), { agentId: null, tab: null });
  assert.deepEqual(parseLocation(''), { agentId: null, tab: null });
});

test('parseLocation: `/agents/<id>` yields agentId with null tab (bootstrap canonicalizes)', () => {
  assert.deepEqual(parseLocation('/agents/nora'), { agentId: 'nora', tab: null });
});

test('parseLocation: `/agents/<id>/<tab>` parses each known tab', () => {
  for (const tab of AGENT_TABS) {
    assert.deepEqual(parseLocation(`/agents/iris/${tab}`), { agentId: 'iris', tab });
  }
});

test('parseLocation: unknown tab keeps agentId, returns tab=null so reconcile fills DEFAULT_TAB', () => {
  assert.deepEqual(parseLocation('/agents/nora/garbage'), { agentId: 'nora', tab: null });
});

test('parseLocation: non-agents prefix or extra segments → reset to nulls', () => {
  assert.deepEqual(parseLocation('/settings'), { agentId: null, tab: null });
  assert.deepEqual(parseLocation('/agents'), { agentId: null, tab: null });
  assert.deepEqual(parseLocation('/agents/nora/activity/extra'), { agentId: null, tab: null });
});

// ---------------------------------------------------------------------------
// buildPath (round-trip)
// ---------------------------------------------------------------------------

test('buildPath: null agentId → `/`', () => {
  assert.equal(buildPath({ agentId: null, tab: null }), '/');
  assert.equal(buildPath({ agentId: null, tab: 'activity' }), '/');
});

test('buildPath: agentId + tab round-trips through parseLocation', () => {
  for (const tab of AGENT_TABS) {
    const path = buildPath({ agentId: 'milo', tab });
    assert.equal(path, `/agents/milo/${tab}`);
    assert.deepEqual(parseLocation(path), { agentId: 'milo', tab });
  }
});

test('buildPath: agentId with no tab emits the canonical-pending form', () => {
  assert.equal(buildPath({ agentId: 'milo', tab: null }), '/agents/milo');
});

// ---------------------------------------------------------------------------
// reconcileLocation — covers iris's 7 routing cases
// ---------------------------------------------------------------------------

// All agents in SNAPSHOT are connected (slack.connected = true) — the normal case.
// Tokens are always redacted to "" on the wire; slack.connected is the durable signal.
const CONNECTED = { connected: true as const };
const SNAPSHOT: ReconcileSnapshot = {
  agents: [
    { id: 'anima', slack: CONNECTED },
    { id: 'iris', slack: CONNECTED },
    { id: 'milo', slack: CONNECTED },
    { id: 'nora', slack: CONNECTED },
  ],
  agentStatuses: [
    { agentId: 'anima', queueDepth: 0 },
    { agentId: 'iris', queueDepth: 0 },
    { agentId: 'milo', currentItemId: 'turn_active', queueDepth: 0 },
    { agentId: 'nora', queueDepth: 0 },
  ],
  selectedAgentId: 'iris',
};

test('reconcileLocation: bare `/` picks the currently-running agent and fills DEFAULT_TAB', () => {
  assert.deepEqual(
    reconcileLocation(SNAPSHOT, { agentId: null, tab: null }),
    { agentId: 'milo', tab: DEFAULT_TAB },
  );
});

test('reconcileLocation: bare `/` falls back to selectedAgentId when nobody is running', () => {
  const idle: ReconcileSnapshot = {
    ...SNAPSHOT,
    agentStatuses: SNAPSHOT.agentStatuses.map((s) => ({ agentId: s.agentId, queueDepth: 0 })),
  };
  assert.deepEqual(
    reconcileLocation(idle, { agentId: null, tab: null }),
    { agentId: 'iris', tab: DEFAULT_TAB },
  );
});

test('reconcileLocation: bare `/` falls back to first agent when no selection hint exists', () => {
  const minimal: ReconcileSnapshot = {
    agents: [{ id: 'anima', slack: CONNECTED }, { id: 'nora', slack: CONNECTED }],
    agentStatuses: [],
  };
  assert.deepEqual(
    reconcileLocation(minimal, { agentId: null, tab: null }),
    { agentId: 'anima', tab: DEFAULT_TAB },
  );
});

test('reconcileLocation: `/agents/<id>` (no tab) canonicalizes to DEFAULT_TAB', () => {
  assert.deepEqual(
    reconcileLocation(SNAPSHOT, { agentId: 'nora', tab: null }),
    { agentId: 'nora', tab: DEFAULT_TAB },
  );
});

test('reconcileLocation: each `/agents/<id>/<tab>` triple is left alone (no-op)', () => {
  for (const tab of AGENT_TABS) {
    assert.equal(
      reconcileLocation(SNAPSHOT, { agentId: 'nora', tab }),
      null,
      `tab ${tab} should be a no-op`,
    );
  }
});

test('reconcileLocation: unknown agentId is left alone for the view-level not-found state', () => {
  assert.equal(
    reconcileLocation(SNAPSHOT, { agentId: 'ghost', tab: 'profile' }),
    null,
  );
});

test('reconcileLocation: parseLocation already maps unknown tab → null, then reconcile fills DEFAULT_TAB', () => {
  // End-to-end: pathname → parseLocation → reconcile → final URL state.
  const parsed = parseLocation('/agents/nora/garbage');
  assert.deepEqual(parsed, { agentId: 'nora', tab: null });
  assert.deepEqual(
    reconcileLocation(SNAPSHOT, parsed),
    { agentId: 'nora', tab: DEFAULT_TAB },
  );
});

test('reconcileLocation: returns null when there are no agents at all (nothing to pick)', () => {
  const empty: ReconcileSnapshot = { agents: [], agentStatuses: [] };
  assert.equal(reconcileLocation(empty, { agentId: null, tab: null }), null);
});

// ---------------------------------------------------------------------------
// Not-connected agents: activity redirects to profile (no kbName).
// ---------------------------------------------------------------------------

const NC_SNAPSHOT: ReconcileSnapshot = {
  agents: [
    { id: 'anima', slack: CONNECTED },
    { id: 'new-agent' }, // no slack object → slack.connected !== true → not-connected
  ],
  agentStatuses: [
    { agentId: 'anima', queueDepth: 0 },
    { agentId: 'new-agent', queueDepth: 0 },
  ],
  selectedAgentId: 'anima',
};

test('reconcileLocation: not-connected + null tab → profile', () => {
  assert.deepEqual(
    reconcileLocation(NC_SNAPSHOT, { agentId: 'new-agent', tab: null }),
    { agentId: 'new-agent', tab: 'profile' },
  );
});

test('reconcileLocation: not-connected + activity tab → no-op (explicit nav respected)', () => {
  // Sidebar navigates to /agents/:id (no tab), so this branch is only reached
  // via an explicit in-page tab click — which should not be overridden.
  assert.equal(
    reconcileLocation(NC_SNAPSHOT, { agentId: 'new-agent', tab: 'activity' }),
    null,
  );
});

test('reconcileLocation: not-connected + profile tab → no-op', () => {
  assert.equal(
    reconcileLocation(NC_SNAPSHOT, { agentId: 'new-agent', tab: 'profile' }),
    null,
  );
});

test('reconcileLocation: not-connected + reminders tab → no-op (explicit nav respected)', () => {
  assert.equal(
    reconcileLocation(NC_SNAPSHOT, { agentId: 'new-agent', tab: 'reminders' }),
    null,
  );
});

test('reconcileLocation: auto-pick of not-connected agent → profile tab', () => {
  // When auto-selecting and the picked agent has no kbName.
  const ncOnly: ReconcileSnapshot = {
    agents: [{ id: 'new-agent' }],
    agentStatuses: [{ agentId: 'new-agent', queueDepth: 0 }],
  };
  assert.deepEqual(
    reconcileLocation(ncOnly, { agentId: null, tab: null }),
    { agentId: 'new-agent', tab: 'profile' },
  );
});

test('reconcileLocation: connected agent activity is left alone (no-op)', () => {
  assert.equal(
    reconcileLocation(NC_SNAPSHOT, { agentId: 'anima', tab: 'activity' }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Kb surface: parse / build / raw-url
// ---------------------------------------------------------------------------

test('parseKbPath: non-kb paths return null (fall back to agent routing)', () => {
  assert.equal(parseKbPath('/'), null);
  assert.equal(parseKbPath('/agents/nora/activity'), null);
  assert.equal(parseKbPath('/settings'), null);
});

test('parseKbPath: bare /kb selects no kb', () => {
  assert.deepEqual(parseKbPath('/kb'), { id: null, filePath: null });
});

test('parseKbPath: /kb/<id> opens a kb with no file', () => {
  assert.deepEqual(parseKbPath('/kb/team'), { id: 'team', filePath: null });
});

test('parseKbPath: /kb/<id>/<file> parses a nested repo-relative path', () => {
  assert.deepEqual(parseKbPath('/kb/team/prds/team-kb-web-view.md'), {
    id: 'team',
    filePath: 'prds/team-kb-web-view.md',
  });
});

test('parseKbPath: percent-encoded segments are decoded', () => {
  assert.deepEqual(parseKbPath('/kb/content-team/notes/a%20b.md'), {
    id: 'content-team',
    filePath: 'notes/a b.md',
  });
});

test('parseKbPath: the raw backend route is not a browse target', () => {
  assert.equal(parseKbPath('/kb/raw/team/docs/report.html'), null);
});

test('buildKbPath: round-trips through parseKbPath', () => {
  const cases = [
    { id: null, filePath: null, expected: '/kb' },
    { id: 'team', filePath: null, expected: '/kb/team' },
    { id: 'team', filePath: 'prds/x.md', expected: '/kb/team/prds/x.md' },
  ];
  for (const { id, filePath, expected } of cases) {
    const path = buildKbPath({ id, filePath });
    assert.equal(path, expected);
    assert.deepEqual(parseKbPath(path), { id, filePath });
  }
});

test('buildKbPath: encodes spaces per segment, keeping slashes literal', () => {
  assert.equal(
    buildKbPath({ id: 'content-team', filePath: 'notes/a b.md' }),
    '/kb/content-team/notes/a%20b.md',
  );
});

test('buildKbRawPath: emits the backend raw route with per-segment encoding', () => {
  assert.equal(
    buildKbRawPath('team', 'docs/report.html'),
    '/kb/raw/team/docs/report.html',
  );
  assert.equal(
    buildKbRawPath('content-team', 'a b/c.css'),
    '/kb/raw/content-team/a%20b/c.css',
  );
});

// ---------------------------------------------------------------------------
// Integration: simulate the user-facing scenarios iris listed as a regression
// table (parseLocation → reconcile → buildPath round-trip).
// ---------------------------------------------------------------------------

test('routing table: every input path lands on the canonical pathname iris specified', () => {
  const cases: Array<{ input: string; expected: string; note: string }> = [
    { input: '/', expected: '/agents/milo/activity', note: 'bare root → most-recently-active' },
    { input: '/agents/nora', expected: '/agents/nora/activity', note: 'no tab → DEFAULT_TAB' },
    { input: '/agents/nora/activity', expected: '/agents/nora/activity', note: 'activity stays' },
    { input: '/agents/nora/profile', expected: '/agents/nora/profile', note: 'profile stays' },
    { input: '/agents/nora/reminders', expected: '/agents/nora/reminders', note: 'reminders stays' },
    { input: '/agents/ghost/profile', expected: '/agents/ghost/profile', note: 'unknown id → view-level not-found' },
    { input: '/agents/nora/garbage', expected: '/agents/nora/activity', note: 'unknown tab → DEFAULT_TAB' },
  ];

  for (const { input, expected, note } of cases) {
    let parsed = parseLocation(input);
    // Run reconcile up to twice so redirects can settle when a URL canonicalizes
    // through an intermediate state.
    for (let i = 0; i < 2; i++) {
      const target = reconcileLocation(SNAPSHOT, parsed);
      if (!target) break;
      parsed = target;
    }
    const finalPath = buildPath(parsed);
    assert.equal(finalPath, expected, `${input} → ${expected} (${note})`);
  }
});
