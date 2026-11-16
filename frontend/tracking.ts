import { create } from 'zustand';
export const useTracking = create<{
  owner: string | null;
  shipment: string | null;
  error: string;
  start: (owner: string, shipment: string) => void;
  stop: () => void;
  report: (error: string) => void;
}>((set) => ({
  owner: null,
  shipment: null,
  error: '',
  start: (owner, shipment) => set({ owner, shipment, error: '' }),
  stop: () => set({ owner: null, shipment: null, error: '' }),
  report: (error) => set({ error }),
}));
