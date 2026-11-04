import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** A key that repeats while held (backspace). A tap fires once through click; a hold fires on a timer and swallows the click. */
export function HoldKey({ onFire, children, ...rest }: { onFire: () => void; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const repeat = useRef<ReturnType<typeof setInterval>>();
  const held = useRef(false);
  const stop = () => { clearTimeout(timer.current); clearInterval(repeat.current); };
  return (
    <button
      type="button"
      {...rest}
      onPointerDown={() => {
        held.current = false;
        stop();
        timer.current = setTimeout(() => {
          held.current = true;
          onFire();
          repeat.current = setInterval(onFire, 70);
        }, 420);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={() => { if (held.current) held.current = false; else onFire(); }}
    >{children}</button>
  );
}
