import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ReadCursor } from '@imbox/contracts';
import { compareDecimal } from './message-state.js';
import { visibleReadSequence } from './read-state.js';
import { isAccessLoss } from './api.js';

interface ReadApi {
  markRead(id: string, seq: string, key: string, signal: AbortSignal): Promise<ReadCursor>;
}

/** Read is derived from rendered message bubbles; delivery ACK never calls this hook. */
export function useReadCursor(options: {
  readonly api: ReadApi;
  readonly scopeId: string;
  readonly viewKey: string | null;
  readonly container: RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
  readonly contentRevision: unknown;
  readonly windowSize: number;
  readonly accessLost: (error: unknown) => void;
}): void {
  const current = useRef(options);
  current.current = options;
  const scheduleRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (options.viewKey === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acknowledged = '0';
    let request: { seq: string; key: string } | null = null;
    let inFlight = false;
    const element = options.container.current;

    const candidate = (): string | null => {
      if (element === null) return null;
      const bounds = element.getBoundingClientRect();
      const messages = [...element.querySelectorAll<HTMLElement>('[data-message-seq]')].map(
        (node) => {
          const rect = node.getBoundingClientRect();
          return { seq: node.dataset['messageSeq'] ?? '0', top: rect.top, bottom: rect.bottom };
        },
      );
      return visibleReadSequence({
        tabVisible: document.visibilityState === 'visible',
        unobscured: current.current.enabled && document.querySelector('dialog[open]') === null,
        viewportTop: Math.max(0, bounds.top),
        viewportBottom: Math.min(window.innerHeight, bounds.bottom),
        messages,
      });
    };
    const submit = async (): Promise<void> => {
      if (controller.signal.aborted || inFlight) return;
      const seq = candidate();
      if (seq === null || compareDecimal(seq, acknowledged) <= 0) return;
      // Retry an unconfirmed request only while its message is still actually visible.
      if (request === null || request.seq !== seq) request = { seq, key: crypto.randomUUID() };
      const command = request;
      inFlight = true;
      try {
        const result = await options.api.markRead(
          options.scopeId,
          command.seq,
          command.key,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        acknowledged = result.last_read_seq;
        request = null;
      } catch (error: unknown) {
        if (!controller.signal.aborted && isAccessLoss(error)) current.current.accessLost(error);
        // Failed read indicators do not interrupt conversation use or falsely report success.
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) schedule(2_000);
      }
    };
    const schedule = (delay = 350): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void submit();
        }, delay);
    };
    const changed = (): void => schedule();
    scheduleRef.current = changed;
    element?.addEventListener('scroll', changed, { passive: true });
    window.addEventListener('resize', changed);
    document.addEventListener('visibilitychange', changed);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(changed);
    const dialogs = new MutationObserver(changed);
    dialogs.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
      childList: true,
    });
    if (element !== null) observer?.observe(element);
    schedule();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      scheduleRef.current = null;
      observer?.disconnect();
      dialogs.disconnect();
      element?.removeEventListener('scroll', changed);
      window.removeEventListener('resize', changed);
      document.removeEventListener('visibilitychange', changed);
    };
  }, [options.api, options.scopeId, options.viewKey, options.container]);
  useEffect(() => {
    scheduleRef.current?.();
  }, [options.contentRevision, options.windowSize, options.enabled]);
}
