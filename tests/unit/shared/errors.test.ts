import { describe, expect, it } from 'vitest';
import { isAbortError, toErrorMessage } from '../../../src/shared/utils/errors';

describe('toErrorMessage', () => {
  it('extracts message from standard Error', () => {
    expect(toErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('handles plain string error', () => {
    expect(toErrorMessage('direct error message')).toBe('direct error message');
  });

  it('handles object with message property', () => {
    expect(toErrorMessage({ message: 'custom object message' })).toBe('custom object message');
  });

  it('handles unknown primitives', () => {
    expect(toErrorMessage(404)).toBe('404');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });
});

describe('isAbortError', () => {
  it('identifies AbortError by name', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('returns false for generic errors', () => {
    expect(isAbortError(new Error('other error'))).toBe(false);
    expect(isAbortError('not an error')).toBe(false);
  });
});
