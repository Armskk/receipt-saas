import {
  CODE_LENGTH,
  extractLinkCode,
  formatCode,
  generateCode,
  hashCode,
  normalizeCode,
} from './channel-link-code';

describe('channel link codes', () => {
  it('generates codes of the right length from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/); // no 0 O 1 I
    }
  });

  it('does not repeat across a batch (sanity check on the randomness source)', () => {
    const codes = new Set(Array.from({ length: 500 }, generateCode));
    expect(codes.size).toBe(500);
  });

  it('formats as XXXX-XXXX', () => {
    expect(formatCode('ABCD2345')).toBe('ABCD-2345');
  });

  it('normalizes separators and case, and hashes deterministically', () => {
    expect(normalizeCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizeCode(' abcd 2345 ')).toBe('ABCD2345');
    expect(hashCode('ABCD2345')).toBe(hashCode(normalizeCode('abcd-2345')!));
    expect(hashCode('ABCD2345')).not.toBe(hashCode('ABCD2346'));
    expect(hashCode('ABCD2345')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects anything that is not exactly 8 symbols of the alphabet', () => {
    expect(normalizeCode('ABCD234')).toBeNull(); // too short
    expect(normalizeCode('ABCD23456')).toBeNull(); // too long
    expect(normalizeCode('ABCD-234O')).toBeNull(); // O is not in the alphabet
    expect(normalizeCode('ABCD-2341')).toBeNull(); // 1 is not in the alphabet
    expect(normalizeCode('')).toBeNull();
  });

  describe('extractLinkCode', () => {
    it.each([
      ['ABCD-2345', 'ABCD2345'],
      ['abcd2345', 'ABCD2345'],
      ['  ABCD 2345  ', 'ABCD2345'],
      ['/start ABCD2345', 'ABCD2345'],
      ['/start ABCD-2345', 'ABCD2345'],
      ['/start@ReceiptBot abcd-2345', 'ABCD2345'],
    ])('reads %j', (text, expected) => {
      expect(extractLinkCode(text)).toBe(expected);
    });

    it.each([
      ['/start'],
      ['hello'],
      ['Thailand'], // 8 letters, but contains I and would-be-a-code otherwise
      ['please add this receipt'],
      ['ABCD-2345 thanks'],
      [''],
    ])('ignores ordinary text %j', (text) => {
      expect(extractLinkCode(text)).toBeNull();
    });

    it('handles missing input', () => {
      expect(extractLinkCode(undefined)).toBeNull();
      expect(extractLinkCode(null)).toBeNull();
    });
  });
});
