import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

// Keep the file in place. The kernel releases ownership after a crash on every platform.
export async function lockDataDirectory(dataDir: string) {
  const { dlopen, FFIType } = await import("bun:ffi");
  const path = join(dataDir, "instance.lock");
  const occupied = `The data directory is already in use by another Tofu instance : ${dataDir}`;
  if (process.platform === "win32") {
    const library = dlopen("kernel32.dll", {
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.u64,
        ],
        returns: FFIType.u64,
      },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    // A non-shared handle excludes all other instances. OPEN_ALWAYS preserves existing bytes.
    const filename = Buffer.from(`${path}\0`, "utf16le");
    const handle = library.symbols.CreateFileW(filename, 0xc0_00_00_00, 0, null, 4, 0x80, 0n);
    if (BigInt(handle) === 0xffffffffffffffffn) {
      const code = library.symbols.GetLastError();
      library.close();
      throw new Error(
        code === 32 || code === 33
          ? occupied
          : `Unable to lock the data directory (Windows error ${code}): ${dataDir}`
      );
    }
    return {
      close() {
        library.symbols.CloseHandle(handle);
        library.close();
      },
    };
  }
  const library = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  let fd: number;
  try {
    fd = openSync(path, "a+", 0o600);
  } catch (error) {
    library.close();
    throw error;
  }
  if (library.symbols.flock(fd, 6) !== 0) {
    // LOCK_EX (2) | LOCK_NB (4).
    closeSync(fd);
    library.close();
    throw new Error(occupied);
  }
  return {
    close() {
      closeSync(fd);
      library.close();
    },
  };
}
