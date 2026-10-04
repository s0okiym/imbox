import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionResourceRef, StoredArtifact, StoredArtifactVersion } from '@imbox/contracts';
import { ResourceApi } from '../resources/resource-api.js';
import { ErrorNotice } from '../components.js';
import { Field } from '../tasks/task-common.js';
import { executionError } from './execution-state.js';

export function PublicationPicker({
  tenantId,
  csrfToken,
  taskId,
  onChange,
}: {
  tenantId: string;
  csrfToken: string;
  taskId: string;
  onChange: (value: ActionResourceRef | null) => void;
}) {
  const api = useMemo(() => new ResourceApi(tenantId, csrfToken), [tenantId, csrfToken]);
  const [artifacts, setArtifacts] = useState<StoredArtifact[]>([]);
  const [artifactId, setArtifactId] = useState('');
  const [versions, setVersions] = useState<StoredArtifactVersion[]>([]);
  const [versionId, setVersionId] = useState('');
  const [error, setError] = useState('');
  const [artifactCursor, setArtifactCursor] = useState<string>();
  const [versionCursor, setVersionCursor] = useState<string>();
  const paging = useRef<AbortController | null>(null);
  useEffect(() => () => paging.current?.abort(), [artifactId, taskId]);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .artifacts({ type: 'task', id: taskId }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setArtifacts(page.items);
          setArtifactCursor(page.next_cursor);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(executionError(e));
      });
    return () => controller.abort();
  }, [api, taskId]);
  useEffect(() => {
    const controller = new AbortController();
    setVersions([]);
    setVersionCursor(undefined);
    if (artifactId)
      void api
        .versions(artifactId, controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) {
            setVersions(page.items);
            setVersionCursor(page.next_cursor);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(executionError(e));
        });
    return () => controller.abort();
  }, [api, artifactId]);
  async function more(kind: 'artifacts' | 'versions') {
    paging.current?.abort();
    const controller = new AbortController();
    paging.current = controller;
    try {
      if (kind === 'artifacts') {
        const page = await api.artifacts(
          { type: 'task', id: taskId },
          controller.signal,
          artifactCursor,
        );
        if (!controller.signal.aborted) {
          setArtifacts((old) => [...old, ...page.items]);
          setArtifactCursor(page.next_cursor);
        }
      } else {
        const page = await api.versions(artifactId, controller.signal, versionCursor);
        if (!controller.signal.aborted) {
          setVersions((old) => [...old, ...page.items]);
          setVersionCursor(page.next_cursor);
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(executionError(e));
    }
  }
  return (
    <>
      <Field label="待发布产物">
        <select
          className="text-input"
          value={artifactId}
          onChange={(e) => {
            setArtifactId(e.target.value);
            setVersionId('');
            setError('');
            onChange(null);
          }}
        >
          <option value="">不绑定产物，使用普通文本行动</option>
          {artifacts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </Field>
      {artifactCursor && (
        <button type="button" onClick={() => void more('artifacts')}>
          加载更多产物
        </button>
      )}
      {artifactId && (
        <Field label="批准使用的固定版本">
          <select
            className="text-input"
            required
            value={versionId}
            onChange={(e) => {
              setVersionId(e.target.value);
              const item = versions.find((v) => v.id === e.target.value);
              onChange(
                item
                  ? {
                      type: 'artifact_version',
                      id: item.id,
                      version: item.version,
                      sha256: item.resource.sha256,
                    }
                  : null,
              );
            }}
          >
            <option value="">明确选择内容版本</option>
            {versions.map((item) => (
              <option key={item.id} value={item.id}>
                版本 {item.version} · {item.resource.filename}
              </option>
            ))}
          </select>
        </Field>
      )}
      {versionCursor && (
        <button type="button" onClick={() => void more('versions')}>
          加载更多版本
        </button>
      )}
      {versionId && (
        <p className="execution-note">授权固定所选版本。后续新版本不会自动替换本次授权。</p>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </>
  );
}
