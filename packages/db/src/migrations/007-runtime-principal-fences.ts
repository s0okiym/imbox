/** Existing runs intentionally retain invalid zero/empty fences and require recreation. */
export const runtimePrincipalFencesSql = `
ALTER TABLE agent_runs ADD COLUMN creator_principal_version bigint NOT NULL DEFAULT 0 CHECK(creator_principal_version >= 0);
ALTER TABLE agent_runs ADD COLUMN agent_principal_version bigint NOT NULL DEFAULT 0 CHECK(agent_principal_version >= 0);
ALTER TABLE agent_runs ADD COLUMN scope_authorization jsonb NOT NULL DEFAULT '{}';
`;
