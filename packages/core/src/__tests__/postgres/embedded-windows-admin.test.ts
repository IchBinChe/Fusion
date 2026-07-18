import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDED_POSTGRES_FLAGS } from "../../postgres/embedded-lifecycle.js";
import {
  buildNonAdminLauncherPs1,
  sanitizePostgresFlags,
} from "../../postgres/embedded-windows-admin.js";

/*
 * FNXC:PostgresEmbedded 2026-07-16-12:45:
 * The constrained-host shared-memory default must retain its exact `-c` form
 * through the Windows cmd.exe launcher sanitizer. This is pure validation
 * coverage; it does not require an elevated process or a Windows binary.
 */
describe("sanitizePostgresFlags", () => {
  it("preserves the shared-memory default and a caller override unchanged", () => {
    const flags = [...DEFAULT_EMBEDDED_POSTGRES_FLAGS, "-c", "shared_memory_type=sysv"];

    expect(sanitizePostgresFlags(flags)).toEqual(flags);
  });
});

/*
 * FNXC:WindowsDesktopPackaging 2026-07-17-21:20:
 * Start-Process -Credential (CreateProcessWithLogonW) validates the working
 * directory as the TARGET user. Without an explicit -WorkingDirectory it
 * inherits the desktop app's cwd (the admin user's profile / install dir),
 * which 'fusion-pg' cannot access, and the launch dies with "The directory
 * name is invalid". The launcher must pin -WorkingDirectory to the granted
 * .pgrunner run dir, passed as a discrete -File param.
 */
describe("buildNonAdminLauncherPs1", () => {
  it("pins Start-Process to the granted run dir via -WorkingDirectory", () => {
    const script = buildNonAdminLauncherPs1();

    expect(script).toContain("[string]$RunDir");
    const startProcessLine = script
      .split("\r\n")
      .find((line) => line.includes("Start-Process"));
    expect(startProcessLine).toContain("-WorkingDirectory $RunDir");
    expect(startProcessLine).toContain("-Credential $c");
  });
});
