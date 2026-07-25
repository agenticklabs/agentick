/**
 * Model-facing tool surface (ADR 59).
 *
 * The agent gets exactly four tools + bash. Mounting a host directory
 * is a privilege boundary the model must NOT cross — `add-mount` /
 * `remove-mount` / `list-mounts` are harness commands (programmatic /
 * dispatch), never model tools. This test is the guard: if someone adds
 * a mount tool to the model surface, it fails.
 */

import { describe, expect, it } from "vitest";

import * as tools from "../tools.js";

describe("sandbox model tool surface", () => {
  it("exposes exactly bash / read_file / write_file / edit_file — no mount tools", () => {
    const names = Object.values(tools)
      .map((t) => t.declaration.name)
      .sort();
    expect(names).toEqual(["bash", "edit_file", "read_file", "write_file"]);
    expect(names).not.toContain("add_mount");
    expect(names.some((n) => n.includes("mount"))).toBe(false);
  });
});
