import { useEffect, useRef } from 'react';

import { Button } from './Button.tsx';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** True while the confirmed action is running, so the dialog can say so. */
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirmation dialog built on the native <dialog> element, opened with showModal():
 * the platform then traps focus inside it, closes it on Escape and makes everything
 * behind it inert. Doing this by hand is where custom modals usually go wrong.
 *
 * Focus starts on Cancel — never on the destructive action — and returns to whatever
 * opened the dialog when it closes.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      openerRef.current = document.activeElement;
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      // Hand focus back to the control that opened this, not to the page body.
      if (openerRef.current instanceof HTMLElement && document.contains(openerRef.current)) openerRef.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
      onCancel={(event) => {
        // Escape: let React decide what "closed" means instead of the browser.
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !busy) onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-raised p-5 text-ink shadow-soft backdrop:bg-overlay"
    >
      <h2 id="confirm-dialog-title" className="text-[17px] font-semibold text-ink">
        {title}
      </h2>
      <p id="confirm-dialog-description" className="mt-2 text-[15px] text-muted">
        {description}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>
          {busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
