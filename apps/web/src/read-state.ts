import { compareDecimal } from './message-state.js';

export interface VisibleMessage {
  readonly seq: string;
  readonly top: number;
  readonly bottom: number;
}

/** Transport ACKs and snapshot contents are deliberately absent from this input. */
export function visibleReadSequence(input: {
  readonly tabVisible: boolean;
  readonly unobscured: boolean;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly messages: readonly VisibleMessage[];
}): string | null {
  if (!input.tabVisible || !input.unobscured || input.viewportBottom <= input.viewportTop)
    return null;
  let highest: string | null = null;
  for (const item of input.messages) {
    const height = item.bottom - item.top;
    const overlap =
      Math.min(input.viewportBottom, item.bottom) - Math.max(input.viewportTop, item.top);
    if (height <= 0 || overlap < Math.min(32, height)) continue;
    if (highest === null || compareDecimal(item.seq, highest) > 0) highest = item.seq;
  }
  return highest;
}
