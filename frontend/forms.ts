import type { Payload } from './types';
export function dataFrom(form: HTMLFormElement): Payload {
  const data: Payload = {};
  new FormData(form).forEach((value, key) => {
    if (typeof value === 'string')
      data[key] = ['kg', 'pallets', 'price', 'rate'].includes(key)
        ? Number(value)
        : value;
  });
  return data;
}
