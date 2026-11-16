// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { isAbsolute, join, toNamespacedPath } from "node:path";

export function queryWindows(script) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // A PowerShell 7 parent can export module paths incompatible with Windows PowerShell.
  const command = `$ErrorActionPreference = 'Stop'; $env:PSModulePath = Join-Path $PSHOME 'Modules'; ${script}`;
  return JSON.parse(execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }));
}

export function hasPrivateWindowsPermissions(path) {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  try {
    return queryWindows(`
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
$acl = Get-Acl -LiteralPath $path;
$trusted = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544');
$safe = $trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
$write = [Security.AccessControl.FileSystemRights]'Write,DeleteSubdirectoriesAndFiles,Delete,ChangePermissions,TakeOwnership';
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value) { $safe = $false; }
}
ConvertTo-Json -Compress -InputObject $safe`) === true;
  } catch { return false; }
}

/** Atomically create an exclusive directory with its private DACL already in place. */
export function createPrivateWindowsDirectory(path) {
  const encodedPath = Buffer.from(toNamespacedPath(path), "utf8").toString("base64");
  return queryWindows(`
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl = [Security.AccessControl.DirectorySecurity]::new();
$acl.SetOwner($owner);
$acl.SetAccessRuleProtection($true, $false);
foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'));
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EinzbernPrivateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Length;
    public IntPtr Descriptor;
    public int InheritHandle;
  }
  [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateDirectory(string path, ref SecurityAttributes attributes);
  public static int Create(string path, byte[] descriptor) {
    IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
    try {
      Marshal.Copy(descriptor, 0, memory, descriptor.Length);
      var attributes = new SecurityAttributes {
        Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = memory, InheritHandle = 0
      };
      return CreateDirectory(path, ref attributes) ? 0 : Marshal.GetLastWin32Error();
    } finally { Marshal.FreeHGlobal(memory); }
  }
}
'@;
$errorCode = [EinzbernPrivateDirectory]::Create($path, $acl.GetSecurityDescriptorBinaryForm());
if ($errorCode -ne 0 -and $errorCode -ne 183) { throw [ComponentModel.Win32Exception]::new($errorCode); }
ConvertTo-Json -InputObject ($errorCode -eq 0)`);
}
