import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecoveryCase, RecoveryEvidence, RecoveryStatus } from '@imbox/contracts';
import { ApiClient, ApiError, type Session } from '../api.js';
import { ErrorNotice, Modal, Spinner } from '../components.js';
import { commandIdentity, formatMicrounits, type CommandIdentity } from '../tasks/task-state.js';
import { RecoveryApi } from './recovery-api.js';
import { canConfirmOrphan, recoveryError, recoverySnapshotChanged } from './recovery-state.js';
import './recovery.css';
interface Props {
  readonly session: Session;
  readonly onClose: () => void;
  readonly onSessionLost: (message: string | null) => void;
  readonly onSessionUpdated: (session: Session) => void;
}
export function RecoveryWorkspace(props: Props) {
  return (
    <RecoveryScope
      key={
        props.session.tenant_id +
        ':' +
        props.session.principal.id +
        ':' +
        props.session.authz_revision
      }
      {...props}
    />
  );
}
function RecoveryScope({ session, onClose, onSessionLost, onSessionUpdated }: Props) {
  const api = useMemo(
    () => new RecoveryApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [status, setStatus] = useState<RecoveryStatus | null>(null),
    [items, setItems] = useState<RecoveryCase[]>([]),
    [selected, setSelected] = useState<RecoveryCase | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const [form, setForm] = useState<'freeze' | 'unfreeze' | 'confirm' | null>(null),
    [reason, setReason] = useState(''),
    [checked, setChecked] = useState(false);
  const [baseline, setBaseline] = useState<RecoveryStatus | null>(null),
    [caseBaseline, setCaseBaseline] = useState<RecoveryCase | null>(null),
    [evidence, setEvidence] = useState<RecoveryEvidence | undefined>();
  const abort = useRef<AbortController | null>(null),
    mutation = useRef<AbortController | null>(null),
    identity = useRef<CommandIdentity | null>(null),
    selectedId = useRef<string | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const failed = useCallback(
    (failure: unknown) => {
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
        mutation.current?.abort();
        abort.current?.abort();
        setBusy(false);
        setItems([]);
        setStatus(null);
        setSelected(null);
        selectedId.current = null;
        setForm(null);
        setEvidence(undefined);
        setCursor(undefined);
        if (failure.status === 401) onSessionLost('登录已失效，请重新登录。');
      }
      setError(recoveryError(failure));
    },
    [onSessionLost],
  );
  useEffect(
    () => () => {
      abort.current?.abort();
      mutation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    void (async () => {
      const me = await new ApiClient(session.tenant_id, session.csrf_token).me(controller.signal);
      if (controller.signal.aborted) return;
      if (
        me.principal.id !== session.principal.id ||
        me.tenant_id !== session.tenant_id ||
        me.authz_revision !== session.authz_revision
      ) {
        mutation.current?.abort();
        setBusy(false);
        setItems([]);
        setSelected(null);
        setStatus(null);
        setForm(null);
        onSessionUpdated(me);
        return;
      }
      const next = await api.status(controller.signal),
        page = await api.cases(controller.signal);
      const detail = selectedId.current
        ? await api.get(selectedId.current, controller.signal)
        : null;
      if (controller.signal.aborted) return;
      setStatus(next);
      setItems(page.items);
      setCursor(page.next_cursor);
      if (detail) setSelected(detail);
    })().catch((failure) => {
      if (!controller.signal.aborted) failed(failure);
    });
    return () => controller.abort();
  }, [
    api,
    failed,
    onSessionUpdated,
    session.tenant_id,
    session.principal.id,
    session.authz_revision,
    session.csrf_token,
    tick,
  ]);
  const run = async (
    body: unknown,
    version: string,
    operation: (key: string, signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    if (busy) return;
    const controller = new AbortController();
    mutation.current?.abort();
    mutation.current = controller;
    identity.current = commandIdentity(identity.current, body, version, () => crypto.randomUUID());
    setBusy(true);
    setError(null);
    try {
      await operation(identity.current.key, controller.signal);
      if (!controller.signal.aborted) {
        setForm(null);
        setChecked(false);
        identity.current = null;
        reload();
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        failed(failure);
        if (failure instanceof ApiError && failure.status === 409) reload();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const open = (kind: 'freeze' | 'unfreeze' | 'confirm', proof?: RecoveryEvidence) => {
    setForm(kind);
    setReason('');
    setChecked(false);
    setError(null);
    setBaseline(status);
    setCaseBaseline(selected);
    setEvidence(proof);
    identity.current = null;
  };
  const choose = (item: RecoveryCase) => {
    selectedId.current = item.id;
    setSelected(item);
    reload();
  };
  const loadMore = async () => {
    if (!cursor || busy) return;
    const signal = abort.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const page = await api.cases(signal, cursor);
      if (!signal.aborted) {
        setItems((old) => [
          ...old,
          ...page.items.filter((item) => !old.some((previous) => previous.id === item.id)),
        ]);
        setCursor(page.next_cursor);
      }
    } catch (failure) {
      if (!signal.aborted) failed(failure);
    }
  };
  const stale =
    form === 'unfreeze' && baseline && status
      ? recoverySnapshotChanged(baseline, status)
      : form === 'confirm' && caseBaseline && selected
        ? caseBaseline.id !== selected.id || caseBaseline.version !== selected.version
        : false;
  const submit = async () => {
    if (!reason.trim() || stale) return;
    if (form === 'freeze')
      return run({ kind: 'freeze', reason }, '1', async (key, signal) => {
        const value = await api.refresh(reason.trim(), key, signal);
        if (!signal.aborted) setStatus(value);
      });
    if (form === 'confirm' && checked && caseBaseline && canConfirmOrphan(caseBaseline, evidence)) {
      const body = { evidence_id: evidence!.id, confirmed: true as const, reason: reason.trim() };
      return run(
        { kind: 'confirm', id: caseBaseline.id, body },
        caseBaseline.version,
        async (key, signal) => {
          const value = await api.confirm(caseBaseline, body, key, signal);
          if (!signal.aborted) setSelected(value);
        },
      );
    }
    if (form === 'unfreeze' && checked && baseline) {
      const body = {
        confirmed: true as const,
        reason: reason.trim(),
        freeze_digest: baseline.freeze_digest,
        journal_digest: baseline.journal_digest,
      };
      return run({ kind: 'unfreeze', body }, baseline.revision, async (key, signal) => {
        const value = await api.unfreeze(baseline, body, key, signal);
        if (!signal.aborted) setStatus(value);
      });
    }
  };
  return (
    <section className="recovery-workspace" aria-label="行动灾难恢复">
      <header className="recovery-header">
        <div>
          <h1>行动灾难恢复</h1>
          <p>仅供人类租户管理员使用。核对不会重新发送外部行动。</p>
        </div>
        <button className="button subtle" onClick={onClose}>
          返回
        </button>
      </header>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {!status && !error && <Spinner label="正在读取恢复状态" />}
      {status && (
        <>
          <div className="recovery-status">
            <strong>{status.frozen ? '外部执行已冻结' : '外部执行未冻结'}</strong>
            <span>
              未解决 {status.open_cases} 项 · 未完成日志操作 {status.pending_operations} 项
            </span>
            <button className="button subtle" disabled={busy} onClick={() => open('freeze')}>
              冻结并重新核对日志
            </button>
            <button
              className="button primary"
              disabled={busy || !status.frozen || status.open_cases > 0}
              onClick={() => open('unfreeze')}
            >
              人工确认解冻
            </button>
          </div>
          <div className="recovery-layout">
            <aside aria-label="恢复案例">
              <h2>恢复案例</h2>
              {items.length === 0 ? (
                <p>当前没有恢复案例。</p>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    className="recovery-case"
                    aria-pressed={selected?.id === item.id}
                    onClick={() => choose(item)}
                  >
                    <strong>{item.status === 'resolved' ? '已确认' : '待核对'}</strong>
                    <span>{item.action_id}</span>
                    <small>{item.reason}</small>
                  </button>
                ))
              )}
              {cursor && (
                <button className="button subtle" onClick={() => void loadMore()}>
                  加载更多案例
                </button>
              )}
            </aside>
            <main>
              {selected ? (
                <>
                  <h2>恢复证据</h2>
                  <dl className="recovery-facts">
                    <dt>Action</dt>
                    <dd>{selected.action_id}</dd>
                    <dt>Attempt</dt>
                    <dd>{selected.attempt_id}</dd>
                    <dt>原因</dt>
                    <dd>{selected.reason}</dd>
                    <dt>状态</dt>
                    <dd>{selected.status === 'resolved' ? '已解决' : '尚未解决'}</dd>
                    {selected.intent && (
                      <>
                        <dt>原任务</dt>
                        <dd>{selected.intent.task_id}</dd>
                        <dt>工具与目标</dt>
                        <dd>
                          {selected.intent.tool_id} /{' '}
                          {selected.intent.tool_version ?? '旧日志未记录版本'} →{' '}
                          {selected.intent.target_id}
                        </dd>
                        <dt>参数指纹</dt>
                        <dd>{selected.intent.fingerprint}</dd>
                        <dt>原预算预估</dt>
                        <dd>
                          {selected.intent.currency}{' '}
                          {formatMicrounits(selected.intent.estimate_microunits)}
                        </dd>
                      </>
                    )}
                  </dl>
                  {selected.status === 'open' && (
                    <button
                      className="button subtle"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          { kind: 'lookup', id: selected.id },
                          selected.version,
                          async (key, signal) => {
                            await api.lookup(selected.id, key, signal);
                            const value = await api.get(selected.id, signal);
                            if (!signal.aborted) setSelected(value);
                          },
                        )
                      }
                    >
                      查询供应方（只读）
                    </button>
                  )}
                  {selected.reason !== 'missing_after_restore' && selected.status === 'open' && (
                    <p>
                      仍存在的 Attempt
                      请通过原行动的结果核对处理；身份冲突需先恢复可靠数据，不能覆盖原记录。
                    </p>
                  )}
                  {selected.evidence.length === 0 ? (
                    <p>尚未获取供应方证据。日志中的“准备发送”不证明已经执行。</p>
                  ) : (
                    selected.evidence.map((proof) => (
                      <article className="recovery-evidence" key={proof.id}>
                        <h3>
                          {proof.outcome === 'succeeded'
                            ? '供应方确认成功'
                            : proof.outcome === 'no_effect'
                              ? '供应方确认未产生效果'
                              : '供应方结果仍未知'}
                        </h3>
                        <p>
                          实际费用：
                          {proof.actual_microunits === null
                            ? '未确认'
                            : (selected.intent?.currency ?? '') +
                              ' ' +
                              formatMicrounits(proof.actual_microunits)}
                        </p>
                        <p>回执：{proof.receipt_id ?? '尚无可信回执'}</p>
                        <p>查询时间：{new Date(proof.created_at).toLocaleString()}</p>
                        {canConfirmOrphan(selected, proof) && (
                          <button
                            className="button primary"
                            disabled={busy}
                            onClick={() => open('confirm', proof)}
                          >
                            核对并确认这份证据
                          </button>
                        )}
                      </article>
                    ))
                  )}
                </>
              ) : (
                <p>选择一个案例，检查原始身份、供应方证据和费用。</p>
              )}
            </main>
          </div>
        </>
      )}
      {form && (
        <Modal
          title={
            form === 'freeze'
              ? '冻结并核对日志'
              : form === 'confirm'
                ? '确认孤立行动证据'
                : '人工确认解冻'
          }
          onClose={() => {
            if (!busy) setForm(null);
          }}
        >
          <form
            className="recovery-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p>
              {form === 'freeze'
                ? '这会冻结当前租户的新外部行动，并读取独立日志建立核对案例。'
                : form === 'confirm'
                  ? '确认将按此回执一次性补记原预算账户，并永久封存原业务键。不会重新执行行动。'
                  : '仅在所有未知结果和费用均已核对后解除冻结。原任务、审批和预算限制仍然有效。'}
            </p>
            {form === 'confirm' && evidence && (
              <p>
                回执 {evidence.receipt_id} · 实际费用 {caseBaseline?.intent?.currency}{' '}
                {evidence.actual_microunits === null
                  ? '未知'
                  : formatMicrounits(evidence.actual_microunits)}
              </p>
            )}
            <label>
              确认理由
              <textarea
                aria-label="恢复确认理由"
                required
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
              />
            </label>
            {form !== 'freeze' && (
              <label className="recovery-check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                  disabled={busy}
                />
                我已核对当前记录、可信回执与费用，明确授权这次
                {form === 'confirm' ? '记账确认' : '解冻'}。
              </label>
            )}
            {stale && (
              <div role="alert">
                <p>记录已经改变，请重新核对最新内容。</p>
                <button
                  type="button"
                  className="button subtle"
                  onClick={() => {
                    setBaseline(status);
                    setCaseBaseline(selected);
                    setChecked(false);
                    identity.current = null;
                  }}
                >
                  采用最新记录并重新确认
                </button>
              </div>
            )}
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <div className="dialog-actions">
              <button
                type="button"
                className="button subtle"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy || !!stale || !reason.trim() || (form !== 'freeze' && !checked)}
              >
                {busy
                  ? '正在提交…'
                  : form === 'freeze'
                    ? '确认冻结并核对'
                    : form === 'confirm'
                      ? '确认记账并封存'
                      : '确认解冻'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
