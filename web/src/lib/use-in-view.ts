import { useEffect, useRef, useState, type RefObject } from "react";

type Options = {
  /** Reveal once then stop observing (default). Set false to toggle in/out. */
  once?: boolean;
  rootMargin?: string;
  threshold?: number;
  /**
   * Scroll container to measure against (default: the viewport). Pass a ref
   * when the observed element lives inside its own overflow-scroll element —
   * e.g. the GIF picker grid — so `rootMargin` preloads within that container
   * instead of the page viewport.
   */
  root?: RefObject<Element | null>;
};

/**
 * Returns `[ref, inView]` — attach `ref` to an element and `inView` flips true
 * once it scrolls into the viewport. Drives scroll-reveal motion (the `.reveal`
 * / `.is-in-view` primitives in globals.css).
 *
 * Degrades gracefully: if IntersectionObserver is unavailable (very old engine,
 * SSR), it reports in-view immediately so content is never stuck hidden.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  options: Options = {},
): [RefObject<T>, boolean] {
  const { once = true, rootMargin = "0px 0px -10% 0px", threshold = 0.12, root } = options;
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  const rootEl = root?.current ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // No IO (very old engine / non-DOM env): reveal immediately so content is
      // never stuck hidden. One-shot fallback, not a render-driven loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (once) io.unobserve(entry.target);
          } else if (!once) {
            setInView(false);
          }
        }
      },
      { root: rootEl, rootMargin, threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once, rootMargin, threshold, rootEl]);

  return [ref, inView];
}
