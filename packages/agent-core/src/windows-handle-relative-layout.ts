const FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
const DIRECTORY_ENTRY_HEADER_BYTES = 104;
const DIRECTORY_ENTRY_ALIGNMENT = 8;
const MAX_WINDOWS_LEAF_UTF16_BYTES = 510;
const OBJ_CASE_INSENSITIVE = 0x0000_0040;

export interface WindowsHandleDirectoryEntryV1 {
  readonly name: string;
  readonly fileType: 'file' | 'directory';
  readonly reparsePoint: boolean;
  readonly size: bigint;
  readonly fileId: string;
  readonly attributes: number;
}

export class WindowsHandleRelativeLayoutError extends Error {
  constructor(
    readonly reasonCode:
      | 'windows_handle_layout_invalid_directory_buffer'
      | 'windows_handle_layout_invalid_leaf'
      | 'windows_handle_layout_invalid_pointer',
    message: string,
  ) {
    super(message);
    this.name = 'WindowsHandleRelativeLayoutError';
  }
}

/**
 * Parses FILE_ID_BOTH_DIR_INFO records returned by
 * GetFileInformationByHandleEx(FileIdBothDirectory*Info).
 *
 * Windows aligns every record to 8 bytes and terminates the list with a zero
 * NextEntryOffset. FileNameLength is authoritative; no NUL terminator is
 * required.
 */
