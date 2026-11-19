import { useState } from 'react';
import { api } from './api';

export interface SavedAddress {
  label: string;
  address: string;
  contact: string;
}

type Save = (work: () => Promise<unknown>, message: string) => Promise<void>;

// Address book for store owners. Saved addresses are offered as suggestions
// when creating a delivery request.
export function SavedAddressesForm({
  addresses,
  busy,
  save,
}: {
  addresses: SavedAddress[];
  busy: boolean;
  save: Save;
}) {
  const [draft, setDraft] = useState<SavedAddress[]>(addresses);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [contact, setContact] = useState('');
  const changed = JSON.stringify(draft) !== JSON.stringify(addresses);

  function add() {
    if (!label.trim() || !address.trim() || draft.length >= 20) return;
    setDraft([
      ...draft,
      { label: label.trim(), address: address.trim(), contact: contact.trim() },
    ]);
    setLabel('');
    setAddress('');
    setContact('');
  }

  return (
    <section className="saved-addresses">
      <h3>Saved addresses</h3>
      <p className="small">
        These appear as suggestions when you request a delivery. Up to 20.
      </p>
      {draft.length ? (
        <ul>
          {draft.map((a, i) => (
            <li key={`${a.label}-${i}`}>
              <span>
                <strong>{a.label}</strong> · {a.address}
                {a.contact ? ` · ${a.contact}` : ''}
              </span>
              <button
                type="button"
                className="textbtn"
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
              >
                Remove {a.label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">No saved addresses yet.</p>
      )}
      <div className="saved-addresses-add">
        <label>
          Label
          <input
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Address
          <input
            value={address}
            maxLength={300}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <label>
          Receiving contact (optional)
          <input
            value={contact}
            maxLength={200}
            onChange={(e) => setContact(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn light"
          onClick={add}
          disabled={!label.trim() || !address.trim() || draft.length >= 20}
        >
          Add address
        </button>
      </div>
      <button
        type="button"
        className="btn light"
        disabled={busy || !changed}
        onClick={() =>
          void save(
            () => api('/api/saved-addresses', 'PATCH', { addresses: draft }),
            'Saved addresses updated.',
          )
        }
      >
        Save addresses
      </button>
    </section>
  );
}
