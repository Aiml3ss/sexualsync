/**
 * Imperative replacement for `window.confirm` that renders a branded
 * `<dialog>` instead of the unstyled native popup. Native confirm reads as
 * "system error" on iOS PWA and blocks the JS thread; this is async-friendly
 * and matches the rest of the app's styling.
 *
 * Usage:
 *   const ok = await confirmAction({ title: "Delete?", body: "..." });
 *   if (!ok) return;
 */

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

const DIALOG_ID = "ss-confirm-dialog";

function ensureStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(`${DIALOG_ID}-style`)) return;
  const style = document.createElement("style");
  style.id = `${DIALOG_ID}-style`;
  style.textContent = `
.ss-confirm-dialog::backdrop {
  background: rgba(8, 4, 6, 0.7);
}
.ss-confirm-dialog {
  border: 1px solid rgba(243, 220, 217, 0.16);
  border-radius: 16px;
  background: #25141a;
  color: #f2e0d8;
  padding: 22px;
  max-width: 360px;
  font-family: var(--ss-font-sans, system-ui, sans-serif);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.4);
}
.ss-confirm-dialog h2 {
  margin: 0 0 8px;
  font-family: var(--ss-font-display, "Cormorant Garamond", serif);
  font-size: 22px;
  line-height: 1.2;
}
.ss-confirm-dialog p {
  margin: 0 0 18px;
  font-size: 14px;
  line-height: 1.5;
  color: rgba(243, 220, 217, 0.78);
}
.ss-confirm-dialog .ss-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.ss-confirm-dialog button {
  border: 1px solid rgba(243, 220, 217, 0.16);
  background: transparent;
  color: #f2e0d8;
  padding: 10px 16px;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
}
.ss-confirm-dialog button.ss-confirm-primary {
  background: #e89ba6;
  border-color: #e89ba6;
  color: #170b10;
  font-weight: 600;
}
.ss-confirm-dialog[data-destructive="true"] button.ss-confirm-primary {
  background: #d96b6b;
  border-color: #d96b6b;
  color: #1a0a0a;
}
`;
  document.head.appendChild(style);
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return Promise.resolve(false);
  }
  if (typeof HTMLDialogElement === "undefined") {
    // Older browsers without <dialog> fall back to the native confirm so we
    // never silently no-op the user's intent.
    return Promise.resolve(window.confirm(`${options.title}\n\n${options.body || ""}`));
  }
  ensureStyle();

  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "ss-confirm-dialog";
    if (options.destructive) dialog.dataset.destructive = "true";

    const title = document.createElement("h2");
    title.textContent = options.title;
    dialog.appendChild(title);

    if (options.body) {
      const body = document.createElement("p");
      body.textContent = options.body;
      dialog.appendChild(body);
    }

    const actions = document.createElement("div");
    actions.className = "ss-confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = options.cancelLabel || "Cancel";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "ss-confirm-primary";
    confirm.textContent = options.confirmLabel || (options.destructive ? "Delete" : "Confirm");

    actions.appendChild(cancel);
    actions.appendChild(confirm);
    dialog.appendChild(actions);

    function settle(result: boolean) {
      try { dialog.close(); } catch { /* ignore */ }
      try { dialog.remove(); } catch { /* ignore */ }
      resolve(result);
    }

    cancel.addEventListener("click", () => settle(false));
    confirm.addEventListener("click", () => settle(true));
    dialog.addEventListener("cancel", (event) => {
      // Default `cancel` closes the dialog; we treat ESC as "cancel".
      event.preventDefault();
      settle(false);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    // For destructive actions, focus Cancel so a stray Enter (common on the
    // lock keypad) doesn't auto-confirm the deletion / sign-out.
    if (options.destructive) cancel.focus();
    else confirm.focus();
  });
}
