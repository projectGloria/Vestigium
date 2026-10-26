// An error whose message is written for the user and may be shown as-is in the UI.
// Anything else that reaches the IPC boundary is replaced with a generic message (and logged).
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}
