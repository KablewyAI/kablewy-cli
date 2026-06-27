#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../dist/core/config.js';
import { streamProcessChatWithCallbacks } from '../dist/commands/chat.js';

const scenarios = [
  {
    name: 'pwd',
    message: 'Use the local CLI shell tool to run exactly `pwd`. Do not search for tools. Answer with the pwd output only.',
    expectedEvents: ['local_tool_call: Bash', 'local_tool_result: Bash'],
    assert: ({ text, probeDir }) => {
      const normalized = normalizePathText(text);
      const expected = normalizePathText(probeDir);
      return normalized.includes(expected);
    },
  },
  {
    name: 'list-files',
    message: 'list the files in this directory',
    expectedEvents: ['local_tool_call: LS', 'local_tool_result: LS'],
    assert: ({ text }) => /probe\.txt/.test(text),
  },
  {
    name: 'write-readback',
    message: 'write a small test file named sample.txt and read it back',
    expectedEvents: [
      'local_tool_call: Write',
      'local_tool_result: Write',
      'local_tool_call: Read',
      'local_tool_result: Read',
    ],
    assert: ({ text }) => /sample\.txt/.test(text) && /Kablewy agent local write test/.test(text),
  },
  {
    name: 'targeted-src-list',
    setup: async (probeDir) => {
      await mkdir(path.join(probeDir, 'src'), { recursive: true });
      await writeFile(path.join(probeDir, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
    },
    message: 'what is in the src directory? Answer with the local filenames only.',
    expectedEvents: ['local_tool_call: LS', 'local_tool_result: LS'],
    assert: ({ text }) => /index\.ts/.test(text),
  },
  {
    name: 'inventory',
    setup: async (probeDir) => {
      await mkdir(path.join(probeDir, 'src'), { recursive: true });
      await writeFile(path.join(probeDir, 'src', 'agent.ts'), 'export const agent = true;\n', 'utf8');
    },
    message: 'recursively inventory this whole directory. Answer with the local paths only.',
    expectedEvents: ['local_tool_call: Inventory', 'local_tool_result: Inventory'],
    assert: ({ text }) => /src\/agent\.ts|src[\\/]agent\.ts/.test(text),
  },
];

async function main() {
  const config = new ConfigManager();
  config.loadFromEnv();

  const missing = ['apiUrl', 'orgId', 'userId', 'apiKey'].filter((key) => !config.get(key));
  if (missing.length > 0) {
    throw new Error(`Missing CLI configuration for live smoke: ${missing.join(', ')}`);
  }

  if (process.env.KABLEWY_AGENT_LIVE_SMOKE_ALLOW_PROD !== '1' && config.get('apiUrl') === 'https://kablewy.ai') {
    throw new Error('Refusing to run live agent smoke against production without KABLEWY_AGENT_LIVE_SMOKE_ALLOW_PROD=1');
  }

  const summaries = [];
  for (const scenario of scenarios) {
    summaries.push(await runScenario(config, scenario));
  }

  console.log(JSON.stringify({
    success: true,
    apiUrl: config.get('apiUrl'),
    scenarios: summaries,
  }, null, 2));
}

async function runScenario(config, scenario) {
  const probeDir = await mkdtemp(path.join(tmpdir(), 'kablewy-agent-live-smoke-'));
  await writeFile(path.join(probeDir, 'probe.txt'), 'kablewy local agent live smoke\n', 'utf8');
  if (typeof scenario.setup === 'function') {
    await scenario.setup(probeDir);
  }

  const requestSummaries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const args = body?.params?.arguments || {};
    const toolNames = Array.isArray(args.tools) ? args.tools.map((tool) => tool.name) : [];
    requestSummaries.push({
      url: String(url).replace(/\/users\/[^/]+\//, '/users/<user>/'),
      model: args.model,
      continuation: args.options?.continuation === true,
      toolChoice: args.tool_choice,
      toolCount: toolNames.length,
      hasFsRunShell: toolNames.includes('fs_run_shell'),
      hasSearchTools: toolNames.includes('search_tools'),
      localToolNames: toolNames.filter((name) => /^(fs_|Bash|Read|Write|Edit|Grep|LS|Inventory|search_tools)/.test(name)),
    });
    return originalFetch(url, init);
  };

  try {
    const chunks = [];
    const toolEvents = [];
    const text = await streamProcessChatWithCallbacks(
      `agent-live-smoke-${Date.now()}-${scenario.name}`,
      scenario.message,
      {
        agent: true,
        model: process.env.KABLEWY_AGENT_LIVE_SMOKE_MODEL || 'gpt-5.4',
        agentSafety: {
          cwd: probeDir,
          allowDangerousShell: false,
          allowOutsideCwd: false,
          requireShellApproval: true,
          commandTimeoutMs: 30_000,
          maxOutputBytes: 20_000,
        },
      },
      {
        config,
        telemetry: { command: 'agent.live-smoke' },
      },
      {
        onText: (chunk) => chunks.push(chunk),
        onToolEvent: (event) => toolEvents.push(event),
      }
    );
    const responseText = text || chunks.join('');
    for (const expected of scenario.expectedEvents) {
      if (!toolEvents.includes(expected)) {
        throw new Error(`${scenario.name}: missing tool event ${expected}; got ${toolEvents.join(', ') || '(none)'}`);
      }
    }
    if (!requestSummaries.some((request) => request.hasFsRunShell && request.toolChoice === 'auto')) {
      throw new Error(`${scenario.name}: request did not include local fs/shell tools with auto tool choice`);
    }
    if (!scenario.assert({ text: responseText, probeDir })) {
      throw new Error(`${scenario.name}: response did not include expected local result: ${responseText.slice(0, 500)}`);
    }
    return {
      name: scenario.name,
      success: true,
      toolEvents,
      responsePreview: responseText.slice(0, 300),
      request: requestSummaries[0],
    };
  } finally {
    globalThis.fetch = originalFetch;
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function normalizePathText(value) {
  return String(value || '').replace('/private/var/', '/var/').trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
