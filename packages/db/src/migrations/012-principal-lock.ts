/** An app may lock/read public identity state without acquiring UPDATE on global identities. */
export const principalLockSql = `
CREATE FUNCTION public.imbox_lock_principal(target uuid)
RETURNS TABLE(id uuid,kind text,status text,version bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
 SELECT p.id,p.kind,p.status,p.version FROM public.principals p WHERE p.id=target FOR SHARE OF p
$body$;
REVOKE ALL ON FUNCTION public.imbox_lock_principal(uuid) FROM PUBLIC;
`;
