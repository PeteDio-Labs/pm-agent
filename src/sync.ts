/**
 * sync.ts — deterministic planning ↔ board sync logic
 *
 * sync-board:    reads active planning/*.md files, diffs against the board,
 *                proposes additions and Done closures. Approval-gated.
 *
 * weekly-report: board state + MC agent run history for the past 7 days.
 *                Posts digest to notification-service. Fully deterministic.
 *
 * close-done:    finds board items in Done status, adds ✅ banners to the
 *                corresponding plan sections, proposes archiving fully-complete
 *                plans to planning/completed/. Approval-gated.
 */

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { listProjectItems, createTasksOnBoard, updateItemStatus, type ProjectItem } from './github.js';
import type { TaskInput } from './github.js';

const PLANNING_ROOT = process.env.PLANNING_ROOT ?? '/home/pedro/PeteDio-Labs/planning';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:3002';

// ─── Planning doc parsing ─────────────────────────────────────────

interface PlanTask {
  title: string;
  priority: 'high' | 'medium' | 'low';
  project: string;
  sourceFile: string;
  phase: string;
}

function inferPriority(line: string): 'high' | 'medium' | 'low' {
  const lower = line.toLowerCase();
  if (lower.includes('critical') || lower.includes('blocking') || lower.includes('phase 1')) return 'high';
  if (lower.includes('low') || lower.includes('cleanup') || lower.includes('phase 5')) return 'low';
  return 'medium';
}

function inferProject(filename: string): string {
  const map: Record<string, string> = {
    'MCP-PLATFORM-PLAN': 'mcp-homelab',
    'MASTER-ROADMAP': 'mission-control',
    'ROOM-MAPPING-SPEC': 'pete-vision',
  };
  for (const [key, project] of Object.entries(map)) {
    if (filename.includes(key)) return project;
  }
  return 'mission-control';
}

export async function extractPlanTasks(planningRoot: string): Promise<PlanTask[]> {
  const tasks: PlanTask[] = [];

  let files: string[] = [];
  try {
    files = (await readdir(planningRoot))
      .filter(f => f.endsWith('.md') && !f.startsWith('.'));
  } catch {
    return [];
  }

  for (const file of files) {
    const path = join(planningRoot, file);
    let content: string;
    try {
      content = await readFile(path, 'utf-8');
    } catch {
      continue;
    }

    // Skip completed/superseded plans
    if (/Status:\s*(COMPLETE|SUPERSEDED)/i.test(content.slice(0, 500))) continue;

    const project = inferProject(file);
    let currentPhase = 'General';

    for (const line of content.split('\n')) {
      // Track phase headings
      const phaseMatch = line.match(/^#{1,3}\s+Phase\s+[\d.]+[^`\n]*/);
      if (phaseMatch) {
        currentPhase = phaseMatch[0].replace(/^#+\s+/, '').trim();
        continue;
      }

      // Incomplete checklist items: - [ ] or * [ ]
      const taskMatch = line.match(/^[-*]\s+\[\s\]\s+(.+)/);
      if (taskMatch) {
        const title = taskMatch[1].trim().slice(0, 100);
        if (title.length < 5) continue;
        tasks.push({
          title,
          priority: inferPriority(line + currentPhase),
          project,
          sourceFile: file,
          phase: currentPhase,
        });
        continue;
      }

      // Status: [ ] Not started lines
      const statusMatch = line.match(/\*\*Status\*\*:\s*\[\s*\]\s*Not started[^)]*\)\s*(.+)/);
      if (statusMatch) {
        const title = statusMatch[1].trim().slice(0, 100);
        if (title) tasks.push({ title, priority: 'medium', project, sourceFile: file, phase: currentPhase });
      }
    }
  }

  return tasks;
}

// ─── sync-board ───────────────────────────────────────────────────

export interface SyncBoardResult {
  toAdd: PlanTask[];
  toClose: ProjectItem[];
  preview: string;
}

