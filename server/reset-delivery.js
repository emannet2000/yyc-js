// Optional integration with an operator-configured email delivery service.
// No messages are sent unless this URL and its credential are configured.
export function configuredResetDelivery(env = process.env) {
  if (!env.RESET_DELIVERY_URL) return null;
  const url = new URL(env.RESET_DELIVERY_URL);
  if (url.protocol !== 'https:' || !env.RESET_DELIVERY_TOKEN)
    throw new Error('Reset delivery requires an HTTPS URL and RESET_DELIVERY_TOKEN.');
  return async (message) => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESET_DELIVERY_TOKEN}`,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Reset delivery failed.');
  };
}
