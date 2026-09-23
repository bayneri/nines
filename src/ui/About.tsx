import { useEffect, useRef } from 'react';
import { Icon } from './icons';

/** What nines is and how to use it, for anyone who arrives without the docs. */
export function About({ open, onClose, onStart }: { open: boolean; onClose: () => void; onStart: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Escape closes a native dialog on its own; listen for that directly so the
  // app's state follows, or the info button couldn't reopen it.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    d.addEventListener('close', onClose);
    return () => d.removeEventListener('close', onClose);
  }, [onClose]);

  return (
    <dialog
      ref={dialog}
      className="about"
      aria-labelledby="about-title"
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="about-body">
        <header>
          <h2 id="about-title">What is nines?</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <p className="about-lead">
          A tool for seeing how reliable a system of services really is, and where napkin math about it goes wrong.
        </p>
        <p>
          Multiplying availabilities assumes every failure is independent. Real systems share dependencies, retry, time out and fan out, so that estimate is off in
          predictable ways. nines models those effects and shows the gap.
        </p>

        <h3>How to use it</h3>
        <ul>
          <li>
            <strong>Learn</strong> has five short lessons, each with one experiment to try.
          </li>
          <li>
            <strong>Model</strong> is for your own system. Click a service or a call to change it; add services from the toolbar.
          </li>
          <li>
            The results panel starts with your promise, like “99.9% of requests succeed within 500 ms”. Its numbers are editable in place.
          </li>
          <li>
            <strong>What would help most</strong> ranks changes by how much they help that promise. <strong>Find a path</strong> chains them until it’s kept.
          </li>
        </ul>

        <h3>Where the numbers come from</h3>
        <p>
          Failures are computed exactly. Anything involving time is simulated, so those numbers carry a ± margin. Everything runs in your browser, and <Icon name="code" size={14} /> shows
          the model as code.
        </p>

        <div className="about-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={onStart}>
            Start with lesson 1
          </button>
        </div>
      </div>
    </dialog>
  );
}
