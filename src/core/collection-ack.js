const utc = (value) => typeof value === 'string' && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;

/** Small operational acknowledgment shared by the scoped trigger and its clients. */
export function collectionAcknowledgment(payload) {
  return { collectedAt: utc(payload?.collectedAt), checkedAt: utc(payload?.checkedAt),
    heartbeat: payload?.heartbeat === true,
    factualPublication: typeof payload?.factualPublication === 'boolean' ? payload.factualPublication : payload?.prepared?.promoted === true,
    completionRepaired: payload?.completionRepaired === true, notificationRepaired: payload?.notificationRepaired === true };
}
