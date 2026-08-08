import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_NAMES, createPlannerTools, plannerCreateTaskSchema } from '../src/tools.js';

function makeTools(overrides = {}) {
  const profileStore = overrides.profileStore ?? {
    async listProfiles() {
      return ['default'];
    },
  };
  const auth = overrides.auth ?? {
    async getStatus() {
      return { connected: true, expiresAt: '2030-01-01T00:00:00.000Z' };
    },
  };
  const graph = overrides.graph ?? {
    async listPlans() {
      return [];
    },
    async listBuckets() {
      return [];
    },
    async listTasks() {
      return [];
    },
    async getTask() {
      return null;
    },
    async createTask() {
      return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' };
    },
    async deleteTask() {
      return null;
    },
  };

  return { tools: createPlannerTools({ auth, graph, profileStore }), profileStore, auth, graph };
}

function makeToolsWithBucketOps(overrides = {}) {
  const base = makeTools(overrides);
  return {
    ...base,
    graph: {
      ...base.graph,
      async getBucketWithEtag() { return null; },
      async updateBucket() { return null; },
      async deleteBucket() { return null; },
    },
  };
}

test('TOOL_NAMES exports all thirteen tool names', () => {
  assert.equal(TOOL_NAMES.length, 13);
  assert.deepEqual(TOOL_NAMES, [
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
  ]);
});

test('planner_create_task schema does not expose assignee_email', () => {
  assert.equal(Object.hasOwn(plannerCreateTaskSchema.shape, 'assignee_email'), false);
});

test('planner_list_profiles returns loaded profiles and ignores the profile arg', async () => {
  const calls = [];
  const { tools, profileStore } = makeTools({
    profileStore: {
      async listProfiles() {
        calls.push('listProfiles');
        return ['default', 'work'];
      },
    },
  });

  const result = await tools.listProfiles({ profile: 'secretaria' });

  assert.deepEqual(result, { profiles: ['default', 'work'] });
  assert.deepEqual(calls, ['listProfiles']);
});

test('planner_status reports connection state without touching Graph', async () => {
  const graphCalls = [];
  const { tools } = makeTools({
    graph: {
      ...makeTools().graph,
      async listPlans() { graphCalls.push('listPlans'); return []; },
    },
    auth: {
      async getStatus() {
        return { connected: true, expiresAt: '2030-01-01T00:00:00.000Z' };
      },
    },
  });

  const result = await tools.status({ profile: 'secretaria' });

  assert.deepEqual(result, { connected: true, expiresAt: '2030-01-01T00:00:00.000Z' });
  assert.deepEqual(graphCalls, []);
});

test('planner_list_plans returns sanitized rows and ignores the profile arg', async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listPlans() {
        calls.push('listPlans');
        return [
          { id: 'p1', title: 'Board', ownerGroupId: 'g1', description: 'secret', members: ['x'] },
        ];
      },
      async listBuckets() { return []; },
      async listTasks() { return []; },
      async getTask() { return null; },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
    },
  });

  const result = await tools.listPlans({ profile: 'secretaria' });

  assert.deepEqual(result, [{ id: 'p1', title: 'Board', ownerGroupId: 'g1' }]);
  assert.deepEqual(calls, ['listPlans']);
});

test('planner_list_tasks filters by bucket and date inputs and strips description', async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks(planId, filters) {
        calls.push({ planId, filters });
        return filters.bucketId === '22222222-2222-4222-8222-222222222222' && filters.assignedToMe === true
          ? [
            { id: 't1', title: 'One', bucketId: '22222222-2222-4222-8222-222222222222', dueDateTime: '2026-08-01T00:00:00.000Z', assignments: { self: {} }, description: 'secret' },
          ]
          : [];
      },
      async getTask() { return null; },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
    },
  });

  const result = await tools.listTasks({
    profile: 'secretaria',
    plan_id: '11111111-1111-4111-8111-111111111111',
    bucket_id: '22222222-2222-4222-8222-222222222222',
    due_before: '2026-12-31',
    due_after: '2026-01-01',
    assigned_to_me: true,
  });

  assert.deepEqual(calls, [{
    planId: '11111111-1111-4111-8111-111111111111',
    filters: {
      bucketId: '22222222-2222-4222-8222-222222222222',
      dueBefore: '2026-12-31',
      dueAfter: '2026-01-01',
      assignedToMe: true,
    },
  }]);
  assert.deepEqual(result, [
    { id: 't1', title: 'One', bucketId: '22222222-2222-4222-8222-222222222222', dueDateTime: '2026-08-01T00:00:00.000Z', assignments: ['self'] },
  ]);
  assert.equal(Object.hasOwn(result[0], 'description'), false);
});

test('planner_get_task truncates description by default and returns full on opt-in', async () => {
  const longDescription = 'x'.repeat(1200);
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks() { return []; },
      async getTask() {
        return { id: 'task-1', title: 'Task', bucketId: 'bucket-1', description: longDescription, assignments: { self: {} } };
      },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
    },
  });

  const short = await tools.getTask({ profile: 'secretaria', task_id: '33333333-3333-4333-8333-333333333333' });
  const full = await tools.getTask({ profile: 'secretaria', task_id: '33333333-3333-4333-8333-333333333333', include_full_description: true });

  assert.equal(short.description.length <= 500, true);
  assert.equal(full.description.length, 1200);
});

