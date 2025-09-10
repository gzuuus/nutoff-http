// LUD-16 LNURL Provider Implementation
// This server provides LNURL-PAY functionality for email-like addresses
// Following LUD-16 specification: https://github.com/lnurl/luds/blob/luds/16.md

import type { LnUrlRawData } from "@getalby/lightning-tools";
import { McpClientService } from "./mcp-client-service";

export interface User {
  username: string;
  minSendable: number; // millisatoshis
  maxSendable: number; // millisatoshis
  description: string;
  longDescription?: string;
  imageData?: string; // base64 encoded image
}

export interface InvoiceResponse {
  pr: string; // bech32-serialized lightning invoice
  routes: []; // empty array
}

export interface ErrorResponse {
  status: "ERROR";
  reason: string;
}

// Dummy user registry
const users: Record<string, User> = {
  alice: {
    username: "alice",
    minSendable: 1000, // 1 satoshi
    maxSendable: 100000000, // 0.1 BTC
    description: "Payment to Alice",
    longDescription:
      "Alice is a software developer who accepts Lightning payments",
  },
  bob: {
    username: "bob",
    minSendable: 1000,
    maxSendable: 50000000, // 0.05 BTC
    description: "Payment to Bob",
    longDescription: "Bob runs a coffee shop and accepts Lightning payments",
  },
  charlie: {
    username: "charlie",
    minSendable: 100,
    maxSendable: 10000000, // 0.001 BTC
    description: "Payment to Charlie",
    longDescription: "Charlie is a content creator accepting Lightning tips",
  },
};

// Helper function to generate metadata array following LUD-06 specification
function generateMetadata(user: User, tag?: string): string {
  const metadata: string[][] = [
    ["text/plain", user.description],
    ["text/identifier", `${user.username}@localhost`], // Using localhost for development
  ];

  if (user.longDescription) {
    metadata.push(["text/long-desc", user.longDescription]);
  }

  if (tag) {
    metadata.push(["text/tag", tag]);
  }

  // Convert to string as required by LNURL spec
  return JSON.stringify(metadata);
}

// Configuration for MCP client
const RELAYS = process.env.RELAYS
  ? process.env.RELAYS.split(",")
  : ["wss://relay.contextvm.org"];

// Initialize MCP client service
const mcpClientService = new McpClientService({
  clientPrivateKeyHex: undefined,
  relays: RELAYS,
});

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const method = req.method;
    console.log(`Received ${method} request for ${path}`);
    return new Response("ok");
  },
  routes: {
    // LNURL-P endpoint for LUD-16
    // This endpoint handles the initial payment request
    "/.well-known/lnurlp/:username": async (req) => {
      const { username: npub } = req.params;

      try {
        // Get server info from MCP server using the npub as server pubkey
        const serverInfo = await mcpClientService.getInfo(npub);

        // Generate metadata following LUD-06 specification
        const metadata = generateMetadata({
          username: npub,
          minSendable: serverInfo.minSendable || 1000,
          maxSendable: serverInfo.maxSendable || 100000000,
          description: serverInfo.description || `Payment to ${npub}`,
          longDescription: serverInfo.longDescription,
          imageData: serverInfo.imageData,
        });

        // Create payment request response following LUD-06 format
        const paymentRequest: LnUrlRawData = {
          callback: `http://localhost:3000/lnurlp/callback/${npub}`,
          maxSendable: serverInfo.maxSendable || 100000000,
          minSendable: serverInfo.minSendable || 1000,
          metadata: metadata,
          tag: "payRequest",
        };

        return Response.json(paymentRequest);
      } catch (error) {
        console.error(`Failed to get info from server ${npub}:`, error);
        return Response.json(
          {
            status: "ERROR",
            reason:
              error instanceof Error
                ? error.message
                : "Failed to connect to server",
          } as ErrorResponse,
          { status: 502 },
        );
      }
    },

    // Callback endpoint for invoice generation
    // This endpoint handles the second request to generate a Lightning invoice
    "/lnurlp/callback/:username": async (req, server) => {
      const url = new URL(req.url);
      const { username: npub } = req.params;
      const amountMsat = url.searchParams.get("amount");

      // Validate amount parameter
      if (!amountMsat) {
        return Response.json(
          {
            status: "ERROR",
            reason: "Missing amount parameter",
          } as ErrorResponse,
          { status: 400 },
        );
      }

      const amount = parseInt(amountMsat);
      if (isNaN(amount) || amount < 1) {
        return Response.json(
          {
            status: "ERROR",
            reason: "Invalid amount parameter",
          } as ErrorResponse,
          { status: 400 },
        );
      }

      try {
        // Request invoice from MCP server
        const invoiceResult = await mcpClientService.makeInvoice(npub, amount);

        // Return invoice response following LUD-06 format
        const invoiceResponse: InvoiceResponse = {
          pr: invoiceResult,
          routes: [],
        };

        return Response.json(invoiceResponse);
      } catch (error) {
        console.error(`Failed to make invoice from server ${npub}:`, error);
        return Response.json(
          {
            status: "ERROR",
            reason:
              error instanceof Error
                ? error.message
                : "Failed to create invoice",
          } as ErrorResponse,
          { status: 502 },
        );
      }
    },

    // Health check endpoint
    "/health": new Response("OK", {
      headers: { "Content-Type": "text/plain" },
    }),

    // Serve static HTML file for root path
    "/": new Response(Bun.file("./index.html"), {
      headers: { "Content-Type": "text/html" },
    }),

    // Serve static HTML file for index.html path
    "/index.html": new Response(Bun.file("./index.html"), {
      headers: { "Content-Type": "text/html" },
    }),

    // Serve CSS file
    "/styles.css": new Response(Bun.file("./styles.css"), {
      headers: { "Content-Type": "text/css" },
    }),

    // API endpoint for service information
    "/api/info": () => {
      return Response.json({
        service: "LUD-16 LNURL Provider with MCP Proxy",
        version: "2.0.0",
        specification: "LUD-16",
        description:
          "Proxy server that resolves LNURL addresses using MCP servers",
        endpoints: {
          lnurlp: "/.well-known/lnurlp/:npub",
          callback: "/lnurlp/callback/:npub",
          health: "/health",
        },
        configuration: {
          relays: RELAYS,
        },
        usage:
          "Replace :npub with the server's npub to resolve LNURL addresses",
        example: "http://localhost:3000/.well-known/lnurlp/npub1example...",
      });
    },
  },

  // Global error handler
  error(error) {
    console.error("Server error:", error);
    return Response.json(
      { status: "ERROR", reason: "Internal server error" } as ErrorResponse,
      { status: 500 },
    );
  },
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down gracefully...");
  await mcpClientService.closeAll();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nShutting down gracefully...");
  await mcpClientService.closeAll();
  process.exit(0);
});

console.log(`LUD-16 LNURL Provider running at http://localhost:${server.port}`);
console.log(`MCP Client initialized with relays: ${RELAYS.join(", ")}`);
console.log(
  `Example: npub1... -> http://localhost:${server.port}/.well-known/lnurlp/npub1...`,
);
console.log(
  "Note: Set CLIENT_PRIVATE_KEY_HEX environment variable for your client private key",
);