export async function computeBoardDiff(projectNumber: number): Promise<SyncBoardResult> {
  const [planTasks, boardItems] = await Promise.all([
    extractPlanTasks(PLANNING_ROOT),
    listProjectItems(projectNumber),
  ]);

  const boardTitlesLower = new Set(boardItems.map(i => i.title.toLowerCase().trim()));
  const doneTitlesLower = new Set(
    boardItems
      .filter(i => i.status === 'Done' || i.status === 'Blogged')
      .map(i => i.title.toLowerCase().trim())
  );

  // Tasks in plans not on board (and not already marked done)
  const toAdd = planTasks.filter(t =>
    !boardTitlesLower.has(t.title.toLowerCase().trim()) &&
    !doneTitlesLower.has(t.title.toLowerCase().trim())
  );

  // Board items in Todo/In Progress that are also ✅ complete in plans
  const completedInPlans = new Set<string>();
  try {
    const files = (await readdir(PLANNING_ROOT)).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = await readFile(join(PLANNING_ROOT, file), 'utf-8');
      for (const line of content.split('\n')) {
        const doneMatch = line.match(/[-*]\s+\[x\]\s+(.+)/i) || line.match(/✅\s+(.+)/);
        if (doneMatch) completedInPlans.add(doneMatch[1].trim().toLowerCase().slice(0, 80));
      }
    }
  } catch { /* */ }

  const toClose = boardItems.filter(i =>
    (i.status === 'Todo' || i.status === 'In Progress') &&
    completedInPlans.has(i.title.toLowerCase().trim())
  );

  const lines: string[] = [];

  if (toAdd.length) {
    lines.push(`**Add to board (${toAdd.length} items from planning docs):**`);
    for (const t of toAdd) {
      lines.push(`  + [${t.priority}] ${t.title} ← ${t.sourceFile} / ${t.phase}`);
    }
  }

  if (toClose.length) {
    lines.push(`\n**Close as Done (${toClose.length} items already complete in plans):**`);
    for (const i of toClose) {
      lines.push(`  ✓ ${i.title} [${i.status}]`);
    }
  }

  if (!toAdd.length && !toClose.length) {
    lines.push('Board is in sync with planning docs — no changes needed.');
  }

  return { toAdd, toClose, preview: lines.join('\n') };
}

export async function applySyncBoard(
  diff: SyncBoardResult,
  projectNumber: number,
): Promise<string> {
  const results: string[] = [];

  if (diff.toAdd.length) {
    const taskInputs: TaskInput[] = diff.toAdd.map(t => ({
      title: t.title,
      description: `From ${t.sourceFile} — ${t.phase}`,
      priority: t.priority,
      project: t.project,
    }));
    const created = await createTasksOnBoard(taskInputs, projectNumber);
    results.push(`Created ${created.created.length} items on board (${created.failed.length} failed).`);
  }

  if (diff.toClose.length) {
    for (const item of diff.toClose) {
      await updateItemStatus(projectNumber, item.id, 'Done');
    }
    results.push(`Marked ${diff.toClose.length} items Done.`);
  }

  return results.join(' ');
}

// ─── weekly-report ────────────────────────────────────────────────

export async function buildWeeklyReport(projectNumber: number): Promise<string> {
  const [boardItems, agentHistory] = await Promise.all([
    listProjectItems(projectNumber),
    fetchRecentAgentRuns(),
  ]);

  const byStatus: Record<string, ProjectItem[]> = {};
  for (const item of boardItems) {
    const s = item.status || 'No Status';
    (byStatus[s] ??= []).push(item);
  }

  const lines: string[] = ['## Weekly Platform Report', ''];

  // Board state
  lines.push('### Board');
  for (const [status, items] of Object.entries(byStatus)) {
    if (status === 'Done' || status === 'Blogged') continue;
    lines.push(`**${status}** (${items.length})`);
    for (const i of items.slice(0, 5)) {
      lines.push(`  - ${i.title}${i.priority ? ` [${i.priority}]` : ''}`);
    }
  }
  const doneCount = (byStatus['Done']?.length ?? 0) + (byStatus['Blogged']?.length ?? 0);
  if (doneCount) lines.push(`**Done/Blogged**: ${doneCount} items`);

  // Agent activity
  lines.push('', '### Agent Activity (last 7 days)');
  if (agentHistory.length === 0) {
    lines.push('No agent runs recorded.');
  } else {
    const byAgent: Record<string, typeof agentHistory> = {};
    for (const run of agentHistory) {
      (byAgent[run.agent_name] ??= []).push(run);
    }
    for (const [agent, runs] of Object.entries(byAgent)) {
      const complete = runs.filter(r => r.status === 'complete').length;
      const failed = runs.filter(r => r.status === 'failed').length;
      lines.push(`**${agent}**: ${runs.length} runs — ${complete} complete, ${failed} failed`);
    }
  }

  return lines.join('\n');
}

