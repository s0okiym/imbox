import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './api.js';
import {
  applyMessageMutation,
  applyMessageSnapshot,
  failPending,
  remainingPending,
  shouldSendOnEnter,
  sortMessages,
  viewKey,
} from './message-state.js';
import type { PendingMessage, ViewIdentity } from './message-state.js';

const view: ViewIdentity = {
  tenantId: 'tenant',
  principalId: 'alice',
  scopeId: 'conversation',
  authzGeneration: '1',
};
function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message',
    conversation_id: 'conversation',
    client_message_id: 'client-message',
    actor: { id: 'alice', kind: 'human', display_name: 'Alice', status: 'active' },
    version: '1',
    seq: '1',
    body: '你好',
    format: 'text',
    attachment_ids: [],
    created_at: '2026-10-04T10:00:00Z',
    deleted: false,
    view_scope: 'conversation',
    authz_generation: '1',
    projection_id: 'projection',
    projection_revision: '1',
    ...overrides,
  };
}

describe('message view boundaries', () => {
  it('cannot retain old body content after the authorization generation changes', () => {
    const previous = applyMessageSnapshot(null, view, [message({ body: '仅旧权限可见' })]);
    const nextView = { ...view, authzGeneration: '2' };
    const next = applyMessageSnapshot(previous, nextView, []);
    expect(next.messages).toEqual([]);
    expect(applyMessageSnapshot(next, view, [message({ body: '迟到的私人内容' })])).toBe(next);
    expect(applyMessageMutation(next, message())).toBe(next);
  });

  it('never merges an account, tenant or scope into another view', () => {
    const previous = applyMessageSnapshot(null, view, [
      message({ id: 'old', body: 'Alice 的内容', seq: '999' }),
    ]);
    for (const nextView of [
      { ...view, principalId: 'bob' },
      { ...view, tenantId: 'another' },
      { ...view, scopeId: 'another-conversation' },
    ]) {
      const next = applyMessageSnapshot(previous, nextView, []);
      expect(next.messages).toEqual([]);
      expect(viewKey(nextView)).not.toBe(viewKey(view));
    }
    expect(() =>
      applyMessageSnapshot(previous, view, [message({ view_scope: 'private-view' })]),
    ).toThrow('INCONSISTENT_VIEW');
  });

  it('a newer redaction revision wins even with a lower entity version', () => {
    const initial = applyMessageSnapshot(null, view, [
      message({ version: '99', projection_revision: '1', body: 'secret' }),
    ]);
    const redacted = applyMessageMutation(
      initial,
      message({ version: '2', projection_revision: '2', body: '', deleted: true }),
    );
    expect(redacted.messages[0]?.body).toBe('');
    const stale = applyMessageSnapshot(redacted, view, [
      message({ version: '100', projection_revision: '1', body: 'secret' }),
    ]);
    expect(stale.messages[0]?.deleted).toBe(true);
    expect(stale.messages[0]?.body).toBe('');
  });

  it('orders large sequence values without converting them to floating point', () => {
    const ordered = sortMessages([
      message({ id: 'last', seq: '9007199254740993' }),
      message({ id: 'first', seq: '9007199254740992' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['first', 'last']);
  });

  it('a successful concurrent send survives an earlier polling snapshot', () => {
    const initial = applyMessageSnapshot(null, view, [message()]);
    const saved = applyMessageMutation(
      initial,
      message({
        id: 'new',
        client_message_id: 'new-client',
        seq: '2',
        projection_id: 'new-projection',
      }),
    );
    expect(
      applyMessageSnapshot(saved, view, [message()]).messages.map((entry) => entry.id),
    ).toEqual(['message', 'new']);
  });

  it('response-loss retry and late network failure cannot create duplicate bubbles', () => {
    const pending: PendingMessage = {
      clientMessageId: 'client-message',
      idempotencyKey: 'original-idempotency-key',
      body: '你好',
      createdAt: '2026-10-04T10:00:00Z',
      state: 'sending',
      error: null,
    };
    const failed = failPending([pending], pending.clientMessageId, '网络中断');
    expect(failed[0]?.idempotencyKey).toBe(pending.idempotencyKey);
    const reconciled = remainingPending(failed, [message()]);
    expect(reconciled).toEqual([]);
    expect(failPending(reconciled, pending.clientMessageId, '迟到的失败')).toEqual([]);
  });
});

describe('Chinese composition and Enter shortcuts', () => {
  const input = {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    compositionActive: false,
    keyCode: 13,
  };
  it('does not send when any IME composition signal is active', () => {
    for (const composing of [
      { ...input, isComposing: true },
      { ...input, compositionActive: true },
      { ...input, keyCode: 229 },
    ]) {
      expect(shouldSendOnEnter(composing)).toBe(false);
    }
  });
  it('preserves Shift+Enter and sends only a normal Enter', () => {
    expect(shouldSendOnEnter({ ...input, shiftKey: true })).toBe(false);
    expect(shouldSendOnEnter({ ...input, key: 'a', keyCode: 65 })).toBe(false);
    expect(shouldSendOnEnter(input)).toBe(true);
  });
});
