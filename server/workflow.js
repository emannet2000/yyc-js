import { randomUUID } from 'node:crypto';
import { prePickup, cargoStates } from '../shared/planning.js';
import { startCargoReturn } from './cargo.js';

export function archiveQuote(s, reason) {
  s.quoteArchive = [
    ...(s.quoteArchive || []),
    {
      version: s.quoteVersion,
      price: s.price,
      rate: s.rate,
      pickup: s.pickup,
      destination: s.destination,
      stops: (s.stops || []).map(({ kind, address, contact }) => ({
        kind,
        address,
        contact,
      })),
      date: s.date,
      window: s.window,
      kg: s.kg,
      pallets: s.pallets,
      reason,
    },
  ];
}

export function createWorkflow({ now, requireThat, text, positive, money }) {
  const terminal = (s) => ['Delivered', 'Returned', 'Cancelled'].includes(s.status);
  function clearAssignment(s) {
    s.driverId = null;
    s.offeredTo = null;
    for (const key of [
      'handover',
      'offerExpiresAt',
      'arrivedAt',
      'pickupArrivedAt',
      'rateChange',
    ])
      delete s[key];
  }
  function changeRate(s, user, data) {
    requireThat(
      user.role === 'admin' && prePickup.includes(s.status) && s.price != null,
      403,
      'Driver rates can only be changed by the broker before pickup.',
    );
    const rate = money(data, 'rate'),
      reason = text(data, 'reason');
    requireThat(
      rate !== s.rate && rate <= s.price,
      400,
      'Choose a different driver rate no higher than the customer price.',
    );
    if (s.rateChange && ![s.driverId, s.offeredTo].includes(s.rateChange.driverId))
      delete s.rateChange;
    requireThat(
      !s.rateChange,
      409,
      'Wait for the driver to respond to the pending rate change.',
    );
    const driverId = s.driverId || s.offeredTo;
    if (driverId) {
      s.rateChange = {
        driverId,
        rate,
        reason,
        requestedAt: new Date(now()).toISOString(),
      };
      return 'Driver rate change proposed; the existing agreed rate remains until the driver accepts';
    }
    s.rateHistory = [
      ...(s.rateHistory || []),
      { rate: s.rate, reason, changedAt: new Date(now()).toISOString() },
    ];
    s.rate = rate;
    s.rateVersion = (s.rateVersion || 1) + 1;
    return 'Driver rate updated; customer quotation unchanged';
  }
  function apply(s, user, data) {
    const admin = user.role === 'admin',
      owner = user.role === 'store' && s.storeId === user.id;
    if (data.action === 'changeRate') return changeRate(s, user, data);
    if (data.action === 'withdrawRateChange') {
      requireThat(
        user.role === 'admin',
        403,
        'Only the broker can withdraw a driver rate proposal.',
      );
      requireThat(
        s.rateChange && prePickup.includes(s.status),
        409,
        'No driver rate proposal is pending.',
      );
      const reason = text(data, 'reason');
      delete s.rateChange;
      return `Driver rate proposal withdrawn; existing agreed rate retained: ${reason}`;
    }
    if (['acceptRate', 'declineRate'].includes(data.action)) {
      requireThat(
        user.role === 'driver' &&
          s.rateChange?.driverId === user.id &&
          [s.driverId, s.offeredTo].includes(user.id) &&
          prePickup.includes(s.status),
        403,
        'No rate change is awaiting this driver.',
      );
      if (data.action === 'acceptRate') {
        requireThat(
          user.approved && user.truck?.approved && !user.disabled,
          403,
          'Driver and truck approvals must be current before accepting a new rate.',
        );
        s.rateHistory = [
          ...(s.rateHistory || []),
          {
            rate: s.rate,
            reason: s.rateChange.reason,
            changedAt: new Date(now()).toISOString(),
          },
        ];
        s.rate = s.rateChange.rate;
        s.rateVersion = (s.rateVersion || 1) + 1;
      }
      delete s.rateChange;
      return data.action === 'acceptRate'
        ? 'Driver accepted the new rate; assignment and customer acceptance retained'
        : 'Driver declined the rate change; existing agreed rate retained';
    }
    if (data.action === 'withdrawRequest') {
      requireThat(
        owner && !terminal(s),
        403,
        'Only the owner can withdraw a request on an open delivery.',
      );
      const request = s.customerRequests?.find(
        (r) => r.id === data.requestId && r.status === 'pending',
      );
      requireThat(request, 409, 'This request is no longer pending.');
      Object.assign(request, {
        status: 'withdrawn',
        response: text(data, 'reason'),
        resolvedAt: new Date(now()).toISOString(),
      });
      return 'Owner withdrew the pending change request';
    }
    if (data.action === 'requestChange') {
      requireThat(
        owner && !terminal(s),
        403,
        'Only the owner can request changes to an open delivery.',
      );
      const kind = text(data, 'kind'),
        details = text(data, 'details');
      requireThat(
        ['quotation', 'shipment', 'cancellation'].includes(kind),
        400,
        'Choose a quotation, shipment, or cancellation request.',
      );
      requireThat(
        kind === 'cancellation' ? s.status !== 'Returning' : prePickup.includes(s.status),
        409,
        'This change is no longer available at the current delivery stage.',
      );
      const requests = s.customerRequests || [];
      const pending = requests.find((r) => r.status === 'pending');
      const supersedes =
        kind === 'cancellation' && pending && pending.kind !== 'cancellation';
      requireThat(
        !pending || supersedes,
        409,
        'Wait for the broker to respond to your pending request.',
      );
      requireThat(
        requests.length < 100,
        409,
        'Request history is full. Contact the broker.',
      );
      const proposal =
        kind === 'shipment'
          ? {
              destination: text(data, 'destination'),
              kg: positive(data, 'kg'),
              pallets: positive(data, 'pallets', true),
            }
          : undefined;
      if (proposal)
        requireThat(
          proposal.destination.toLowerCase() !== s.pickup.toLowerCase() &&
            (proposal.destination !== s.destination ||
              proposal.kg !== s.kg ||
              proposal.pallets !== s.pallets),
          400,
          'Propose a changed destination or cargo; pickup and destination must differ.',
        );
      if (supersedes)
        Object.assign(pending, {
          status: 'superseded',
          response: 'Replaced by an urgent cancellation request from the owner.',
          resolvedAt: new Date(now()).toISOString(),
        });
      s.customerRequests = [
        ...requests,
        {
          id: randomUUID(),
          kind,
          details,
          proposal,
          status: 'pending',
          requestedAt: new Date(now()).toISOString(),
        },
      ];
      return `Owner requested ${kind} review; existing instructions remain until broker response`;
    }
    if (data.action !== 'respondRequest') return false;
    requireThat(
      admin && !terminal(s),
      403,
      'Only the broker can respond to an open delivery request.',
    );
    const request = s.customerRequests?.find(
      (r) => r.id === data.requestId && r.status === 'pending',
    );
    requireThat(
      request,
      409,
      'This request has already been resolved or is unavailable.',
    );
    const decision = text(data, 'decision'),
      response = text(data, 'response');
    requireThat(
      ['approve', 'decline'].includes(decision),
      400,
      'Approve or decline the request.',
    );
    if (decision === 'approve') {
      if (request.kind !== 'cancellation')
        requireThat(
          prePickup.includes(s.status),
          409,
          'The load has progressed; decline this request with updated instructions.',
        );
      if (request.kind === 'quotation') {
        const price = money(data, 'price'),
          rate = money(data, 'rate');
        requireThat(
          rate <= price && price !== s.price,
          400,
          'Enter a changed customer price and a driver rate no higher than that price.',
        );
        archiveQuote(s, response);
        clearAssignment(s);
        Object.assign(s, {
          price,
          rate,
          quoteVersion: s.quoteVersion + 1,
          status: 'Quote ready',
          quoteExpiresAt: now() + 48 * 3600000,
        });
      } else if (request.kind === 'shipment') {
        archiveQuote(s, response);
        clearAssignment(s);
        Object.assign(s, request.proposal, {
          price: null,
          rate: null,
          quoteVersion: s.quoteVersion + 1,
          status: 'Awaiting quote',
        });
        delete s.quoteExpiresAt;
      } else if (cargoStates.includes(s.status)) {
        requireThat(
          !s.issue || s.issue.resolved,
          409,
          'Resolve the open delivery exception before approving a cancellation.',
        );
        // Already returning: keep the broker's existing return instructions.
        if (s.status !== 'Returning') startCargoReturn(s, response);
      } else {
        requireThat(
          prePickup.includes(s.status),
          409,
          'This delivery can no longer be cancelled.',
        );
        clearAssignment(s);
        s.status = 'Cancelled';
      }
    }
    Object.assign(request, {
      status: decision === 'approve' ? 'approved' : 'declined',
      response,
      resolvedAt: new Date(now()).toISOString(),
    });
    return `Owner ${request.kind} request ${request.status}: ${response}`;
  }
  return { apply, changeRate };
}
