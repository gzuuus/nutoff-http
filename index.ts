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
function generateMetadata(user: User, tag?: string, host?: string): string {
  const metadata: string[][] = [
    ["text/plain", user.description],
    ["text/identifier", `${user.username}@${host ?? "localhost"}`],
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

const CTX_CLIENT_PRIVATE_KEY = process.env.CTX_CLIENT_PRIVATE_KEY || undefined;

// Initialize MCP client service
const mcpClientService = new McpClientService({
  clientPrivateKeyHex: CTX_CLIENT_PRIVATE_KEY,
  relays: RELAYS,
});

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const method = req.method;
    console.log(`Received ${method} request for ${path}`);
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*", // or specify a domain instead of '*'
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  },
  routes: {
    // LNURL-P endpoint for LUD-16
    // This endpoint handles the initial payment request
    "/.well-known/lnurlp/:username": async (req) => {
      const { username: npub } = req.params;

      try {
        // Get server info from MCP server using the npub as server pubkey
        const serverInfo = await mcpClientService.getInfo(npub);

        // Extract domain from the request URL
        const url = new URL(req.url);
        const domain = `https://${url.host}`;

        // Generate metadata following LUD-06 specification
        const metadata = generateMetadata(
          {
            username: npub,
            minSendable: serverInfo.minSendable || 1000,
            maxSendable: serverInfo.maxSendable || 100000000,
            description: serverInfo.description || `Payment to ${npub}`,
            longDescription: serverInfo.longDescription,
            imageData: serverInfo.imageData,
          },
          undefined,
          url.host,
        );

        // Create payment request response following LUD-06 format
        const paymentRequest: LnUrlRawData = {
          callback: `${domain}/lnurlp/callback/${npub}`,
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

      // Convert from millisats to sats for the MCP server
      const amountSats = Math.floor(amount / 1000);

      try {
        // Request invoice from MCP server
        const invoiceResult = await mcpClientService.makeInvoice(
          npub,
          amountSats,
        );

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

    // Wallet page endpoint
    "/w/:walletpubkey": async (
      req: Request & { params: { walletpubkey: string } },
    ) => {
      const { walletpubkey } = req.params;
      const url = new URL(req.url);
      const walletAddress = `${walletpubkey}@${url.host}`;

      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Wallet Address - ${walletAddress}</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        .container {
            text-align: center;
            background: white;
            padding: 2.5rem;
            border-radius: 15px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            max-width: 500px;
            width: 100%;
        }
        h1 {
            color: #2c3e50;
            margin-bottom: 1.5rem;
            word-break: break-all;
            font-size: 1.3rem;
            font-weight: 600;
        }
        h2 {
            color: #34495e;
            margin-bottom: 1.5rem;
            font-size: 1.4rem;
            font-weight: 600;
        }
        h3 {
            color: #34495e;
            margin-bottom: 1rem;
            font-size: 1.2rem;
            font-weight: 600;
        }
        #qrcode {
            margin: 1.5rem auto;
            text-align: center;
                display: flex;
    justify-content: center;
    align-items: center;
        }
        .address {
            background: #f8f9fa;
            padding: 0.75rem;
            border-radius: 8px;
            margin: 1.5rem 0;
            word-break: break-all;
            font-size: 0.9rem;
            color: #495057;
            border: 1px solid #e9ecef;
        }
        .invoice-form {
            margin-top: 2.5rem;
            padding-top: 2.5rem;
            border-top: 2px solid #e9ecef;
        }
        .form-group {
            margin-bottom: 1.5rem;
            text-align: left;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
            color: #495057;
            font-size: 0.95rem;
        }
        input[type="number"] {
            width: 100%;
            padding: 0.875rem;
            border: 2px solid #e9ecef;
            border-radius: 8px;
            font-size: 1rem;
            box-sizing: border-box;
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        input[type="number"]:focus {
            outline: none;
            border-color: #3498db;
            box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.1);
        }
        button {
            background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
            color: white;
            padding: 0.875rem 2rem;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 6px rgba(52, 152, 219, 0.3);
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 12px rgba(52, 152, 219, 0.4);
        }
        button:active {
            transform: translateY(0);
        }
        button:disabled {
            background: #bdc3c7;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }
        .invoice-result {
            margin-top: 2rem;
            padding: 1.5rem;
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            border-radius: 10px;
            border: 1px solid #dee2e6;
            display: none;
            text-align: center;
        }
        .invoice-result.show {
            display: block;
        }
        .invoice-text {
            font-size: 0.85rem;
            word-break: break-all;
            background-color: #2c3e50;
            color: #ecf0f1;
            padding: 1.25rem;
            border-radius: 8px;
            margin: 1.5rem 0;
            text-align: left;
            line-height: 1.4;
        }
        .error-message {
            color: #e74c3c;
            margin-top: 1rem;
            padding: 0.75rem;
            background-color: #fdf2f2;
            border-radius: 8px;
            border: 1px solid #e74c3c;
            font-weight: 500;
        }
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid #3498db;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-left: 10px;
            vertical-align: middle;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .amount-hint {
            font-size: 0.85rem;
            color: #6c757d;
            margin-top: 0.5rem;
            font-weight: 400;
        }
        #invoiceQrCode {
            margin: 1.5rem auto;
            text-align: center;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        #copyInvoice {
            background: linear-gradient(135deg, #27ae60 0%, #229954 100%);
            box-shadow: 0 4px 6px rgba(39, 174, 96, 0.3);
        }
        #copyInvoice:hover {
            box-shadow: 0 6px 12px rgba(39, 174, 96, 0.4);
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>${walletAddress}</h1>
        </header>
        
        <main>
            <div id="qrcode"></div>
            <div class="address">Scan this QR code with your wallet</div>
            
            <section class="invoice-form">
                <h2>Generate Lightning Invoice</h2>
                <form id="invoiceForm">
                    <div class="form-group">
                        <label for="amount">Amount (sats):</label>
                        <input type="number" id="amount" name="amount" placeholder="Enter amount in satoshis" min="1" step="1">
                        <div class="amount-hint">Enter the amount in satoshis to generate a Lightning invoice</div>
                    </div>
                    <button type="submit" id="generateBtn">Generate Invoice</button>
                    <span id="loadingSpinner" class="loading" style="display: none;"></span>
                </form>
                
                <div id="errorMessage" class="error-message" style="display: none;"></div>
                
                <div id="invoiceResult" class="invoice-result">
                    <h3>Lightning Invoice</h3>
                    <div id="invoiceQrCode" style="margin: 1.5rem auto; text-align: center;"></div>
                    <div id="invoiceText" class="invoice-text"></div>
                    <button id="copyInvoice" onclick="copyInvoiceToClipboard()">Copy Invoice</button>
                </div>
            </section>
        </main>
    </div>
    
    <script>
        // Generate QR code for wallet address
        new QRCode(document.getElementById("qrcode"), {
            text: "${walletAddress}",
            width: 200,
            height: 200,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });

        // Handle invoice form submission
        document.getElementById('invoiceForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const amount = document.getElementById('amount').value;
            const generateBtn = document.getElementById('generateBtn');
            const loadingSpinner = document.getElementById('loadingSpinner');
            const errorMessage = document.getElementById('errorMessage');
            const invoiceResult = document.getElementById('invoiceResult');
            
            // Reset UI
            generateBtn.disabled = true;
            loadingSpinner.style.display = 'inline-block';
            errorMessage.style.display = 'none';
            invoiceResult.classList.remove('show');
            
            try {
                // Call the callback endpoint to generate invoice
                const response = await fetch('/lnurlp/callback/${walletpubkey}?amount=' + (amount * 1000));
                const data = await response.json();
                
                if (response.ok && data.pr) {
                    // Show the invoice
                    document.getElementById('invoiceText').textContent = data.pr;
                    
                    // Generate QR code for the invoice
                    const invoiceQrContainer = document.getElementById('invoiceQrCode');
                    invoiceQrContainer.innerHTML = ''; // Clear previous QR code
                    new QRCode(invoiceQrContainer, {
                        text: data.pr,
                        width: 250,
                        height: 250,
                        colorDark: "#000000",
                        colorLight: "#ffffff",
                        correctLevel: QRCode.CorrectLevel.M
                    });
                    
                    invoiceResult.classList.add('show');
                } else {
                    // Show error
                    errorMessage.textContent = data.reason || 'Failed to generate invoice';
                    errorMessage.style.display = 'block';
                }
            } catch (error) {
                console.error('Error generating invoice:', error);
                errorMessage.textContent = 'Network error: ' + error.message;
                errorMessage.style.display = 'block';
            } finally {
                generateBtn.disabled = false;
                loadingSpinner.style.display = 'none';
            }
        });

        // Copy invoice to clipboard
        function copyInvoiceToClipboard() {
            const invoiceText = document.getElementById('invoiceText').textContent;
            navigator.clipboard.writeText(invoiceText).then(function() {
                const copyBtn = document.getElementById('copyInvoice');
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                }, 2000);
            }).catch(function(err) {
                console.error('Could not copy text: ', err);
            });
        }
    </script>
</body>
</html>`,
        {
          headers: { "Content-Type": "text/html" },
        },
      );
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
