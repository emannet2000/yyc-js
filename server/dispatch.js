import { cargoStates, prePickup } from '../shared/planning.js';
import {
  canTakeCargo,
  driverAvailable,
  driverVehicleBlockers,
} from '../shared/scheduling.js';

export function releaseDriverOffer(shipment) {
  const prevOfferedTo = shipment.offeredTo;
  shipment.offeredTo = null;
  delete shipment.offerExpiresAt;
  delete shipment.handover;
  if (shipment.status === 'Offered') shipment.status = 'Ready to assign';
  if (
    shipment.rateChange &&
    ![shipment.driverId, prevOfferedTo].includes(shipment.rateChange.driverId)
  )
    delete shipment.rateChange;
}

export function applyDispatchAction(
  s,
  user,
  data,
  {
    allowed,
    requireThat,
    text,
    now,
    requireCurrentPickupDate,
    commitments,
    cargoCommitments,
    findDriver,
  },
) {
  const broker = user.role === 'admin';
  const liveCargo = cargoStates.includes(s.status);
  const active = s.status === 'Assigned' || liveCargo;
  const canAnswer =
    user.role === 'driver' &&
    s.offeredTo === user.id &&
    (s.status === 'Offered' || (active && !!s.handover));
  const available = (driverId) => driverAvailable(s, commitments(driverId), driverId);
  const canCarry = (driverId) =>
    !liveCargo || canTakeCargo(s.id, cargoCommitments(driverId), driverId);
  const timestamp = () => new Date(now()).toISOString();
  function offerTo(driverId) {
    s.offeredTo = driverId;
    s.offerExpiresAt = now() + 3600000;
  }
  switch (data.action) {
    case 'acceptQuote':
      allowed(
        user.role === 'store' && s.storeId === user.id && s.status === 'Quote ready',
      );
      requireCurrentPickupDate();
      s.status = 'Ready to assign';
      delete s.quoteExpiresAt;
      return 'Quotation accepted';
    case 'offer': {
      allowed(broker && s.status === 'Ready to assign');
      requireCurrentPickupDate();
      const driver = findDriver(text(data, 'driverId'));
      requireThat(
        !driverVehicleBlockers(s, driver).length,
        400,
        'Driver and truck must be approved and suitable.',
      );
      requireThat(
        available(driver.id),
        409,
        'Driver already has a commitment in this pickup window.',
      );
      offerTo(driver.id);
      s.status = 'Offered';
      return 'Job offered';
    }
    case 'handover': {
      allowed(broker && active && !!s.driverId);
      if (s.status === 'Assigned') requireCurrentPickupDate();
      requireThat(
        !s.handover && !s.offeredTo,
        409,
        'Withdraw the pending handover before offering another driver.',
      );
      const replacementId = text(data, 'driverId');
      const reason = text(data, 'reason');
      requireThat(
        replacementId !== s.driverId,
        400,
        'Choose a different replacement driver.',
      );
      const replacement = findDriver(replacementId);
      requireThat(
        !driverVehicleBlockers(s, replacement).length,
        400,
        'Replacement driver and truck must be approved and suitable.',
      );
      requireThat(
        available(replacementId),
        409,
        'Replacement driver already has a commitment in this pickup window.',
      );
      requireThat(
        canCarry(replacementId),
        409,
        'Replacement driver must finish the current live load or pending cargo handover first.',
      );
      offerTo(replacementId);
      s.handover = { fromDriverId: s.driverId, reason, offeredAt: timestamp() };
      return `Driver handover offered to ${replacement.name}: ${reason}`;
    }
    case 'withdrawOffer':
    case 'withdrawHandover': {
      const handover = data.action === 'withdrawHandover';
      allowed(
        broker &&
          !!s.offeredTo &&
          (handover ? active && !!s.handover : s.status === 'Offered'),
      );
      const reason = text(data, 'reason');
      releaseDriverOffer(s);
      return `${handover ? 'Driver handover' : 'Job offer'} withdrawn: ${reason}`;
    }
    case 'acceptJob': {
      allowed(canAnswer);
      if (prePickup.includes(s.status)) requireCurrentPickupDate();
      requireThat(
        !driverVehicleBlockers(s, user).length,
        403,
        'Driver and truck approval or suitability is missing.',
      );
      requireThat(
        available(user.id),
        409,
        'You already have a commitment in this pickup window.',
      );
      requireThat(
        !s.handover || canCarry(user.id),
        409,
        'Finish the current live load or pending cargo handover before accepting another load.',
      );
      let message = 'Job accepted';
      if (s.handover) {
        const original = findDriver(s.driverId);
        s.handoverHistory = [
          ...(s.handoverHistory || []),
          {
            ...s.handover,
            toDriverId: user.id,
            acceptedAt: timestamp(),
            status: s.status,
          },
        ];
        message = `Driver accepted handover from ${original?.name || s.driverId}: ${s.handover.reason}`;
        delete s.arrivedAt;
      } else {
        s.status = 'Assigned';
      }
      s.driverId = user.id;
      s.driverAcceptedAt = timestamp();
      releaseDriverOffer(s);
      return message;
    }
    case 'decline': {
      allowed(canAnswer);
      const handover = !!s.handover;
      releaseDriverOffer(s);
      return handover
        ? 'Driver handover declined; current assignment retained'
        : 'Job offer declined';
    }
    default:
      return false;
  }
}
