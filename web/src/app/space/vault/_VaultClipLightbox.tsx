"use client";

/**
 * Full-screen video viewer for an unlocked Vault clip. Mounted as a portal
 * into document.body so the surrounding card layout / scroll doesn't bleed
 * through. The companion `useVaultLightbox` hook hides body scroll and
 * wires up the Esc shortcut.
 *
 * Split out of `vault/page.tsx` as part of H-1 so the clip + moment
 * lightboxes can be dynamic-imported (they're below-the-fold for users
 * who haven't unlocked a clip yet).
 */

import { type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

export function VaultClipLightbox({
  src,
  title,
  initialTime,
  onClose,
}: {
  src: string;
  title: string;
  initialTime: number;
  onClose: (currentTime?: number) => void;
}) {
  const lightboxVideoRef = useRef<HTMLVideoElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useVaultLightbox(() => onClose(lightboxVideoRef.current?.currentTime), dialogRef);

  useEffect(() => {
    const video = lightboxVideoRef.current;
    if (!video) return;
    video.defaultMuted = true;
    video.muted = true;
    const startAt = Math.max(0, initialTime || 0);
    const seek = () => {
      if (startAt > 0 && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(startAt, Math.max(0, video.duration - 0.1));
      }
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [initialTime]);

  return createPortal(
    <div
      ref={dialogRef}
      className="vault-moment-lightbox vault-clip-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose(lightboxVideoRef.current?.currentTime);
      }}
    >
      <div className="vault-moment-lightbox-bar">
        <p className="vault-clip-lightbox-title">{title}</p>
        <button type="button" className="btn-ghost pressable" onClick={() => onClose(lightboxVideoRef.current?.currentTime)}>
          Close
        </button>
      </div>
      <div className="vault-moment-lightbox-stage vault-clip-lightbox-stage">
        <video
          ref={lightboxVideoRef}
          src={src}
          controls
          muted
          autoPlay
          playsInline
          preload="metadata"
          controlsList="nodownload noplaybackrate"
          disablePictureInPicture
        />
      </div>
    </div>,
    document.body
  );
}

export function useVaultLightbox(
  onClose: () => void,
  dialogRef?: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Remember what was focused before the lightbox opened so we can restore
    // it on close (the thumbnail/button the user activated).
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Move focus into the dialog: prefer the first focusable control (Close
    // button), otherwise the dialog container itself (tabIndex={-1}).
    const dialog = dialogRef?.current ?? null;
    if (dialog) {
      const focusable = getFocusable(dialog);
      (focusable[0] ?? dialog).focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // Trap Tab within the dialog so focus can't escape to the page behind it.
      if (event.key === "Tab" && dialog) {
        const focusable = getFocusable(dialog);
        if (focusable.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || active === dialog || !dialog.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      // Restore focus to the opener if it's still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [onClose, dialogRef]);
}
