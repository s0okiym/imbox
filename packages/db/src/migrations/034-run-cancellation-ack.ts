export const runCancellationAckSql = `
ALTER TABLE agent_runs ADD COLUMN cancellation_acknowledged_at timestamptz;
`;
