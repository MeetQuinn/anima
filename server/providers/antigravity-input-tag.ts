import { createHmac } from 'node:crypto';

/**
 * agy's Stop payload carries the conversation's last user input: the prompt the
 * loop ran for, or for a turn agy starts on its own, the prompt before it. The
 * Stop hook keeps only this keyed digest of it, so the controller can tell which
 * prompt a Stop belongs to without the text being written anywhere. The key
 * lives for one launch of `agy`.
 */
export function antigravityInputTag(key: string, text: string): string {
  return createHmac('sha256', key).update(text).digest('hex').slice(0, 32);
}
