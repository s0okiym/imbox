/** Freeze the complete execution ancestry when proposals and submissions are made. */
export const taskFencesSql = `
ALTER TABLE collaboration_requests ADD COLUMN ancestor_fences jsonb NOT NULL DEFAULT '[]';
ALTER TABLE request_proposals ADD COLUMN ancestor_fences jsonb NOT NULL DEFAULT '[]';
ALTER TABLE task_submissions ADD COLUMN ancestor_fences jsonb NOT NULL DEFAULT '[]';
`;
