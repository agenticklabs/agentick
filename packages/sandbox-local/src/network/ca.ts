/**
 * Ephemeral CA Certificate Generation
 *
 * Uses the openssl CLI to generate a short-lived CA certificate and
 * per-host certificates for HTTPS interception.
 *
 * Currently used only by tests. When full HTTPS MITM proxy support is
 * added (allowing body-level inspection and URL pattern matching for
 * HTTPS traffic), this will be wired into NetworkProxyServer to
 * generate per-host certs on CONNECT and terminate TLS.
 */

import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CACertPaths {
  certPath: string;
  keyPath: string;
}

export interface HostCertPaths {
  certPath: string;
  keyPath: string;
}

export class EphemeralCA {
  private readonly dir: string;
  private ca?: CACertPaths;
  private hostCerts = new Map<string, HostCertPaths>();
  private destroyed = false;

  constructor() {
    this.dir = join(tmpdir(), `agentick-ca-${randomBytes(6).toString("hex")}`);
  }

  /** Get the CA certificate path (generates on first call). */
  get caCertPath(): string | undefined {
    return this.ca?.certPath;
  }

  /** Initialize the ephemeral CA. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });

    const keyPath = join(this.dir, "ca-key.pem");
    const certPath = join(this.dir, "ca-cert.pem");

    // Generate CA key + self-signed cert (1 day validity)
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Agentick Sandbox CA",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);

    this.ca = { certPath, keyPath };
  }

  /**
   * Get or generate a certificate for a specific hostname.
   * Caches per-host certs in memory.
   */
  async certForHost(hostname: string): Promise<HostCertPaths> {
    if (this.destroyed) throw new Error("CA has been destroyed");
    if (!this.ca) throw new Error("CA not initialized");

    const cached = this.hostCerts.get(hostname);
    if (cached) return cached;

    const hostKeyPath = join(this.dir, `${hostname}-key.pem`);
    const hostCsrPath = join(this.dir, `${hostname}.csr`);
    const hostCertPath = join(this.dir, `${hostname}-cert.pem`);
    const serial = randomBytes(8).toString("hex");

    // Generate host key + CSR
    await execFileAsync("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${hostname}`,
      "-keyout",
      hostKeyPath,
      "-out",
      hostCsrPath,
    ]);

    // Create SAN extension config for the host cert
    const extPath = join(this.dir, `${hostname}-ext.cnf`);
    await writeFile(extPath, `subjectAltName=DNS:${hostname}\nbasicConstraints=CA:FALSE\n`);

    // Sign with CA
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-in",
      hostCsrPath,
      "-CA",
      this.ca.certPath,
      "-CAkey",
      this.ca.keyPath,
      "-set_serial",
      `0x${serial}`,
      "-days",
      "1",
      "-extfile",
      extPath,
      "-out",
      hostCertPath,
    ]);

    // Clean up CSR and ext file
    await Promise.all([safeUnlink(hostCsrPath), safeUnlink(extPath)]);

    const paths: HostCertPaths = { certPath: hostCertPath, keyPath: hostKeyPath };
    this.hostCerts.set(hostname, paths);
    return paths;
  }

  /** Clean up all generated certificate files. */
  async cleanup(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    const files: string[] = [];
    if (this.ca) {
      files.push(this.ca.certPath, this.ca.keyPath);
    }
    for (const cert of this.hostCerts.values()) {
      files.push(cert.certPath, cert.keyPath);
    }

    await Promise.allSettled(files.map(safeUnlink));
    this.hostCerts.clear();

    // Try to remove the directory itself
    try {
      const { rm } = await import("node:fs/promises");
      await rm(this.dir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Ignore
  }
}
