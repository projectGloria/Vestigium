import type { FrameRef } from '../../shared/types.js';

// Picks which child frame corresponds to a recorded FrameRef. Pure, so it is unit-tested without Electron.
//
// Frames have no stable identity across page loads, so several weak signals are combined:
// same URL (strongest), same origin + path (query strings often carry tokens), same non-empty name, same position.
// A candidate needs URL or name evidence; position alone is never enough, because an ad or a new widget
// inserted before the target would otherwise silently redirect the step into the wrong frame.

export interface FrameCandidate { url: string; name: string }

function originAndPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? null : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function matchFrame(children: FrameCandidate[], ref: FrameRef): number | null {
  const expectedPath = originAndPath(ref.url);
  let best: { index: number; score: number } | null = null;
  let tie = false;
  children.forEach((child, index) => {
    let evidence = 0;
    if (child.url === ref.url) evidence += 4;
    else if (expectedPath && originAndPath(child.url) === expectedPath) evidence += 2;
    if (ref.name && child.name === ref.name) evidence += 3;
    if (evidence === 0) return;
    const score = evidence + (index === ref.index ? 1 : 0);
    if (!best || score > best.score) {
      best = { index, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  });
  // Two equally good candidates (e.g. two identical embeds, neither at the recorded position) are ambiguous.
  return best && !tie ? (best as { index: number }).index : null;
}
