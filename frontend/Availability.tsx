import { useState } from 'react';
import { api } from './api';

type Save = (work: () => Promise<unknown>, message: string) => Promise<void>;

// Lets a driver mark the days they cannot take work. Those days are excluded
// from offers and from driver suggestions.
export function AvailabilityForm({
  dates,
  busy,
  save,
}: {
  dates: string[];
  busy: boolean;
  save: Save;
}) {
  const [draft, setDraft] = useState<string[]>(dates);
  const [day, setDay] = useState('');
  const changed =
    draft.length !== dates.length || draft.some((d, i) => d !== [...dates].sort()[i]);

  function add() {
    if (!day || draft.includes(day)) return;
    setDraft([...draft, day].sort());
    setDay('');
  }

  return (
    <section className="availability">
      <h3>Unavailable days</h3>
      <p className="small">
        Offers and suggestions will skip these dates. Choose a day, then save.
      </p>
      <div className="availability-add">
        <label>
          Day
          <input
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
          />
        </label>
        <button type="button" className="btn light" onClick={add} disabled={!day}>
          Add day
        </button>
      </div>
      {draft.length ? (
        <ul className="availability-list">
          {draft.map((d) => (
            <li key={d}>
              <span>{d}</span>
              <button
                type="button"
                className="textbtn"
                onClick={() => setDraft(draft.filter((x) => x !== d))}
              >
                Remove {d}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">No unavailable days.</p>
      )}
      <button
        type="button"
        className="btn light"
        disabled={busy || !changed}
        onClick={() =>
          void save(
            () => api('/api/availability', 'PATCH', { dates: draft }),
            'Availability saved.',
          )
        }
      >
        Save availability
      </button>
    </section>
  );
}
