/**
 * GitHub client for pm-agent. Lifted from mcp-homelab/src/clients/github.ts.
 * Uses Bun's $ shell helper to invoke the gh CLI.
 */

import { $ } from 'bun';

const GITHUB_ORG = process.env.GITHUB_ORG ?? 'PeteDio-Labs';

export interface ProjectItem {
  id: string;
  title: string;
  status: string;
  project: string;
  priority: string;
  url: string;
  labels: string[];
  number: number;
}

export interface TaskInput {
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  project?: string;
  dependsOn?: string[];
}

export interface CreatedItem {
  id: string;
  title: string;
  url?: string;
  number?: number;
}

// ─── Read ─────────────────────────────────────────────────────────

export async function listProjectItems(projectNumber: number): Promise<ProjectItem[]> {
  const result = await $`gh project item-list ${projectNumber} --owner ${GITHUB_ORG} --format json --limit 200`.quiet().text();
  const parsed = JSON.parse(result);
  return (parsed.items ?? []).map((item: Record<string, unknown>) => ({
    id: item.id,
    title: item.title,
    status: (item.status as string) ?? 'No Status',
    project: (item.project as string) ?? '',
    priority: (item.priority as string) ?? '',
    url: (item as { content?: { url?: string } }).content?.url ?? '',
    labels: (item.labels as string[]) ?? [],
    number: (item as { content?: { number?: number } }).content?.number ?? 0,
  }));
}

// ─── Write (gated — call only after approval) ─────────────────────

async function getProjectId(projectNumber: number): Promise<string> {
  const result = await $`gh project view ${projectNumber} --owner ${GITHUB_ORG} --format json`.quiet().text();
  return (JSON.parse(result) as { id: string }).id;
}

async function resolveFieldOption(
  projectNumber: number,
  fieldName: string,
  optionName: string,
): Promise<{ fieldId: string; optionId: string } | null> {
  const result = await $`gh project field-list ${projectNumber} --owner ${GITHUB_ORG} --format json`.quiet().text();
  const fields = ((JSON.parse(result) as { fields?: unknown[] }).fields ?? []) as Array<{
    id: string; name: string; options?: Array<{ id: string; name: string }>;
  }>;
  const field = fields.find(f => f.name.toLowerCase() === fieldName.toLowerCase());
  if (!field?.options) return null;
  const option = field.options.find(o => o.name.toLowerCase() === optionName.toLowerCase());
  if (!option) return null;
  return { fieldId: field.id, optionId: option.id };
}

async function setItemFields(
  projectNumber: number,
  projectId: string,
  itemId: string,
  fields: { project?: string; priority?: string; status?: string },
): Promise<void> {
  for (const [fieldName, value] of Object.entries(fields)) {
    if (!value) continue;
    const resolved = await resolveFieldOption(projectNumber, fieldName, value);
    if (resolved) {
      await $`gh project item-edit --project-id ${projectId} --id ${itemId} --field-id ${resolved.fieldId} --single-select-option-id ${resolved.optionId}`.quiet();
    }
  }
}

export async function createTasksOnBoard(
  tasks: TaskInput[],
  projectNumber: number,
  defaultProject?: string,
  repo?: string,
): Promise<{ created: CreatedItem[]; failed: { title: string; error: string }[] }> {
  const created: CreatedItem[] = [];
  const failed: { title: string; error: string }[] = [];
  const projectId = await getProjectId(projectNumber);

  for (const task of tasks) {
    try {
      const body = [
        task.description,
        ...(task.dependsOn?.length ? ['', '### Dependencies', ...task.dependsOn.map(d => `- ${d}`)] : []),
      ].join('\n');

      let itemId: string;

      if (repo) {
        const issueResult = await $`gh issue create --repo ${repo} --title ${task.title} --body ${body} --label ${'priority-' + task.priority}`.quiet().text();
        const issueUrl = issueResult.trim();
        const addResult = await $`gh project item-add ${projectNumber} --owner ${GITHUB_ORG} --url ${issueUrl} --format json`.quiet().text();
        itemId = (JSON.parse(addResult) as { id: string }).id;
        const num = issueUrl.match(/\/issues\/(\d+)$/);
        created.push({ id: itemId, title: task.title, url: issueUrl, number: num ? parseInt(num[1]) : undefined });
      } else {
        const draftResult = await $`gh project item-create ${projectNumber} --owner ${GITHUB_ORG} --title ${task.title} --body ${body} --format json`.quiet().text();
        itemId = (JSON.parse(draftResult) as { id: string }).id;
        created.push({ id: itemId, title: task.title });
      }

      await setItemFields(projectNumber, projectId, itemId, {
        project: task.project ?? defaultProject,
        priority: task.priority,
        status: 'Todo',
      });
    } catch (err) {
      failed.push({ title: task.title, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { created, failed };
}
