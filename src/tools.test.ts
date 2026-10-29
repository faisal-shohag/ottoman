import { describe, expect, it } from 'vitest';
import { isRisky, normalizeUrl } from './tools';

describe('isRisky', () => {
  it.each(['Pay now', 'Place order', 'Checkout', 'Post', 'Publish', 'Reply', 'Comment', 'Tweet', 'Repost', 'Share', 'Send message', 'Delete my data', 'Subscribe', 'Donate', 'Withdraw'])(
    'gates "%s"',
    (label) => expect(isRisky(label)).toBe(true),
  );

  it.each(['Search', 'Add to cart', 'Next', 'Sign in', 'Save draft', 'Load more comments?', 'Open'])('allows "%s"', (label) => {
    // "Load more comments?" contains "comments", not the word "comment".
    expect(isRisky(label)).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('adds http for local hosts and https otherwise', () => {
    expect(normalizeUrl('localhost:5555/shop.html')).toBe('http://localhost:5555/shop.html');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('https://x.dev/a')).toBe('https://x.dev/a');
  });
});
