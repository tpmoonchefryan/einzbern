// SPDX-License-Identifier: Apache-2.0
// Executed by the system JXA host, never imported by Node. Descriptors are
// opened without following links and bound to the reader's held descriptors by
// exact device/file identity. No source data or caller output FD is inherited.
ObjC.import("Foundation");
ObjC.bindFunction("open", ["int", ["char *", "int"]]);
ObjC.bindFunction("close", ["int", ["int"]]);
ObjC.bindFunction("getattrlist", ["int", ["char *", "void *", "void *", "unsigned long", "unsigned long"]]);
ObjC.bindFunction("fgetattrlist", ["int", ["int", "void *", "void *", "unsigned long", "unsigned long"]]);
ObjC.bindFunction("sysctlbyname", ["int", ["char *", "void *", "void *", "void *", "unsigned long"]]);
ObjC.bindFunction("setiopolicy_np", ["int", ["int", "int", "int"]]);
const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES = 3;
const IOPOL_SCOPE_PROCESS = 0;
const IOPOL_MATERIALIZE_DATALESS_FILES_OFF = 1;

function attributes(target, encoded, byPath) {
  var list = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0);
  var bytes = $.NSMutableData.dataWithLength(8192);
  var result = byPath
    ? $.getattrlist(target, list.bytes, bytes.mutableBytes, bytes.length, 32)
    : $.fgetattrlist(target, list.bytes, bytes.mutableBytes, bytes.length, 32);
  // Both getattrlist variants store the actual packed extent in the first
  // uint32. Encode only that validated range, without fixed-buffer padding.
  if (result !== 0) return { result: result, bytes: null };
  var header = ObjC.unwrap(bytes.subdataWithRange($.NSMakeRange(0, 4)).base64EncodedStringWithOptions(0));
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var returnedLength = 0, packed = 0, bits = 0, offset = 0;
  for (var i = 0; i < header.length && header[i] !== "="; i++) {
    packed = (packed << 6) | alphabet.indexOf(header[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      returnedLength += ((packed >>> bits) & 255) * Math.pow(256, offset++);
    }
  }
  if (offset !== 4 || returnedLength < 24 || returnedLength > bytes.length) return { result: result, bytes: null };
  return { result: result, bytes: ObjC.unwrap(bytes.subdataWithRange($.NSMakeRange(0, returnedLength)).base64EncodedStringWithOptions(0)) };
}

function run(arguments_) {
  var request = JSON.parse(arguments_[0]);
  // Apple documents that path metadata calls can materialize dataless
  // intermediate folders. Keep this short-lived process from doing so; an
  // EDEADLK or unsupported policy setting yields an unavailable result.
  var ioPolicyResult = $.setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_OFF);
  if (ioPolicyResult !== 0) {
    return JSON.stringify({ schemaVersion: "einzbern.darwin-source-identity.v1", preflight: request.preflight === true, ioPolicyResult: ioPolicyResult, files: [] });
  }
  if (request.preflight === true) {
    return JSON.stringify({
      schemaVersion: "einzbern.darwin-source-identity.v1",
      preflight: true,
      ioPolicyResult: ioPolicyResult,
      files: request.files.map(function (file) {
        // getattrlist reads SF_DATALESS before either Node or JXA opens data.
        return { file: attributes(file.path, request.fileAttributes, true) };
      }),
    });
  }
  var boot = $.NSMutableData.dataWithLength(128);
  var length = $.NSMutableData.alloc.initWithBase64EncodedStringOptions("gAAAAAAAAAA=", 0);
  var bootResult = $.sysctlbyname("kern.bootsessionuuid", boot.mutableBytes, length.mutableBytes, null, 0);
  var records = request.files.map(function (file) {
    // Darwin O_NOFOLLOW | O_NONBLOCK, with O_RDONLY (zero). The Node reader
    // retains its original FD throughout both probes and checks this identity
    // against it, so a different named object never authorizes its bytes.
    var descriptor = $.open(file.path, 0x0104);
    if (descriptor < 0) return { file: { result: descriptor, bytes: null }, volume: { result: descriptor, bytes: null }, resources: {}, resourceError: "open unavailable" };
    try {
      var url = $.NSURL.fileURLWithPath(file.path);
      url.removeAllCachedResourceValues;
      var error = Ref();
      var values = url.resourceValuesForKeysError($([
        $.NSURLIsUbiquitousItemKey,
        $.NSURLUbiquitousItemIsDownloadingKey,
        $.NSURLUbiquitousItemDownloadingStatusKey,
        $.NSURLUbiquitousItemDownloadingErrorKey,
        $.NSURLFileResourceIdentifierKey,
      ]), error);
      var resources = {};
      if (values) {
        resources = ObjC.deepUnwrap(values);
        var identity = values.objectForKey($.NSURLFileResourceIdentifierKey);
        resources.NSURLFileResourceIdentifierKey = ObjC.unwrap(identity.description) || null;
        var downloadError = values.objectForKey($.NSURLUbiquitousItemDownloadingErrorKey);
        resources.NSURLUbiquitousItemDownloadingErrorKey = ObjC.unwrap(downloadError.description) || null;
      }
      return {
        file: attributes(descriptor, request.fileAttributes, false),
        volume: attributes(descriptor, request.volumeAttributes, false),
        resources: resources,
        resourceError: ObjC.unwrap(error[0].description) || null,
      };
    } finally {
      if (descriptor >= 0) $.close(descriptor);
    }
  });
  return JSON.stringify({
    schemaVersion: "einzbern.darwin-source-identity.v1",
    bootResult: bootResult,
    boot: ObjC.unwrap(boot.base64EncodedStringWithOptions(0)),
    files: records,
  });
}
