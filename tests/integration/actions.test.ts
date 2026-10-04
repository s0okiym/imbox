import {randomUUID} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createActionService,createFileJournal,createHttpToolRegistry,createToolRunner,requiredActionsClosed,type ActionService,type JournalPort} from '@imbox/actions';
import {createTaskService,type TaskService} from '@imbox/application';
import {runtimeCompletionGate} from '@imbox/runtime';
import type {ContractTypes as C} from '@imbox/contracts';
import {sql,withTenant} from '@imbox/db';
import {tenantFixture,testDatabases} from '../helpers/database.js';
import {createIdentityService} from '@imbox/auth';
import {createApp} from '../../apps/api/src/app.js';
let databases:Awaited<ReturnType<typeof testDatabases>>,fixture:Awaited<ReturnType<typeof tenantFixture>>,actions:ActionService,tasks:TaskService,journal:JournalPort;
let task:C['Task'];let directory:string;let sideEffects:number;let attempts:number;
let mode:'normal'|'drop'|'no_effect'='normal';
const cleanup:Array<()=>Promise<void>>=[];
const receipts=new Map<string,{status:'succeeded';receipt_id:string;fingerprint:string;cost_microunits:string;safe_retry:boolean}>();
const secret='actions-cursor-test-secret-at-least-thirty-two-characters';
const key=()=>randomUUID();
beforeAll(async()=>{databases=await testDatabases();});afterAll(async()=>{await databases?.close();});
beforeEach(async()=>{
 fixture=await tenantFixture(databases.owner);directory=await mkdtemp(join(tmpdir(),'imbox-action-journal-'));journal=await createFileJournal({directory,signingKey:secret});
 sideEffects=0;attempts=0;mode='normal';receipts.clear();
 const send=(response:ServerResponse,value:unknown)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify(value));};
 const server=createServer((request,response)=>{
  const url=new URL(request.url!,'http://localhost');
  if(request.method==='GET'){send(response,receipts.get(url.searchParams.get('business_key')!)??{status:'not_found'});return;}
  let body='';request.setEncoding('utf8');request.on('data',part=>body+=part);request.on('end',()=>{const input=JSON.parse(body) as {business_key:string;fingerprint:string};attempts++;
   if(mode==='no_effect'&&attempts===1){send(response,{status:'no_effect',receipt_id:key(),fingerprint:input.fingerprint,cost_microunits:'0',safe_retry:true});return;}
   let receipt=receipts.get(input.business_key);if(!receipt){sideEffects++;receipt={status:'succeeded',receipt_id:key(),fingerprint:input.fingerprint,cost_microunits:'7',safe_retry:false};receipts.set(input.business_key,receipt);}
   if(mode==='drop'){response.destroy();return;}send(response,receipt);
  });
 });server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
 const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 actions=createActionService({db:databases.db,journal,cursorSecret:secret,tools:createHttpToolRegistry([{id:'demo.delivery',version:'1',targetId:'demo',executeUrl:`${origin}/execute`,lookupUrl:`${origin}/lookup`,allowInsecureLoopback:true,retryDelayMs:0}])});
 tasks=createTaskService(databases.db,secret,{requiredActionsClosed:async(tx,id)=>await runtimeCompletionGate(tx,id)&&await requiredActionsClosed(tx,id)});
 task=await tasks.createTask(fixture.alice,{workspace_id:fixture.workspaceId,title:'Controlled delivery',goal:'Deliver exactly one approved message',acceptance_criteria:['Receipt confirms the approved version'],reviewer_principal_ids:[fixture.alice.principalId],budget:{currency:'USD',limit_microunits:'100'}},key());
 task=await tasks.changeParticipant(fixture.alice,task.id,fixture.bob.principalId,'contributor',task.version,key());
 task=await tasks.changeState(fixture.alice,task.id,{state:'active'},task.version,key());
});
afterEach(async()=>{for(const close of cleanup.splice(0))await close();if(directory)await rm(directory,{recursive:true,force:true});});
async function proposed(){
 const grant=await actions.createGrant(fixture.alice,{task_id:task.id,executor_principal_id:fixture.bob.principalId,tool_id:'demo.delivery',tool_version:'1',target_id:'demo',allow_execute:true,allow_disclosure:true,resource_versions:[{type:'task',id:task.id,version:task.version}],approver_principal_ids:[fixture.alice.principalId],budget:{currency:'USD',limit_microunits:'10'},expires_at:new Date(Date.now()+3600000).toISOString()},key());
 const action=await actions.createAction(fixture.bob,{task_id:task.id,grant_id:grant.id,executor_principal_id:fixture.bob.principalId,tool_id:'demo.delivery',tool_version:'1',target_id:'demo',parameters:{text:'A deliberately approved delivery'},resource_versions:[{type:'task',id:task.id,version:task.version}],business_key:key(),estimate:{currency:'USD',limit_microunits:'10'}},key());return {grant,action};
}
const approve=(action:C['Action'])=>actions.decideApproval(fixture.alice,action.id,{decision:'approve',action_version:action.approval_binding_version,fingerprint:action.fingerprint,comment:'Reviewed exact text and destination'},action.version,key());
const runner=()=>createToolRunner({actions,workerId:'test-tool-worker'});

