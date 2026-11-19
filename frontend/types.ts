// Re-export shared enum-derived types so UI code imports from one place.
// Domain shapes specific to the frontend remain here.
export type { Role, Status, Action, TruckType, PickupWindow } from '../shared/types.js';
import type { Role, Status } from '../shared/types.js';

export interface Truck {
  id: string;
  truck: string;
  plate: string;
  type: string;
  kg: number;
  pallets: number;
  area: string;
  liftgate: boolean;
  approved: boolean;
}
export interface User {
  id: string;
  version: number;
  name: string;
  email: string;
  role: Role;
  approved: boolean;
  disabled: boolean;
  profile: {
    address: string;
    contact: string;
    phone: string;
    reviewReason?: string;
    savedAddresses?: { label: string; address: string; contact: string }[];
  };
  truck: Truck | null;
}
export interface Quote {
  version: number;
  price?: number | null;
  rate?: number | null;
  pickup?: string;
  destination: string;
  stops?: Pick<Stop, 'kind' | 'address' | 'contact'>[];
  kg: number;
  pallets: number;
  reason: string;
}
export interface EvidenceDraft {
  pod: string;
  recipient: string;
}
export interface Stop {
  id: string;
  kind: 'pickup' | 'dropoff';
  address: string;
  contact?: string;
  completedAt?: string;
  pod?: string;
  recipient?: string;
}
export interface Shipment {
  redeliveryPlan?: Pick<
    Shipment,
    'date' | 'window' | 'deliveryDeadline' | 'estimatedMinutes' | 'travelBufferMinutes'
  >;
  deliveryAttempt?: number;
  finalArrivalVersion?: number;
  pickupArrivedAt?: string;
  pickupAt?: string;
  pickupVersion?: number;
  pickupDriverId?: string;
  handoverHistory?: { status: string; fromDriverId: string; toDriverId: string }[];
  customerRequests?: {
    id: string;
    kind: string;
    details: string;
    status: string;
    response?: string;
    proposal?: { destination: string; kg: number; pallets: number };
  }[];
  rateChange?: { driverId: string; rate: number; reason: string };
  deliveryEvidence?: {
    fileId: string;
    sha256: string;
    arrivedAt: string;
    confirmedAt: string;
    policy: string;
  };
  evidenceCount?: number;
  invoiceIssued?: boolean;
  stops?: Stop[];
  id: string;
  status: Status;
  version: number;
  customer: string;
  pickup: string;
  destination: string;
  date: string;
  window: string;
  goods: string;
  kg: number;
  pallets: number;
  type: string;
  unloading: string;
  notes: string;
  cargoNotes: string;
  pickupContact: string;
  receivingContact: string;
  hours: string;
  appointment: string;
  deliveryDeadline?: string;
  estimatedMinutes?: number;
  travelBufferMinutes?: number;
  quoteExpiresAt?: number;
  offerExpiresAt?: number;
  returnDestination?: string;
  returnPod?: string;
  returnRecipient?: string;
  failedAttempts?: { reason: string; note: string; time: string }[];
  quoteVersion: number;
  price?: number | null;
  rate?: number | null;
  driverId: string | null;
  driverName: string | null;
  offeredTo: string | null;
  handover?: { fromDriverId: string; reason: string; offeredAt: string };
  pod?: string;
  recipient?: string;
  arrivedAt?: string;
  issue?: {
    reason: string;
    note: string;
    resolved: boolean;
    resolution?: string;
  };
  quoteArchive?: Quote[];
  history: { text: string; actor: string; time: string }[];
}
export interface Workspace {
  csrf: string;
  user: User;
  shipments: Shipment[];
  drivers: User[];
  accounts: User[];
}
export type Payload = Record<string, string | number | boolean | object>;
