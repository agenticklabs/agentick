import { describe, it, expect, afterEach } from "vitest";
import { DockerAPI, DockerAPIError } from "../docker-api.js";

const hasDocker = await checkDocker();

async function checkDocker(): Promise<boolean> {
  try {
    const api = new DockerAPI();
    await api.ping();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasDocker)("DockerAPI", () => {
  const api = new DockerAPI();
  const containers: string[] = [];
  const volumes: string[] = [];

  afterEach(async () => {
    for (const id of containers) {
      try {
        await api.removeContainer(id, { force: true, v: true });
      } catch {
        /* already gone */
      }
    }
    containers.length = 0;

    for (const name of volumes) {
      try {
        await api.removeVolume(name);
      } catch {
        /* already gone */
      }
    }
    volumes.length = 0;
  });

  it("pings the Docker daemon", async () => {
    await expect(api.ping()).resolves.not.toThrow();
  });

  it("creates and removes a container", async () => {
    const id = await api.createContainer({
      Image: "node:22-slim",
      Cmd: ["sleep", "infinity"],
    });
    containers.push(id);

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    await api.startContainer(id);
    await api.removeContainer(id, { force: true });
    containers.length = 0;
  });

  it("executes a command and demuxes stdout", async () => {
    const id = await api.createContainer({
      Image: "node:22-slim",
      Cmd: ["sleep", "infinity"],
    });
    containers.push(id);
    await api.startContainer(id);

    const execId = await api.execCreate(id, {
      Cmd: ["echo", "hello"],
      AttachStdout: true,
      AttachStderr: true,
    });

    const result = await api.execStart(execId);
    expect(result.stdout.trim()).toBe("hello");

    const inspection = await api.execInspect(execId);
    expect(inspection.ExitCode).toBe(0);
  });

  it("demuxes stderr separately", async () => {
    const id = await api.createContainer({
      Image: "node:22-slim",
      Cmd: ["sleep", "infinity"],
    });
    containers.push(id);
    await api.startContainer(id);

    const execId = await api.execCreate(id, {
      Cmd: ["sh", "-c", "echo error >&2"],
      AttachStdout: true,
      AttachStderr: true,
    });

    const result = await api.execStart(execId);
    expect(result.stderr.trim()).toBe("error");
    expect(result.stdout).toBe("");
  });

  it("returns non-zero exit codes via inspect", async () => {
    const id = await api.createContainer({
      Image: "node:22-slim",
      Cmd: ["sleep", "infinity"],
    });
    containers.push(id);
    await api.startContainer(id);

    const execId = await api.execCreate(id, {
      Cmd: ["sh", "-c", "exit 42"],
      AttachStdout: true,
      AttachStderr: true,
    });

    await api.execStart(execId);
    const inspection = await api.execInspect(execId);
    expect(inspection.ExitCode).toBe(42);
  });

  it("streams output via callbacks", async () => {
    const id = await api.createContainer({
      Image: "node:22-slim",
      Cmd: ["sleep", "infinity"],
    });
    containers.push(id);
    await api.startContainer(id);

    const execId = await api.execCreate(id, {
      Cmd: ["sh", "-c", "echo out && echo err >&2"],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    await api.execStart(execId, {
      onStdout: (data) => stdoutChunks.push(data),
      onStderr: (data) => stderrChunks.push(data),
    });

    expect(stdoutChunks.join("")).toContain("out");
    expect(stderrChunks.join("")).toContain("err");
  });

  it("creates and removes a volume", async () => {
    const vol = await api.createVolume("test-agentick-docker-vol");
    volumes.push(vol.Name);

    expect(vol.Name).toBe("test-agentick-docker-vol");
    expect(vol.Mountpoint).toBeTruthy();

    await api.removeVolume(vol.Name);
    volumes.length = 0;
  });

  it("resolves with partial output on abort", async () => {
    const id = await api.createContainer({
      Image: "node:22-slim",
      Cmd: ["sleep", "infinity"],
    });
    containers.push(id);
    await api.startContainer(id);

    const execId = await api.execCreate(id, {
      Cmd: ["sh", "-c", "echo before && sleep 60"],
      AttachStdout: true,
      AttachStderr: true,
    });

    const controller = new AbortController();

    // Abort after a short delay to let "before" arrive
    setTimeout(() => controller.abort(), 500);

    const result = await api.execStart(execId, {
      signal: controller.signal,
    });

    expect(result.stdout).toContain("before");
  }, 10000);

  it("throws DockerAPIError on invalid container", async () => {
    await expect(api.startContainer("nonexistent")).rejects.toThrow(DockerAPIError);
  });

  it("throws DockerAPIError on invalid image", async () => {
    await expect(
      api.createContainer({
        Image: "agentick-nonexistent-image:never",
        Cmd: ["echo"],
      }),
    ).rejects.toThrow(DockerAPIError);
  });
});
