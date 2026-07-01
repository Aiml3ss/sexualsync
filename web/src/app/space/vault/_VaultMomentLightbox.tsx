"use client";

/**
 * Full-screen lightbox for a saved Vault moment (decrypted screenshot +
 * title). Supports pinch-to-zoom + pan via Pointer Events. Mounted as a
 * portal so the surrounding card scroll doesn't bleed through.
 *
 * Split out of `vault/page.tsx` as part of H-1 alongside `VaultClipLightbox`
 * — the moment + clip lightboxes share the same `useVaultLightbox` hook
 * for Esc + body-scroll-lock.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useVaultLightbox } from "./_VaultClipLightbox";
import type { VaultMoment } from "@/lib/types";

type DecryptedMoment = VaultMoment & { titleText: string; noteText: string; frameUrl: string };

type VaultMomentPoint = { x: number; y: number };
type VaultMomentTransform = { scale: number; x: number; y: number };
type VaultMomentGesture = {
  pointers: Map<number, VaultMomentPoint>;
  startCenter: VaultMomentPoint;
  startDistance: number;
  startTransform: VaultMomentTransform;
  moved: boolean;
  suppressTap: boolean;
};

const VAULT_MOMENT_INITIAL_TRANSFORM: VaultMomentTransform = { scale: 1, x: 0, y: 0 };
const VAULT_MOMENT_TAP_SCALE = 2.5;
const VAULT_MOMENT_MAX_SCALE = 5;

function clampVaultMomentNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function vaultMomentDistance(a: VaultMomentPoint, b: VaultMomentPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function vaultMomentMidpoint(a: VaultMomentPoint, b: VaultMomentPoint): VaultMomentPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function limitVaultMomentTransform(transform: VaultMomentTransform, node: HTMLElement | null): VaultMomentTransform {
  const scale = clampVaultMomentNumber(transform.scale, 1, VAULT_MOMENT_MAX_SCALE);
  if (!node || scale <= 1.01) return VAULT_MOMENT_INITIAL_TRANSFORM;
  const rect = node.getBoundingClientRect();
  const maxX = Math.max(0, (rect.width * scale - rect.width) / 2);
  const maxY = Math.max(0, (rect.height * scale - rect.height) / 2);
  return {
    scale,
    x: clampVaultMomentNumber(transform.x, -maxX, maxX),
    y: clampVaultMomentNumber(transform.y, -maxY, maxY),
  };
}

function vaultMomentTransformAroundPoint(
  start: VaultMomentTransform,
  nextScale: number,
  startPoint: VaultMomentPoint,
  currentPoint: VaultMomentPoint,
  rect: DOMRect
): VaultMomentTransform {
  const scale = clampVaultMomentNumber(nextScale, 1, VAULT_MOMENT_MAX_SCALE);
  if (scale <= 1.01 || start.scale <= 0) return VAULT_MOMENT_INITIAL_TRANSFORM;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const startOffsetX = startPoint.x - centerX;
  const startOffsetY = startPoint.y - centerY;
  const currentOffsetX = currentPoint.x - centerX;
  const currentOffsetY = currentPoint.y - centerY;
  const ratio = scale / start.scale;
  return {
    scale,
    x: currentOffsetX - (startOffsetX - start.x) * ratio,
    y: currentOffsetY - (startOffsetY - start.y) * ratio,
  };
}

export function VaultMomentLightbox({
  moment,
  canDelete,
  deleting,
  onClose,
  onDelete,
}: {
  moment: DecryptedMoment;
  canDelete: boolean;
  deleting: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [transform, setTransform] = useState<VaultMomentTransform>(VAULT_MOMENT_INITIAL_TRANSFORM);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<VaultMomentTransform>(VAULT_MOMENT_INITIAL_TRANSFORM);
  const gestureRef = useRef<VaultMomentGesture>({
    pointers: new Map(),
    startCenter: { x: 0, y: 0 },
    startDistance: 0,
    startTransform: VAULT_MOMENT_INITIAL_TRANSFORM,
    moved: false,
    suppressTap: false,
  });
  const zoomed = transform.scale > 1.01;

  useVaultLightbox(onClose, dialogRef);

  useEffect(() => {
    function onResize() {
      const limited = limitVaultMomentTransform(transformRef.current, zoomRef.current);
      transformRef.current = limited;
      setTransform(limited);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function commitTransform(next: VaultMomentTransform) {
    const limited = limitVaultMomentTransform(next, zoomRef.current);
    transformRef.current = limited;
    setTransform(limited);
  }

  function zoomAtPoint(point: VaultMomentPoint, scale: number) {
    const rect = zoomRef.current?.getBoundingClientRect();
    if (!rect) {
      commitTransform({ scale, x: 0, y: 0 });
      return;
    }
    commitTransform(vaultMomentTransformAroundPoint(transformRef.current, scale, point, point, rect));
  }

  function toggleZoom(point?: VaultMomentPoint) {
    if (transformRef.current.scale > 1.01) {
      commitTransform(VAULT_MOMENT_INITIAL_TRANSFORM);
      return;
    }
    const rect = zoomRef.current?.getBoundingClientRect();
    zoomAtPoint(
      point || (rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 }),
      VAULT_MOMENT_TAP_SCALE
    );
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    const gesture = gestureRef.current;
    gesture.pointers.set(event.pointerId, point);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The node can unmount while a lightbox is closing.
    }

    if (gesture.pointers.size === 1) {
      gesture.startCenter = point;
      gesture.startDistance = 0;
      gesture.startTransform = transformRef.current;
      gesture.moved = false;
      gesture.suppressTap = false;
      return;
    }

    const points = Array.from(gesture.pointers.values());
    gesture.startCenter = vaultMomentMidpoint(points[0], points[1]);
    gesture.startDistance = Math.max(1, vaultMomentDistance(points[0], points[1]));
    gesture.startTransform = transformRef.current;
    gesture.moved = false;
    gesture.suppressTap = true;
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture.pointers.has(event.pointerId)) return;
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    gesture.pointers.set(event.pointerId, point);
    const points = Array.from(gesture.pointers.values());

    if (points.length >= 2) {
      const currentCenter = vaultMomentMidpoint(points[0], points[1]);
      const currentDistance = vaultMomentDistance(points[0], points[1]);
      const rect = zoomRef.current?.getBoundingClientRect();
      if (!rect) return;
      const nextScale = gesture.startTransform.scale * (currentDistance / Math.max(1, gesture.startDistance));
      if (Math.abs(currentDistance - gesture.startDistance) > 3 || vaultMomentDistance(currentCenter, gesture.startCenter) > 3) {
        gesture.moved = true;
      }
      commitTransform(vaultMomentTransformAroundPoint(gesture.startTransform, nextScale, gesture.startCenter, currentCenter, rect));
      return;
    }

    const deltaX = point.x - gesture.startCenter.x;
    const deltaY = point.y - gesture.startCenter.y;
    if (Math.hypot(deltaX, deltaY) > 6) gesture.moved = true;
    if (gesture.startTransform.scale <= 1.01) return;
    commitTransform({
      ...gesture.startTransform,
      x: gesture.startTransform.x + deltaX,
      y: gesture.startTransform.y + deltaY,
    });
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    const hadPointer = gesture.pointers.has(event.pointerId);
    const wasTap = hadPointer && gesture.pointers.size === 1 && !gesture.moved && !gesture.suppressTap;
    const point = { x: event.clientX, y: event.clientY };
    if (hadPointer) {
      event.preventDefault();
      gesture.pointers.delete(event.pointerId);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // The browser may already have released capture.
      }
    }

    if (gesture.pointers.size === 1) {
      const [remaining] = Array.from(gesture.pointers.values());
      gesture.startCenter = remaining;
      gesture.startDistance = 0;
      gesture.startTransform = transformRef.current;
      gesture.moved = false;
      return;
    }

    if (gesture.pointers.size === 0) {
      if (transformRef.current.scale <= 1.01) commitTransform(VAULT_MOMENT_INITIAL_TRANSFORM);
      if (wasTap) toggleZoom(point);
      gesture.startDistance = 0;
      gesture.moved = false;
      gesture.suppressTap = false;
    }
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    gesture.pointers.delete(event.pointerId);
    if (gesture.pointers.size === 0) {
      if (transformRef.current.scale <= 1.01) commitTransform(VAULT_MOMENT_INITIAL_TRANSFORM);
      gesture.startDistance = 0;
      gesture.moved = false;
      gesture.suppressTap = false;
    }
  }

  function onZoomKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleZoom();
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="vault-moment-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Saved moment"
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="vault-moment-lightbox-bar">
        <button type="button" className="btn-ghost pressable" onClick={onClose}>
          Close
        </button>
        {canDelete && (
          <button type="button" className="btn-ghost pressable vault-moment-lightbox-delete" onClick={onDelete} disabled={deleting}>
            {deleting ? "Deleting" : "Delete"}
          </button>
        )}
      </div>
      <div className={`vault-moment-lightbox-stage ${zoomed ? "is-zoomed" : ""}`}>
        {moment.frameUrl && (
          <div
            ref={zoomRef}
            role="button"
            tabIndex={0}
            className={`vault-moment-zoom ${zoomed ? "is-zoomed" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={onPointerCancel}
            onKeyDown={onZoomKeyDown}
            aria-label={zoomed ? "Reset saved moment zoom" : "Zoom saved moment"}
          >
            {/* next/image can't optimize a blob: URL (E2E-decrypted). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={moment.frameUrl}
              alt={moment.titleText || ""}
              draggable={false}
              style={{
                transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
              }}
            />
          </div>
        )}
        {moment.titleText && <p>{moment.titleText}</p>}
      </div>
    </div>,
    document.body
  );
}
