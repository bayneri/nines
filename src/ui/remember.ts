import { useCallback, useState } from 'react';

/**
 * Whether a collapsible section was last left open, per browser. Storage can
 * be unavailable (private windows, blocked site data); the section then just
 * starts closed.
 */
export function useRememberedOpen(key: string): [boolean, (open: boolean) => void] {
  const storageKey = `nines.open.${key}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const remember = useCallback(
    (next: boolean) => {
      setOpen(next);
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        // Not remembered; nothing else depends on it.
      }
    },
    [storageKey],
  );
  return [open, remember];
}
