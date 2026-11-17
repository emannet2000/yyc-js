import { cargoStates } from './planning.js';
/** @param {{driverId?: string|null,pickupDriverId?: string,handoverHistory?: {status:string,fromDriverId:string,toDriverId:string}[]}} shipment */
export function cargoDrivers(shipment) {
  const transfers = (shipment.handoverHistory || []).filter((item) =>
    cargoStates.includes(item.status),
  );
  return [
    ...new Set(
      [
        shipment.pickupDriverId || transfers[0]?.fromDriverId || shipment.driverId,
        ...transfers.flatMap((item) => [item.fromDriverId, item.toDriverId]),
        shipment.driverId,
      ].filter((id) => typeof id === 'string'),
    ),
  ];
}
