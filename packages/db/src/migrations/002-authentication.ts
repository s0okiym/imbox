/** OIDC attempts are global authentication state; grant only to the identity role. */
export const authenticationSql = `
CREATE TABLE oidc_login_attempts (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  cookie_hash text NOT NULL,
  context_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_login_attempts_expiry_idx ON oidc_login_attempts(expires_at);
`;
export const authenticationTableNames: readonly string[] = ['oidc_login_attempts'];
