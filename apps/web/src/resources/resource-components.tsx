import { VersionComparison } from './version-comparison.js';
import { useEffect, useRef, useState } from 'react';
import type { StoredArtifact, StoredArtifactVersion, StoredResource } from '@imbox/contracts';
import { isAccessLoss, type Session } from '../api.js';
import type { Conversation, Task } from '@imbox/contracts';
import { ArtifactCollaborationPanel } from './artifact-collaboration-panel.js';
import { ErrorNotice, fullTime, Modal, Spinner } from '../components.js';
import { Field } from '../tasks/task-common.js';
import { Fact, Facts, SubmitActions, useExecutionCommand } from '../execution/execution-common.js';
import { ResourceApi, resourceError, TextUpload, textFileType } from './resource-api.js';
import type { ResourceScope } from './resource-api.js';
import './resources.css';

export function UploadForm({
  api,
  scope,
  title = '上传文本文件',
  onClose,
  onUploaded,
  accessLost,
}: {
  readonly api: ResourceApi;
  readonly scope: ResourceScope;
  readonly title?: string;
  readonly onClose: () => void;
  readonly onUploaded: (resource: StoredResource) => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<'preparing' | 'uploading' | 'verifying' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<TextUpload | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!file || request.current) return;
          const controller = new AbortController();
          request.current = controller;
          setError(null);
          operation.current ??= new TextUpload(api, file, scope);
          void operation.current
            .run(controller.signal, setStage)
            .then((resource) => {
              if (!controller.signal.aborted) onUploaded(resource);
            })
            .catch((failure: unknown) => {
              if (!controller.signal.aborted) {
                if (isAccessLoss(failure)) accessLost(failure);
                else setError(resourceError(failure));
              }
            })
            .finally(() => {
              if (!controller.signal.aborted) {
                request.current = null;
                setStage(null);
              }
            });
        }}
      >
        <p className="execution-note">
          支持 UTF-8 的 TXT、Markdown、JSON，单个文件不超过 8
          MiB。上传后的访问范围与当前任务或会话一致。
        </p>
        <Field label="选择文本文件">
          <input
            className="text-input"
            type="file"
            accept=".txt,.md,.markdown,.json,text/plain,text/markdown,application/json"
            required
            disabled={stage !== null}
            onChange={(event) => {
              setError(null);
              operation.current = null;
              const selected = event.target.files?.[0] ?? null;
              try {
                if (selected) textFileType(selected);
                setFile(selected);
              } catch (failure: unknown) {
                setFile(null);
                setError(resourceError(failure));
              }
            }}
          />
        </Field>
        {file && (
          <p className="execution-note">
            {file.name} · {file.size.toLocaleString()} 字节
          </p>
        )}
        {stage && (
          <div>
            <Spinner
              label={
                {
                  preparing: '正在核对文件内容…',
                  uploading: '正在传输文件…',
                  verifying: '等待服务端验证并发布…',
                }[stage]
              }
            />
          </div>
        )}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <div className="dialog-actions">
          <button className="button subtle" type="button" onClick={onClose}>
            {stage ? '停止等待并关闭' : '关闭'}
          </button>
          <button className="button primary" disabled={!file || stage !== null}>
            {error ? '重试本次上传' : '上传并验证'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ResourceContent({
  api,
  resource,
  accessLost,
}: {
  readonly api: ResourceApi;
  readonly resource: StoredResource;
  readonly accessLost: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const release = () => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  };
  useEffect(
    () => () => {
      request.current?.abort();
      release();
    },
    [],
  );
  const download = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const current = await api.resource(resource.id, controller.signal);
      const blob = await api.download(current, controller.signal);
      if (controller.signal.aborted) return;
      release();
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = current.filename;
      anchor.click();
      setTimeout(() => {
        if (objectUrl.current === url) release();
      }, 1_000);
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(resourceError(failure));
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <Facts>
        <Fact label="文件名称">{resource.filename}</Fact>
        <Fact label="类型">{resource.content_type}</Fact>
        <Fact label="大小">{resource.byte_size.toLocaleString()} 字节</Fact>
        <Fact label="上传时间">{fullTime(resource.created_at)}</Fact>
      </Facts>
      <button
        className="button primary"
        disabled={busy}
        onClick={() => {
          void download();
        }}
      >
        {busy ? '正在核验并下载…' : '下载文件'}
      </button>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <details className="resource-identity">
        <summary>文件标识与内容指纹</summary>
        <code>{resource.id}</code>
        <code>{resource.sha256}</code>
      </details>
    </>
  );
}
export function CreateArtifactForm({
  api,
  resource,
  onClose,
  onCreated,
  refresh,
  accessLost,
}: {
  readonly api: ResourceApi;
  readonly resource: StoredResource;
  readonly onClose: () => void;
  readonly onCreated: (artifact: StoredArtifact) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [title, setTitle] = useState(resource.filename);
  const command = useExecutionCommand(resource.version, refresh, accessLost);
  return (
    <Modal title="保存为版本化制品" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = { title, resource_id: resource.id };
          void command.run(input, async (key, signal) => {
            const artifact = await api.createArtifact(input, key, signal);
            if (!signal.aborted) onCreated(artifact);
          });
        }}
      >
        <Field label="制品标题">
          <input
            className="text-input"
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <p className="execution-note">
          将「{resource.filename}
          」保存为第一个固定版本。未来更新会追加新版本，已有证据引用不会自动改变。
        </p>
        <SubmitActions command={command} label="创建制品" onClose={onClose} />
      </form>
    </Modal>
  );
}
export function DeleteResourceForm({
  api,
  resource,
  onClose,
  onDeleted,
  refresh,
  accessLost,
}: {
  readonly api: ResourceApi;
  readonly resource: StoredResource;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const command = useExecutionCommand(resource.version, refresh, accessLost);
  return (
    <Modal title="删除文件" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed) return;
          void command.run({ id: resource.id }, async (key, signal) => {
            await api.remove(resource, key, signal);
            if (!signal.aborted) onDeleted();
          });
        }}
      >
        <p className="execution-note">
          删除后无法继续从应用下载「{resource.filename}
          」，关联消息、制品或证据中的此文件内容也将不可读。已经下载到应用外的副本不会被撤回。
        </p>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          确认删除此文件。
        </label>
        <SubmitActions
          command={command}
          label="确认删除文件"
          disabled={!confirmed}
          onClose={onClose}
          onAdopt={() => setConfirmed(false)}
        />
      </form>
    </Modal>
  );
}
export function ArtifactContent({
  api,
  artifact,
  onChanged,
  accessLost,
  refresh,
  editable,
  collaboration,
}: {
  readonly api: ResourceApi;
  readonly artifact: StoredArtifact;
  readonly onChanged: (artifact: StoredArtifact) => void;
  readonly accessLost: (error: unknown) => void;
  readonly refresh: () => void;
  readonly editable: boolean;
  readonly collaboration?: { session: Session; conversations: Conversation[]; tasks: Task[] };
}) {
  const [versions, setVersions] = useState<StoredArtifactVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<StoredResource | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const command = useExecutionCommand(artifact.version, refresh, accessLost);
  useEffect(() => {
    const controller = new AbortController();
    setVersions([]);
    setSelected(null);
    setError(null);
    void (async () => {
      const items: StoredArtifactVersion[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.versions(artifact.id, controller.signal, cursor);
        items.push(...page.items);
        cursor = page.next_cursor;
        if (cursor) {
          if (seen.has(cursor)) throw new Error('Invalid pagination');
          seen.add(cursor);
        }
      } while (cursor);
      if (!controller.signal.aborted) setVersions(items);
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(resourceError(failure));
      }
    });
    return () => controller.abort();
  }, [api, artifact.id, artifact.version, accessLost]);
  const current = versions.find((item) => item.id === selected);
  const scope: ResourceScope = artifact.resource.task_id
    ? { type: 'task', id: artifact.resource.task_id }
    : { type: 'conversation', id: artifact.resource.conversation_id! };
  return (
    <>
      <p className="execution-note">
        当前版本 {artifact.head_version}。每个版本固定内容；下载和证据引用都针对明确版本。
        {artifact.resource.task_id && '任务负责人和贡献者可追加版本；并发修改需要刷新后重新提交。'}
      </p>
      {editable && (
        <button className="button subtle" onClick={() => setUploading(true)}>
          上传新版本
        </button>
      )}
      <section className="task-section">
        <h2>固定版本</h2>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {versions.map((version) => (
          <article
            key={version.id}
            className={`resource-version ${selected === version.id ? 'selected' : ''}`}
          >
            <button onClick={() => setSelected(version.id)}>
              <strong>版本 {version.version}</strong>
              <span>{version.resource.filename}</span>
              <small>{fullTime(version.created_at)}</small>
            </button>
            <Field
              label={`版本 ${version.version} 的固定引用`}
              hint="提交任务证据时使用这个版本标识。"
            >
              <input
                className="text-input"
                readOnly
                value={version.id}
                onFocus={(event) => event.target.select()}
              />
            </Field>
          </article>
        ))}
      </section>
      {versions.length > 1 && (
        <VersionComparison
          key={`${artifact.id}:${artifact.version}`}
          api={api}
          versions={versions}
          accessLost={accessLost}
        />
      )}
      <ResourceContent
        key={current?.id ?? artifact.version_id}
        api={api}
        resource={current?.resource ?? artifact.resource}
        accessLost={accessLost}
      />
      {collaboration && (
        <ArtifactCollaborationPanel
          {...collaboration}
          artifact={artifact}
          versionId={current?.id ?? artifact.version_id}
          resource={current?.resource ?? artifact.resource}
          accessLost={accessLost}
        />
      )}
      {uploading && (
        <UploadForm
          api={api}
          scope={scope}
          title="上传制品的新内容"
          onClose={() => setUploading(false)}
          onUploaded={(resource) => {
            setUploaded(resource);
            setUploading(false);
          }}
          accessLost={accessLost}
        />
      )}
      {uploaded && (
        <Modal title="确认追加固定版本" onClose={() => setUploaded(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void command.run({ resource_id: uploaded.id }, async (key, signal) => {
                const next = await api.appendVersion(artifact, uploaded.id, key, signal);
                if (!signal.aborted) {
                  onChanged(next);
                  setUploaded(null);
                  command.adoptLatest();
                }
              });
            }}
          >
            <p className="execution-note">
              将「{uploaded.filename}」追加到制品「{artifact.title}」。当前制品版本为{' '}
              {artifact.head_version}，旧引用继续指向旧内容。
            </p>
            <SubmitActions command={command} label="追加新版本" onClose={() => setUploaded(null)} />
          </form>
        </Modal>
      )}
    </>
  );
}

