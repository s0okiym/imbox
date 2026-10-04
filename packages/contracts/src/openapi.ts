import {
  CONTRACT_VERSION,
  JSON_SCHEMA_DIALECT,
  schemaDocument,
  schemaNames,
  type SchemaName,
} from './schemas.js';

interface RouteContract {
  method: 'get' | 'post' | 'patch' | 'delete' | 'put';
  path: string;
  operationId: string;
  response?: SchemaName;
  success: '200' | '201' | '204' | '302';
  request?: SchemaName;
  paginated?: boolean;
  cursorOnly?: boolean;
  cursorRequired?: boolean;
  ifMatch?: boolean;
  idempotency?: boolean;
  authenticated?: boolean;
  tenant?: boolean;
  csrf?: boolean;
  machine?: boolean;
  workspaceQuery?: boolean;
  runScopeQuery?: boolean;
  knowledgeQuery?: boolean;
  searchQuery?: boolean;
  snapshotWindowQuery?: boolean;
  artifactVersionQuery?: boolean;
  status?: 'implemented' | 'contract-only' | 'development-only';
}

/** Inventory checked against API/auth route sources; deployment capabilities are separate. */
export const routeContracts: readonly RouteContract[] = [
  {
    method: 'get',
    path: '/v1/organization/members',
    operationId: 'listManagedTenantMembers',
    response: 'ManagedTenantMemberPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'put',
    path: '/v1/organization/members/{id}',
    operationId: 'setTenantMember',
    request: 'SetTenantMemberInput',
    response: 'ManagedTenantMember',
    success: '200',
    idempotency: true,
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/organization/access',
    operationId: 'getOrganizationAccess',
    response: 'OrganizationManagementAccess',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/organization/workspaces',
    operationId: 'listManagedWorkspaces',
    response: 'ManagedWorkspacePage',
    success: '200',
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/organization/candidates',
    operationId: 'listOrganizationCandidates',
    response: 'OrganizationCandidatePage',
    success: '200',
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/organization/workspaces/{id}/members',
    operationId: 'listManagedWorkspaceMembers',
    response: 'ManagedWorkspaceMemberPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/organization/workspaces',
    operationId: 'createManagedWorkspace',
    request: 'CreateManagedWorkspaceInput',
    response: 'ManagedWorkspace',
    success: '201',
    idempotency: true,
  },
  {
    method: 'put',
    path: '/v1/organization/workspaces/{id}/members',
    operationId: 'setWorkspaceMember',
    request: 'SetWorkspaceMemberInput',
    response: 'ManagedWorkspace',
    success: '200',
    idempotency: true,
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/notifications',
    operationId: 'listNotifications',
    response: 'NotificationPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/notifications/unread',
    operationId: 'getUnreadNotifications',
    response: 'NotificationUnread',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/notifications/{id}/open',
    operationId: 'openNotification',
    response: 'NotificationLocation',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/notifications/{id}/read',
    operationId: 'readNotification',
    response: 'NotificationRead',
    success: '200',
    ifMatch: true,
    idempotency: false,
  },
  {
    method: 'get',
    path: '/v1/notification-preferences',
    operationId: 'getNotificationPreferences',
    response: 'NotificationPreferences',
    success: '200',
  },
  {
    method: 'put',
    path: '/v1/notification-preferences',
    operationId: 'setNotificationPreferences',
    request: 'NotificationPreferencesInput',
    response: 'NotificationPreferences',
    success: '200',
    ifMatch: true,
    idempotency: false,
  },
  {
    method: 'put',
    path: '/v1/notification-mutes/{id}',
    operationId: 'setConversationMute',
    request: 'NotificationMuteInput',
    response: 'NotificationMute',
    success: '200',
    idempotency: false,
  },
  {
    method: 'get',
    path: '/v1/notification-push-key',
    operationId: 'getNotificationPushKey',
    response: 'NotificationPushKey',
    success: '200',
  },
  {
    method: 'put',
    path: '/v1/notification-subscription',
    operationId: 'subscribeNotificationPush',
    request: 'NotificationSubscription',
    response: 'NotificationDevice',
    success: '200',
    idempotency: false,
  },
  {
    method: 'get',
    path: '/v1/notification-devices',
    operationId: 'listNotificationDevices',
    response: 'NotificationDevicePage',
    success: '200',
  },
  {
    method: 'put',
    path: '/v1/notification-devices/current',
    operationId: 'setNotificationDevice',
    request: 'NotificationDeviceInput',
    response: 'NotificationDevice',
    success: '200',
    idempotency: false,
  },
  {
    method: 'delete',
    path: '/v1/notification-devices/{id}',
    operationId: 'disableNotificationDevice',
    response: 'NotificationDevice',
    success: '200',
    idempotency: false,
  },

  {
    method: 'get',
    path: '/v1/agent-runs/{id}/tool-intent',
    operationId: 'getRunToolIntent',
    response: 'Action',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/machine/agent-runs/{id}/tool-intent',
    operationId: 'getMachineRunToolIntent',
    response: 'Action',
    success: '200',
    machine: true,
  },
  {
    method: 'post',
    path: '/v1/machine/agent-runs/{id}/tool-intents',
    operationId: 'proposeMachineRunToolIntent',
    request: 'MachineToolIntentInput',
    response: 'Action',
    success: '201',
    machine: true,
  },
  {
    method: 'post',
    path: '/v1/machine/agent-runs/{id}/tool-execution',
    operationId: 'executeMachineRunTool',
    request: 'MachineToolExecuteInput',
    response: 'Action',
    success: '200',
    machine: true,
  },

  {
    method: 'post',
    path: '/v1/artifacts/{id}/comments',
    operationId: 'createArtifactComment',
    success: '201',
    response: 'ArtifactComment',
    request: 'CreateArtifactCommentInput',
  },
  {
    method: 'get',
    path: '/v1/artifacts/{id}/comments',
    operationId: 'listArtifactComments',
    success: '200',
    response: 'ArtifactCommentPage',
    paginated: true,
    artifactVersionQuery: true,
  },
  {
    method: 'patch',
    path: '/v1/artifact-comments/{id}',
    operationId: 'editArtifactComment',
    success: '200',
    response: 'ArtifactComment',
    request: 'EditArtifactCommentInput',
    ifMatch: true,
  },
  {
    method: 'delete',
    path: '/v1/artifact-comments/{id}',
    operationId: 'deleteArtifactComment',
    success: '200',
    response: 'ArtifactCommentDeletion',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/artifacts/{id}/shares',
    operationId: 'createArtifactShare',
    success: '201',
    response: 'ArtifactShare',
    request: 'CreateArtifactShareInput',
  },
  {
    method: 'get',
    path: '/v1/artifacts/{id}/shares',
    operationId: 'listArtifactShares',
    success: '200',
    response: 'ArtifactSharePage',
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/artifact-shares/{id}',
    operationId: 'getArtifactShare',
    success: '200',
    response: 'ArtifactShare',
  },
  {
    method: 'delete',
    path: '/v1/artifact-shares/{id}',
    operationId: 'revokeArtifactShare',
    success: '200',
    response: 'ArtifactShareRevocation',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/artifact-shares/{id}/content',
    operationId: 'downloadArtifactShare',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/action-recovery',
    operationId: 'getActionRecovery',
    response: 'RecoveryStatus',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/action-recovery/refresh',
    operationId: 'refreshActionRecovery',
    request: 'RecoveryReasonInput',
    response: 'RecoveryStatus',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/action-recovery/cases',
    operationId: 'listActionRecoveryCases',
    response: 'RecoveryCasePage',
    success: '200',
    paginated: true,
    cursorOnly: true,
  },
  {
    method: 'get',
    path: '/v1/action-recovery/cases/{id}',
    operationId: 'getActionRecoveryCase',
    response: 'RecoveryCase',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/action-recovery/cases/{id}/lookup',
    operationId: 'lookupActionRecovery',
    request: 'RecoveryLookupInput',
    response: 'RecoveryEvidence',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/action-recovery/cases/{id}/confirm',
    operationId: 'confirmActionRecovery',
    request: 'RecoveryConfirmInput',
    response: 'RecoveryCase',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/action-recovery/unfreeze',
    operationId: 'unfreezeActionRecovery',
    request: 'RecoveryUnfreezeInput',
    response: 'RecoveryStatus',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/governance/policy',
    operationId: 'getGovernancePolicy',
    response: 'GovernancePolicy',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/exports',
    operationId: 'createExport',
    request: 'CreateExportInput',
    response: 'ExportJob',
    success: '201',
  },
  {
    method: 'get',
    path: '/v1/exports/{id}',
    operationId: 'getExport',
    response: 'ExportJob',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/exports/{id}/content',
    operationId: 'downloadExport',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/memories',
    operationId: 'createMemory',
    request: 'CreateMemoryInput',
    response: 'ExplicitMemory',
    success: '201',
  },
  {
    method: 'patch',
    path: '/v1/memories/{id}',
    operationId: 'updateMemory',
    request: 'UpdateMemoryInput',
    response: 'ExplicitMemory',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'delete',
    path: '/v1/memories/{id}',
    operationId: 'deleteMemory',
    response: 'MemoryDeletion',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/memories/{id}',
    operationId: 'getMemory',
    response: 'ExplicitMemory',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/memories',
    operationId: 'listMemories',
    response: 'ExplicitMemoryPage',
    success: '200',
    knowledgeQuery: true,
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/search',
    operationId: 'searchKnowledge',
    response: 'KnowledgeSearchPage',
    success: '200',
    knowledgeQuery: true,
    searchQuery: true,
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/machine/memories/{id}',
    operationId: 'machineGetMemory',
    response: 'ExplicitMemory',
    success: '200',
    machine: true,
  },
  {
    method: 'get',
    path: '/v1/machine/memories',
    operationId: 'machineListMemories',
    response: 'ExplicitMemoryPage',
    success: '200',
    machine: true,
    knowledgeQuery: true,
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/machine/search',
    operationId: 'machineSearchKnowledge',
    response: 'KnowledgeSearchPage',
    success: '200',
    machine: true,
    knowledgeQuery: true,
    searchQuery: true,
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/agent-runs/{id}/promote',
    operationId: 'promoteRunToTask',
    request: 'PromoteRunInput',
    response: 'Task',
    success: '201',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}/run-origin',
    operationId: 'getTaskRunOrigin',
    response: 'TaskRunOrigin',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}/handoff-actions',
    operationId: 'getTaskHandoffActions',
    response: 'TaskHandoffActions',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/machine/tasks/{id}/handoff-actions',
    operationId: 'machineGetTaskHandoffActions',
    response: 'TaskHandoffActions',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/messages/{id}',
    operationId: 'getMessage',
    response: 'Message',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/messages/{id}/thread',
    operationId: 'listMessageThread',
    response: 'MessagePage',
    success: '200',
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/messages/{id}/reactions/remove',
    operationId: 'removeReaction',
    request: 'ReactionInput',
    response: 'Message',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/task-escalations',
    operationId: 'listTaskEscalations',
    response: 'TaskEscalationPage',
    success: '200',
    paginated: true,
    cursorOnly: true,
  },
  {
    method: 'get',
    path: '/v1/resources',
    operationId: 'listStoredResources',
    response: 'StoredResourcePage',
    success: '200',
    paginated: true,
    runScopeQuery: true,
  },
  {
    method: 'get',
    path: '/v1/artifacts',
    operationId: 'listStoredArtifacts',
    response: 'StoredArtifactPage',
    success: '200',
    paginated: true,
    runScopeQuery: true,
  },
  {
    method: 'post',
    path: '/v1/schedules',
    operationId: 'createSchedule',
    request: 'CreateScheduleInput',
    response: 'Schedule',
    success: '201',
  },
  {
    method: 'get',
    path: '/v1/schedules',
    operationId: 'listSchedules',
    response: 'ScheduleList',
    success: '200',
    paginated: true,
    cursorOnly: true,
  },
  {
    method: 'get',
    path: '/v1/schedules/{id}',
    operationId: 'getSchedule',
    response: 'Schedule',
    success: '200',
  },
  {
    method: 'patch',
    path: '/v1/schedules/{id}',
    operationId: 'reviseSchedule',
    request: 'ReviseScheduleInput',
    response: 'Schedule',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'delete',
    path: '/v1/schedules/{id}',
    operationId: 'disableSchedule',
    response: 'Schedule',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/schedules/{id}/occurrences',
    operationId: 'listScheduleOccurrences',
    response: 'ScheduleOccurrenceList',
    success: '200',
    paginated: true,
    cursorOnly: true,
  },
  {
    method: 'get',
    path: '/v1/agent-runs',
    operationId: 'listRuntimeRuns',
    response: 'RuntimeRunPage',
    success: '200',
    paginated: true,
    runScopeQuery: true,
  },
  {
    method: 'post',
    path: '/v1/uploads',
    operationId: 'createUpload',
    success: '201',
    response: 'UploadTicket',
    request: 'CreateUploadInput',
  },
  {
    method: 'post',
    path: '/v1/uploads/{id}/complete',
    operationId: 'completeUpload',
    success: '200',
    response: 'StoredResource',
  },
  {
    method: 'get',
    path: '/v1/resources/{id}',
    operationId: 'getResource',
    success: '200',
    response: 'StoredResource',
  },
  {
    method: 'get',
    path: '/v1/resources/{id}/content',
    operationId: 'downloadResource',
    success: '200',
  },
  {
    method: 'delete',
    path: '/v1/resources/{id}',
    operationId: 'deleteResource',
    success: '200',
    ifMatch: true,
    response: 'ResourceDeletion',
  },
  {
    method: 'post',
    path: '/v1/artifacts',
    operationId: 'createStoredArtifact',
    success: '201',
    response: 'StoredArtifact',
    request: 'CreateStoredArtifactInput',
  },
  {
    method: 'get',
    path: '/v1/artifacts/{id}',
    operationId: 'getStoredArtifact',
    success: '200',
    response: 'StoredArtifact',
  },
  {
    method: 'post',
    path: '/v1/artifacts/{id}/versions',
    operationId: 'createStoredArtifactVersion',
    success: '201',
    ifMatch: true,
    response: 'StoredArtifact',
    request: 'CreateStoredArtifactVersionInput',
  },
  {
    method: 'get',
    path: '/v1/artifacts/{id}/versions',
    operationId: 'listStoredArtifactVersions',
    success: '200',
    paginated: true,
    response: 'StoredArtifactVersionPage',
  },

  {
    method: 'post',
    path: '/v1/machine/requests/{id}/ack',
    operationId: 'machineAcknowledgeRequest',
    response: 'AgentDeliveryReceipt',
    request: 'AgentDeliveryInput',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/agent-management',
    operationId: 'getAgentManagementAccess',
    response: 'AgentManagementAccess',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/agents/{id}/credentials',
    operationId: 'listAgentCredentials',
    response: 'AgentCredentialPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/agents',
    operationId: 'listAgents',
    response: 'AgentDirectory',
    success: '200',
    workspaceQuery: true,
  },
  {
    method: 'post',
    path: '/v1/agents',
    operationId: 'registerAgent',
    response: 'RegisteredAgent',
    success: '201',
    request: 'RegisterAgentInput',
  },
  {
    method: 'post',
    path: '/v1/agents/{id}/credentials',
    operationId: 'issueAgentCredential',
    response: 'IssuedAgentCredential',
    success: '201',
    request: 'IssueAgentCredentialInput',
  },
  {
    method: 'post',
    path: '/v1/agents/{id}/disable',
    operationId: 'disableAgent',
    response: 'RegisteredAgent',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/agent-credentials/{id}/revoke',
    operationId: 'revokeAgentCredential',
    response: 'AgentCredential',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/machine-tokens',
    operationId: 'exchangeMachineCredential',
    response: 'MachineToken',
    success: '200',
    authenticated: false,
    tenant: false,
    idempotency: false,
    csrf: false,
    machine: true,
    request: 'MachineTokenInput',
  },
  {
    method: 'get',
    path: '/v1/machine/agents',
    operationId: 'machineListAgents',
    response: 'AgentDirectory',
    success: '200',
    workspaceQuery: true,
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/agent-runs',
    operationId: 'machineListRuns',
    response: 'MachineRunPage',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/agent-runs',
    operationId: 'machineCreateRun',
    response: 'RuntimeRun',
    success: '201',
    request: 'CreateRuntimeRunInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/agent-runs/{id}',
    operationId: 'machineGetRun',
    response: 'RuntimeRun',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/agent-runs/{id}/context-manifest',
    operationId: 'machineGetContext',
    response: 'RuntimeContextManifest',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/agent-runs/{id}/claim',
    operationId: 'machineClaimRun',
    response: 'MachineClaim',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/agent-runs/{id}/heartbeat',
    operationId: 'machineHeartbeatRun',
    response: 'MachineHeartbeat',
    success: '200',
    idempotency: false,
    request: 'MachineHeartbeatInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/agent-runs/{id}/reports',
    operationId: 'machineReportRun',
    response: 'RuntimeRun',
    success: '200',
    request: 'MachineReportInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/conversations',
    operationId: 'machineListConversations',
    response: 'ConversationPage',
    success: '200',
    paginated: true,
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/conversations/{id}/messages',
    operationId: 'machineListMessages',
    response: 'MessagePage',
    success: '200',
    paginated: true,
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/conversations/{id}/messages',
    operationId: 'machineSendMessage',
    response: 'Message',
    success: '201',
    request: 'CreateMessageInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/tasks',
    operationId: 'machineListTasks',
    response: 'TaskPage',
    success: '200',
    paginated: true,
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/tasks/{id}',
    operationId: 'machineGetTask',
    response: 'Task',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/tasks',
    operationId: 'machineCreateTask',
    response: 'Task',
    success: '201',
    request: 'CreateTaskInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/tasks/{id}/state',
    operationId: 'machineSetTaskState',
    response: 'Task',
    success: '200',
    ifMatch: true,
    request: 'TaskStateInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/tasks/{id}/requests',
    operationId: 'machineCreateRequest',
    response: 'CollaborationRequest',
    success: '201',
    ifMatch: true,
    request: 'CreateTaskRequestInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/tasks/{id}/submissions',
    operationId: 'machineSubmitTask',
    response: 'Submission',
    success: '201',
    ifMatch: true,
    request: 'SubmissionInput',
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/requests',
    operationId: 'machineListRequests',
    response: 'CollaborationRequestPage',
    success: '200',
    paginated: true,
    machine: true,
    csrf: false,
  },
  {
    method: 'get',
    path: '/v1/machine/requests/{id}',
    operationId: 'machineGetRequest',
    response: 'CollaborationRequest',
    success: '200',
    machine: true,
    csrf: false,
  },
  {
    method: 'post',
    path: '/v1/machine/requests/{id}/decisions',
    operationId: 'machineDecideRequest',
    response: 'RequestDecisionResult',
    success: '200',
    ifMatch: true,
    request: 'RequestDecisionInput',
    machine: true,
    csrf: false,
  },

  {
    method: 'get',
    path: '/v1/auth/login',
    operationId: 'startLogin',
    success: '302',
    authenticated: false,
    tenant: false,
  },
  {
    method: 'get',
    path: '/v1/auth/callback',
    operationId: 'finishLogin',
    success: '302',
    authenticated: false,
    tenant: false,
  },
  {
    method: 'post',
    path: '/v1/auth/dev-login',
    operationId: 'devLogin',
    request: 'DevLoginInput',
    response: 'DevLoginResult',
    success: '200',
    authenticated: false,
    tenant: false,
    csrf: false,
    idempotency: false,
    status: 'development-only',
  },
  {
    method: 'post',
    path: '/v1/auth/logout',
    operationId: 'logout',
    success: '204',
    tenant: false,
    idempotency: false,
  },
  { method: 'get', path: '/v1/me', operationId: 'getMe', response: 'Me', success: '200' },
  {
    method: 'get',
    path: '/v1/sessions/{id}',
    operationId: 'getSession',
    response: 'Session',
    success: '200',
  },
  {
    method: 'delete',
    path: '/v1/sessions/{id}',
    operationId: 'revokeSession',
    success: '204',
    idempotency: false,
  },
  {
    method: 'get',
    path: '/v1/workspaces',
    operationId: 'listWorkspaces',
    response: 'WorkspacePage',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/conversations',
    operationId: 'listConversations',
    response: 'ConversationPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/conversations',
    operationId: 'createConversation',
    request: 'CreateConversationInput',
    response: 'Conversation',
    success: '201',
  },
  {
    method: 'get',
    path: '/v1/conversations/{id}',
    operationId: 'getConversation',
    response: 'Conversation',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/workspaces/{id}/members',
    operationId: 'listWorkspaceMembers',
    response: 'WorkspaceMemberPage',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/conversations/{id}/members',
    operationId: 'listConversationMembers',
    response: 'ConversationMemberPage',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/conversations/{id}/members',
    operationId: 'addConversationMember',
    request: 'AddConversationMemberInput',
    response: 'Conversation',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'delete',
    path: '/v1/conversations/{id}/members/{principalId}',
    operationId: 'removeConversationMember',
    response: 'Conversation',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/messages/{id}/reactions',
    operationId: 'listReactions',
    response: 'ReactionPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/messages/{id}/reactions',
    operationId: 'addReaction',
    request: 'ReactionInput',
    response: 'Message',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/conversations/{id}/read-cursor',
    operationId: 'setReadCursor',
    request: 'ReadCursorInput',
    response: 'ReadCursor',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/conversations/{id}/messages',
    operationId: 'listMessages',
    response: 'MessagePage',
    success: '200',
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/conversations/{id}/messages',
    operationId: 'createMessage',
    request: 'CreateMessageInput',
    response: 'Message',
    success: '201',
  },
  {
    method: 'patch',
    path: '/v1/messages/{id}',
    operationId: 'editMessage',
    request: 'EditMessageInput',
    response: 'Message',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'delete',
    path: '/v1/messages/{id}',
    operationId: 'deleteMessage',
    response: 'Message',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/streams/{id}/snapshot',
    operationId: 'getStreamSnapshot',
    snapshotWindowQuery: true,
    response: 'StreamSnapshot',
    success: '200',
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/streams/{id}/events',
    operationId: 'getStreamEvents',
    response: 'StreamEvents',
    success: '200',
    paginated: true,
    cursorRequired: true,
  },
  {
    method: 'get',
    path: '/v1/tasks',
    operationId: 'listTasks',
    response: 'TaskPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/tasks',
    operationId: 'createTask',
    response: 'Task',
    success: '201',
    request: 'CreateTaskInput',
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}',
    operationId: 'getTask',
    response: 'Task',
    success: '200',
  },
  {
    method: 'patch',
    path: '/v1/tasks/{id}',
    operationId: 'updateTask',
    response: 'Task',
    success: '200',
    request: 'UpdateTaskInput',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}/participants',
    operationId: 'listTaskParticipants',
    response: 'TaskParticipantPage',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/participants',
    operationId: 'setTaskParticipant',
    response: 'Task',
    success: '200',
    request: 'TaskParticipantInput',
    ifMatch: true,
  },
  {
    method: 'delete',
    path: '/v1/tasks/{id}/participants/{principalId}',
    operationId: 'removeTaskParticipant',
    response: 'Task',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/conversation-links',
    operationId: 'discloseTaskSummary',
    response: 'Task',
    success: '200',
    request: 'TaskConversationLinkInput',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/conversations/{id}/task-summaries',
    operationId: 'listConversationTaskSummaries',
    response: 'TaskSummaryPage',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/state',
    operationId: 'changeTaskState',
    response: 'Task',
    success: '200',
    request: 'TaskStateInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/cancel',
    operationId: 'cancelTask',
    response: 'Task',
    success: '200',
    request: 'TaskReasonInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/reopen',
    operationId: 'reopenTask',
    response: 'Task',
    success: '200',
    request: 'ReopenTaskInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/takeover',
    operationId: 'takeoverTask',
    response: 'Task',
    success: '200',
    request: 'TaskReasonInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/dependencies',
    operationId: 'addTaskDependency',
    response: 'Task',
    success: '200',
    request: 'TaskDependencyInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/requests',
    operationId: 'createTaskRequest',
    response: 'CollaborationRequest',
    success: '201',
    request: 'CreateTaskRequestInput',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/requests',
    operationId: 'listTaskRequests',
    response: 'CollaborationRequestPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'get',
    path: '/v1/requests/{id}',
    operationId: 'getTaskRequest',
    response: 'CollaborationRequest',
    success: '200',
  },
  {
    method: 'patch',
    path: '/v1/requests/{id}',
    operationId: 'reviseTaskRequest',
    response: 'CollaborationRequest',
    success: '200',
    request: 'ReviseTaskRequestInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/requests/{id}/decisions',
    operationId: 'decideTaskRequest',
    response: 'RequestDecisionResult',
    success: '200',
    request: 'RequestDecisionInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/requests/{id}/withdraw',
    operationId: 'withdrawTaskRequest',
    response: 'CollaborationRequest',
    success: '200',
    request: 'TaskReasonInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/submissions',
    operationId: 'submitTask',
    response: 'Submission',
    success: '201',
    request: 'SubmissionInput',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}/submissions',
    operationId: 'listTaskSubmissions',
    response: 'SubmissionPage',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/reviews',
    operationId: 'reviewTask',
    response: 'TaskReview',
    success: '201',
    request: 'TaskReviewInput',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}/reviews',
    operationId: 'listTaskReviews',
    response: 'TaskReviewPage',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/agent-installations',
    operationId: 'installRuntimeAgent',
    response: 'RuntimeAgentInstallation',
    success: '201',
    request: 'InstallRuntimeAgentInput',
  },
  {
    method: 'post',
    path: '/v1/agent-runs',
    operationId: 'createRuntimeRun',
    response: 'RuntimeRun',
    success: '201',
    request: 'CreateRuntimeRunInput',
  },
  {
    method: 'get',
    path: '/v1/agent-runs/{id}',
    operationId: 'getRuntimeRun',
    response: 'RuntimeRun',
    success: '200',
  },
  {
    method: 'get',
    path: '/v1/agent-runs/{id}/context-manifest',
    operationId: 'getRuntimeContext',
    response: 'RuntimeContextManifest',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/agent-runs/{id}/pause',
    operationId: 'pauseRuntimeRun',
    response: 'RuntimeRun',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/agent-runs/{id}/resume',
    operationId: 'resumeRuntimeRun',
    response: 'RuntimeRun',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/agent-runs/{id}/cancel',
    operationId: 'cancelRuntimeRun',
    response: 'RuntimeRun',
    success: '200',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/grants',
    operationId: 'listGrants',
    response: 'CapabilityGrantPage',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/grants',
    operationId: 'createGrant',
    response: 'CapabilityGrant',
    success: '201',
    request: 'CreateGrantInput',
  },
  {
    method: 'get',
    path: '/v1/grants/{id}',
    operationId: 'getGrant',
    response: 'CapabilityGrant',
    success: '200',
  },
  {
    method: 'post',
    path: '/v1/grants/{id}/revoke',
    operationId: 'revokeGrant',
    response: 'CapabilityGrant',
    success: '200',
    request: 'TaskReasonInput',
    ifMatch: true,
  },
  {
    method: 'get',
    path: '/v1/actions',
    operationId: 'listActions',
    response: 'ActionPage',
    success: '200',
    paginated: true,
  },
  {
    method: 'post',
    path: '/v1/actions',
    operationId: 'createAction',
    response: 'Action',
    success: '201',
    request: 'CreateActionInput',
  },
  {
    method: 'get',
    path: '/v1/actions/{id}',
    operationId: 'getAction',
    response: 'Action',
    success: '200',
  },
  {
    method: 'patch',
    path: '/v1/actions/{id}',
    operationId: 'reviseAction',
    response: 'Action',
    success: '200',
    request: 'ReviseActionInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/actions/{id}/approvals/decisions',
    operationId: 'decideActionApproval',
    response: 'Action',
    success: '200',
    request: 'ActionApprovalDecisionInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/actions/{id}/reconcile',
    operationId: 'reconcileAction',
    response: 'ActionReconciliation',
    success: '200',
    request: 'ActionReconcileInput',
    ifMatch: true,
  },
  {
    method: 'post',
    path: '/v1/actions/{id}/cancel',
    operationId: 'cancelAction',
    response: 'Action',
    success: '200',
    request: 'TaskReasonInput',
    ifMatch: true,
  },
];

