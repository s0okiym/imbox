import { useCallback, useEffect, useState } from 'react';

export type AppSection =
  | 'messages'
  | 'tasks'
  | 'execution'
  | 'resources'
  | 'knowledge'
  | 'recovery'
  | 'governance'
  | 'agents'
  | 'notifications'
  | 'device';
export interface AppLocation {
  readonly section: AppSection;
  readonly tenantId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly taskId?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly actionId?: string;
  readonly grantId?: string;
  readonly shareId?: string;
}
const uuid = (value: string | null | undefined) =>
  value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
export function parseAppLocation(url: URL): AppLocation {
  const parts = url.pathname.split('/').filter(Boolean),
    id = uuid(parts[1]);
  const tenantId = uuid(url.searchParams.get('tenant'));
  const base = { ...(tenantId ? { tenantId } : {}) };
  switch (parts[0]) {
    case 'conversations': {
      const messageId = uuid(url.searchParams.get('message'));
      return {
        ...base,
        section: 'messages',
        ...(id ? { conversationId: id, ...(messageId ? { messageId } : {}) } : {}),
      };
    }
    case 'tasks':
      return { ...base, section: 'tasks', ...(id ? { taskId: id } : {}) };
    case 'requests':
      return { ...base, section: 'tasks', ...(id ? { requestId: id } : {}) };
    case 'runs':
      return { ...base, section: 'execution', ...(id ? { runId: id } : {}) };
    case 'actions':
      return { ...base, section: 'execution', ...(id ? { actionId: id } : {}) };
    case 'grants':
      return { ...base, section: 'execution', ...(id ? { grantId: id } : {}) };
    case 'resources': {
      const shareId = uuid(url.searchParams.get('share'));
      return { ...base, section: 'resources', ...(shareId ? { shareId } : {}) };
    }
    case 'knowledge':
      return { ...base, section: 'knowledge' };
    case 'recovery':
      return { ...base, section: 'recovery' };
    case 'device':
      return { ...base, section: 'device' };
    case 'agents':
      return { ...base, section: 'agents' };
    case 'notifications':
      return { ...base, section: 'notifications' };
    case 'governance':
      return { ...base, section: 'governance' };
    default:
      return { ...base, section: 'messages' };
  }
}
/** IDs locate resources only; neither URL contents nor history entries confer authority. */
export function appLocationPath(location: AppLocation): string {
  const query = new URLSearchParams();
  if (location.tenantId) query.set('tenant', location.tenantId);
  let path: string;
  if (location.section === 'messages') {
    path = location.conversationId
      ? `/conversations/${encodeURIComponent(location.conversationId)}`
      : '/';
    if (location.conversationId && location.messageId) query.set('message', location.messageId);
  } else if (location.section === 'tasks')
    path = location.taskId
      ? `/tasks/${encodeURIComponent(location.taskId)}`
      : location.requestId
        ? `/requests/${encodeURIComponent(location.requestId)}`
        : '/tasks';
  else if (location.section === 'execution')
    path = location.runId
      ? `/runs/${encodeURIComponent(location.runId)}`
      : location.actionId
        ? `/actions/${encodeURIComponent(location.actionId)}`
        : location.grantId
          ? `/grants/${encodeURIComponent(location.grantId)}`
          : '/runs';
  else {
    path = `/${location.section}`;
    if (location.section === 'resources' && location.shareId) query.set('share', location.shareId);
  }
  return `${path}${query.size ? `?${query}` : ''}`;
}
export function useAppLocation() {
  const [location, setLocation] = useState(() => parseAppLocation(new URL(window.location.href)));
  useEffect(() => {
    const changed = () => setLocation(parseAppLocation(new URL(window.location.href)));
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  const navigate = useCallback((next: AppLocation, replace = false) => {
    const path = appLocationPath(next);
    if (path === `${window.location.pathname}${window.location.search}`) return;
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setLocation(next);
  }, []);
  return { location, navigate };
}
