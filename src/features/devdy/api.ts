// Devdy service API: the only Devdy module other features may import
// (service-worker side). Everything else under features/devdy is private.

export { outbox } from './background';
export { openSettings } from './background/open-settings';
export { DEVDY_MAX_ATTACHMENTS, type SendOutcome } from './core/client';
export type { DevdyDelivery } from './messages';
