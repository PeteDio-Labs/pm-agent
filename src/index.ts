/**
 * pm-agent — Project management agent.
 *
 * Modes:
 *   board-status:   reads GitHub board directly → deterministic summary (no LLM)
 *   break-plan:     reads a plan doc, uses Gemma 4 to extract tasks,
 *                   requests MC approval, then creates tasks on the board
 *   full-cycle:     board-status (deterministic) + break-plan (LLM if planFile provided)
 *   dispatch-tasks: reviews board + routes tasks to agents via Gemma 4 (LLM)
 *
 * Approval gate: task creation is always gated — agent pauses and
 * posts an approval card to MC before writing anything to GitHub.
 */

import express from 'express';
import pino from 'pino';
import { AgentReporter, runToolLoop } from '@petedio/shared/agents';
import { TaskPayloadSchema } from '@petedio/shared/agents';
import { PmAgentInputSchema, type PmAgentInput } from './schema.js';
import { buildTools, type LoopState } from './tools.js';
import { listProjectItems, createTasksOnBoard, type ProjectItem } from './github.js';
import {
  computeBoardDiff, applySyncBoard,
  buildWeeklyReport, postWeeklyReportToDiscord,
  computeCloseDone, applyCloseDone,
} from './sync.js';
import { resolveOllamaUrl } from './ollamaRouter.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3006', 10);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4';
const OLLAMA_URL = resolveOllamaUrl(OLLAMA_MODEL);
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const GITHUB_PROJECT_NUMBER = parseInt(process.env.GITHUB_PROJECT_NUMBER ?? '1', 10);
// PLANNING_ROOT consumed by sync.ts via process.env directly

// ─── Board summary (deterministic — no LLM) ───────────────────────

function formatBoardSummary(items: ProjectItem[], filter?: string): string {
  const filtered = filter
    ? items.filter(i =>
        i.project?.toLowerCase().includes(filter.toLowerCase()) ||
        i.title?.toLowerCase().includes(filter.toLowerCase())
      )
    : items;

  if (filtered.length === 0) return 'No items found on board.';

  const byStatus: Record<string, typeof filtered> = {};
  for (const item of filtered) {
    const s = item.status || 'No Status';
    if (!byStatus[s]) byStatus[s] = [];
    byStatus[s].push(item);
  }

  const lines: string[] = [`Board status (${filtered.length} items):`];
  for (const [status, its] of Object.entries(byStatus)) {
    lines.push(`\n**${status}** (${its.length}):`);
    for (const i of its) {
      const priority = i.priority ? ` [${i.priority}]` : '';
      lines.push(`  - ${i.title}${priority}`);
    }
  }

  return lines.join('\n');
}

// ─── Agent Logic ──────────────────────────────────────────────────

