#!/bin/sh
# opencode-resolve.sh — read-only probe of OpenCode Desktop's serve endpoint.
#
# Resolves the Desktop's CURRENT loopback serve port + basic-auth credentials
# over SSH (read-only OS queries; Desktop never notices) and prints three
# `NAME=value` lines for the caller to parse:
#   PORT=<remote loopback port>
#   USERNAME=<serve username>
#   PASSWORD=<serve password>
#
# Env (required): OPENCODE_SSH_TARGET (e.g. user@winpc-lan).
#
# Used by opencode-tunnel.sh (one-shot) and opencode-keeper.sh (persistent).
# Real connection values live in the operator's environment, never in this
# repo (public-fork hygiene: no machine names, LAN IPs, or SSH usernames).
#
# NOTE: never run this script with `sh -x` / `set -x` — stdout carries the
# ephemeral serve password.

set -u

TARGET="${OPENCODE_SSH_TARGET:?set OPENCODE_SSH_TARGET=user@winpc-lan (see header)}"

# The PowerShell below walks the sidecar's PEB to read its own environment
# block (PROCESS_QUERY_INFORMATION | PROCESS_VM_READ — purely observational)
# and matches OpenCode-owned loopback listeners to PIDs. Output is three
# `NAME=value` lines; CRs stripped because PowerShell emits CRLF.
PROBE_OUT="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" \
  "powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<'PS_EOF' | tr -d '\r'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;public class E{[DllImport("kernel32.dll",EntryPoint="OpenProcess")]public static extern IntPtr O(int a,bool b,int c);[DllImport("kernel32.dll",EntryPoint="CloseHandle")]public static extern bool C(IntPtr h);[DllImport("ntdll.dll",EntryPoint="NtQueryInformationProcess")]public static extern int N(IntPtr h,int cl,byte[] pi,int l,ref int r);[DllImport("kernel32.dll",EntryPoint="ReadProcessMemory")]public static extern bool R(IntPtr h,IntPtr a,byte[] b,int s,ref int r);static long P(IntPtr h,long a){byte[] b=new byte[8];int r=0;return R(h,(IntPtr)a,b,8,ref r)?BitConverter.ToInt64(b,0):0;}public static string G(int pid){IntPtr h=O(0x410,false,pid);if(h==IntPtr.Zero)return "OPENFAIL";try{byte[] q=new byte[48];int l=0;if(N(h,0,q,q.Length,ref l)!=0)return "QUERYFAIL";long pb=BitConverter.ToInt64(q,8);long pp=P(h,pb+0x20);if(pp==0)return "NOPEB";long e=P(h,pp+0x80);if(e==0)return "NOENV";StringBuilder s=new StringBuilder();byte[] c=new byte[4096];for(int i=0;i<16;i++){int r=0;if(!R(h,(IntPtr)(e+i*4096),c,4096,ref r))break;s.Append(Encoding.Unicode.GetString(c,0,r));if(s.ToString().Contains((char)0+""+(char)0))break;}return s.ToString();}finally{C(h);}}}';
$ocs=(Get-Process -Name OpenCode -ErrorAction SilentlyContinue).Id;
$conns=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$ocs -contains $_.OwningProcess -and $_.LocalAddress -eq '127.0.0.1'};
foreach($x in $conns){$raw=[E]::G($x.OwningProcess);$w="";$u="";if($raw -match "OPENCODE_SERVER_PASSWORD=([^`0]*)"){$w=$Matches[1]};if($raw -match "OPENCODE_SERVER_USERNAME=([^`0]*)"){$u=$Matches[1]};if($w.Length -gt 0){Write-Output ("PORT=" + $x.LocalPort);Write-Output ("USERNAME=" + $u);Write-Output ("PASSWORD=" + $w)}}
PS_EOF
)"
if [ -z "$PROBE_OUT" ]; then
  echo "opencode-resolve: serve probe returned nothing — is OpenCode Desktop running on $TARGET?" >&2
  exit 1
fi

REMOTE_PORT=""
SERVE_USER=""
SERVE_PASS=""
while IFS= read -r line; do
  case "$line" in
    PORT=*) REMOTE_PORT="${line#PORT=}" ;;
    USERNAME=*) SERVE_USER="${line#USERNAME=}" ;;
    PASSWORD=*) SERVE_PASS="${line#PASSWORD=}" ;;
  esac
done <<EOF
$PROBE_OUT
EOF

case "$REMOTE_PORT" in
  '' | *[!0-9]*) echo "opencode-resolve: no serve port resolved (Desktop restarted? retry)" >&2; exit 1 ;;
esac
if [ -z "$SERVE_PASS" ]; then
  echo "opencode-resolve: serve password not found in sidecar env" >&2
  exit 1
fi

printf 'PORT=%s\nUSERNAME=%s\nPASSWORD=%s\n' "$REMOTE_PORT" "$SERVE_USER" "$SERVE_PASS"