const componentRef = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });

function rewriteReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteReferences);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === '$ref' && typeof child === 'string'
        ? child.replace('#/$defs/', '#/components/schemas/')
        : rewriteReferences(child),
    ]),
  );
}

export function generateOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routeContracts) {
    const parameters: unknown[] = [];
    for (const match of route.path.matchAll(/\{([^}]+)\}/g)) {
      parameters.push({
        name: match[1],
        in: 'path',
        required: true,
        schema: componentRef('Identifier'),
      });
    }
    if (route.authenticated !== false && route.tenant !== false) {
      parameters.push({
        name: 'X-Imbox-Tenant-Id',
        in: 'header',
        required: true,
        schema: componentRef('Identifier'),
      });
    }
    if (route.runScopeQuery)
      for (const name of ['task_id', 'conversation_id'])
        parameters.push({
          name,
          in: 'query',
          required: false,
          description: 'Exactly one of task_id or conversation_id is required.',
          schema: componentRef('Identifier'),
        });
    if (route.knowledgeQuery) {
      for (const name of [
        'conversation_id',
        'task_id',
        ...(route.searchQuery ? ['workspace_id'] : []),
      ])
        parameters.push({ name, in: 'query', required: false, schema: componentRef('Identifier') });
      if (route.searchQuery) {
        parameters.push({
          name: 'q',
          in: 'query',
          required: true,
          schema: { type: 'string', minLength: 2, maxLength: 200 },
        });
        parameters.push({
          name: 'kind',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['message', 'task', 'artifact_version', 'memory'] },
        });
      }
    }
    if (route.artifactVersionQuery)
      parameters.push({
        name: 'version_id',
        in: 'query',
        required: true,
        schema: componentRef('Identifier'),
      });
    if (route.snapshotWindowQuery)
      parameters.push({
        name: 'window',
        in: 'query',
        required: false,
        schema: { type: 'string', const: 'recent' },
        description:
          'Materialize at most 200 newest visible messages at a fixed head. Repeat on snapshot cursor pages.',
      });
    if (route.workspaceQuery)
      parameters.push({
        name: 'workspace_id',
        in: 'query',
        required: true,
        schema: componentRef('Identifier'),
      });
    if (route.paginated) {
      parameters.push({
        name: 'cursor',
        in: 'query',
        required: route.cursorRequired ?? false,
        schema: componentRef('Cursor'),
      });
      if (!route.cursorOnly)
        parameters.push({
          name: 'limit',
          in: 'query',
          required: false,
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: route.knowledgeQuery ? 50 : route.runScopeQuery ? 100 : 200,
            default: 50,
          },
        });
    }
    if (route.method !== 'get' && route.idempotency !== false) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: componentRef('IdempotencyKey'),
      });
    }
    if (route.method !== 'get' && route.csrf !== false) {
      parameters.push({
        name: 'X-CSRF-Token',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 128 },
      });
    }
    if (route.method !== 'get' && !route.machine) {
      parameters.push({
        name: 'Origin',
        in: 'header',
        required: true,
        schema: { type: 'string', format: 'uri', maxLength: 2000 },
      });
    }
    if (route.ifMatch) {
      parameters.push({
        name: 'If-Match',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 3, maxLength: 256, pattern: '^"[^"\\r\\n]+"$' },
      });
    }
    if (route.operationId === 'startLogin') {
      parameters.push({
        name: 'return_to',
        in: 'query',
        required: false,
        schema: { type: 'string', maxLength: 2000 },
      });
    }
    const successResponse: Record<string, unknown> = {
      description:
        route.success === '302'
          ? 'Redirect; handled by the browser authentication flow'
          : 'Authorized response',
    };
    if (route.response)
      successResponse.content = { 'application/json': { schema: componentRef(route.response) } };
    if (route.operationId === 'downloadExport')
      successResponse.content = {
        'application/x-ndjson': {
          schema: {
            type: 'string',
            description:
              'imbox.ndjson.v1 live authorized records; require final complete marker and SHA-256 of all preceding lines',
          },
        },
      };
    if (route.operationId === 'downloadResource')
      successResponse.content = {
        'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
      };
    if (route.success === '302')
      successResponse.headers = {
        Location: { required: true, schema: { type: 'string', maxLength: 8192 } },
      };
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      'x-imbox-implementation-status': route.status ?? 'implemented',
      security:
        route.authenticated === false
          ? []
          : route.machine
            ? [{ agentBearer: [] }]
            : [{ browserSession: [] }],
      parameters,
      responses: {
        [route.success]: successResponse,
        default: {
          description: 'Structured error; authentication and authorization are enforced by the API',
          content: { 'application/json': { schema: componentRef('Error') } },
        },
      },
    };
    if (route.request)
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: componentRef(route.request) } },
      };
    (paths[route.path] ??= {})[route.method] = operation;
  }
  return {
    openapi: '3.1.1',
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: {
      title: 'Imbox V1 contracts',
      version: CONTRACT_VERSION,
      description:
        'Operations distinguish implemented, development-only and contract-only status. Implemented means code exists, not that a deployment has enabled it. Browser routes use sessions and CSRF; machine routes use scoped short-lived bearer tokens without cookies. WebSocket frames are component schemas.',
    },
    security: [{ browserSession: [] }],
    paths,
    components: {
      securitySchemes: {
        browserSession: { type: 'apiKey', in: 'cookie', name: 'imbox_session' },
        agentBearer: { type: 'http', scheme: 'bearer' },
      },
      schemas: Object.fromEntries(
        schemaNames.map((name) => [name, rewriteReferences(schemaDocument.$defs[name])]),
      ),
    },
  };
}

