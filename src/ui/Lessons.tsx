import type { LoadedScenario } from '../scenarios';
import { Icon } from './icons';

interface Props {
  lessons: LoadedScenario[];
  current: string;
  /** The current lesson's Try edit is applied. */
  tried: boolean;
  edited: boolean;
  completed: Set<string>;
  onOpen: (id: string) => void;
  onTry: () => void;
  onReset: () => void;
  onBlank: () => void;
}

/** The curriculum: every lesson visible, the current one open. */
export function Lessons({ lessons, current, tried, edited, completed, onOpen, onTry, onReset, onBlank }: Props) {
  return (
    <nav className="lessons" aria-label="Lessons">
      <p className="rail-title">Lessons</p>
      <ol>
        {lessons.map((lesson, i) => {
          const open = lesson.id === current;
          return (
            <li key={lesson.id} className={open ? 'open' : undefined}>
              <button className="lesson-title" aria-current={open ? 'step' : undefined} onClick={() => onOpen(lesson.id)}>
                <span className={`lesson-number${completed.has(lesson.id) ? ' done' : ''}`}>{completed.has(lesson.id) ? <Icon name="check" size={12} /> : i + 1}</span>
                {lesson.title}
              </button>
              {open && (
                <div className="lesson-body">
                  {tried && edited ? (
                    <>
                      <p className="lesson-result">{lesson.tryIt.result}</p>
                      {lesson.tryIt.more && <Why text={lesson.tryIt.more} />}
                      <button onClick={onReset}>Undo the experiment</button>
                    </>
                  ) : (
                    <>
                      <p>{lesson.summary}</p>
                      <Why text={lesson.more} />
                      <button className="primary" onClick={onTry}>
                        Try: {lesson.tryIt.label.charAt(0).toLowerCase() + lesson.tryIt.label.slice(1)}
                      </button>
                      {edited && (
                        <button className="text-button" onClick={onReset}>
                          Reset the lesson
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <button className="blank" onClick={onBlank}>
        <Icon name="plus" size={14} /> Model your own system
      </button>
    </nav>
  );
}

function Why({ text }: { text: string }) {
  return (
    <details className="why">
      <summary>
        <Icon name="chevron" size={13} /> Why?
      </summary>
      <p>{text}</p>
    </details>
  );
}
