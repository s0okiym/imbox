import { useEffect, useState } from 'react';
import type { StoredArtifactVersion } from '@imbox/contracts';
import { isAccessLoss } from '../api.js';
import { ErrorNotice } from '../components.js';
import { ResourceApi, resourceError } from './resource-api.js';
import { compareTextVersions } from './version-difference.js';

const MAX_COMPARISON_BYTES = 256 * 1024;
export function VersionComparison({
  api,
  versions,
  accessLost,
}: {
  readonly api: ResourceApi;
  readonly versions: readonly StoredArtifactVersion[];
  readonly accessLost: (error: unknown) => void;
}) {
  const [beforeId, setBeforeId] = useState(versions.at(-2)?.id ?? '');
  const [afterId, setAfterId] = useState(versions.at(-1)?.id ?? '');
  const [requested, setRequested] = useState(0);
  const [result, setResult] = useState<ReturnType<typeof compareTextVersions> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const before = versions.find((v) => v.id === beforeId);
  const after = versions.find((v) => v.id === afterId);
  const oversized = [before, after].some((v) => v && v.resource.byte_size > MAX_COMPARISON_BYTES);
  useEffect(() => {
    setResult(null);
    setError(null);
    if (!requested || !before || !after || oversized) return;
    const controller = new AbortController();
    void Promise.all([
      api.download(before.resource, controller.signal),
      api.download(after.resource, controller.signal),
    ])
      .then(async (blobs) =>
        Promise.all(
          blobs.map(async (blob) =>
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              await blob.arrayBuffer(),
            ),
          ),
        ),
      )
      .then(([left, right]) => {
        if (!controller.signal.aborted) setResult(compareTextVersions(left!, right!));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setResult(null);
          setError(resourceError(failure));
          if (isAccessLoss(failure)) accessLost(failure);
        }
      });
    return () => controller.abort();
  }, [api, before, after, oversized, requested, accessLost]);
  return (
    <section className="task-section" aria-label="版本内容比较">
      <h2>比较固定版本</h2>
      <label>
        比较起始版本
        <select
          aria-label="比较起始版本"
          value={beforeId}
          onChange={(e) => {
            setBeforeId(e.target.value);
            setRequested(0);
            setResult(null);
          }}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              版本 {v.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        比较目标版本
        <select
          aria-label="比较目标版本"
          value={afterId}
          onChange={(e) => {
            setAfterId(e.target.value);
            setRequested(0);
            setResult(null);
          }}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              版本 {v.version}
            </option>
          ))}
        </select>
      </label>
      <button
        className="button subtle"
        disabled={!before || !after || oversized || (requested > 0 && !result && !error)}
        onClick={() => setRequested((value) => value + 1)}
      >
        比较内容
      </button>
      {oversized && <p>在线比较每个版本最多支持 256 KiB；请下载选定版本进行完整比较。</p>}
      {requested > 0 && !result && !error && <p role="status">正在读取并校验两个固定版本…</p>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {result &&
        (result.equal ? (
          <p role="status">两个版本内容完全相同。</p>
        ) : (
          <>
            <p>
              共同开头 {result.prefixLines} 行，共同结尾 {result.suffixLines}{' '}
              行。下方显示首个至最后一个变化之间的范围，其中可能包含未改动的行。
            </p>
            <div className="version-comparison-columns">
              <section aria-label="起始版本变化范围">
                <h3>起始版本 {before?.version}</h3>
                <pre>{result.before || '（空）'}</pre>
                <p>{result.beforeFormat}</p>
              </section>
              <section aria-label="目标版本变化范围">
                <h3>目标版本 {after?.version}</h3>
                <pre>{result.after || '（空）'}</pre>
                <p>{result.afterFormat}</p>
              </section>
            </div>
            {result.truncated && (
              <p>变化范围较长，每侧仅显示前 12,000 个字符；请下载两个版本查看完整内容。</p>
            )}
          </>
        ))}
    </section>
  );
}
