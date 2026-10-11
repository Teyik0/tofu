import type { Pointer } from "bun:ffi";
import type { InstanceProfile, TorrentDefaults } from "../../../types";
import { UserError } from "../../lib/errors";

export function readTorrentDefaults() {
  return torrentDefaults(null);
}

export async function setDefaultTorrentApp(profile: InstanceProfile) {
  if (profile !== "release") {
    throw new UserError("Use the installed release of Tofu to change default applications", {
      status: 409,
    });
  }
  return await torrentDefaults("app.tofu.torrents");
}

async function torrentDefaults(identifier: string | null): Promise<TorrentDefaults> {
  if (process.platform !== "darwin") {
    throw new UserError("Default torrent associations are currently supported on macOS", {
      status: 409,
    });
  }
  const { dlopen, FFIType } = await import("bun:ffi");
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CFStringCreateWithCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.ptr,
    },
    CFStringGetCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32],
      returns: FFIType.bool,
    },
  });
  const references: (Pointer | bigint)[] = [];
  const services = dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", {
    LSCopyDefaultHandlerForURLScheme: { args: [FFIType.ptr], returns: FFIType.ptr },
    LSCopyDefaultRoleHandlerForContentType: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.ptr,
    },
    LSSetDefaultHandlerForURLScheme: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    LSSetDefaultRoleHandlerForContentType: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    UTTypeCreatePreferredIdentifierForTag: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
  });
  const utf8 = 0x08_00_01_00;
  const viewer = 2;
  const keep = (reference: Pointer | bigint | null) => {
    if (!reference) {
      throw new Error("macOS could not resolve the torrent file type");
    }
    references.push(reference);
    return reference;
  };
  const string = (value: string) =>
    keep(cf.symbols.CFStringCreateWithCString(null, Buffer.from(`${value}\0`), utf8));
  const read = (reference: Pointer | bigint | null) => {
    if (!reference) {
      return null;
    }
    keep(reference);
    const buffer = Buffer.alloc(4096);
    if (!cf.symbols.CFStringGetCString(reference, buffer, buffer.length, utf8)) {
      throw new Error("macOS could not read the default torrent application");
    }
    return buffer.subarray(0, buffer.indexOf(0)).toString("utf8");
  };
  try {
    const magnet = string("magnet");
    const torrent = keep(
      services.symbols.UTTypeCreatePreferredIdentifierForTag(
        string("public.filename-extension"),
        string("torrent"),
        null
      )
    );
    if (identifier) {
      const bundle = string(identifier);
      const fileStatus = services.symbols.LSSetDefaultRoleHandlerForContentType(
        torrent,
        viewer,
        bundle
      );
      if (fileStatus !== 0) {
        throw new Error(
          `macOS could not set Tofu as the default for .torrent files (error ${fileStatus}). Move Tofu to Applications and try again.`
        );
      }
      const magnetStatus = services.symbols.LSSetDefaultHandlerForURLScheme(magnet, bundle);
      if (magnetStatus !== 0) {
        throw new Error(
          `Tofu is the default for .torrent files, but macOS could not associate magnet links (error ${magnetStatus}).`
        );
      }
    }
    const defaults = {
      magnet: read(services.symbols.LSCopyDefaultHandlerForURLScheme(magnet)),
      torrent: read(services.symbols.LSCopyDefaultRoleHandlerForContentType(torrent, viewer)),
    };
    if (identifier && (defaults.magnet !== identifier || defaults.torrent !== identifier)) {
      throw new Error(
        "macOS did not confirm both torrent associations. Move Tofu to Applications and try again."
      );
    }
    return defaults;
  } finally {
    for (const reference of references) {
      cf.symbols.CFRelease(reference);
    }
    services.close();
    cf.close();
  }
}
