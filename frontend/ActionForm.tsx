import { useLayoutEffect, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useUiStore } from './stores/useUiStore';
import { actionDraftKey } from './actionDrafts';
import { dataFrom } from './forms';
import type { Action, Payload } from './types';
const emptyDraft: Record<string, string> = {};
export function ActionForm({
  owner,
  shipmentId,
  draftScope,
  action,
  children,
  busy,
  label,
  onSave,
}: {
  owner: string;
  shipmentId: string;
  draftScope?: string;
  action: Action;
  children: ReactNode;
  busy: boolean;
  label: string;
  onSave: (data: Payload) => Promise<void>;
}) {
  const key = actionDraftKey(shipmentId, action, draftScope),
    form = useRef<HTMLFormElement>(null);
  const draft = useUiStore((state) =>
    state.draftOwner === owner ? state.actionDrafts[key] || emptyDraft : emptyDraft,
  );
  const setDraft = useUiStore((state) => state.setActionDraft);
  useLayoutEffect(() => {
    for (const [name, value] of Object.entries(draft)) {
      const field = form.current?.elements.namedItem(name);
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement ||
        field instanceof HTMLTextAreaElement
      ) {
        if (field.value !== value) field.value = value;
      }
    }
  }, [draft, key]);
  function change(event: FormEvent<HTMLFormElement>) {
    const field = event.target;
    if (
      (field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement ||
        field instanceof HTMLTextAreaElement) &&
      field.name
    )
      setDraft(owner, shipmentId, action, field.name, field.value, draftScope);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) void onSave(dataFrom(event.currentTarget));
  }
  return (
    <form key={key} ref={form} onChange={change} onSubmit={submit}>
      {children}
      <button className="btn" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
    </form>
  );
}
