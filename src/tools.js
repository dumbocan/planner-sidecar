import { z } from 'zod';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_TITLE_CHARS = 256;

export const TOOL_NAMES = [
  'planner_list_profiles',
  'planner_status',
  'planner_list_plans',
  'planner_list_buckets',
  'planner_list_tasks',
  'planner_get_task',
  'planner_create_task',
];

const profileArgSchema = z.object({ profile: z.string().optional() }).passthrough();

export const plannerCreateTaskSchema = profileArgSchema.extend({
  plan_id: z.string().uuid(),
  bucket_id: z.string().uuid(),
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  due_date: z.string().regex(DATE_REGEX, 'due_date must be YYYY-MM-DD').optional(),
}).strict();

const plannerListBucketsSchema = profileArgSchema.extend({
  plan_id: z.string().uuid(),
}).strict();

const plannerListTasksSchema = profileArgSchema.extend({
  plan_id: z.string().uuid(),
  bucket_id: z.string().uuid().optional(),
  due_before: z.string().regex(DATE_REGEX, 'due_before must be YYYY-MM-DD').optional(),
  due_after: z.string().regex(DATE_REGEX, 'due_after must be YYYY-MM-DD').optional(),
  assigned_to_me: z.boolean().optional(),
}).strict();

const plannerGetTaskSchema = profileArgSchema.extend({
  task_id: z.string().uuid(),
  include_full_description: z.boolean().optional(),
}).strict();

const plannerStatusSchema = profileArgSchema.strict();

const plannerListPlansSchema = profileArgSchema.strict();
const plannerListProfilesSchema = profileArgSchema.strict();

function boundText(value, maximum) {
  return String(value ?? '').slice(0, maximum);
}

function normalizePlanRow(row) {
  return {
    id: boundText(row?.id, 512),
    title: boundText(row?.title, 512),
    ownerGroupId: boundText(row?.ownerGroupId, 512),
  };
}

function normalizeBucketRow(row) {
  return {
    id: boundText(row?.id, 512),
    name: boundText(row?.name, 512),
    orderHint: boundText(row?.orderHint, 512),
  };
}

function normalizeTaskRow(row, { includeDescription = false, descriptionLimit = MAX_DESCRIPTION_CHARS } = {}) {
  const task = {
    id: boundText(row?.id, 512),
    title: boundText(row?.title, MAX_TITLE_CHARS),
    bucketId: boundText(row?.bucketId, 512),
  };
  if (row?.dueDateTime) task.dueDateTime = boundText(row.dueDateTime, 512);
  if (row?.assignments && typeof row.assignments === 'object') {
    task.assignments = Array.isArray(row.assignments)
      ? row.assignments.map((value) => boundText(value, 512))
      : Object.keys(row.assignments).map((key) => boundText(key, 512));
  } else {
    task.assignments = [];
  }
  if (includeDescription) {
    task.description = boundText(row?.description, descriptionLimit);
  }
  return task;
}

function parseArgs(schema, input) {
  return schema.parse(input ?? {});
}

export function createPlannerTools({ auth, graph, profileStore }) {
  if (!auth || !graph || !profileStore) {
    throw new TypeError('auth, graph, and profileStore are required');
  }

  return {
    async listProfiles(input) {
      parseArgs(plannerListProfilesSchema, input);
      const profiles = await profileStore.listProfiles();
      return { profiles: [...profiles] };
    },

    async status(input) {
      parseArgs(plannerStatusSchema, input);
      const status = typeof auth.getStatus === 'function'
        ? await auth.getStatus()
        : { connected: false, expiresAt: null };
      return {
        connected: Boolean(status?.connected),
        ...(status?.expiresAt ? { expiresAt: status.expiresAt } : {}),
      };
    },

    async listPlans(input) {
      parseArgs(plannerListPlansSchema, input);
      const rows = await graph.listPlans();
      return rows.map(normalizePlanRow);
    },

    async listBuckets(input) {
      const parsed = parseArgs(plannerListBucketsSchema, input);
      const rows = await graph.listBuckets(parsed.plan_id);
      return rows.map(normalizeBucketRow);
    },

    async listTasks(input) {
      const parsed = parseArgs(plannerListTasksSchema, input);
      const rows = await graph.listTasks(parsed.plan_id, {
        bucketId: parsed.bucket_id,
        dueBefore: parsed.due_before,
        dueAfter: parsed.due_after,
        assignedToMe: parsed.assigned_to_me,
      });
      return rows.map((row) => normalizeTaskRow(row, { includeDescription: false }));
    },

    async getTask(input) {
      const parsed = parseArgs(plannerGetTaskSchema, input);
      const row = await graph.getTask(parsed.task_id);
      return normalizeTaskRow(row, {
        includeDescription: true,
        descriptionLimit: parsed.include_full_description ? Number.POSITIVE_INFINITY : MAX_DESCRIPTION_CHARS,
      });
    },

    async createTask(input) {
      const parsed = parseArgs(plannerCreateTaskSchema, input);
      const row = await graph.createTask({
        planId: parsed.plan_id,
        bucketId: parsed.bucket_id,
        title: parsed.title,
        ...(parsed.due_date ? { dueDateTime: `${parsed.due_date}T00:00:00.000Z` } : {}),
      });
      return {
        id: boundText(row?.id, 512),
        title: boundText(row?.title ?? parsed.title, MAX_TITLE_CHARS),
        bucketId: boundText(row?.bucketId ?? parsed.bucket_id, 512),
        ...(row?.dueDateTime ? { dueDateTime: boundText(row.dueDateTime, 512) } : {}),
      };
    },
  };
}

export const toolSchemas = {
  planner_list_profiles: plannerListProfilesSchema,
  planner_status: plannerStatusSchema,
  planner_list_plans: plannerListPlansSchema,
  planner_list_buckets: plannerListBucketsSchema,
  planner_list_tasks: plannerListTasksSchema,
  planner_get_task: plannerGetTaskSchema,
  planner_create_task: plannerCreateTaskSchema,
};
