import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import type { LnUrlRawData } from "@getalby/lightning-tools";
import type { ErrorResponse, InvoiceResponse } from ".";

// Test the LUD-16 LNURL Provider implementation
describe("LUD-16 LNURL Provider", () => {
  const baseUrl = "http://localhost:3000";
  let serverProcess: ReturnType<typeof spawn> | null = null;

  // Start the server before all tests
  beforeAll(async () => {
    serverProcess = spawn({
      cmd: [process.execPath, "index.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  // Stop the server after all tests
  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  describe("LNURL-P Endpoint", () => {
    test("should return valid payment request for existing user", async () => {
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/alice`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as LnUrlRawData;

      // Verify response structure matches LUD-06 specification
      expect(data).toHaveProperty("callback");
      expect(data).toHaveProperty("maxSendable");
      expect(data).toHaveProperty("minSendable");
      expect(data).toHaveProperty("metadata");
      expect(data).toHaveProperty("tag", "payRequest");

      // Verify amount constraints
      expect(typeof data.maxSendable).toBe("number");
      expect(typeof data.minSendable).toBe("number");
      expect(data.minSendable).toBeGreaterThanOrEqual(1);
      expect(data.maxSendable).toBeGreaterThanOrEqual(data.minSendable);

      // Verify metadata is a valid JSON string
      expect(() => JSON.parse(data.metadata)).not.toThrow();

      const metadata = JSON.parse(data.metadata);
      expect(Array.isArray(metadata)).toBe(true);

      // Check for required metadata entries
      const hasTextPlain = metadata.some(
        (entry: any[]) =>
          entry[0] === "text/plain" && typeof entry[1] === "string",
      );
      const hasTextIdentifier = metadata.some(
        (entry: any[]) =>
          entry[0] === "text/identifier" && typeof entry[1] === "string",
      );

      expect(hasTextPlain).toBe(true);
      expect(hasTextIdentifier).toBe(true);
    });

    test("should support username+tag format", async () => {
      const response = await fetch(
        `${baseUrl}/.well-known/lnurlp/alice+donation`,
      );
      expect(response.status).toBe(200);

      const data = (await response.json()) as LnUrlRawData;
      const metadata = JSON.parse(data.metadata) as string[][];

      // Check for text/tag entry
      const hasTextTag = metadata.some(
        (entry: any[]) => entry[0] === "text/tag" && entry[1] === "donation",
      );
      expect(hasTextTag).toBe(true);
    });

    test("should return 404 for non-existent user", async () => {
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/nonexistent`);
      expect(response.status).toBe(404);

      const data = (await response.json()) as ErrorResponse;
      expect(data).toHaveProperty("status", "ERROR");
      expect(data).toHaveProperty("reason");
    });

    test("should validate username format", async () => {
      // Test invalid characters
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/Alice@123`);
      expect(response.status).toBe(400);

      const data = (await response.json()) as ErrorResponse;
      expect(data).toHaveProperty("status", "ERROR");
      expect(data.reason).toContain("Invalid username format");
    });

    test("should support all valid username characters", async () => {
      const validUsernames = ["alice", "bob123", "charlie_test", "david+tag"];

      for (const username of validUsernames) {
        const response = await fetch(
          `${baseUrl}/.well-known/lnurlp/${username}`,
        );
        // Should either succeed (if user exists) or return 404 (if user doesn't exist)
        // but never 400 (invalid format)
        expect(response.status).not.toBe(400);
      }
    });
  });

  describe("Callback Endpoint", () => {
    test("should generate invoice for valid request", async () => {
      const amount = 10000; // 10 satoshis in millisatoshis
      const response = await fetch(
        `${baseUrl}/lnurlp/callback/alice?amount=${amount}`,
      );
      expect(response.status).toBe(200);

      const data = (await response.json()) as InvoiceResponse;
      expect(data).toHaveProperty("pr");
      expect(data).toHaveProperty("routes", []);

      // Verify invoice format (mock invoice should start with lnbc)
      expect(data.pr).toMatch(/^lnbc/);
    });

    test("should validate amount parameter", async () => {
      // Missing amount
      const response1 = await fetch(`${baseUrl}/lnurlp/callback/alice`);
      expect(response1.status).toBe(400);

      const data1 = (await response1.json()) as ErrorResponse;
      expect(data1).toHaveProperty("status", "ERROR");
      expect(data1.reason).toContain("Missing amount parameter");

      // Invalid amount
      const response2 = await fetch(
        `${baseUrl}/lnurlp/callback/alice?amount=invalid`,
      );
      expect(response2.status).toBe(400);

      const data2 = (await response2.json()) as ErrorResponse;
      expect(data2).toHaveProperty("status", "ERROR");
      expect(data2.reason).toContain("Invalid amount parameter");

      // Zero amount
      const response3 = await fetch(
        `${baseUrl}/lnurlp/callback/alice?amount=0`,
      );
      expect(response3.status).toBe(400);

      const data3 = await response3.json();
      expect(data3).toHaveProperty("status", "ERROR");
    });

    test("should validate amount range", async () => {
      // Amount below minimum
      const response1 = await fetch(
        `${baseUrl}/lnurlp/callback/alice?amount=500`,
      );
      expect(response1.status).toBe(400);

      const data1 = (await response1.json()) as ErrorResponse;
      expect(data1).toHaveProperty("status", "ERROR");
      expect(data1.reason).toContain("Amount out of range");

      // Amount above maximum
      const response2 = await fetch(
        `${baseUrl}/lnurlp/callback/alice?amount=200000000`,
      );
      expect(response2.status).toBe(400);

      const data2 = (await response2.json()) as ErrorResponse;
      expect(data2).toHaveProperty("status", "ERROR");
      expect(data2.reason).toContain("Amount out of range");
    });

    test("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${baseUrl}/lnurlp/callback/nonexistent?amount=1000`,
      );
      expect(response.status).toBe(404);

      const data = (await response.json()) as ErrorResponse;
      expect(data).toHaveProperty("status", "ERROR");
      expect(data.reason).toContain("User not found");
    });
  });

  describe("Metadata Format", () => {
    test("should include text/plain entry", async () => {
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/alice`);
      const data = (await response.json()) as LnUrlRawData;
      const metadata = JSON.parse(data.metadata) as string[][];

      const textPlainEntry = metadata.find(
        (entry: any[]) => entry[0] === "text/plain",
      );
      expect(textPlainEntry).toBeDefined();
      expect(textPlainEntry).toBeDefined();
      expect(textPlainEntry).not.toBeUndefined();
      expect(typeof textPlainEntry![1]).toBe("string");
      expect((textPlainEntry![1] as string).length).toBeGreaterThan(0);
    });

    test("should include text/identifier entry", async () => {
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/alice`);
      const data = (await response.json()) as LnUrlRawData;
      const metadata = JSON.parse(data.metadata) as string[][];

      const textIdentifierEntry = metadata.find(
        (entry: any[]) => entry[0] === "text/identifier",
      );
      expect(textIdentifierEntry).toBeDefined();
      expect(textIdentifierEntry![1]).toMatch(/^alice@/);
    });

    test("should include text/long-desc when available", async () => {
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/alice`);
      const data = (await response.json()) as LnUrlRawData;
      const metadata = JSON.parse(data.metadata) as string[][];

      const textLongDescEntry = metadata.find(
        (entry: any[]) => entry[0] === "text/long-desc",
      );
      expect(textLongDescEntry).toBeDefined();
      expect(textLongDescEntry).not.toBeUndefined();
      expect(typeof textLongDescEntry![1]).toBe("string");
      expect((textLongDescEntry![1] as string).length).toBeGreaterThan(0);
    });

    test("should handle users without long description", async () => {
      // Create a test user without long description if needed
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/bob`);
      const data = (await response.json()) as LnUrlRawData;
      const metadata = JSON.parse(data.metadata) as string[][];

      const textLongDescEntry = metadata.find(
        (entry: any[]) => entry[0] === "text/long-desc",
      );
      // Bob should have a long description in our test data, but if not, it should be handled gracefully
      if (textLongDescEntry) {
        expect(typeof textLongDescEntry[1]).toBe("string");
      }
    });
  });

  describe("Health and Info Endpoints", () => {
    test("health endpoint should return OK", async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);

      const text = await response.text();
      expect(text).toBe("OK");
    });

    test("root endpoint should return service info", async () => {
      const response = await fetch(`${baseUrl}/`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as any;
      expect(data).toHaveProperty("service", "LUD-16 LNURL Provider");
      expect(data).toHaveProperty("version");
      expect(data).toHaveProperty("endpoints");
      expect(data).toHaveProperty("supportedUsers");
      expect(Array.isArray(data.supportedUsers)).toBe(true);
      expect(data.supportedUsers.length).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    test("should handle server errors gracefully", async () => {
      // Test with malformed URL that might cause issues
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/`);
      expect(response.status).toBe(404);
    });

    test("should return proper error format", async () => {
      const response = await fetch(`${baseUrl}/.well-known/lnurlp/nonexistent`);
      const data = (await response.json()) as ErrorResponse;

      expect(data).toHaveProperty("status", "ERROR");
      expect(data).toHaveProperty("reason");
      expect(typeof data.reason).toBe("string");
      expect(data.reason.length).toBeGreaterThan(0);
    });
  });

  describe("LUD-16 Specification Compliance", () => {
    test("should support email-like addresses format", async () => {
      // Test that the service properly handles the LUD-16 format
      const users = ["alice", "bob", "charlie"];

      for (const username of users) {
        const response = await fetch(
          `${baseUrl}/.well-known/lnurlp/${username}`,
        );
        expect(response.status).toBe(200);

        const data = (await response.json()) as LnUrlRawData;

        // Verify the callback URL follows the expected pattern
        expect(data.callback).toContain(`/lnurlp/callback/${username}`);

        // Verify metadata includes proper identifier
        const metadata = JSON.parse(data.metadata) as string[][];
        const identifierEntry = metadata.find(
          (entry: any[]) => entry[0] === "text/identifier",
        );
        expect(identifierEntry).toBeDefined();
        expect(identifierEntry![1]).toBe(`${username}@localhost`);
      }
    });

    test("should handle the complete payment flow", async () => {
      // Step 1: Get payment request
      const paymentResponse = await fetch(
        `${baseUrl}/.well-known/lnurlp/alice`,
      );
      expect(paymentResponse.status).toBe(200);

      const paymentData = (await paymentResponse.json()) as LnUrlRawData;

      // Step 2: Request invoice
      const amount = 5000; // 5 satoshis
      const invoiceResponse = await fetch(
        `${paymentData.callback}?amount=${amount}`,
      );
      expect(invoiceResponse.status).toBe(200);

      const invoiceData = await invoiceResponse.json();
      expect(invoiceData).toHaveProperty("pr");
      expect(invoiceData).toHaveProperty("routes", []);
    });
  });
});
