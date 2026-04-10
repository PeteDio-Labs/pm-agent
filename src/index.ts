/**
 * pm-agent — Project management agent.
 *
 * Modes:
 *   board-status: reads GitHub board, produces a summary report
 *   break-plan:   reads a plan doc, uses Gemma 4 to extract tasks,
 *                 requests MC approval, then creates tasks on the board
 *   full-cycle:   board-status + break-plan
 *
 * Approval gate: task creation is always gated — agent pauses and
 * posts an approval card to MC before writing anything to GitHub.
 */

import express from 'express';
import pino from 'pino';
import { AgentReporter, runToolLoop } from '@petedio/shared/agents';
import { TaskPayloadSchema } from '@petedio/shared/agents';
import { PmAgentInputSchema } from './schema.js';
import { buildTools, type LoopState } from './tools.js';
import { createTasksOnBoard } from './github.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3006', 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.50.59:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const GITHUB_PROJECT_NUMBER = parseInt(process.env.GITHUB_PROJECT_NUMBER ?? '1', 10);

// ─── Agent Logic ──────────────────────────────────────────────────

async function runPmAgent(payload: ReturnType<typeof TaskPayloadSchema.parse>): Promise<void> {
  const startMs = Date.now();
  const input = PmAgentInputSchema.parse(payload.input);
  const projectNumber = input.projectNumber ?? GITHUB_PROJECT_NUMBER;

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'pm-agent',
  });

  await reporter.running(`Starting pm-agent in mode: ${input.mode}`);
  log.info({ taskId: payload.taskId, input }, 'pm-agent starting');

  const loopState: LoopState = {};

  // ── Build prompt based on mode ──────────────────────────────────

  let userPrompt = '';

  if (input.mode === 'board-status') {
    userPrompt = `
Review the current GitHub Projects board${input.projectFilter ? ` filtered to "${input.projectFilter}"` : ''}.
Use get_board_status to fetch the board, then write a concise status report:
- Overall health (on track / behind / blocked)
- What is in progress
- Any blockers
- Recommended next actions
Keep the summary under 300 words.
    `.trim();
  } else if (input.mode === 'break-plan') {
    if (!input.planFile) {
      await reporter.fail('break-plan mode requires planFile input');
      return;
    }
    userPrompt = `
Read the plan document at "${input.planFile}" using read_plan_doc.
Extract all remaining (not completed) implementation tasks.
Group them by phase. For each task, determine:
- title (imperative verb, under 80 chars)
- description (one sentence)
- priority (high = critical path, medium = important, low = cleanup)
- dependsOn (titles of tasks this depends on, if any)

Then use propose_tasks with a JSON array of all extracted tasks.
Do NOT invent tasks not in the document.
    `.trim();
  } else if (input.mode === 'dispatch-tasks') {
    userPrompt = `
Review the GitHub Projects board using get_board_status.
Identify tasks that are ready to be actioned by an autonomous agent — look for items in "In Progress" or "Ready" status that match agent capabilities.

For each actionable task, use dispatch_to_agent to send it to the appropriate agent:
- workstation-agent: coding tasks, file edits, bun/git ops on LXC 113
- infra-agent: infrastructure changes, Ansible playbooks, Proxmox capacity
- ops-investigator: health checks, incident investigation
- knowledge-janitor: knowledge doc audits and cleanup
- blog-agent: blog content generation

Only dispatch tasks that are clearly ready (not blocked, not already running).
Provide a brief summary of what you dispatched and why.
    `.trim();
  } else {
    // full-cycle
    const planPart = input.planFile
      ? `Also read the plan at "${input.planFile}" and use propose_tasks to extract remaining tasks.`
      : 'No plan file provided — skip task extraction.';
    userPrompt = `
First, get the board status${input.projectFilter ? ` for "${input.projectFilter}"` : ''} and write a summary.
${planPart}
    `.trim();
  }

  try {
    const { finalResponse } = await runToolLoop({
      ollamaUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      system: 'You are a disciplined project manager. Be concise. Extract tasks exactly as written in documents — do not invent or expand scope.',
      userPrompt,
      tools: buildTools(loopState, projectNumber, MC_BACKEND_URL, input.agentsToDispatch),
      onIteration: (i, content) => {
        if (content) log.info({ taskId: payload.taskId, iteration: i }, 'pm-agent loop response');
      },
    });

    const durationMs = Date.now() - startMs;
    const artifacts = [];

    // Always produce a summary artifact
    artifacts.push({
      type: 'summary' as const,
      label: 'Board / Plan Summary',
      content: finalResponse || loopState.boardSummary || 'No summary generated',
    });

    // If tasks were dispatched, add a dispatch summary artifact
    if (loopState.dispatches && loopState.dispatches.length > 0) {
      const dispatchLines = loopState.dispatches.map(d =>
        `- **${d.agent}** — taskId: \`${d.taskId}\``
      );
      artifacts.push({
        type: 'log' as const,
        label: `${loopState.dispatches.length} task(s) dispatched`,
        content: dispatchLines.join('\n'),
      });
    }

    // If tasks were proposed, gate them before creating
    if (loopState.generatedTasks && loopState.generatedTasks.length > 0) {
      const taskPreview = loopState.generatedTasks
        .map((t, i) => `${i + 1}. [${t.priority}] **${t.title}**\n   ${t.description}`)
        .join('\n\n');

      artifacts.push({
        type: 'task-list' as const,
        label: `${loopState.generatedTasks.length} tasks proposed`,
        content: taskPreview,
      });

      const approval = await reporter.requestApproval({
        actionType: 'create-tasks',
        description: `Create ${loopState.generatedTasks.length} tasks on GitHub Projects board #${projectNumber}`,
        preview: taskPreview,
      });

      if (approval.outcome === 'approved') {
        await reporter.running('Approval received — creating tasks on GitHub board...');
        const result = await createTasksOnBoard(
          loopState.generatedTasks,
          projectNumber,
          input.planProjectName,
          input.repo,
        );

        const createdLines = result.created.map(c =>
          c.url ? `- [#${c.number}](${c.url}) ${c.title}` : `- ${c.title} (draft)`
        );
        const failedLines = result.failed.map(f => `- ${f.title}: ${f.error}`);

        artifacts.push({
          type: 'task-list' as const,
          label: `Tasks created (${result.created.length} ok, ${result.failed.length} failed)`,
          content: [
            `**Created (${result.created.length}):**`,
            ...createdLines,
            ...(failedLines.length ? ['', `**Failed (${result.failed.length}):**`, ...failedLines] : []),
          ].join('\n'),
        });
      } else {
        artifacts.push({
          type: 'log' as const,
          label: 'Task creation skipped',
          content: `Approval rejected${approval.reason ? ': ' + approval.reason : ''}`,
        });
      }
    }

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'pm-agent',
      status: 'complete',
      summary: firstLine(finalResponse) || `pm-agent completed (${input.mode})`,
      artifacts,
      durationMs: Date.now() - startMs,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: payload.taskId, err: msg }, 'pm-agent failed');
    await reporter.fail(msg);
  }
}

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim().length > 0) ?? '';
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }

  res.json({ accepted: true, taskId: parsed.data.taskId });

  runPmAgent(parsed.data).catch(err => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled pm-agent error');
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'pm-agent', model: OLLAMA_MODEL });
});

