# @imbox/domain

Pure, immutable TypeScript domain rules for the first Imbox implementation stage.
The package has no database, HTTP, model, clock, or network dependency. Monetary
amounts, account counters, resource versions and fencing generations use `bigint`.
Times are explicit safe-integer Unix milliseconds supplied by the caller.

The application must authenticate and authorize actors, validate received schemas,
load complete current state, hold the documented database locks, and persist each
returned aggregate change together with events, outbox records and idempotency
results. Domain errors can contain internal identifiers: sanitize `details` before
returning them to a client. Pure function success is not a grant of authority.

- `task`: owner handoff; lifecycle, acceptance and monotonic execution epochs;
  complete ancestor-fence comparison. Archival and principal availability belong
  to separate application-managed records.
- `run`: lightweight conversation runs, task escalation, waiting/pause/cancel and
  terminal state rules. Cancellation records platform authority termination;
  it never proves an external process has stopped.
- `request`: proposal versions, expiry, clarification and immutable accepted
  decisions. The application verifies the decision maker and accepted contract.
- `action`: stable business identity and separate attempts. Only a confirmed
  effect-free failed attempt can safely return an executing Action to `ready`.
  Unknown results require observation/reconciliation; terminal Actions stay closed.
- `lease`: holder, generation and strict expiry checks, including expiry before
  another worker has taken over. Pass current database time after locking.
- `budget`: one reservation/usage record with counters on its ancestor accounts;
  parents and children are not separate charges. Unknown costs retain reserves.
  Verified actual cost may exceed estimates; the actual ledger records it and
  blocks affected accounts from new reservations.
- `dependency`: iterative cycle detection. Persist changes under the tenant-wide
  dependency-graph lock; a pure graph check cannot prevent concurrent write skew.

Budget functions model a finite supplied ledger for correctness and tests. They
are not an instruction to load every tenant's history in production: repositories
may load the relevant locked accounts, reservation and unique usage records while
enforcing the same database constraints and retaining idempotency history. A
database restore, external action journal, disclosure policy, scheduling, worker
leases for execution slots and external-effect recovery are not implemented here.
