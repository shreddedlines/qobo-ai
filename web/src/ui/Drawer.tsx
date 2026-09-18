import { useEffect, useRef, type ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A panel that slides in from the left below desktop width. It is a native modal
 * <dialog>, so focus is trapped inside it, Escape closes it and the page behind it is
 * inert — the same guarantees the confirmation dialog relies on.
 */
export function Drawer({ open, label, onClose, children }: DrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      openerRef.current = document.activeElement;
      dialog.showModal();
      // Start on the first control in the panel rather than on the panel itself.
      dialog.querySelector<HTMLElement>('a, button')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      if (openerRef.current instanceof HTMLElement && document.contains(openerRef.current)) openerRef.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="m-0 h-dvh max-h-dvh w-[17rem] max-w-[85vw] overflow-y-auto border-r border-line bg-surface p-0 text-ink backdrop:bg-overlay"
    >
      {/* Rendered only while open, so the closed drawer leaves no duplicate of the
          conversation list (and no duplicate element ids) in the document. */}
      {open ? children : null}
    </dialog>
  );
}
