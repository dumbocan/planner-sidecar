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
  'planner_update_task',
  'planner_delete_task',
  'planner_create_plan',
  'planner_create_bucket',
  'planner_update_bucket',
  'planner_delete_bucket',
];

const profileArgSchema = z.object({ profile: z.string().optional() }).passthrough();

const plannerId = () => z.string().min(1).max(512);

export const plannerCreateTaskSchema = profileArgSchema.extend({
  plan_id: plannerId(),
  bucket_id: plannerId(),
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  due_date: z.string().regex(DATE_REGEX, 'due_date must be YYYY-MM-DD').optional(),
}).strict();

const plannerListBucketsSchema = profileArgSchema.extend({
  plan_id: plannerId(),
}).strict();

const plannerListTasksSchema = profileArgSchema.extend({
  plan_id: plannerId(),
  bucket_id: plannerId().optional(),
  due_before: z.string().regex(DATE_REGEX, 'due_before must be YYYY-MM-DD').optional(),
  due_after: z.string().regex(DATE_REGEX, 'due_after must be YYYY-MM-DD').optional(),
  assigned_to_me: z.boolean().optional(),
}).strict();

const plannerGetTaskSchema = profileArgSchema.extend({
  task_id: plannerId(),
  include_full_description: z.boolean().optional(),
}).strict();

const plannerUpdateTaskSchema = profileArgSchema.extend({
  task_id: plannerId(),
  percent_complete: z.number().int().min(0).max(100).optional(),
  due_date: z.string().regex(DATE_REGEX, 'due_date must be YYYY-MM-DD').optional(),
  bucket_id: plannerId().optional(),
  title: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
}).strict();

const plannerDeleteTaskSchema = profileArgSchema.extend({
  task_id: plannerId(),
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'confirm must be true to delete a task' }),
  }),
}).strict();

const plannerCreatePlanSchema = profileArgSchema.extend({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  group_id: plannerId().optional(),
}).strict();

const plannerCreateBucketSchema = profileArgSchema.extend({
  plan_id: plannerId(),
  name: z.string().min(1).max(128),
}).strict();

const plannerUpdateBucketSchema = profileArgSchema.extend({
  bucket_id: plannerId(),
  name: z.string().min(1).max(128),
}).strict();

const plannerDeleteBucketSchema = profileArgSchema.extend({
  bucket_id: plannerId(),
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'confirm must be true to delete a bucket' }),
  }),
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
    owner: boundText(row?.owner, 512),
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
  if (row?.percentComplete !== undefined && row?.percentComplete !== null) task.percentComplete = row.percentComplete;
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

    async updateTask(input) {
      const parsed = parseArgs(plannerUpdateTaskSchema, input);
      const body = {};
      if (parsed.percent_complete !== undefined) body.percentComplete = parsed.percent_complete;
      if (parsed.due_date !== undefined) body.dueDateTime = `${parsed.due_date}T00:00:00.000Z`;
      if (parsed.bucket_id !== undefined) body.bucketId = parsed.bucket_id;
      if (parsed.title !== undefined) body.title = parsed.title;
      const row = await graph.updateTask(parsed.task_id, body);
      return { updated: true, taskId: parsed.task_id, changes: Object.keys(body) };
    },
    async deleteTask(input) {
      const parsed = parseArgs(plannerDeleteTaskSchema, input);
      await graph.deleteTask(parsed.task_id);
      return { deleted: true, taskId: parsed.task_id };
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
    async createPlan(input) {
      const parsed = parseArgs(plannerCreatePlanSchema, input);
      let groupId = parsed.group_id;
      if (!groupId) {
        const plans = await graph.listPlans();
        if (!plans.length) throw new Error('No existing plans found — provide a group_id to create the first plan');
        groupId = plans[0].owner;
      }
      const row = await graph.createPlan(parsed.title, groupId);
      return normalizePlanRow(row);
    },
    async createBucket(input) {
      const parsed = parseArgs(plannerCreateBucketSchema, input);
      const row = await graph.createBucket(parsed.plan_id, parsed.name);
      return normalizeBucketRow(row);
    },
    async updateBucket(input) {
      const parsed = parseArgs(plannerUpdateBucketSchema, input);
      await graph.updateBucket(parsed.bucket_id, parsed.name);
      return { updated: true, bucketId: parsed.bucket_id, name: parsed.name };
    },
    async deleteBucket(input) {
      const parsed = parseArgs(plannerDeleteBucketSchema, input);

      // Warn if the bucket still has tasks — deleting a Planner bucket deletes all tasks inside it.
      const bucket = await graph.getBucketWithEtag(parsed.bucket_id);
      const planId = bucket?.planId;
      if (planId) {
        const tasks = await graph.listTasks(planId, { bucketId: parsed.bucket_id });
        if (tasks.length > 0) {
          return {
            blocked: true,
            reason: `Bucket ${parsed.bucket_id} still has ${tasks.length} task(s). Deleting a Planner bucket permanently removes all its tasks. Move or delete the tasks first, or call deleteBucket again with confirm: true and a force: true flag.`,
          };
        }
      }

      await graph.deleteBucket(parsed.bucket_id);
      return { deleted: true, bucketId: parsed.bucket_id };
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
  planner_update_task: plannerUpdateTaskSchema,
  planner_delete_task: plannerDeleteTaskSchema,
  planner_create_plan: plannerCreatePlanSchema,
  planner_create_bucket: plannerCreateBucketSchema,
  planner_update_bucket: plannerUpdateBucketSchema,
  planner_delete_bucket: plannerDeleteBucketSchema,
};
