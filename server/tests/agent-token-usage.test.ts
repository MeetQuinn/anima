import assert from 'node:assert/strict';
import { rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import Fastify from 'fastify';
import { DateTime } from 'luxon';

import { providerUsageFromStats } from '../providers/provider-usage.js';
import { AgentTokenUsageStore } from '../storage/schema/agent-token-usage.store.js';
import {
  AgentTokenUsageService,
  agentTokenUsageReport,
  agentTokenUsageServiceForAgent,
} from '../usage/agent-token-usage.service.js';
import { localDateReader } from '../usage/local-date.js';
import { registerAgentTokenUsageRoutes } from '../web/agent-token-usage-routes.js';
import { registerErrorHandler } from '../web/http.js';
import { defaultAgentConfig, withTempAnimaHome, writeAgentConfigs } from './helpers/harness.js';

test('agent token usage is idempotent and grouped in the requested timezone', async () => {
  await withTempAnimaHome(async (stateDir) => {
    const agent = defaultAgentConfig('anima');
    await writeAgentConfigs(stateDir, [{
      ...agent,
      slack: { ...agent.slack, avatarUrl: 'https://avatars.example/anima.png' },
    }]);
    const usage = agentTokenUsageServiceForAgent('anima');
    await usage.initialize('2026-08-01T00:00:00.000Z');

    const first = await usage.record('item-1', 'claude-code', {
      cacheReadInputTokens: 20,
      inputTokens: 10,
      model: 'claude-opus-4-8',
      occurredAt: '2026-08-02T15:59:00.000Z',
      outputTokens: 5,
      reasoningOutputTokens: 3,
      sourceId: 'session-1:result:1',
    });
    const duplicate = await usage.record('item-1', 'claude-code', {
      cacheReadInputTokens: 20,
      inputTokens: 10,
      occurredAt: '2026-08-02T15:59:00.000Z',
      outputTokens: 5,
      reasoningOutputTokens: 3,
      sourceId: 'session-1:result:1',
    });
    await usage.record('item-2', 'codex-cli', {
      occurredAt: '2026-08-02T16:01:00.000Z',
      sourceId: 'thread-1:turn-2',
      totalTokens: 7,
    });
    await usage.record('item-3', 'kimi-cli', {
      occurredAt: '2026-08-02T16:02:00.000Z',
      sourceId: 'session-2:prompt:1',
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);

    const report = await agentTokenUsageReport({
      agentId: 'anima',
      from: '2026-08-02',
      through: '2026-08-03',
      timezone: 'Asia/Shanghai',
    });
    assert.equal(report.agents.length, 1);
    assert.equal(report.totalTokens, 42);
    assert.equal(report.outputTokens, 5);
    assert.equal(report.reasoningOutputTokens, 3);
    assert.equal(report.reportedRuns, 2);
    assert.equal(report.unknownRuns, 1);
    assert.equal(report.agents[0]?.coverageStartedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(report.agents[0]?.avatarUrl, 'https://avatars.example/anima.png');
    assert.deepEqual(
      report.agents[0]?.days.map((day) => ({
        date: day.date,
        reportedRuns: day.reportedRuns,
        totalTokens: day.totalTokens,
        unknownRuns: day.unknownRuns,
      })),
      [
        { date: '2026-08-02', reportedRuns: 1, totalTokens: 35, unknownRuns: 0 },
        { date: '2026-08-03', reportedRuns: 1, totalTokens: 7, unknownRuns: 1 },
      ],
    );
  });
});

test('reasoning tokens remain an output subset rather than inflating totals', async () => {
  await withTempAnimaHome(async (stateDir) => {
    await writeAgentConfigs(stateDir);
    const usage = agentTokenUsageServiceForAgent('anima');
    await usage.record('item-1', 'codex-cli', {
      inputTokens: 100,
      occurredAt: '2026-08-04T00:00:00.000Z',
      outputTokens: 20,
      reasoningOutputTokens: 15,
      sourceId: 'turn-1',
    });
    const report = await agentTokenUsageReport({
      from: '2026-08-04',
      through: '2026-08-04',
      timezone: 'UTC',
    });
    assert.equal(report.totalTokens, 120);
    assert.equal(report.reasoningOutputTokens, 15);
  });
});

test('a late provider usage payload upgrades the same unknown run', async () => {
  await withTempAnimaHome(async (stateDir) => {
    await writeAgentConfigs(stateDir);
    const usage = agentTokenUsageServiceForAgent('anima');
    await usage.record('item-1', 'codex-cli', {
      occurredAt: '2026-08-04T00:00:00.000Z',
      sourceId: 'thread-1:turn-1',
    });
    const upgraded = await usage.record('item-1', 'codex-cli', {
      occurredAt: '2026-08-04T00:00:01.000Z',
      sourceId: 'thread-1:turn-1',
      totalTokens: 42,
    });
    assert.equal(upgraded.inserted, true);
    const report = await agentTokenUsageReport({
      from: '2026-08-04',
      through: '2026-08-04',
      timezone: 'UTC',
    });
    assert.equal(report.totalTokens, 42);
    assert.equal(report.reportedRuns, 1);
    assert.equal(report.unknownRuns, 0);
  });
});

test('a summary reads ledger rows again only after the ledger or the request changes', async () => {
  await withTempAnimaHome(async (stateDir) => {
    await writeAgentConfigs(stateDir);
    class CountingStore extends AgentTokenUsageStore {
      reads = 0;
      override async listBetween(fromUtc: string, throughUtc: string) {
        this.reads += 1;
        return super.listBetween(fromUtc, throughUtc);
      }
    }
    const store = new CountingStore('anima');
    const usage = new AgentTokenUsageService('anima', store);
    const request = { agentName: 'Anima', from: '2026-08-04', through: '2026-08-05', timezone: 'UTC' };
    await usage.record('item-1', 'codex-cli', {
      occurredAt: '2026-08-04T00:00:00.000Z',
      sourceId: 'turn-1',
      totalTokens: 10,
    });
    await usage.record('item-2', 'codex-cli', { occurredAt: '2026-08-04T01:00:00.000Z', sourceId: 'turn-2' });
    await usage.record('item-4', 'codex-cli', {
      occurredAt: '2026-08-05T23:30:00.000Z',
      sourceId: 'turn-4',
      totalTokens: 0,
    });

    const first = await usage.summary(request);
    assert.equal(first.totalTokens, 10);
    assert.equal(first.unknownRuns, 1);
    assert.equal(store.reads, 1);

    // Same ledger and request: the cached summary, under the caller's name. A
    // caller changing a returned summary does not change the cached one.
    first.days[0]!.totalTokens = 999;
    const renamed = await usage.summary({ ...request, agentName: 'Renamed' });
    assert.equal(store.reads, 1);
    assert.equal(renamed.agentName, 'Renamed');
    assert.equal(renamed.days[0]!.totalTokens, 10);
    renamed.days[0]!.totalTokens = 555;
    assert.equal((await usage.summary(request)).days[0]!.totalTokens, 10);
    assert.equal(store.reads, 1);

    // Each ledger keeps only its latest request. Over a year, London and UTC
    // give the same UTC range, but London puts a summer 23:30Z on the next day.
    const year = { ...request, from: '2026-01-01', through: '2026-12-31' };
    const utcDates = (await usage.summary(year)).days.map((day) => day.date);
    const londonDates = (await usage.summary({ ...year, timezone: 'Europe/London' })).days.map((day) => day.date);
    assert.deepEqual([utcDates, londonDates], [['2026-08-04', '2026-08-05'], ['2026-08-04', '2026-08-06']]);
    assert.equal(store.reads, 3);
    await usage.summary(request);
    assert.equal(store.reads, 4);

    // A new run, a late payload upgrade, and a write from another connection
    // each give a new stamp.
    await usage.record('item-3', 'codex-cli', {
      occurredAt: '2026-08-05T00:00:00.000Z',
      sourceId: 'turn-3',
      totalTokens: 5,
    });
    assert.equal((await usage.summary(request)).totalTokens, 15);
    assert.equal(store.reads, 5);
    await usage.record('item-2', 'codex-cli', {
      occurredAt: '2026-08-04T01:00:00.000Z',
      sourceId: 'turn-2',
      totalTokens: 7,
    });
    const upgraded = await usage.summary(request);
    assert.deepEqual([upgraded.totalTokens, upgraded.unknownRuns, store.reads], [22, 0, 6]);
    const db = new DatabaseSync(store.path);
    try {
      db.exec("UPDATE provider_usage SET total_tokens = total_tokens + 100 WHERE item_id = 'item-1'");
    } finally {
      db.close();
    }
    assert.equal((await usage.summary(request)).totalTokens, 122);
    assert.equal(store.reads, 7);
    assert.equal((await usage.summary(request)).totalTokens, 122);
    assert.equal(store.reads, 7);

    // A ledger file replaced by another.
    const other = new AgentTokenUsageService('other');
    await other.record('item-9', 'codex-cli', {
      occurredAt: '2026-08-04T00:00:00.000Z',
      sourceId: 'turn-9',
      totalTokens: 3,
    });
    await rename(new AgentTokenUsageStore('other').path, store.path);
    assert.equal((await usage.summary(request)).totalTokens, 3);
    assert.equal(store.reads, 8);
  });
});

test('provider usage normalizes ACP aliases without treating context occupancy as usage', () => {
  assert.deepEqual(
    providerUsageFromStats('prompt-1', {
      cacheWriteInputTokens: 17,
      currentContextTokens: 99_999,
      inputTokens: 11,
      outputTokens: 5,
      reasoningTokens: 3,
    }),
    {
      cacheCreationInputTokens: 17,
      cacheReadInputTokens: undefined,
      inputTokens: 11,
      outputTokens: 5,
      reasoningOutputTokens: 3,
      sourceId: 'prompt-1',
      totalTokens: undefined,
    },
  );
});

test('token usage API validates the local-day range and returns an agent-scoped report', async () => {
  await withTempAnimaHome(async (stateDir) => {
    await writeAgentConfigs(stateDir);
    await agentTokenUsageServiceForAgent('anima').record('item-1', 'claude-code', {
      occurredAt: '2026-08-03T23:30:00.000Z',
      sourceId: 'result-1',
      totalTokens: 42,
    });
    const fastify = Fastify({ logger: false });
    registerErrorHandler(fastify);
    registerAgentTokenUsageRoutes(fastify);
    try {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/agent-token-usage?agentId=anima&from=2026-08-04&through=2026-08-04&timezone=Asia%2FShanghai',
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().totalTokens, 42);
      assert.equal(response.json().agents[0].days[0].date, '2026-08-04');

      const invalidZone = await fastify.inject({
        method: 'GET',
        url: '/api/agent-token-usage?timezone=not-a-zone',
      });
      assert.equal(invalidZone.statusCode, 400);

      const unknownAgent = await fastify.inject({
        method: 'GET',
        url: '/api/agent-token-usage?agentId=missing',
      });
      assert.equal(unknownAgent.statusCode, 404);
    } finally {
      await fastify.close();
    }
  });
});

test('local dates match Luxon in every zone, around each local midnight', () => {
  const luxonDate = (iso: string, timezone: string) =>
    DateTime.fromISO(iso, { setZone: true }).setZone(timezone).toISODate();
  const zones = [
    ...Intl.supportedValuesOf('timeZone'),
    'Asia/Calcutta',
    'UTC',
    'utc',
    'UTC+3',
    'UTC-9:30',
    'system',
    'not-a-zone',
  ];
  // Local midnights through both 2026 offset-change seasons, and in 1900, when
  // many zones kept local mean time (offsets with seconds). In a zone that skips
  // midnight, startOf('day') is the day's first instant.
  const days = [
    ...Array.from({ length: 3 }, (_, i) => DateTime.utc(1900, 1, 1).plus({ days: i })),
    ...Array.from({ length: 50 }, (_, i) => DateTime.utc(2026, 3, 1).plus({ days: i })),
    ...Array.from({ length: 50 }, (_, i) => DateTime.utc(2026, 9, 15).plus({ days: i })),
  ];
  const fixed = [
    // Fallback: not in toISOString form, or not a time.
    '2026-03-08T01:59:59-05:00',
    '2026-03-08T07:00:00Z',
    '2026-03-08T06:59:59.999+00:00',
    '2026-02-30T00:00:00.000Z',
    'not a time',
    '',
    // Fallback: within 2^29 ms of 1970.
    '1970-01-01T00:44:30.000Z',
    '1970-01-07T05:00:00.000Z',
    // Years the fast path cannot write in four digits. Intl shows year -1000
    // (1001 BC) as 1001, with no era.
    '-001000-06-15T12:00:00.000Z',
    '+010000-01-01T00:00:00.000Z',
    '0999-12-31T23:59:59.999Z',
    '1000-01-01T00:00:00.000Z',
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
    // Monrovia's local midnight in 1960, at -0:44:30.
    '1960-06-15T00:44:30.000Z',
  ];
  let compared = 0;
  for (const timezone of zones) {
    const localDate = localDateReader(timezone);
    const instants = [...fixed];
    for (const day of days) {
      const midnight = DateTime.fromObject(
        { year: day.year, month: day.month, day: day.day },
        { zone: timezone },
      ).startOf('day');
      if (!midnight.isValid) continue;
      for (const delta of [-1, 0, 1]) instants.push(new Date(midnight.toMillis() + delta).toISOString());
    }
    for (const iso of instants) {
      assert.equal(localDate(iso), luxonDate(iso, timezone), `${timezone} ${iso}`);
      compared += 1;
    }
  }
  assert.ok(compared > 100_000);
});
