"use client";

/**
 * Fullscreen, pinch-zoomable viewer for an image sent in Sext. Mounted as a
 * portal on document.body so it sits above the pinned composer. Re-decrypts its
 * own copy of the blob (the bubble's object URL is short-lived), and supports
 * pinch-to-zoom, pan, double-tap zoom, wheel zoom (desktop), swipe-down to
 * dismiss, tap-the-backdrop / X / Escape to close.
 *
 * The transform is applied imperatively to the <img> during gestures so a drag
 * doesn't re-render the tree each frame; React state only tracks load status and
 * whether we're zoomed (which decides if a backdrop tap should close).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getChatImageBlobCached } from "@/lib/api";
import type { ChatMedia } from "@/lib/types";

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 280;
const SWIPE_CLOSE_PX = 90;

export default function ImageLightbox({
  workspaceId,
  media,
  onClose,
}: {
  workspaceId: string;
  media: ChatMedia;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [, setZoomed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const tf = useRef({ scale: 1, tx: 0, ty: 0 });
  const gesture = useRef({
    mode: "none" as "none" | "pan" | "pinch",
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const lastTap = useRef(0);

  // Reads through the decrypted-blob LRU: when the bubble already fetched this
  // image, opening the lightbox costs one createObjectURL instead of a second
  // download + decrypt. Still an independent object URL, so the bubble
  // revoking its own URL can't break the zoomed view.
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    getChatImageBlobCached({ workspaceId, media })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [workspaceId, media.mediaId, media.key, media.iv]);

  // Lock background scroll while open; Escape closes.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function apply() {
    const el = imgRef.current;
    if (!el) return;
    const { scale, tx, ty } = tf.current;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function clampPan() {
    const el = imgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect(); // already reflects the current scale
    const maxX = Math.max(0, (rect.width - window.innerWidth) / 2) + 24;
    const maxY = Math.max(0, (rect.height - window.innerHeight) / 2) + 24;
    tf.current.tx = Math.max(-maxX, Math.min(maxX, tf.current.tx));
    tf.current.ty = Math.max(-maxY, Math.min(maxY, tf.current.ty));
  }

  // Scale toward a focal point (fx, fy in screen coords) so the content under
  // the fingers / cursor stays put. Derived for transform-origin: center on an
  // image centered in the viewport.
  function setScaleAt(next: number, fx: number, fy: number) {
    const old = tf.current.scale;
    let clamped = Math.max(1, Math.min(MAX_SCALE, next));
    const f = clamped / old;
    const ux = fx - window.innerWidth / 2;
    const uy = fy - window.innerHeight / 2;
    tf.current.tx = ux * (1 - f) + f * tf.current.tx;
    tf.current.ty = uy * (1 - f) + f * tf.current.ty;
    tf.current.scale = clamped;
    if (clamped <= 1.01) { tf.current.scale = 1; tf.current.tx = 0; tf.current.ty = 0; clamped = 1; }
    clampPan();
    apply();
    setZoomed(clamped > 1.01);
  }

  function touchDist(t: React.TouchList) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }
  function touchMid(t: React.TouchList) {
    return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches;
    if (t.length === 2) {
      gesture.current = {
        mode: "pinch", startDist: touchDist(t), startScale: tf.current.scale,
        startTx: tf.current.tx, startTy: tf.current.ty, startX: 0, startY: 0, moved: true,
      };
    } else if (t.length === 1) {
      gesture.current = {
        mode: tf.current.scale > 1 ? "pan" : "none", startDist: 0, startScale: tf.current.scale,
        startTx: tf.current.tx, startTy: tf.current.ty, startX: t[0].clientX, startY: t[0].clientY, moved: false,
      };
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    const t = e.touches;
    const g = gesture.current;
    if (g.mode === "pinch" && t.length === 2) {
      e.preventDefault();
      const m = touchMid(t);
      setScaleAt(g.startScale * (touchDist(t) / (g.startDist || 1)), m.x, m.y);
    } else if (g.mode === "pan" && t.length === 1) {
      e.preventDefault();
      tf.current.tx = g.startTx + (t[0].clientX - g.startX);
      tf.current.ty = g.startTy + (t[0].clientY - g.startY);
      clampPan();
      apply();
      g.moved = true;
    } else if (g.mode === "none" && t.length === 1) {
      if (Math.abs(t[0].clientX - g.startX) > 8 || Math.abs(t[0].clientY - g.startY) > 8) g.moved = true;
    }
  }

  function onTouchEnd(e: React.TouchEvent) {
    const g = gesture.current;
    const ct = e.changedTouches[0];

    // Double-tap zoom toggle (only on a clean, single-finger tap).
    if (g.mode !== "pinch" && !g.moved && ct) {
      const now = Date.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        if (tf.current.scale > 1.01) setScaleAt(1, window.innerWidth / 2, window.innerHeight / 2);
        else setScaleAt(DOUBLE_TAP_SCALE, ct.clientX, ct.clientY);
        if (e.touches.length === 0) gesture.current.mode = "none";
        return;
      }
      lastTap.current = now;
    }

    // Swipe down to dismiss when not zoomed in.
    if (g.mode !== "pinch" && tf.current.scale <= 1.01 && ct) {
      const dy = ct.clientY - g.startY;
      if (dy > SWIPE_CLOSE_PX && Math.abs(ct.clientX - g.startX) < 120) { onClose(); return; }
    }

    if (e.touches.length === 0) gesture.current.mode = "none";
  }

  function onWheel(e: React.WheelEvent) {
    setScaleAt(tf.current.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (tf.current.scale > 1.01) setScaleAt(1, window.innerWidth / 2, window.innerHeight / 2);
    else setScaleAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY);
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      ref={stageRef}
      onClick={(e) => { if (e.target === stageRef.current) onClose(); }}
    >
      <button type="button" className="chat-lightbox-close" aria-label="Close" onClick={onClose}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {failed ? (
        <span className="chat-lightbox-status">Image unavailable</span>
      ) : !url ? (
        <span className="chat-lightbox-status">Loading…</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={url}
          alt="Shared image"
          className="chat-lightbox-img"
          draggable={false}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
        />
      )}
    </div>,
    document.body,
  );
}
