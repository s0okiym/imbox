import { useEffect, useState } from 'react';
import type {
  ArtifactEvidenceRef,
  StoredArtifact,
  StoredArtifactVersion,
  StoredResource,
} from '@imbox/contracts';
import { ApiError, isAccessLoss } from '../api.js';
import { ErrorNotice, Modal, Spinner } from '../components.js';
import { Field } from '../tasks/task-common.js';
import { ResourceApi, resourceError } from './resource-api.js';
import { ResourceContent } from './resource-components.js';
async function versions(
  api: ResourceApi,
  artifactId: string,
  signal: AbortSignal,
): Promise<StoredArtifactVersion[]> {
  const items: StoredArtifactVersion[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.versions(artifactId, signal, cursor);
    items.push(...page.items);
    cursor = page.next_cursor;
    if (cursor) {
      if (seen.has(cursor)) throw new Error('Invalid pagination');
      seen.add(cursor);
    }
  } while (cursor && !signal.aborted);
  return items;
}
export function ArtifactEvidencePicker({
  api,
  taskId,
  selected,
  onChange,
  accessLost,
  disabled,
}: {
  readonly api: ResourceApi;
  readonly taskId: string;
  readonly selected: ArtifactEvidenceRef[];
  readonly onChange: (items: ArtifactEvidenceRef[]) => void;
  readonly accessLost: (error: unknown) => void;
  readonly disabled: boolean;
}) {
  const [artifacts, setArtifacts] = useState<StoredArtifact[]>([]);
  const [artifactId, setArtifactId] = useState('');
  const [items, setItems] = useState<StoredArtifactVersion[]>([]);
  const [versionId, setVersionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void (async () => {
      const all: StoredArtifact[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.artifacts({ type: 'task', id: taskId }, controller.signal, cursor);
        all.push(...page.items);
        cursor = page.next_cursor;
        if (cursor) {
          if (seen.has(cursor)) throw new Error('Invalid pagination');
          seen.add(cursor);
        }
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) setArtifacts(all);
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(resourceError(failure));
      }
    });
    return () => controller.abort();
  }, [api, taskId, accessLost]);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setVersionId('');
    if (!artifactId) return () => controller.abort();
    setLoading(true);
    void versions(api, artifactId, controller.signal)
      .then((all) => {
        if (!controller.signal.aborted) setItems(all);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(resourceError(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, artifactId, accessLost]);
  const version = items.find((item) => item.id === versionId);
  return (
    <fieldset className="execution-inputs">
      <legend>固定制品版本证据（可选）</legend>
      <p>只列出本任务范围内的制品；明确选择版本，后续新版本不会改变本次证据。</p>
      <Field label="证据制品">
        <select
          className="text-input"
          value={artifactId}
          onChange={(event) => setArtifactId(event.target.value)}
          disabled={disabled}
        >
          <option value="">选择制品</option>
          {artifacts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </Field>
      {loading ? (
        <Spinner />
      ) : (
        <Field label="证据固定版本">
          <select
            className="text-input"
            value={versionId}
            onChange={(event) => setVersionId(event.target.value)}
            disabled={disabled}
          >
            <option value="">明确选择版本</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                版本 {item.version} · {item.resource.filename}
              </option>
            ))}
          </select>
        </Field>
      )}
      <button
        type="button"
        className="button subtle"
        disabled={
          disabled ||
          !version ||
          selected.length >= 19 ||
          selected.some((item) => item.version_id === versionId)
        }
        onClick={() => {
          if (version)
            onChange([
              ...selected,
              {
                type: 'artifact_version',
                artifact_id: version.artifact_id,
                version_id: version.id,
                sha256: version.resource.sha256,
              },
            ]);
        }}
      >
        加入固定版本证据
      </button>
      {selected.map((item) => (
        <p className="execution-note" key={item.version_id}>
          已固定：
          {artifacts.find((artifact) => artifact.id === item.artifact_id)?.title ??
            item.artifact_id}{' '}
          · {item.version_id}
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() =>
              onChange(selected.filter((value) => value.version_id !== item.version_id))
            }
          >
            移除此证据
          </button>
        </p>
      ))}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </fieldset>
  );
}
export function ArtifactEvidenceViewer({
  api,
  evidence,
}: {
  readonly api: ResourceApi;
  readonly evidence: ArtifactEvidenceRef;
}) {
  const [open, setOpen] = useState(false);
  const [resource, setResource] = useState<StoredResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!open) return () => controller.abort();
    setResource(null);
    setError(null);
    void versions(api, evidence.artifact_id, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        const version = items.find((item) => item.id === evidence.version_id);
        if (!version || version.resource.sha256 !== evidence.sha256)
          throw new ApiError(404, 'NOT_FOUND', '固定证据不可用');
        setResource(version.resource);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(resourceError(failure));
      });
    return () => controller.abort();
  }, [api, evidence.artifact_id, evidence.version_id, evidence.sha256, open]);
  return (
    <>
      <p>固定制品版本 {evidence.version_id}</p>
      <button className="text-button" type="button" onClick={() => setOpen(true)}>
        查看这一固定版本
      </button>
      {open && (
        <Modal title="固定制品证据" onClose={() => setOpen(false)}>
          {error ? (
            <ErrorNotice>{error}</ErrorNotice>
          ) : resource ? (
            <ResourceContent
              api={api}
              resource={resource}
              accessLost={(failure) => {
                setResource(null);
                setError(resourceError(failure));
              }}
            />
          ) : (
            <Spinner />
          )}
        </Modal>
      )}
    </>
  );
}
