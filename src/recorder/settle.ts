// Waits until `element` has stopped moving and the document has stopped changing, so a click lands where the
// element is *going* to be (after animations, lazy layout, late-inserted banners), not where it was mid-render.
//
// Bounded on purpose: some pages never go quiet (a ticking countdown, a carousel). After `limitMs` we proceed
// anyway; the caller still checks visibility, enabled state and obstruction right before acting.

const SAMPLE_MS = 50;
const QUIET_MS = 150;

const box = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
};

export async function settle(element: Element, limitMs = 1200): Promise<void> {
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  let lastChange = performance.now();
  const observer = new view.MutationObserver(() => { lastChange = performance.now(); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    const start = performance.now();
    let previous = box(element);
    let stable = 0;
    while (performance.now() - start < limitMs && element.isConnected) {
      await new Promise(resolve => view.setTimeout(resolve, SAMPLE_MS));
      const current = box(element);
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 2 && performance.now() - lastChange >= QUIET_MS) return;
    }
  } finally {
    observer.disconnect();
  }
}
