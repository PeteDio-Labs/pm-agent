/**
 * Tool definitions for the pm-agent Gemma 4 loop.
 */

import { readFile } from 'node:fs/promises';
import type { ToolDef } from '@petedio/shared/agents';
import { listProjectItems, type TaskInput } from './github.js';
import { DISPATCHABLE_AGENTS } from './schema.js';

// Shared state — the loop populates this so index.ts can read it for approval
export interface LoopState {
  boardSummary?: string;
  generatedTasks?: TaskInput[];
  dispatches?: Array<{ agent: string; taskId: string; input: unknown }>;
}

export function buildTools(state: LoopState, projectNumber: number, mcBackendUrl?: string, allowedAgents?: readonly string[]): ToolDef[] {
  return [
    {
      name: 'get_board_status',
      description: 'Get current GitHub Projects board status — items grouped by status with priorities',
      parameters: {
        type: 'object',
        properties: {
          projectFilter: {
            type: 'string',
            description: 'Optional: filter by project name (blog, mission-control, infrastructure, etc.)',
          },
        },
      },
      async execute(args: { projectFilter?: string }) {
        const items = await listProjectItems(projectNumber);
        const filtered = args.projectFilter
          ? items.filter(i =>
              i.project?.toLowerCase().includes(args.projectFilter!.toLowerCase()) ||
              i.title?.toLowerCase().includes(args.projectFilter!.toLowerCase())
            )
          : items;

        if (filtered.length === 0) return 'No items found on board';

        const byStatus: Record<string, typeof filtered> = {};
        for (const item of filtered) {
          const s = item.status || 'No Status';
          if (!byStatus[s]) byStatus[s] = [];
          byStatus[s].push(item);
        }

        const lines: string[] = [`Board status (${filtered.length} items):`];
        for (const [status, its] of Object.entries(byStatus)) {
          lines.push(`\n${status} (${its.length}):`);
          for (const i of its) {
            const priority = i.priority ? ` [${i.priority}]` : '';
            lines.push(`  - ${i.title}${priority}`);
          }
        }

        const summary = lines.join('\n');
        state.boardSummary = summary;
        return summary;
      },
    },

    {
      name: 'read_plan_doc',
      description: 'Read a planning document from the filesystem to extract implementation phases',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the plan doc' },
        },
        required: ['path'],
      },
      async execute(args: Record<string, unknown>) {
        const { path } = args as { path: string };
        try {
          const content = await readFile(path, 'utf-8');
          // Trim to relevant sections to save context
          const phasesMatch = content.match(/## Implementation Phases?\s*([\s\S]*?)(?=\n---|\n## [A-Z]|$)/);
          const relevant = phasesMatch ? phasesMatch[1] : content;
          // Strip completed items
          const trimmed = relevant
            .split('\n')
            .filter(line => !line.includes('✅') && !line.includes('DONE'))
            .join('\n')
            .slice(0, 4000);
          return trimmed || 'No implementation phases found in document';
        } catch (err) {
          return `Cannot read file: ${err instanceof Error ? err.message : err}`;
        }
      },
    },

    {
      name: 'dispatch_to_agent',
      description: `Dispatch a task to another agent via MC Backend. Available agents: ${DISPATCHABLE_AGENTS.join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          agentName: {
            type: 'string',
            description: `Agent to dispatch to. One of: ${DISPATCHABLE_AGENTS.join(', ')}`,
          },
          input: {
            type: 'string',
            description: 'JSON object with the agent-specific input payload',
          },
          reason: {
            type: 'string',
            description: 'One-sentence reason for dispatching this task',
          },
        },
        required: ['agentName', 'input', 'reason'],
      },
      async execute(args: Record<string, unknown>) {
        const { agentName, input: inputStr, reason } = args as { agentName: string; input: string; reason: string };

        const allowed = allowedAgents ?? DISPATCHABLE_AGENTS;
        if (!allowed.includes(agentName)) {
          return `Agent "${agentName}" is not in the allowed dispatch list: ${allowed.join(', ')}`;
        }

        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(inputStr);
        } catch {
          return `Invalid input JSON: ${inputStr}`;
        }

        const url = `${mcBackendUrl}/api/v1/agents/${agentName}/trigger`;
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentName, trigger: 'manual', input: parsedInput }),
          });

          if (!res.ok) {
            const body = await res.text();
            return `Dispatch failed (HTTP ${res.status}): ${body}`;
          }

          const data = await res.json() as { taskId?: string };
          const taskId = data.taskId ?? 'unknown';

          state.dispatches ??= [];
          state.dispatches.push({ agent: agentName, taskId, input: parsedInput });

          return `Dispatched ${agentName} — taskId: ${taskId}. Reason: ${reason}`;
        } catch (err) {
          return `Dispatch error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    {
      name: 'propose_tasks',
      description: 'Propose a structured list of tasks derived from a plan doc. These will be submitted for approval before being created on the board.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'string',
            description: 'JSON array of tasks: [{title, description, priority (high|medium|low), dependsOn?: string[]}]',
          },
        },
        required: ['tasks'],
      },
      async execute(args: Record<string, unknown>) {
        const { tasks } = args as { tasks: string };
        try {
          const parsed = JSON.parse(tasks) as TaskInput[];
          state.generatedTasks = parsed;
          const lines = parsed.map((t, i) =>
            `${i + 1}. [${t.priority}] ${t.title}\n   ${t.description}${t.dependsOn?.length ? `\n   deps: ${t.dependsOn.join(', ')}` : ''}`
          );
          return `Proposed ${parsed.length} tasks (pending approval):\n\n${lines.join('\n\n')}`;
        } catch (err) {
          return `Invalid task JSON: ${err instanceof Error ? err.message : err}`;
        }
      },
    },
  ];
}
