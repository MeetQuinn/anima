// Kept apart from shared/linear.ts so the activity feed can use it without zod.
/** A whole issue identifier such as `ANI-11`: team key, dash, number. */
export const LINEAR_ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;
