import { useEffect, useRef, type ReactNode } from 'react';
export default function Sheet({ children, onClose, label, className = '' }: { children: ReactNode; onClose: () => void; label: string; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); dialog?.querySelector<HTMLElement>('[autofocus]')?.focus(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`desk-sheet ${className}`} aria-label={label} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }} onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation(); }} onClick={e => { if (e.target === ref.current) onClose(); }}>{children}</dialog>;
}
