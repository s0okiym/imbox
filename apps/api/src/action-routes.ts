import type {FastifyInstance,FastifyRequest} from 'fastify';
import {authenticationInput,type IdentityService} from '@imbox/auth';
import {ApplicationError} from '@imbox/application';
import {assertContract,schemas,type SchemaName,type ContractTypes} from '@imbox/contracts';
import type {ActionService} from '@imbox/actions';
const header=(request:FastifyRequest,name:string)=>{const value=request.headers[name];if(typeof value!=='string')throw new ApplicationError('VALIDATION_FAILED',400);return value;};
const key=(request:FastifyRequest)=>assertContract('IdempotencyKey',header(request,'idempotency-key'));
const id=(request:FastifyRequest)=>assertContract('Identifier',(request.params as {id:string}).id);
const version=(request:FastifyRequest)=>{const value=header(request,'if-match');if(!/^"[1-9][0-9]*"$/.test(value))throw new ApplicationError('VALIDATION_FAILED',400);return assertContract('Version',value.slice(1,-1));};
export function registerActionRoutes(app:FastifyInstance,identity:IdentityService,actions:ActionService){
 const auth=(request:FastifyRequest)=>identity.authenticate(authenticationInput(request));
 function mutate<N extends SchemaName>(path:string,input:N,output:SchemaName,handler:(r:FastifyRequest,body:ContractTypes[N])=>Promise<unknown>,status:200|201=200,method:'POST'|'PATCH'='POST'){
  app.route({method,url:path,schema:{body:schemas[input],response:{[status]:schemas[output]},...(path.includes(':id')?{params:schemas.ResourceParams}:{})},handler:async(request,reply)=>{
   const result=await handler(request,assertContract(input,request.body));const v=result as {version?:string;revision?:string;action?:{version:string}};
   if(v.version??v.revision??v.action?.version)reply.header('ETag',`"${v.version??v.revision??v.action?.version}"`);
   return reply.code(status).send(result);
  }});
 }
 app.get('/v1/grants',{schema:{response:{200:schemas.CapabilityGrantPage}}},async r=>actions.listGrants(await auth(r)));
 app.get('/v1/grants/:id',{schema:{params:schemas.ResourceParams,response:{200:schemas.CapabilityGrant}}},async(r,reply)=>{const value=await actions.getGrant(await auth(r),id(r));return reply.header('ETag',`"${value.revision}"`).send(value);});
 mutate('/v1/grants','CreateGrantInput','CapabilityGrant',async(r,b)=>actions.createGrant(await auth(r),b,key(r)),201);
 mutate('/v1/grants/:id/revoke','TaskReasonInput','CapabilityGrant',async(r,b)=>actions.revokeGrant(await auth(r),id(r),version(r),key(r),b.reason));
 app.get('/v1/actions',{schema:{querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',maxLength:4096},limit:{type:'string',pattern:'^(?:[1-9][0-9]?|1[0-9]{2}|200)$'}}},response:{200:schemas.ActionPage}}},async r=>{const q=r.query as {cursor?:string;limit?:string};return actions.listActions(await auth(r),assertContract('PaginationQuery',{...(q.cursor?{cursor:q.cursor}:{}),...(q.limit?{limit:Number(q.limit)}:{})}));});
 app.get('/v1/actions/:id',{schema:{params:schemas.ResourceParams,response:{200:schemas.Action}}},async(r,reply)=>{const value=await actions.getAction(await auth(r),id(r));return reply.header('ETag',`"${value.version}"`).send(value);});
 mutate('/v1/actions','CreateActionInput','Action',async(r,b)=>actions.createAction(await auth(r),b,key(r)),201);
 mutate('/v1/actions/:id','ReviseActionInput','Action',async(r,b)=>actions.reviseAction(await auth(r),id(r),b,version(r),key(r)),200,'PATCH');
 mutate('/v1/actions/:id/approvals/decisions','ActionApprovalDecisionInput','Action',async(r,b)=>actions.decideApproval(await auth(r),id(r),b,version(r),key(r)));
 mutate('/v1/actions/:id/reconcile','ActionReconcileInput','ActionReconciliation',async(r,b)=>actions.reconcile(await auth(r),id(r),b,version(r),key(r)));
 mutate('/v1/actions/:id/cancel','TaskReasonInput','Action',async(r,b)=>actions.cancel(await auth(r),id(r),version(r),key(r),b.reason));
 // Claims, intent persistence, dispatch, receipts and budget settlement are internal capabilities.
}