// ─── Monday Dispatch Cron ─────────────────────────────────────────
// Every Monday at 10:00 UTC — trigger a dispatch-tasks run via MC Backend

function startDispatchCron(): void {
  const CHECK_INTERVAL_MS = 60_000;
  let lastRun: string | null = null;

  setInterval(() => {
    const now = new Date();
    // Monday = 1, 10:00 UTC
    if (now.getUTCDay() !== 1 || now.getUTCHours() !== 10) return;

    const todayKey = now.toISOString().split('T')[0];
    if (lastRun === todayKey) return;
    lastRun = todayKey;

    log.info('Monday dispatch cron firing — triggering dispatch-tasks via MC Backend');

    fetch(`${MC_BACKEND_URL}/api/v1/agents/pm-agent/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: 'pm-agent',
        trigger: 'cron',
        input: { mode: 'dispatch-tasks' },
      }),
    }).then(res => {
      if (!res.ok) res.text().then(t => log.error({ status: res.status, body: t }, 'dispatch cron trigger failed'));
      else log.info('dispatch-tasks cron dispatched successfully');
    }).catch(err => {
      log.error({ err: err instanceof Error ? err.message : err }, 'dispatch cron fetch error');
    });
  }, CHECK_INTERVAL_MS);

  log.info('Monday dispatch cron started — fires at 10:00 UTC');
}

app.listen(PORT, () => {
  log.info({ port: PORT, model: OLLAMA_MODEL }, 'pm-agent listening');
  startDispatchCron();
});
