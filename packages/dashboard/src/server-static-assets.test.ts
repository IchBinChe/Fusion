import express from "express";
import { describe, expect, it } from "vitest";

describe("static asset serving", () => {
  it("returns 404 for missing asset paths instead of falling back to index.html", async () => {
    const app = express();

    app.use(express.static("packages/dashboard/dist/client", { index: false }));

    app.get(/^(?!\/assets\/).*/, (_req, res) => {
      res.sendFile("index.html", { root: "packages/dashboard/dist/client" });
    });

    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Failed to get test server port");

      const res = await fetch(`http://127.0.0.1:${address.port}/assets/does-not-exist.js`);

      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
