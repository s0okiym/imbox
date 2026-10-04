export interface SessionChange {
  readonly type: 'session.invalidate';
  readonly sourceId: string;
}

export function sessionChange(sourceId: string): SessionChange {
  return { type: 'session.invalidate', sourceId };
}

/** A second channel instance in this tab also receives a locally published message. */
export function isExternalSessionChange(message: unknown, localSourceId: string): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  return (
    candidate['type'] === 'session.invalidate' &&
    typeof candidate['sourceId'] === 'string' &&
    candidate['sourceId'].length > 0 &&
    candidate['sourceId'] !== localSourceId
  );
}