describe('controlled actions with real PostgreSQL, HTTP and independent signed journal',()=>{
 it('requires explicit approval, records durable intent before the effect, and settles once',async()=>{
  const {action}=await proposed();await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toMatchObject({code:'FORBIDDEN'});expect(sideEffects).toBe(0);
  const approved=await approve(action);expect(await runner().runOnce(fixture.tenantId,approved.id)).toMatchObject({status:'succeeded'});expect(sideEffects).toBe(1);
  const records=await journal.records(fixture.tenantId);expect(records.filter(row=>row.kind==='intent')).toHaveLength(1);expect(records.filter(row=>row.kind==='receipt')).toHaveLength(1);expect(JSON.stringify(records)).not.toContain('A deliberately approved delivery');
  expect(await withTenant(databases.db,fixture.tenantId,tx=>requiredActionsClosed(tx,task.id))).toBe(true);
  expect((await withTenant(databases.db,fixture.tenantId,tx=>sql`select reserved_microunits,spent_microunits from task_budgets where task_id=${task.id}`.execute(tx))).rows[0]).toEqual({reserved_microunits:'0',spent_microunits:'7'});
  await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toBeDefined();expect(sideEffects).toBe(1);
 });
 it('retains an unknown result after response loss, queries it, and never resends the business action',async()=>{
  mode='drop';const {action}=await proposed();await approve(action);expect(await runner().runOnce(fixture.tenantId,action.id)).toMatchObject({status:'unknown'});expect(sideEffects).toBe(1);
  expect(await withTenant(databases.db,fixture.tenantId,tx=>requiredActionsClosed(tx,task.id))).toBe(false);
  await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toBeDefined();expect(attempts).toBe(1);
  const unknown=await actions.getAction(fixture.alice,action.id);const reconcileKey=key();const result=await actions.reconcile(fixture.alice,action.id,{reason:'Check the recorded business key'},unknown.version,reconcileKey);expect(result.outcome).toBe('succeeded');expect(sideEffects).toBe(1);expect(attempts).toBe(1);
  expect(await actions.reconcile(fixture.alice,action.id,{reason:'Check the recorded business key'},unknown.version,reconcileKey)).toMatchObject({outcome:'succeeded'});
  await expect(actions.reconcile(fixture.alice,action.id,{reason:'Different request'},unknown.version,reconcileKey)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it('retries confirmed no-effect attempts under the same action, fingerprint and business key',async()=>{
  mode='no_effect';const {action}=await proposed();await approve(action);expect(await runner().runOnce(fixture.tenantId,action.id)).toMatchObject({status:'ready'});expect(sideEffects).toBe(0);
  expect(await runner().runOnce(fixture.tenantId,action.id)).toMatchObject({status:'succeeded'});expect(sideEffects).toBe(1);expect(attempts).toBe(2);
  const intents=(await journal.records(fixture.tenantId)).filter(row=>row.kind==='intent');expect(intents).toHaveLength(2);expect(new Set(intents.map(row=>row.action_id)).size).toBe(1);expect(new Set(intents.map(row=>row.business_key)).size).toBe(1);
 });
 it('invalidates old approval after changing parameters and refuses revoked grants before effects',async()=>{
  const {action,grant}=await proposed();const approved=await approve(action);
  const revised=await actions.reviseAction(fixture.bob,action.id,{parameters:{text:'Different text'},resource_versions:action.resource_versions},approved.version,key());expect(revised.fingerprint).not.toBe(action.fingerprint);expect(revised.status).toBe('awaiting_approval');
  await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toBeDefined();
  await approve(revised);await actions.revokeGrant(fixture.alice,grant.id,grant.revision,key());await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toBeDefined();expect(sideEffects).toBe(0);
 });
 it('rejects expired leases even before takeover and retains unresolved attempts',async()=>{
  const {action}=await proposed();await approve(action);const claim=await actions.claim(fixture.tenantId,action.id,'test-tool-worker');await actions.persistIntent(claim);
  await withTenant(databases.owner,fixture.tenantId,tx=>sql`update actions set lease_expires_at=clock_timestamp()-interval '1 second' where id=${action.id}`.execute(tx));
  await expect(actions.dispatch(claim)).rejects.toMatchObject({code:'LEASE_EXPIRED'});expect(sideEffects).toBe(0);
  await actions.expireLeases(fixture.tenantId);expect((await actions.getAction(fixture.alice,action.id)).status).toBe('unknown');
 });
 it('does not revive a grant or action when a disabled global identity is re-enabled',async()=>{
  const {action}=await proposed();await approve(action);
  await databases.identityDb.updateTable('principals').set({status:'disabled',version:sql`version+1`}).where('id','=',fixture.bob.principalId).execute();
  await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toMatchObject({code:'FORBIDDEN'});
  await databases.identityDb.updateTable('principals').set({status:'active',version:sql`version+1`}).where('id','=',fixture.bob.principalId).execute();
  await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toMatchObject({code:'FORBIDDEN'});expect(sideEffects).toBe(0);
 });
 it('does not revive old authority after task membership removal/reinvitation or epoch changes',async()=>{
  const {action}=await proposed();await approve(action);
  await withTenant(databases.owner,fixture.tenantId,async tx=>{await sql`update task_participants set status='removed',version=version+1 where task_id=${task.id} and principal_id=${fixture.bob.principalId}`.execute(tx);await sql`update task_participants set status='active',version=version+1 where task_id=${task.id} and principal_id=${fixture.bob.principalId}`.execute(tx);});
  await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toMatchObject({code:'FORBIDDEN'});expect(sideEffects).toBe(0);
  const fresh=await proposed();await approve(fresh.action);
  await withTenant(databases.owner,fixture.tenantId,tx=>sql`update tasks set execution_epoch=execution_epoch+1 where id=${task.id}`.execute(tx));
  await expect(runner().runOnce(fixture.tenantId,fresh.action.id)).rejects.toMatchObject({code:'EXECUTION_FENCE_CONFLICT'});
  await expect(actions.createAction(fixture.bob,{task_id:task.id,grant_id:fresh.grant.id,executor_principal_id:fixture.bob.principalId,tool_id:'demo.delivery',tool_version:'1',target_id:'demo',parameters:{text:'Cannot reuse an old grant'},resource_versions:[],business_key:key(),estimate:{currency:'USD',limit_microunits:'10'}},key())).rejects.toMatchObject({code:'EXECUTION_FENCE_CONFLICT'});expect(sideEffects).toBe(0);
 });
 it('rejects an expired approval before opening a network attempt',async()=>{
  const {action}=await proposed();await approve(action);
  await withTenant(databases.owner,fixture.tenantId,tx=>sql`update action_approvals set expires_at=clock_timestamp()-interval '1 second' where action_id=${action.id}`.execute(tx));
  await expect(runner().runOnce(fixture.tenantId,action.id)).rejects.toMatchObject({code:'FORBIDDEN'});expect(attempts).toBe(0);
 });
 it('deduplicates the same receipt and preserves a conflicting late receipt as an open case',async()=>{
  const {action}=await proposed();await approve(action);const claim=await actions.claim(fixture.tenantId,action.id,'test-tool-worker');await actions.persistIntent(claim);const admitted=await actions.dispatch(claim);const receipt=await admitted.tool.execute(admitted.call);
  await actions.recordOutcome(claim,receipt);await actions.recordOutcome(claim,receipt);
  const count=(await withTenant(databases.db,fixture.tenantId,tx=>sql`select id from action_receipts`.execute(tx))).rows.length;expect(count).toBe(1);
  if(receipt.status==='unknown')throw new Error('Expected confirmed fixture receipt');
  expect(await actions.recordOutcome(claim,{...receipt,actualMicrounits:'99'})).toMatchObject({status:'succeeded',conflict:true});
  expect(await withTenant(databases.db,fixture.tenantId,tx=>requiredActionsClosed(tx,task.id))).toBe(false);expect(sideEffects).toBe(1);
 });
 it('enforces human HTTP approval contracts and never exposes internal execution/report capabilities',async()=>{
  const {action}=await proposed();const origin='http://actions.test';const identity=createIdentityService({db:databases.db,identityDb:databases.identityDb,publicOrigin:origin,sessionSecret:secret,environment:'test',enableDevAuth:true,devPrincipalIds:[fixture.alice.principalId]});
  const app=createApp({readiness:async()=>{},identity,actions});await app.ready();
  try{
   const session=await identity.devLogin({principalId:fixture.alice.principalId,origin});const headers={origin,cookie:`imbox_session=${session.token}`,'x-imbox-tenant-id':fixture.tenantId,'x-csrf-token':session.csrfToken,'idempotency-key':key(),'if-match':`"${action.version}"`};
   expect((await app.inject({method:'GET',url:`/v1/actions/${action.id}`,headers})).statusCode).toBe(200);
   const payload={decision:'approve',action_version:action.approval_binding_version,fingerprint:action.fingerprint,comment:'Explicit HTTP review'};
   expect((await app.inject({method:'POST',url:`/v1/actions/${action.id}/approvals/decisions`,headers,payload:{...payload,actor_id:fixture.bob.principalId}})).statusCode).toBe(400);
   const approved=await app.inject({method:'POST',url:`/v1/actions/${action.id}/approvals/decisions`,headers,payload});expect(approved.statusCode).toBe(200);expect(approved.json()).toMatchObject({status:'ready',approval:{decided_by:fixture.alice.principalId}});
   for(const command of ['claim','dispatch','record-outcome','receipts'])expect((await app.inject({method:'POST',url:`/v1/actions/${action.id}/${command}`,headers,payload:{status:'succeeded'}})).statusCode).toBe(404);
   expect(sideEffects).toBe(0);
  }finally{await app.close();}
 });
 it('finds a whole action lost across a simulated database recovery and freezes new execution',async()=>{
  const {action}=await proposed();await approve(action);await runner().runOnce(fixture.tenantId,action.id);
  // The separate journal survives while this test removes the business rows as if
  // restoring a PG snapshot taken before the action existed. No shared DB is reset.
  await withTenant(databases.owner,fixture.tenantId,async tx=>{for(const table of ['action_receipts','action_budget_reservations','action_attempts','action_approvals','actions'])await sql.raw(`delete from ${table} where tenant_id='${fixture.tenantId}'`).execute(tx);});
  await expect(actions.auditJournal(fixture.tenantId)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});expect(await journal.frozen(fixture.tenantId)).toBe(true);
  const cases=(await withTenant(databases.db,fixture.tenantId,tx=>sql`select reason,status from action_reconciliation_cases`.execute(tx))).rows;expect(cases).toEqual([{reason:'missing_after_restore',status:'open'}]);expect(sideEffects).toBe(1);
 });
});
