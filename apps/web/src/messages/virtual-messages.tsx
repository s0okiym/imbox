import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage } from '../api.js';

/** Keep ordinary short conversations fully accessible; measure variable-height long histories. */
export function VirtualMessages(props: {
  messages: readonly ChatMessage[];
  scroll: RefObject<HTMLDivElement | null>;
  followBottom: RefObject<boolean>;
  render: (message: ChatMessage, index: number) => ReactNode;
}) {
  return props.messages.length <= 200 ? (
    <>{props.messages.map(props.render)}</>
  ) : (
    <MeasuredMessages {...props} />
  );
}

function MeasuredMessages({
  messages,
  scroll,
  followBottom,
  render,
}: Parameters<typeof VirtualMessages>[0]) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const node = wrapper.current,
      parent = scroll.current;
    if (!node || !parent) return;
    const measure = () =>
      setMargin(
        node.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    if (node.previousElementSibling) observer.observe(node.previousElementSibling);
    return () => observer.disconnect();
  }, [scroll, messages.length]);
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 140,
    getItemKey: (index) => messages[index]!.id,
    overscan: 6,
    scrollMargin: margin,
  });
  const size = virtual.getTotalSize();
  useLayoutEffect(() => {
    if (followBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [size, followBottom, scroll]);
  return (
    <div
      ref={wrapper}
      data-virtual-messages={messages.length}
      style={{ height: size, position: 'relative' }}
    >
      {virtual.getVirtualItems().map((item) => (
        <div
          key={item.key}
          ref={virtual.measureElement}
          data-index={item.index}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            display: 'flow-root',
            transform: `translateY(${item.start - margin}px)`,
          }}
        >
          {render(messages[item.index]!, item.index)}
        </div>
      ))}
    </div>
  );
}
