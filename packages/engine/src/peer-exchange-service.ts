import type { CentralCore } from "@fusion/core";
import type { NodeConfig, PeerSyncRequest, PeerSyncResponse } from "@fusion/core";
import { peerExchangeLog } from "./logger.js";

export interface PeerExchangeServiceOptions {
  /** Interval between peer sync cycles in milliseconds. Default: 60000 (1 minute) */
  syncIntervalMs?: number;
}

/**
 * Result of syncing with a single node.
 */
export interface SyncResult {
  /** Node ID that was synced with */
  nodeId: string;
  /** Whether the sync was successful */
  success: boolean;
  /** Number of new peers discovered */
  added: number;
  /** Number of peers updated */
  updated: number;
  /** Error message if sync failed */
  error?: string;
}

/**
 * Background service that implements the peer gossip protocol.
 *
 * Periodically exchanges peer information with connected remote nodes
 * to keep the mesh state up-to-date across all nodes.
 */
export class PeerExchangeService {
  private centralCore: CentralCore;
  private syncIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private activeSync: Promise<void> | null = null;
  private stopped = false;

  /**
   * Create a PeerExchangeService.
   *
   * @param centralCore - CentralCore instance for node registry access
   * @param options - Configuration options
   */
  constructor(centralCore: CentralCore, options: PeerExchangeServiceOptions = {}) {
    this.centralCore = centralCore;
    this.syncIntervalMs = options.syncIntervalMs ?? 60_000; // 1 minute default
  }

  /**
   * Start the peer exchange service.
   * Begins periodic gossip with all online remote nodes.
   */
  start(): void {
    if (this.stopped) {
      peerExchangeLog.warn("Cannot start - service has been stopped");
      return;
    }

    // Get initial peer count for logging (async call)
    this.centralCore.listNodes().then((nodes) => {
      const onlineRemoteCount = nodes.filter(
        (n) => n.type === "remote" && n.status === "online" && n.url
      ).length;

      peerExchangeLog.log(`Starting peer exchange service (sync interval: ${this.syncIntervalMs}ms, ${onlineRemoteCount} online remote peers)`);
    }).catch((err) => {
      peerExchangeLog.warn(`Failed to get initial peer count: ${err}`);
    });

    // Start periodic sync
    this.interval = setInterval(() => {
      void this.syncWithAllPeers();
    }, this.syncIntervalMs);
  }

  /**
   * Stop the peer exchange service.
   * Clears the sync interval and prevents further syncs.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.stopped = true;
    peerExchangeLog.log("Stopped peer exchange service");
  }

  /**
   * Trigger an immediate sync with all peers, bypassing the interval.
   *
   * If a sync is already in progress, returns the in-progress sync.
   *
   * @returns Promise that resolves when the sync completes
   */
  async triggerSync(): Promise<SyncResult[]> {
    return this.syncWithAllPeers();
  }

  /**
   * Sync with all online remote nodes.
   *
   * Uses single-flight pattern to prevent overlapping syncs.
   * If a sync is already in progress, returns that sync's promise.
   */
  async syncWithAllPeers(): Promise<SyncResult[]> {
    // Single-flight: if a sync is already running, return that
    if (this.activeSync) {
      peerExchangeLog.log("Sync already in progress, skipping");
      await this.activeSync;
      return [];
    }

    this.activeSync = this.runSyncWithAllPeers();
    try {
      await this.activeSync;
    } finally {
      this.activeSync = null;
    }

    return [];
  }

  private async runSyncWithAllPeers(): Promise<void> {
    try {
      // Get all online remote nodes with URLs
      const nodes = await this.centralCore.listNodes();
      const onlineRemoteNodes = nodes.filter(
        (node) => node.type === "remote" && node.status === "online" && node.url
      );

      if (onlineRemoteNodes.length === 0) {
        peerExchangeLog.log("No online remote nodes to sync with");
        return;
      }

      peerExchangeLog.log(`Starting sync with ${onlineRemoteNodes.length} peers`);

      // Sync with each node sequentially (not in parallel to avoid thundering herd)
      let totalAdded = 0;
      let totalUpdated = 0;
      const errors: string[] = [];

      for (const node of onlineRemoteNodes) {
        try {
          const result = await this.syncWithNode(node);
          totalAdded += result.added;
          totalUpdated += result.updated;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${node.name}: ${message}`);
          peerExchangeLog.warn(`Sync with ${node.name} failed: ${message}`);
        }
      }

      // Log summary
      if (errors.length > 0) {
        peerExchangeLog.log(
          `Sync complete: ${onlineRemoteNodes.length - errors.length} succeeded, ${errors.length} failed. ` +
          `${totalAdded} new peers discovered, ${totalUpdated} updated. Errors: ${errors.join("; ")}`
        );
      } else {
        peerExchangeLog.log(
          `Sync complete: ${onlineRemoteNodes.length} peers synced. ` +
          `${totalAdded} new peers discovered, ${totalUpdated} updated.`
        );
      }
    } catch (error) {
      peerExchangeLog.error("Unexpected error in sync loop:", error);
    }
  }

  /**
   * Sync with a single remote node.
   *
   * Sends our known peers and merges the response.
   *
   * @param node - Remote node configuration
   * @returns Sync result with counts and any errors
   */
  async syncWithNode(node: NodeConfig): Promise<SyncResult> {
    try {
      // Build the sync request
      // Refresh local metrics first to ensure freshness
      await this.centralCore.reportMeshState();

      // Get local node info
      const nodes = await this.centralCore.listNodes();
      const localNode = nodes.find((n) => n.type === "local");
      if (!localNode) {
        return { nodeId: node.id, success: false, added: 0, updated: 0, error: "Local node not found" };
      }

      // Get all known peers for the request
      const allKnownPeers = await this.centralCore.getAllKnownPeerInfo();

      const request: PeerSyncRequest = {
        senderNodeId: localNode.id,
        senderNodeUrl: localNode.url || "",
        knownPeers: allKnownPeers,
        timestamp: new Date().toISOString(),
      };

      // Build headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (node.apiKey) {
        headers["Authorization"] = `Bearer ${node.apiKey}`;
      }

      // Send the sync request with 10-second timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(`${node.url}/api/mesh/sync`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          return {
            nodeId: node.id,
            success: false,
            added: 0,
            updated: 0,
            error: `HTTP ${response.status}: ${response.statusText}`,
          };
        }

        const peerResponse: PeerSyncResponse = await response.json();

        // Merge ALL known peers from the response (not just newPeers)
        // This ensures we get updates for existing peers too
        const mergeResult = await this.centralCore.mergePeers(peerResponse.knownPeers);

        peerExchangeLog.log(
          `Synced with ${node.name}: ${mergeResult.added.length} new, ${mergeResult.updated.length} updated, ` +
          `${peerResponse.newPeers.length} new to sender`
        );

        return {
          nodeId: node.id,
          success: true,
          added: mergeResult.added.length,
          updated: mergeResult.updated.length,
        };
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("abort")) {
        return { nodeId: node.id, success: false, added: 0, updated: 0, error: "Timeout (10s)" };
      }
      return { nodeId: node.id, success: false, added: 0, updated: 0, error: message };
    }
  }
}
