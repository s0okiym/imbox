import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '@imbox/contracts';
import type { Session } from '../api.js';
import { deviceGeneration, deviceStore } from './device-store.js';
import { conversationScope, offlineScopeKey } from './offline-store.js';

/** Persist only explicit edits. Sync resets must never overwrite a stored draft with an empty value. */
export function useDeviceDraft(session: Session, conversation: Conversation, enabled: boolean) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const edited = useRef(false);
  const writes = useRef(0);
  const bodyRef = useRef('');
  const scope = conversationScope(session, conversation);
  const key = offlineScopeKey(scope);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    if (edited.current) {
      persist(bodyRef.current, ++writes.current);
      return;
    }
    const epoch = deviceGeneration();
    void deviceStore()
      .drafts.get(key)
      .then((stored) => {
        if (!active || epoch !== deviceGeneration() || edited.current) return;
        if (stored && stored.expiresAt > Date.now()) {
          setDraft(stored.body);
          setNotice('已恢复本机文字草稿；附件和引用需要重新选择。');
        }
      })
      .catch(() => {
        if (active) setNotice('本机草稿无法读取。');
      });
    return () => {
      active = false;
    };
  }, [enabled, key]);
  function persist(body: string, write: number) {
    const epoch = deviceGeneration();
    // Start the transaction with the edit; no delayed unmount flush can resurrect data.
    void (async () => {
      await deviceStore().saveDraft(scope, body);
      const saved = await deviceStore().drafts.get(key);
      if (write === writes.current && epoch === deviceGeneration())
        setNotice(
          body
            ? saved?.body === body
              ? '文字草稿已保存在本机。'
              : '草稿仅保留在当前页面。'
            : null,
        );
    })().catch(() => {
      if (write === writes.current && epoch === deviceGeneration())
        setNotice('草稿仅保留在当前页面，本机保存失败。');
    });
  }
  const editDraft = (body: string) => {
    edited.current = true;
    bodyRef.current = body;
    setDraft(body);
    setNotice(null);
    const write = ++writes.current;
    if (enabled) persist(body, write);
  };
  const resetDraft = () => {
    writes.current += 1;
    edited.current = false;
    bodyRef.current = '';
    setDraft('');
    setNotice(null);
  };
  return { draft, editDraft, resetDraft, draftNotice: notice };
}
