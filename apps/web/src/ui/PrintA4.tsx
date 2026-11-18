/**
 * Prints one A4 document (count sheets, count results) without leaving the page: the document is rendered into
 * body, html.print-a4doc makes window.print() show only it on A4, and it goes away after printing.
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function PrintA4({ children, onDone }: { children: ReactNode; onDone: () => void }) {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('print-a4doc');
    const done = () => onDone();
    window.addEventListener('afterprint', done);
    const t = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('afterprint', done);
      html.classList.remove('print-a4doc');
    };
  }, [onDone]);
  return createPortal(<div className="a4-doc" data-testid="a4-doc">{children}</div>, document.body);
}

/** Signature block: a line to sign on, the printed name(s) and a date line. */
export function SignBox({ role, names }: { role: string; names: readonly string[] }) {
  return (
    <div className="a4-sign">
      <div className="a4-sign-line" />
      <div>({names.length ? names.join(', ') : '..............................................'})</div>
      <div className="a4-muted">{role}</div>
      <div className="a4-muted">วันที่ ........ / ........ / ............</div>
    </div>
  );
}
