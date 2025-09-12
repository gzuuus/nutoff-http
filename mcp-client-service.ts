import { Client } from "@modelcontextprotocol/sdk/client";
import {
  NostrClientTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from "@contextvm/sdk";
import { decode } from "nostr-tools/nip19";

export interface McpClientServiceConfig {
  clientPrivateKeyHex?: string;
  relays: string[];
}

export class McpClientService {
  private config: McpClientServiceConfig;
  private clients: Map<string, Client> = new Map();

  constructor(config: McpClientServiceConfig) {
    this.config = config;
  }

  /**
   * Creates or reuses an MCP client for the given server pubkey
   */
  async getClient(serverPubkey: string): Promise<Client> {
    // Check if we already have a client for this server
    if (this.clients.has(serverPubkey)) {
      return this.clients.get(serverPubkey)!;
    }

    // Create new client
    const signer = this.config.clientPrivateKeyHex
      ? new PrivateKeySigner(this.config.clientPrivateKeyHex)
      : new PrivateKeySigner();
    const relayPool = new ApplesauceRelayPool(this.config.relays);

    const clientTransport = new NostrClientTransport({
      signer,
      relayHandler: relayPool,
      serverPubkey,
    });

    const client = new Client(
      {
        name: "lnurl-proxy-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );
    await client.connect(clientTransport);

    // Store the client for reuse
    this.clients.set(serverPubkey, client);

    return client;
  }

  /**
   * Calls the get_info method on the remote MCP server
   */
  async getInfo(serverPubkey: string): Promise<any> {
    if (serverPubkey.startsWith("npub1")) {
      serverPubkey = decode(serverPubkey).data as string;
    }
    const client = await this.getClient(serverPubkey);

    try {
      const result = await client.callTool({
        name: "get_info",
        arguments: {},
      });
      return result;
    } catch (error) {
      console.error(
        `Failed to call get_info for server ${serverPubkey}:`,
        error,
      );
      throw new Error(
        `Failed to get info from server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Calls the make_invoice method on the remote MCP server
   */
  async makeInvoice(
    serverPubkey: string,
    amount: number,
  ): Promise<{ invoice: string; quoteId: string }> {
    if (serverPubkey.startsWith("npub1")) {
      serverPubkey = decode(serverPubkey).data as string;
    }
    const client = await this.getClient(serverPubkey);

    try {
      const result = await client.callTool({
        name: "make_invoice",
        arguments: { amount },
      });
      const parsed = JSON.parse((result.content as any[])[0].text).result;
      return { invoice: parsed.invoice, quoteId: parsed.payment_hash };
    } catch (error) {
      console.error(
        `Failed to call make_invoice for server ${serverPubkey}:`,
        error,
      );
      throw new Error(
        `Failed to make invoice from server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Calls the lookup_invoice method on the remote MCP server
   */
  async lookupInvoice(serverPubkey: string, quoteId: string): Promise<any> {
    if (serverPubkey.startsWith("npub1")) {
      serverPubkey = decode(serverPubkey).data as string;
    }
    const client = await this.getClient(serverPubkey);

    try {
      const result = await client.callTool({
        name: "lookup_invoice",
        arguments: { payment_hash: quoteId },
      });
      const parsed = JSON.parse((result.content as any[])[0].text).result;
      console.log("result", result, parsed);
      return parsed;
    } catch (error) {
      console.error(
        `Failed to call lookup_invoice for server ${serverPubkey}:`,
        error,
      );
      throw new Error(
        `Failed to lookup invoice from server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Closes all client connections
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map((client) =>
      client
        .close()
        .catch((error) => console.error("Error closing client:", error)),
    );

    await Promise.all(closePromises);
    this.clients.clear();
  }
}