test('planner_create_task self-assigns through Graph and rejects invalid input', async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks() { return []; },
      async getTask() { return null; },
      async createTask(payload) {
        calls.push(payload);
        return { id: 'task-99', title: payload.title, bucketId: payload.bucketId, dueDateTime: payload.dueDateTime };
      },
    },
  });

  const created = await tools.createTask({
    profile: 'secretaria',
    plan_id: '44444444-4444-4444-8444-444444444444',
    bucket_id: '55555555-5555-4555-8555-555555555555',
    title: 'New task',
    due_date: '2026-08-01',
  });

  assert.deepEqual(calls, [{
    planId: '44444444-4444-4444-8444-444444444444',
    bucketId: '55555555-5555-4555-8555-555555555555',
    title: 'New task',
    dueDateTime: '2026-08-01T00:00:00.000Z',
  }]);
  assert.deepEqual(created, {
    id: 'task-99',
    title: 'New task',
    bucketId: '55555555-5555-4555-8555-555555555555',
    dueDateTime: '2026-08-01T00:00:00.000Z',
  });

  await assert.rejects(
    tools.createTask({ profile: 'secretaria', plan_id: 'abc', bucket_id: '55555555-5555-4555-8555-555555555555', title: 'x' }),
    /uuid/i,
  );
  await assert.rejects(
    tools.createTask({ profile: 'secretaria', plan_id: '44444444-4444-4444-8444-444444444444', bucket_id: 'bad', title: 'x' }),
    /uuid/i,
  );
  await assert.rejects(
    tools.createTask({ profile: 'secretaria', plan_id: '44444444-4444-4444-8444-444444444444', bucket_id: '55555555-5555-4555-8555-555555555555', title: 'x'.repeat(257) }),
    /256/i,
  );
  await assert.rejects(
    tools.createTask({ profile: 'secretaria', plan_id: '44444444-4444-4444-8444-444444444444', bucket_id: '55555555-5555-4555-8555-555555555555', title: 'x', due_date: '2026/08/01' }),
    /YYYY-MM-DD/i,
  );
});

test('planner_update_bucket forwards the bucket_id and name to graph.updateBucket', async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks() { return []; },
      async getTask() { return null; },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
      async updateBucket(bucketId, name) {
        calls.push({ bucketId, name });
        return null;
      },
    },
  });

  const result = await tools.updateBucket({
    profile: 'secretaria',
    bucket_id: 'bucket-99',
    name: 'Nuevo nombre',
  });

  assert.deepEqual(calls, [{ bucketId: 'bucket-99', name: 'Nuevo nombre' }]);
  assert.deepEqual(result, { updated: true, bucketId: 'bucket-99', name: 'Nuevo nombre' });
});

test('planner_update_bucket rejects empty name', async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.updateBucket({ profile: 'secretaria', bucket_id: 'bucket-99', name: '' }),
    /min/i,
  );
});

test('planner_delete_bucket requires confirm: true', async () => {
  const { tools } = makeTools({});
  await assert.rejects(
    tools.deleteBucket({ profile: 'secretaria', bucket_id: 'bucket-99' }),
    /expected true/i,
  );
});

test('planner_delete_bucket forwards the bucket_id to graph.deleteBucket', async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks() { return []; },
      async getTask() { return null; },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
      async getBucketWithEtag() { return { id: 'bucket-99', name: 'Test', planId: 'plan-1', '@odata.etag': '"etag-1"' }; },
      async deleteBucket(bucketId) {
        calls.push({ bucketId });
        return null;
      },
    },
  });

  const result = await tools.deleteBucket({
    profile: 'secretaria',
    bucket_id: 'bucket-99',
    confirm: true,
  });

  assert.deepEqual(calls, [{ bucketId: 'bucket-99' }]);
  assert.deepEqual(result, { deleted: true, bucketId: 'bucket-99' });
});

test('planner_delete_bucket warns when bucket has tasks', async () => {
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks() { return [{ id: 't-1', title: 'Task' }, { id: 't-2', title: 'Another' }]; },
      async getTask() { return null; },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
      async getBucketWithEtag() { return { id: 'bucket-99', name: 'Test', planId: 'plan-1', '@odata.etag': '"etag-1"' }; },
      async deleteBucket() { throw new Error('should not reach delete'); },
    },
  });

  const result = await tools.deleteBucket({
    profile: 'secretaria',
    bucket_id: 'bucket-99',
    confirm: true,
  });

  assert.equal(result.blocked, true);
  assert.match(result.reason, /2 task/);
});

test('planner_delete_task warns when task is not complete', async () => {
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks() { return []; },
      async getTask() { return { id: 't-1', title: 'Test', percentComplete: 40 }; },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
      async deleteTask() { throw new Error('should not reach delete'); },
    },
  });

  const result = await tools.deleteTask({
    profile: 'secretaria',
    task_id: 't-1',
    confirm: true,
  });

  assert.equal(result.blocked, true);
  assert.match(result.reason, /40%/);
});

test('planner_delete_task deletes when task is 100% complete', async () => {
  const calls = [];
  const { tools } = makeTools({
    graph: {
      async listPlans() { return []; },
      async listBuckets() { return []; },
      async listTasks() { return []; },
      async getTask() { return { id: 't-1', title: 'Test', percentComplete: 100 }; },
      async createTask() { return { id: 'task-1', title: 'Task', bucketId: 'bucket-1' }; },
      async deleteTask(taskId) {
        calls.push({ taskId });
        return null;
      },
    },
  });

  const result = await tools.deleteTask({
    profile: 'secretaria',
    task_id: 't-1',
    confirm: true,
  });

  assert.deepEqual(calls, [{ taskId: 't-1' }]);
  assert.deepEqual(result, { deleted: true, taskId: 't-1' });
});
