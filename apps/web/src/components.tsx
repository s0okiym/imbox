import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Principal } from '@imbox/contracts';

type IconName =
  | 'plus'
  | 'search'
  | 'send'
  | 'chat'
  | 'close'
  | 'info'
  | 'back'
  | 'refresh'
  | 'logout'
  | 'edit'
  | 'trash'
  | 'check'
  | 'alert'
  | 'users'
  | 'arrow';

const paths: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4 4" />
    </>
  ),
  send: (
    <>
      <path d="m4 4 17 8-17 8 3-8-3-8Z" />
      <path d="M7 12h14" />
    </>
  ),
  chat: <path d="M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-4-.9L3.5 20l1.3-4.5a8 8 0 1 1 15.2-4Z" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  back: <path d="m14 5-7 7 7 7" />,
  refresh: (
    <>
      <path d="M20 5v5h-5M4 19v-5h5" />
      <path d="M5.5 8a7 7 0 0 1 11.7-3L20 10M4 14l2.8 5A7 7 0 0 0 18.5 16" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H5v16h4M10 12h11m-4-4 4 4-4 4" />
    </>
  ),
  edit: (
    <>
      <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 9v-3a6 6 0 0 0-2-4" />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
};

export function Icon({ name, size = 20 }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Brand({ compact = false }: { readonly compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-symbol" aria-hidden="true">
        i<span />
      </span>
      {!compact && (
        <span>
          imbox<span className="brand-dot">.</span>
        </span>
      )}
    </div>
  );
}

export function Avatar({
  name,
  agent = false,
  size = 'normal',
}: {
  readonly name: string;
  readonly agent?: boolean;
  readonly size?: 'small' | 'normal' | 'large';
}) {
  const palette =
    [...name].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 5;
  return (
    <span
      className={`avatar avatar-${size} palette-${palette} ${agent ? 'avatar-agent' : ''}`}
      aria-hidden="true"
    >
      {agent ? '✧' : [...name.trim()].slice(0, 1).join('').toUpperCase() || '·'}
    </span>
  );
}

export function IdentityTag({ principal }: { readonly principal: Principal }) {
  if (principal.kind === 'agent') return <span className="identity-tag">AI Agent</span>;
  if (principal.kind === 'service') return <span className="identity-tag service">服务</span>;
  return <span className="identity-tag human">人类</span>;
}

export function Modal({
  title,
  children,
  onClose,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <section className="dialog-content" aria-label={title}>
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </dialog>
  );
}

export function ErrorNotice({ children }: { readonly children: ReactNode }) {
  return (
    <div className="error-notice" role="alert">
      <Icon name="alert" size={17} />
      <span>{children}</span>
    </div>
  );
}

export function Spinner({ label = '正在加载' }: { readonly label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function relativeTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
    : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

export function fullTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '';
}
