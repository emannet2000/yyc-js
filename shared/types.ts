// Domain values used by the delivery workspace and its API requests.
export type Role = 'admin' | 'store' | 'driver';
export type Status =
  | 'Awaiting quote'
  | 'Quote ready'
  | 'Ready to assign'
  | 'Offered'
  | 'Assigned'
  | 'In transit'
  | 'Delivery failed'
  | 'Returning'
  | 'Returned'
  | 'Delivered'
  | 'Cancelled';
export type Action =
  | 'attachEvidence'
  | 'setStops'
  | 'completeStop'
  | 'reschedule'
  | 'failDelivery'
  | 'redeliver'
  | 'return'
  | 'confirmReturn'
  | 'quote'
  | 'requote'
  | 'handover'
  | 'withdrawHandover'
  | 'offer'
  | 'resolve'
  | 'change'
  | 'cancel'
  | 'acceptQuote'
  | 'acceptJob'
  | 'decline'
  | 'arrival'
  | 'pickup'
  | 'deliver'
  | 'issue';
export type TruckType = 'Box truck' | 'Dry van';
export type PickupWindow = '09:00–12:00' | '13:00–16:00' | 'Flexible';
