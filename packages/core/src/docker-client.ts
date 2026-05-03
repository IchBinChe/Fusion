import Docker from "dockerode";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  DockerConnectivityResult,
  DockerContainerInspectResult,
  DockerContextInfo,
  DockerHostConfig,
} from "./types.js";

const EXEC_OPTIONS = {
  timeout: 15_000,
  maxBuffer: 5 * 1024 * 1024,
} as const;

function isLocalDaemonHost(host?: string): boolean {
  return !host || host.trim() === "" || host === "unix:///var/run/docker.sock";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

interface DockerContextCliEntry {
  Name?: string;
  Description?: string;
  DockerEndpoint?: string;
  DockerHost?: string;
  Current?: boolean;
  Error?: string;
}

export class DockerClientService {
  private dockerInstance: Docker | null = null;

  constructor(private readonly defaultHostConfig?: DockerHostConfig) {}

  private async createDockerInstance(hostConfig?: DockerHostConfig): Promise<Docker> {
    if (hostConfig?.context) {
      const contextName = hostConfig.context.trim();
      if (!contextName) throw new Error("Docker context name cannot be empty");

      let stdout: string;
      try {
        ({ stdout } = await promisify(exec)(`docker context inspect ${JSON.stringify(contextName)}`, EXEC_OPTIONS));
      } catch (error) {
        throw new Error(`Failed to inspect Docker context "${contextName}": ${toErrorMessage(error)}`);
      }

      const parsed = JSON.parse(stdout) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
      const dockerHost = parsed[0]?.Endpoints?.docker?.Host;
      if (!dockerHost) throw new Error(`Docker context "${contextName}" does not define a Docker endpoint host`);
      return new Docker({ host: dockerHost });
    }

    if (hostConfig?.host) {
      const options: {
        host: string;
        ca?: Buffer;
        cert?: Buffer;
        key?: Buffer;
        rejectUnauthorized?: boolean;
      } = {
        host: hostConfig.host,
      };

      if (hostConfig.tlsCaPath) options.ca = await readFile(hostConfig.tlsCaPath);
      if (hostConfig.tlsCertPath) options.cert = await readFile(hostConfig.tlsCertPath);
      if (hostConfig.tlsKeyPath) options.key = await readFile(hostConfig.tlsKeyPath);
      if (hostConfig.tlsVerify === false) options.rejectUnauthorized = false;

      return new Docker(options);
    }

    return new Docker();
  }

  async testConnection(hostConfig?: DockerHostConfig): Promise<DockerConnectivityResult> {
    const isLocalDaemon = isLocalDaemonHost(hostConfig?.host) && !hostConfig?.context;

    try {
      const docker = await this.createDockerInstance(hostConfig);
      await docker.ping();
      const version = await docker.version();

      return {
        success: true,
        dockerVersion: version.Version,
        apiVersion: version.ApiVersion,
        operatingSystem: version.Os,
        isLocalDaemon,
      };
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
        isLocalDaemon,
      };
    }
  }

  async listContexts(): Promise<DockerContextInfo[]> {
    try {
      const { stdout } = await promisify(exec)("docker context ls --format json", EXEC_OPTIONS);
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        return [{ name: "default", isCurrentContext: true, description: "Current Docker context" }];
      }

      try {
        return lines.map((line) => {
          const entry = JSON.parse(line) as DockerContextCliEntry;
          return {
            name: entry.Name ?? "default",
            description: entry.Description,
            dockerHost: entry.DockerEndpoint ?? entry.DockerHost,
            isCurrentContext: Boolean(entry.Current),
            isError: Boolean(entry.Error),
            errorMessage: entry.Error,
          } satisfies DockerContextInfo;
        });
      } catch {
        const tableLines = lines.slice(1);
        const contexts: DockerContextInfo[] = [];
        for (const line of tableLines) {
          const parts = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
          if (parts.length === 0) continue;
          const rawName = parts[0] ?? "";
          const isCurrentContext = rawName.startsWith("*");
          const name = rawName.replace(/^\*\s*/, "") || "default";
          contexts.push({
            name,
            description: parts[2] || undefined,
            dockerHost: parts[1] || undefined,
            isCurrentContext,
          });
        }
        return contexts;
      }
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.includes("ENOENT")) {
        return [{ name: "default", isCurrentContext: true, description: "Current Docker context" }];
      }
      throw error;
    }
  }

  /**
   * Get a Docker instance for the given host config.
   * If no host config is provided, uses the default config (cached).
   * Otherwise creates a fresh instance for the custom config.
   */
  async getDockerInstance(hostConfig?: DockerHostConfig): Promise<Docker> {
    if (!hostConfig || hostConfig === this.defaultHostConfig) {
      return this.getInstance();
    }
    return this.createDockerInstance(hostConfig);
  }

  async getContainerInfo(containerId: string): Promise<DockerContainerInspectResult | null> {
    try {
      const docker = await this.getInstance();
      const inspect = await docker.getContainer(containerId).inspect();
      return {
        id: inspect.Id,
        name: (inspect.Name ?? "").replace(/^\//, ""),
        status: inspect.State?.Status ?? "unknown",
        image: inspect.Config?.Image ?? "",
        created: inspect.Created ? Date.parse(inspect.Created) : 0,
        state: {
          running: Boolean(inspect.State?.Running),
          paused: Boolean(inspect.State?.Paused),
          restarting: Boolean(inspect.State?.Restarting),
          dead: Boolean(inspect.State?.Dead),
          error: inspect.State?.Error || undefined,
        },
      };
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.includes("404") || message.toLowerCase().includes("no such container")) {
        return null;
      }
      throw error;
    }
  }

  private async getInstance(): Promise<Docker> {
    if (!this.dockerInstance) {
      this.dockerInstance = await this.createDockerInstance(this.defaultHostConfig);
    }
    return this.dockerInstance;
  }

  dispose(): void {
    this.dockerInstance = null;
  }
}