async function runBoardStatus(
  payload: ReturnType<typeof TaskPayloadSchema.parse>,
  input: PmAgentInput,
  reporter: InstanceType<typeof AgentReporter>,
  startMs: number,
): Promise<void> {
  const projectNumber = input.projectNumber ?? GITHUB_PROJECT_NUMBER;
  await reporter.running('Fetching GitHub Projects board...');

  const items = await listProjectItems(projectNumber);
  const summary = formatBoardSummary(items, input.projectFilter);

  log.info({ taskId: payload.taskId, itemCount: items.length }, 'board-status complete');

  await reporter.complete({
    taskId: payload.taskId,
    agentName: 'pm-agent',
    status: 'complete',
    summary: `Board fetched — ${items.length} items`,
    artifacts: [
      { type: 'summary', label: 'Board Summary', content: summary },
    ],
    durationMs: Date.now() - startMs,
    completedAt: new Date().toISOString(),
  });
}

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

  // ── board-status ──────────────────────────────────────────────
  if (input.mode === 'board-status') {
    await runBoardStatus(payload, input, reporter, startMs);
    return;
  }

  // ── sync-board ────────────────────────────────────────────────
  if (input.mode === 'sync-board') {
    await reporter.running('Diffing planning docs against GitHub board...');
    const diff = await computeBoardDiff(projectNumber);

    if (!diff.toAdd.length && !diff.toClose.length) {
      await reporter.complete({
        taskId: payload.taskId, agentName: 'pm-agent', status: 'complete',
        summary: 'Board in sync — no changes needed',
        artifacts: [{ type: 'log', label: 'Sync result', content: diff.preview }],
        durationMs: Date.now() - startMs, completedAt: new Date().toISOString(),
      });
      return;
    }

    const approval = await reporter.requestApproval({
      actionType: 'create-tasks',
      description: `Sync board: add ${diff.toAdd.length} items, close ${diff.toClose.length} items`,
      preview: diff.preview,
    });

    if (approval.outcome === 'approved') {
      await reporter.running('Applying board sync...');
      const result = await applySyncBoard(diff, projectNumber);
      await reporter.complete({
        taskId: payload.taskId, agentName: 'pm-agent', status: 'complete',
        summary: result,
        artifacts: [
          { type: 'log', label: 'Sync preview', content: diff.preview },
          { type: 'log', label: 'Result', content: result },
        ],
        durationMs: Date.now() - startMs, completedAt: new Date().toISOString(),
      });
    } else {
      await reporter.complete({
        taskId: payload.taskId, agentName: 'pm-agent', status: 'complete',
        summary: 'Sync cancelled',
        artifacts: [{ type: 'log', label: 'Sync preview (not applied)', content: diff.preview }],
        durationMs: Date.now() - startMs, completedAt: new Date().toISOString(),
      });
    }
    return;
  }

  // ── weekly-report ─────────────────────────────────────────────
  if (input.mode === 'weekly-report') {
    await reporter.running('Building weekly report...');
    const report = await buildWeeklyReport(projectNumber);
    await postWeeklyReportToDiscord(report);
    await reporter.complete({
      taskId: payload.taskId, agentName: 'pm-agent', status: 'complete',
      summary: 'Weekly report posted to Discord',
      artifacts: [{ type: 'summary', label: 'Weekly Report', content: report }],
      durationMs: Date.now() - startMs, completedAt: new Date().toISOString(),
    });
    return;
  }

  // ── close-done ────────────────────────────────────────────────
  if (input.mode === 'close-done') {
    await reporter.running('Computing done items to reconcile with plans...');
    const result = await computeCloseDone(projectNumber);

    if (!result.markedDoneInPlans.length && !result.plansToArchive.length) {
      await reporter.complete({
        taskId: payload.taskId, agentName: 'pm-agent', status: 'complete',
        summary: 'Nothing to close — plans already in sync with board',
        artifacts: [{ type: 'log', label: 'Result', content: result.preview }],
        durationMs: Date.now() - startMs, completedAt: new Date().toISOString(),
      });
      return;
    }

    const approval = await reporter.requestApproval({
      actionType: 'write-file',
      description: `Mark ${result.markedDoneInPlans.length} tasks done in plans; archive ${result.plansToArchive.length} complete plan(s)`,
      preview: result.preview,
    });

    if (approval.outcome === 'approved') {
      await reporter.running('Applying close-done changes...');
      const outcome = await applyCloseDone(result);
      await reporter.complete({
        taskId: payload.taskId, agentName: 'pm-agent', status: 'complete',
        summary: outcome,
        artifacts: [
          { type: 'log', label: 'Changes preview', content: result.preview },
          { type: 'log', label: 'Result', content: outcome },
        ],
        durationMs: Date.now() - startMs, completedAt: new Date().toISOString(),
      });
    } else {
      await reporter.complete({
        taskId: payload.taskId, agentName: 'pm-agent', status: 'complete',
        summary: 'Close-done cancelled',
        artifacts: [{ type: 'log', label: 'Preview (not applied)', content: result.preview }],
        durationMs: Date.now() - startMs, completedAt: new Date().toISOString(),
      });
    }
    return;
  }

  // ── all other modes: may use LLM ──────────────────────────────

  const loopState: LoopState = {};
  const artifacts = [];

  // full-cycle: board part is deterministic, plan part may use LLM
  if (input.mode === 'full-cycle') {
    await reporter.running('Fetching board status...');
    const items = await listProjectItems(projectNumber);
    loopState.boardSummary = formatBoardSummary(items, input.projectFilter);
    artifacts.push({
      type: 'summary' as const,
      label: 'Board Summary',
      content: loopState.boardSummary,
    });

    if (!input.planFile) {
      // No plan file — just the board summary, no LLM needed
      await reporter.complete({
        taskId: payload.taskId,
        agentName: 'pm-agent',
        status: 'complete',
        summary: `Board fetched — ${items.length} items`,
        artifacts,
        durationMs: Date.now() - startMs,
        completedAt: new Date().toISOString(),
      });
      return;
    }
  }

  // Build LLM prompt for break-plan, dispatch-tasks, and full-cycle with planFile
  let userPrompt = '';

  if (input.mode === 'break-plan') {
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
    // full-cycle with planFile
    userPrompt = `
Read the plan at "${input.planFile}" and use propose_tasks to extract remaining tasks.
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

    // Always produce a summary artifact (board summary already added for full-cycle above)
    if (input.mode !== 'full-cycle') {
      artifacts.push({
        type: 'summary' as const,
        label: 'Board / Plan Summary',
        content: finalResponse || loopState.boardSummary || 'No summary generated',
      });
    } else if (finalResponse) {
      artifacts.push({
        type: 'summary' as const,
        label: 'Plan Summary',
        content: finalResponse,
      });
    }

    // Dispatch log
    if (loopState.dispatches && loopState.dispatches.length > 0) {
      artifacts.push({
        type: 'log' as const,
        label: `${loopState.dispatches.length} task(s) dispatched`,
        content: loopState.dispatches.map(d =>
          `- **${d.agent}** — taskId: \`${d.taskId}\``
        ).join('\n'),
      });
    }

    // Task proposal approval gate
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
  res.json({ status: 'ok', agent: 'pm-agent' });
});

// ─── Monday Dispatch Cron ─────────────────────────────────────────
// Every Monday at 10:00 UTC — trigger a dispatch-tasks run via MC Backend

function startDispatchCron(): void {
  const CHECK_INTERVAL_MS = 60_000;
  let lastRun: string | null = null;

  setInterval(() => {
    const now = new Date();
    if (now.getUTCDay() !== 1 || now.getUTCHours() !== 10) return;

    const todayKey = now.toISOString().split('T')[0];
    if (lastRun === todayKey) return;
    lastRun = todayKey;

    log.info('Monday cron firing — sync-board → dispatch-tasks → weekly-report');

    const trigger = async (mode: string) => {
      const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/pm-agent/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName: 'pm-agent', trigger: 'cron', input: { mode } }),
      });
      if (!res.ok) {
        const t = await res.text();
        log.error({ mode, status: res.status, body: t }, 'Monday cron trigger failed');
      } else {
        log.info({ mode }, 'Monday cron trigger queued');
      }
    };

    trigger('sync-board').catch(() => {});
    // dispatch-tasks and weekly-report fire sequentially with a short gap
    setTimeout(() => trigger('dispatch-tasks').catch(() => {}), 5_000);
    setTimeout(() => trigger('weekly-report').catch(() => {}), 10_000);
  }, CHECK_INTERVAL_MS);

  log.info('Monday dispatch cron started — fires at 10:00 UTC');
}

app.listen(PORT, () => {
  log.info({ port: PORT }, 'pm-agent listening');
  startDispatchCron();
});
