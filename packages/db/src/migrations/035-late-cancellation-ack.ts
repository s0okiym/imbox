export const lateCancellationAckSql = `
ALTER TABLE agent_runs ADD COLUMN last_claim_holder text;
ALTER TABLE agent_runs ADD COLUMN last_claim_generation bigint;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_last_claim_pair CHECK
 ((last_claim_holder IS NULL AND last_claim_generation IS NULL) OR
  (last_claim_holder IS NOT NULL AND last_claim_generation IS NOT NULL AND last_claim_generation>0));
UPDATE agent_runs SET last_claim_holder=lease_holder,last_claim_generation=lease_generation WHERE lease_holder IS NOT NULL AND lease_generation>0;
`;