/** Attachment identifiers never grant access: metadata and bytes are freshly authorized. */
export function AttachmentLinks({
  api,
  ids,
}: {
  readonly api: ResourceApi;
  readonly ids: readonly string[];
}) {
  const [resource, setResource] = useState<StoredResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const lost = (failure: unknown) => {
    setResource(null);
    setError(resourceError(failure));
  };
  return (
    <div className="message-attachments">
      {ids.map((id, index) => (
        <button
          type="button"
          className="resource-attachment"
          key={id}
          disabled={loading !== null}
          onClick={() => {
            controller.current?.abort();
            const request = new AbortController();
            controller.current = request;
            setLoading(id);
            setError(null);
            void api
              .resource(id, request.signal)
              .then((value) => {
                if (!request.signal.aborted) setResource(value);
              })
              .catch((failure: unknown) => {
                if (!request.signal.aborted) lost(failure);
              })
              .finally(() => {
                if (!request.signal.aborted) setLoading(null);
              });
          }}
        >
          {loading === id ? '正在核对…' : `查看附件 ${index + 1}`}
        </button>
      ))}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {resource && (
        <Modal title={resource.filename} onClose={() => setResource(null)}>
          <ResourceContent api={api} resource={resource} accessLost={lost} />
        </Modal>
      )}
    </div>
  );
}