/** Structural/reference checks for our generated subset; not a full OpenAPI meta-schema validator. */
export function checkOpenApi(document: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (document.openapi !== '3.1.1') errors.push('Expected OpenAPI 3.1.1');
  if (document.jsonSchemaDialect !== JSON_SCHEMA_DIALECT)
    errors.push('Unexpected JSON Schema dialect');
  const components = document.components;
  const actualSchemas =
    components && typeof components === 'object' && 'schemas' in components
      ? components.schemas
      : undefined;
  const names = new Set<string>(
    actualSchemas && typeof actualSchemas === 'object' ? Object.keys(actualSchemas) : [],
  );
  for (const name of schemaNames)
    if (!names.has(name)) errors.push(`Missing schema component: ${name}`);
  function visit(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if ('$ref' in node) {
      const target = node.$ref;
      if (
        typeof target !== 'string' ||
        !target.startsWith('#/components/schemas/') ||
        !names.has(target.slice('#/components/schemas/'.length))
      ) {
        errors.push(`Unresolved schema reference: ${String(target)}`);
      }
    }
    Object.values(node).forEach(visit);
  }
  visit(document);
  const operations = new Set<string>();
  const paths = document.paths;
  if (!paths || typeof paths !== 'object') {
    errors.push('Missing paths');
  } else {
    for (const item of Object.values(paths)) {
      if (!item || typeof item !== 'object') {
        errors.push('Invalid path item');
        continue;
      }
      for (const operation of Object.values(item)) {
        if (
          !operation ||
          typeof operation !== 'object' ||
          !('operationId' in operation) ||
          typeof operation.operationId !== 'string'
        ) {
          errors.push('Missing operationId');
          continue;
        }
        if (operations.has(operation.operationId))
          errors.push(`Duplicate operationId: ${operation.operationId}`);
        operations.add(operation.operationId);
      }
    }
  }
  return errors;
}