export function parseWindowsHandleDirectoryEntries(
  buffer: Buffer,
): readonly WindowsHandleDirectoryEntryV1[] {
  if (!Buffer.isBuffer(buffer)
    || buffer.byteLength < DIRECTORY_ENTRY_HEADER_BYTES) {
    return invalidDirectoryBuffer();
  }
  const entries: WindowsHandleDirectoryEntryV1[] = [];
  const visited = new Set<number>();
  let offset = 0;
  while (true) {
    if (visited.has(offset)
      || offset < 0
      || offset + DIRECTORY_ENTRY_HEADER_BYTES > buffer.byteLength) {
      return invalidDirectoryBuffer();
    }
    visited.add(offset);
    const next = buffer.readUInt32LE(offset);
    const size = buffer.readBigInt64LE(offset + 40);
    const attributes = buffer.readUInt32LE(offset + 56);
    const fileNameLength = buffer.readUInt32LE(offset + 60);
    if (size < 0n
      || fileNameLength === 0
      || fileNameLength % 2 !== 0
      || fileNameLength > MAX_WINDOWS_LEAF_UTF16_BYTES
      || offset + DIRECTORY_ENTRY_HEADER_BYTES + fileNameLength
        > buffer.byteLength) {
      return invalidDirectoryBuffer();
    }
    const name = buffer.toString(
      'utf16le',
      offset + DIRECTORY_ENTRY_HEADER_BYTES,
      offset + DIRECTORY_ENTRY_HEADER_BYTES + fileNameLength,
    );
    if (!isSafeEnumeratedLeaf(name)) {
      return invalidDirectoryBuffer();
    }
    if (name !== '.' && name !== '..') {
      entries.push(Object.freeze({
        name,
        fileType: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0
          ? 'directory'
          : 'file',
        reparsePoint:
          (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
        size,
        fileId: buffer.subarray(offset + 96, offset + 104)
          .toString('hex'),
        attributes,
      }));
    }
    if (next === 0) return Object.freeze(entries);
    if (next < DIRECTORY_ENTRY_HEADER_BYTES
      || next % DIRECTORY_ENTRY_ALIGNMENT !== 0
      || offset + next <= offset
      || offset + next > buffer.byteLength) {
      return invalidDirectoryBuffer();
    }
    offset += next;
  }
}

/**
 * Builds the variable-length FILE_RENAME_INFO buffer used with
 * SetFileInformationByHandle(FileRenameInfo).
 *
 * replace=false is the only safe default for Candidate/Target transactions;
 * a caller must never use this helper as an unconditional clobber primitive.
 */
export function buildWindowsHandleRelativeRenameInfo(
  rootHandleAddress: bigint,
  destinationLeaf: string,
  options: {
    readonly replace: false;
    readonly pointerBytes?: 4 | 8;
  },
): Buffer {
  return buildRenameInfo(
    rootHandleAddress,
    destinationLeaf,
    false,
    options.pointerBytes,
  );
}

/**
 * Candidate worktrees have one fenced Writer and may atomically replace their
 * own leaf after an exact handle identity check. Keep this clobber-capable
 * layout separate from the no-replace Target helper so Target code cannot opt
 * into replacement accidentally.
 */
export function buildWindowsCandidateHandleRelativeReplaceInfo(
  rootHandleAddress: bigint,
  destinationLeaf: string,
  options?: {
    readonly pointerBytes?: 4 | 8;
  },
): Buffer {
  return buildRenameInfo(
    rootHandleAddress,
    destinationLeaf,
    true,
    options?.pointerBytes,
  );
}

/**
 * Builds the native UNICODE_STRING header for a separately retained UTF-16LE
 * leaf buffer. The caller must keep `terminatedName` alive until NtCreateFile
 * returns.
 */
export function buildWindowsUnicodeStringLayout(
  terminatedName: Buffer,
  nameBufferAddress: bigint,
  options?: {
    readonly pointerBytes?: 4 | 8;
  },
): Buffer {
  const pointerBytes = options?.pointerBytes
    ?? (process.arch === 'ia32' ? 4 : 8);
  if (!Buffer.isBuffer(terminatedName)
    || terminatedName.byteLength < 4
    || terminatedName.byteLength > MAX_WINDOWS_LEAF_UTF16_BYTES + 2
    || terminatedName.byteLength % 2 !== 0
    || terminatedName.readUInt16LE(terminatedName.byteLength - 2) !== 0
    || containsUtf16Nul(terminatedName, terminatedName.byteLength - 2)) {
    throw new WindowsHandleRelativeLayoutError(
      'windows_handle_layout_invalid_leaf',
      'The Windows UNICODE_STRING leaf buffer is invalid.',
    );
  }
  assertPointerFits(nameBufferAddress, pointerBytes);
  const output = Buffer.alloc(pointerBytes === 8 ? 16 : 8);
  output.writeUInt16LE(terminatedName.byteLength - 2, 0);
  output.writeUInt16LE(terminatedName.byteLength, 2);
  writePointer(output, pointerBytes === 8 ? 8 : 4, nameBufferAddress, pointerBytes);
  return output;
}

function containsUtf16Nul(
  value: Buffer,
  endOffset: number,
): boolean {
  for (let offset = 0; offset < endOffset; offset += 2) {
    if (value.readUInt16LE(offset) === 0) return true;
  }
  return false;
}

/**
 * Builds OBJECT_ATTRIBUTES for a case-insensitive name relative to an already
 * verified directory handle. SecurityDescriptor and QoS remain null.
 */
export function buildWindowsObjectAttributesLayout(
  rootHandleAddress: bigint,
  unicodeStringAddress: bigint,
  options?: {
    readonly pointerBytes?: 4 | 8;
  },
): Buffer {
  const pointerBytes = options?.pointerBytes
    ?? (process.arch === 'ia32' ? 4 : 8);
  assertPointerFits(rootHandleAddress, pointerBytes);
  assertPointerFits(unicodeStringAddress, pointerBytes);
  const output = Buffer.alloc(pointerBytes === 8 ? 48 : 24);
  const rootOffset = pointerBytes === 8 ? 8 : 4;
  const objectNameOffset = pointerBytes === 8 ? 16 : 8;
  const attributesOffset = pointerBytes === 8 ? 24 : 12;
  output.writeUInt32LE(output.byteLength, 0);
  writePointer(output, rootOffset, rootHandleAddress, pointerBytes);
  writePointer(
    output,
    objectNameOffset,
    unicodeStringAddress,
    pointerBytes,
  );
  output.writeUInt32LE(OBJ_CASE_INSENSITIVE, attributesOffset);
  return output;
}

function buildRenameInfo(
  rootHandleAddress: bigint,
  destinationLeaf: string,
  replace: boolean,
  requestedPointerBytes: 4 | 8 | undefined,
): Buffer {
  if (typeof rootHandleAddress !== 'bigint'
    || rootHandleAddress <= 0n) {
    throw new WindowsHandleRelativeLayoutError(
      'windows_handle_layout_invalid_pointer',
      'A non-null Windows root handle address is required.',
    );
  }
  if (!isSafeMutationLeaf(destinationLeaf)) {
    throw new WindowsHandleRelativeLayoutError(
      'windows_handle_layout_invalid_leaf',
      'The Windows handle-relative rename leaf is unsafe.',
    );
  }
  const pointerBytes = requestedPointerBytes
    ?? (process.arch === 'ia32' ? 4 : 8);
  const name = Buffer.from(destinationLeaf, 'utf16le');
  if (name.byteLength === 0
    || name.byteLength > MAX_WINDOWS_LEAF_UTF16_BYTES) {
    throw new WindowsHandleRelativeLayoutError(
      'windows_handle_layout_invalid_leaf',
      'The Windows handle-relative rename leaf is oversized.',
    );
  }
  const rootOffset = pointerBytes === 8 ? 8 : 4;
  const lengthOffset = rootOffset + pointerBytes;
  const nameOffset = lengthOffset + 4;
  const output = Buffer.alloc(nameOffset + name.byteLength);
  output.writeUInt8(replace ? 1 : 0, 0);
  if (pointerBytes === 8) {
    if (rootHandleAddress > 0xffff_ffff_ffff_ffffn) {
      throw new WindowsHandleRelativeLayoutError(
        'windows_handle_layout_invalid_pointer',
        'The Windows root handle exceeds pointer width.',
      );
    }
    output.writeBigUInt64LE(rootHandleAddress, rootOffset);
  } else {
    if (rootHandleAddress > 0xffff_ffffn) {
      throw new WindowsHandleRelativeLayoutError(
        'windows_handle_layout_invalid_pointer',
        'The Windows root handle exceeds pointer width.',
      );
    }
    output.writeUInt32LE(Number(rootHandleAddress), rootOffset);
  }
  output.writeUInt32LE(name.byteLength, lengthOffset);
  name.copy(output, nameOffset);
  return output;
}

function assertPointerFits(
  address: bigint,
  pointerBytes: 4 | 8,
): void {
  const maximum = pointerBytes === 8
    ? 0xffff_ffff_ffff_ffffn
    : 0xffff_ffffn;
  if (typeof address !== 'bigint'
    || address <= 0n
    || address > maximum) {
    throw new WindowsHandleRelativeLayoutError(
      'windows_handle_layout_invalid_pointer',
      'The Windows native pointer is null or exceeds pointer width.',
    );
  }
}

function writePointer(
  output: Buffer,
  offset: number,
  address: bigint,
  pointerBytes: 4 | 8,
): void {
  if (pointerBytes === 8) {
    output.writeBigUInt64LE(address, offset);
  } else {
    output.writeUInt32LE(Number(address), offset);
  }
}

function isSafeEnumeratedLeaf(value: string): boolean {
  return value.length > 0
    && !/[\u0000/\\]/u.test(value);
}

function isSafeMutationLeaf(value: string): boolean {
  return isSafeEnumeratedLeaf(value)
    && value !== '.'
    && value !== '..'
    && !/[\u0001-\u001F<>:"|?*]/u.test(value)
    && !value.endsWith('.')
    && !value.endsWith(' ')
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
      .test(value);
}

function invalidDirectoryBuffer(): never {
  throw new WindowsHandleRelativeLayoutError(
    'windows_handle_layout_invalid_directory_buffer',
    'The Windows directory enumeration buffer is malformed.',
  );
}
