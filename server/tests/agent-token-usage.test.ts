import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { providerUsageFromStats } from '../providers/provider-usage.js';
import { agentTokenUsageReport, agentTokenUsageServiceForAgent } from '../usage/agent-token-usage.service.js';
import { registerAgentTokenUsageRoutes } from '../web/agent-token-usage-routes.js';
import { registerErrorHandler } from '../web/http.js';
import { withTempAnimaHome, writeAgentConfigs } from './helpers/harness.js';

test('agent token usage is idempotent and grouped in the requested timezone', async () => {
  await withTempAnimaHome(async (stateDir) => {
    await writeAgentConfigs(stateDir);
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
