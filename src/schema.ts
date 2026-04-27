import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const VALID_PROJECTS = [
  'pm-agent', 'pete-vision', 'blog', 'mission-control',
  'infrastructure', 'notification-service', 'web-search', 'mcp-homelab',
] as const;

export const DISPATCHABLE_AGENTS = [
  'ops-investigator', 'blog-agent', 'knowledge-janitor',
  'workstation-agent', 'infra-agent',
] as const;

export const PmAgentInputSchema = z.object({
  mode: z.enum(['board-status', 'break-plan', 'full-cycle', 'dispatch-tasks', 'sync-board', 'weekly-report', 'close-done']).default('board-status')
    .describe('board-status: summarize board | break-plan: parse plan doc into tasks | full-cycle: both | dispatch-tasks: route ready items to agents | sync-board: diff plans vs board and propose changes | weekly-report: digest + Discord | close-done: mark done items in plans and archive complete plans'),
  projectNumber: z.coerce.number().default(1)
    .describe('GitHub Project number (1 = PeteDio Labs Backlog)'),
  projectFilter: z.enum(VALID_PROJECTS).optional()
    .describe('Filter board to a specific project'),
  planFile: z.string().optional()
    .describe('Absolute path to plan doc (required for break-plan / full-cycle modes)'),
  planProjectName: z.enum(VALID_PROJECTS).optional()
    .describe('Project tag to assign generated tasks'),
  repo: z.string().optional()
    .describe('Optional repo for issue creation (e.g. PeteDio-Labs/blog-api)'),
  agentsToDispatch: z.array(z.enum(DISPATCHABLE_AGENTS)).optional()
    .describe('Allowlist of agents that may be dispatched in dispatch-tasks mode (defaults to all)'),
});

export type PmAgentInput = z.infer<typeof PmAgentInputSchema>;

export const PmTaskPayloadSchema = TaskPayloadSchema.extend({
  input: PmAgentInputSchema,
});