async function fetchRecentAgentRuns(): Promise<Array<{ agent_name: string; status: string; summary: string }>> {
  try {
    const res = await fetch(`${MC_BACKEND_URL}/api/v1/agents/history?limit=200`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { runs: Array<{ agent_name: string; status: string; summary: string; issued_at: string }> };
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return data.runs.filter(r => new Date(r.issued_at).getTime() > cutoff);
  } catch {
    return [];
  }
}

export async function postWeeklyReportToDiscord(report: string): Promise<void> {
  try {
    await fetch(`${NOTIFICATION_SERVICE_URL}/api/v1/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: report,
        severity: 'info',
        source: 'pm-agent',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* non-fatal */ }
}

// ─── close-done ───────────────────────────────────────────────────

export interface CloseDoneResult {
  markedDoneInPlans: string[];
  plansToArchive: string[];
  preview: string;
}

export async function computeCloseDone(projectNumber: number): Promise<CloseDoneResult> {
  const boardItems = await listProjectItems(projectNumber);
  const doneItems = boardItems.filter(i => i.status === 'Done' || i.status === 'Blogged');
  const doneTitles = new Set(doneItems.map(i => i.title.toLowerCase().trim()));

  let files: string[] = [];
  try {
    files = (await readdir(PLANNING_ROOT)).filter(f => f.endsWith('.md'));
  } catch {
    return { markedDoneInPlans: [], plansToArchive: [], preview: 'Cannot read planning directory.' };
  }

  const markedDoneInPlans: string[] = [];
  const plansToArchive: string[] = [];

  for (const file of files) {
    const path = join(PLANNING_ROOT, file);
    let content: string;
    try { content = await readFile(path, 'utf-8'); } catch { continue; }

    if (/Status:\s*(COMPLETE|SUPERSEDED)/i.test(content.slice(0, 500))) continue;

    let modified = content;
    let anyMarked = false;

    // Mark [ ] items as [x] if they appear as Done on the board
    modified = modified.replace(/^([-*]\s+)\[\s\]\s+(.+)$/gm, (match, prefix, title) => {
      if (doneTitles.has(title.trim().toLowerCase().slice(0, 80))) {
        anyMarked = true;
        markedDoneInPlans.push(`${file}: ${title.trim()}`);
        return `${prefix}[x] ${title}`;
      }
      return match;
    });

    if (anyMarked) {
      // Check if all tasks are now complete → candidate for archiving
      const remainingOpen = (modified.match(/^[-*]\s+\[\s\]/gm) ?? []).length;
      if (remainingOpen === 0) plansToArchive.push(file);
    }
  }

  const lines: string[] = [];
  if (markedDoneInPlans.length) {
    lines.push(`**Mark done in plans (${markedDoneInPlans.length}):**`);
    markedDoneInPlans.forEach(m => lines.push(`  ✓ ${m}`));
  }
  if (plansToArchive.length) {
    lines.push(`\n**Archive to planning/completed/ (all tasks complete):**`);
    plansToArchive.forEach(f => lines.push(`  → ${f}`));
  }
  if (!lines.length) lines.push('No done items to reconcile with plans.');

  return { markedDoneInPlans, plansToArchive, preview: lines.join('\n') };
}

export async function applyCloseDone(result: CloseDoneResult): Promise<string> {
  const outcomes: string[] = [];
  const completedDir = join(PLANNING_ROOT, 'completed');
  try { await mkdir(completedDir, { recursive: true }); } catch { /* */ }

  // Re-write plan files with [x] markers
  const fileMap: Record<string, string[]> = {};
  for (const entry of result.markedDoneInPlans) {
    const [file] = entry.split(': ');
    (fileMap[file] ??= []).push(entry);
  }

  for (const file of Object.keys(fileMap)) {
    const path = join(PLANNING_ROOT, file);
    try {
      let content = await readFile(path, 'utf-8');
      // Re-apply [x] marking (same logic as compute)
      content = content.replace(/^([-*]\s+)\[\s\]\s+(.+)$/gm, (match, prefix, title) => {
        const marked = result.markedDoneInPlans.some(m => m.includes(title.trim().slice(0, 40)));
        return marked ? `${prefix}[x] ${title}` : match;
      });
      await writeFile(path, content, 'utf-8');
    } catch { /* */ }
  }

  if (result.markedDoneInPlans.length) {
    outcomes.push(`Marked ${result.markedDoneInPlans.length} tasks done in plans.`);
  }

  // Archive complete plans
  for (const file of result.plansToArchive) {
    const src = join(PLANNING_ROOT, file);
    const dest = join(completedDir, file);
    try {
      let content = await readFile(src, 'utf-8');
      const today = new Date().toISOString().split('T')[0];
      const banner = `> **Status: COMPLETE — ${today}**\n> All tasks complete. Archived to \`planning/completed/\`.\n\n`;
      content = content.replace(/^(#[^\n]+\n)/, `$1\n${banner}`);
      await writeFile(dest, content, 'utf-8');
      await rename(src, dest);
      outcomes.push(`Archived ${file} to planning/completed/.`);
    } catch (err) {
      outcomes.push(`Failed to archive ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return outcomes.join(' ') || 'Nothing to apply.';
}
