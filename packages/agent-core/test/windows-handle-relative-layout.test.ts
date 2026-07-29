import { describe, expect, it } from 'vitest';

import {
  buildWindowsCandidateHandleRelativeReplaceInfo,
  buildWindowsHandleRelativeRenameInfo,
  buildWindowsObjectAttributesLayout,
  buildWindowsUnicodeStringLayout,
  parseWindowsHandleDirectoryEntries,
} from '../src/windows-handle-relative-layout';

describe('Windows handle-relative native layouts', () => {
  it('parses aligned FILE_ID_BOTH_DIR_INFO records without NUL names', () => {
    const first = directoryEntry({
      name: 'src',
      attributes: 0x10,
      size: 0n,
      fileId: 0x0102_0304_0506_0708n,
      nextOffset: 112,
      totalBytes: 112,
    });
    const second = directoryEntry({
      name: 'index.ts',
      attributes: 0x80,
      size: 42n,
      fileId: 0x1112_1314_1516_1718n,
      nextOffset: 0,
      totalBytes: 120,
    });

    expect(parseWindowsHandleDirectoryEntries(
      Buffer.concat([first, second]),
    )).toEqual([
      {
        name: 'src',
        fileType: 'directory',
        reparsePoint: false,
        size: 0n,
        fileId: '0807060504030201',
        attributes: 0x10,
      },
      {
        name: 'index.ts',
        fileType: 'file',
        reparsePoint: false,
        size: 42n,
        fileId: '1817161514131211',
        attributes: 0x80,
      },
    ]);
  });

  it('reports reparse-point metadata for fail-closed traversal', () => {
    const entry = directoryEntry({
      name: 'linked',
      attributes: 0x10 | 0x400,
      size: 0n,
      fileId: 1n,
      nextOffset: 0,
      totalBytes: 120,
    });

    expect(parseWindowsHandleDirectoryEntries(entry))
      .toMatchObject([{
        name: 'linked',
        fileType: 'directory',
        reparsePoint: true,
      }]);
  });

  it('skips the directory self and parent records', () => {
    const self = directoryEntry({
      name: '.',
      attributes: 0x10,
      size: 0n,
      fileId: 1n,
      nextOffset: 112,
      totalBytes: 112,
    });
    const parent = directoryEntry({
      name: '..',
      attributes: 0x10,
      size: 0n,
      fileId: 2n,
      nextOffset: 0,
      totalBytes: 112,
    });

    expect(parseWindowsHandleDirectoryEntries(
      Buffer.concat([self, parent]),
    )).toEqual([]);
  });

  it.each([
    ['truncated header', Buffer.alloc(103)],
    ['odd UTF-16 length', directoryEntry({
      name: 'a',
      attributes: 0x80,
      size: 0n,
      fileId: 1n,
      nextOffset: 0,
      totalBytes: 112,
      overrideNameLength: 1,
    })],
    ['misaligned next offset', directoryEntry({
      name: 'a',
      attributes: 0x80,
      size: 0n,
      fileId: 1n,
      nextOffset: 105,
      totalBytes: 112,
    })],
    ['separator name', directoryEntry({
      name: 'a/b',
      attributes: 0x80,
      size: 0n,
      fileId: 1n,
      nextOffset: 0,
      totalBytes: 120,
    })],
  ])('rejects a malformed %s directory buffer', (_name, buffer) => {
    expect(() => parseWindowsHandleDirectoryEntries(buffer))
      .toThrow(/malformed/u);
  });

  it('builds an x64 FILE_RENAME_INFO with a relative root handle', () => {
    const output = buildWindowsHandleRelativeRenameInfo(
      0x0102_0304_0506_0708n,
      'target.txt',
      { replace: false, pointerBytes: 8 },
    );

    expect(output.readUInt8(0)).toBe(0);
    expect(output.readBigUInt64LE(8))
      .toBe(0x0102_0304_0506_0708n);
    expect(output.readUInt32LE(16)).toBe(20);
    expect(output.toString('utf16le', 20)).toBe('target.txt');
  });

  it('builds an x86 FILE_RENAME_INFO without alignment ambiguity', () => {
    const output = buildWindowsHandleRelativeRenameInfo(
      0x0102_0304n,
      'a.txt',
      { replace: false, pointerBytes: 4 },
    );

    expect(output.readUInt32LE(4)).toBe(0x0102_0304);
    expect(output.readUInt32LE(8)).toBe(10);
    expect(output.toString('utf16le', 12)).toBe('a.txt');
  });

  it('isolates Candidate replace layout from the Target no-replace helper', () => {
    const target = buildWindowsHandleRelativeRenameInfo(
      1n,
      'target.txt',
      { replace: false, pointerBytes: 8 },
    );
    const candidate = buildWindowsCandidateHandleRelativeReplaceInfo(
      1n,
      'target.txt',
      { pointerBytes: 8 },
    );

    expect(target.readUInt8(0)).toBe(0);
    expect(candidate.readUInt8(0)).toBe(1);
    expect(candidate.subarray(1)).toEqual(target.subarray(1));
  });

  it('builds x64 UNICODE_STRING and OBJECT_ATTRIBUTES layouts', () => {
    const name = Buffer.from('leaf.txt\0', 'utf16le');
    const unicode = buildWindowsUnicodeStringLayout(
      name,
      0x1112_1314_1516_1718n,
      { pointerBytes: 8 },
    );
    const attributes = buildWindowsObjectAttributesLayout(
      0x0102_0304_0506_0708n,
      0x2122_2324_2526_2728n,
      { pointerBytes: 8 },
    );

    expect(unicode.byteLength).toBe(16);
    expect(unicode.readUInt16LE(0)).toBe(name.byteLength - 2);
    expect(unicode.readUInt16LE(2)).toBe(name.byteLength);
    expect(unicode.readBigUInt64LE(8))
      .toBe(0x1112_1314_1516_1718n);
    expect(attributes.byteLength).toBe(48);
    expect(attributes.readUInt32LE(0)).toBe(48);
    expect(attributes.readBigUInt64LE(8))
      .toBe(0x0102_0304_0506_0708n);
    expect(attributes.readBigUInt64LE(16))
      .toBe(0x2122_2324_2526_2728n);
    expect(attributes.readUInt32LE(24)).toBe(0x40);
    expect(attributes.subarray(28)).toEqual(Buffer.alloc(20));
  });

  it('builds x86 UNICODE_STRING and OBJECT_ATTRIBUTES layouts', () => {
    const name = Buffer.from('a\0', 'utf16le');
    const unicode = buildWindowsUnicodeStringLayout(
      name,
      0x0102_0304n,
      { pointerBytes: 4 },
    );
    const attributes = buildWindowsObjectAttributesLayout(
      0x1112_1314n,
      0x2122_2324n,
      { pointerBytes: 4 },
    );

    expect(unicode.byteLength).toBe(8);
    expect(unicode.readUInt16LE(0)).toBe(2);
    expect(unicode.readUInt16LE(2)).toBe(4);
    expect(unicode.readUInt32LE(4)).toBe(0x0102_0304);
    expect(attributes.byteLength).toBe(24);
    expect(attributes.readUInt32LE(0)).toBe(24);
    expect(attributes.readUInt32LE(4)).toBe(0x1112_1314);
    expect(attributes.readUInt32LE(8)).toBe(0x2122_2324);
    expect(attributes.readUInt32LE(12)).toBe(0x40);
    expect(attributes.subarray(16)).toEqual(Buffer.alloc(8));
  });

  it('accepts UTF-16 code units whose byte boundary contains zero pairs', () => {
    const name = Buffer.from('a\u0100\0', 'utf16le');
    const unicode = buildWindowsUnicodeStringLayout(
      name,
      0x0102_0304_0506_0708n,
      { pointerBytes: 8 },
    );

    expect(unicode.readUInt16LE(0)).toBe(name.byteLength - 2);
    expect(unicode.readUInt16LE(2)).toBe(name.byteLength);
  });

  it.each([
    ['unterminated name', Buffer.from('a', 'utf16le'), 1n],
    ['embedded NUL', Buffer.from('a\0b\0', 'utf16le'), 1n],
    ['null pointer', Buffer.from('a\0', 'utf16le'), 0n],
    [
      'x86 pointer overflow',
      Buffer.from('a\0', 'utf16le'),
      0x1_0000_0000n,
    ],
  ])('rejects an invalid %s UNICODE_STRING layout', (
    _name,
    value,
    address,
  ) => {
    expect(() => buildWindowsUnicodeStringLayout(
      value,
      address,
      { pointerBytes: 4 },
    )).toThrow(/invalid|null|pointer/u);
  });

  it.each([
    '',
    '.',
    '..',
    'a/b',
    'a\\b',
    'stream:name',
    'CON',
    'tail.',
    'tail ',
  ])('rejects unsafe rename leaf %j', (leaf) => {
    expect(() => buildWindowsHandleRelativeRenameInfo(
      1n,
      leaf,
      { replace: false, pointerBytes: 8 },
    )).toThrow(/unsafe|oversized/u);
  });
});

function directoryEntry(input: {
  readonly name: string;
  readonly attributes: number;
  readonly size: bigint;
  readonly fileId: bigint;
  readonly nextOffset: number;
  readonly totalBytes: number;
  readonly overrideNameLength?: number;
}): Buffer {
  const output = Buffer.alloc(input.totalBytes);
  const name = Buffer.from(input.name, 'utf16le');
  output.writeUInt32LE(input.nextOffset, 0);
  output.writeBigInt64LE(input.size, 40);
  output.writeUInt32LE(input.attributes, 56);
  output.writeUInt32LE(
    input.overrideNameLength ?? name.byteLength,
    60,
  );
  output.writeBigUInt64LE(input.fileId, 96);
  name.copy(output, 104);
  return output;
}
