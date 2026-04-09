import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const VALID_PROJECTS = [
  'pm-agent', 'pete-vision', 'blog', 'mission-control',
  'infrastructure', 'notification-service', 'web-search', 'mcp-homelab',
] as const;

export const PmAgentInputSchema = z.object({
  mode: z.enum(['board-status', 'break-plan', 'full-cycle']).default('board-status')
    .describe('board-status: summarize board | break-plan: parse a plan doc into tasks | full-cycle: both'),
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
});

export type PmAgentInput = z.infer<typeof PmAgentInputSchema>;

export const PmTaskPayloadSchema = TaskPayloadSchema.extend({
  input: PmAgentInputSchema,
});
