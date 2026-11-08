import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui.jsx';

// A modal confirm, on the native <dialog>: it traps focus, closes on Escape, and returns
// focus to the opener. Cancel sends nothing.
export default function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      onClose={onCancel}
      className="m-auto w-[min(92vw,26rem)] bg-slate-900 text-slate-200 border border-white/10 rounded-[1.5rem] p-0 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="bg-rose-500/15 p-2 rounded-xl">
            <AlertTriangle className="text-rose-400" size={18} aria-hidden="true" />
          </div>
          <h2 id="confirm-title" className="text-lg font-black text-white uppercase tracking-tighter">
            {title}
          </h2>
        </div>
        <p id="confirm-message" className="text-sm text-slate-300 mb-6">
          {message}
        </p>
        <div className="flex justify-end gap-3">
          <Button onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
