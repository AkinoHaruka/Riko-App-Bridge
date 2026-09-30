import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../dist/index.js";

const adminToken = "riko-mobile-bridge-admin-test-token-0123456789";

test("open registration issues hashed account tokens and isolates DSH sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "riko-mobile-accounts-"));
  const tokenPath = join(directory, "admin-token");
  const registryPath = join(directory, "session-registry.json");
  const accountStorePath = join(directory, "accounts.json");
  await writeFile(tokenPath, adminToken, { mode: 0o600 });
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    sessions: ["legacy-session"],
    createRequests: { "old-request-id": "legacy-session" },
  }));

  const sessions = new Map([["legacy-session", "riko"]]);
  const sessionController = {
    async list() {
      return { items: [...sessions.keys()].map((sessionId) => ({ sessionId, updatedAt: 1, running: false, blank: false })) };
    },
    async create({ sessionId, agentPreset }) {
      sessions.set(sessionId, agentPreset);
      return { sessionId, agentPreset };
    },
    async modelCatalog() { return { groups: [{ id: "builtin", models: [] }] }; },
  };

  let handler;
  const server = createServer((req, res) => { void handler(req, res); });
  const ctx = {
    webServer: {
      register(route) {
        assert.equal(route.path, "/riko-app-api/v1");
        handler = route.handler;
        return () => { handler = undefined; };
      },
    },
    sessionController,
    settings: {},
    credentials: {},
    llm: { listConfigurableProviders: () => [], listProviders: () => [] },
    effect(effect) { effect(); },
    logger: { info() {}, warn() {}, error() {} },
  };

  try {
    apply(ctx, {
      apiTokenFile: tokenPath,
      sessionRegistryFile: registryPath,
      accountStoreFile: accountStorePath,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}/riko-app-api/v1`;
    const request = async (path, { token, method = "GET", body, address: clientAddress = "203.0.113.10" } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "x-real-ip": clientAddress,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await request("/health")).status, 200);
    assert.equal((await request("/sessions")).status, 401);

    const registered = await request("/auth/register", {
      method: "POST",
      body: { username: "Alice", password: "correct horse battery staple" },
    });
    assert.equal(registered.status, 201);
    const aliceToken = registered.body.accessToken;
    const aliceId = registered.body.account.userId;
    assert.equal(registered.body.account.username, "alice");
    assert.equal(typeof aliceToken, "string");
    assert.equal((await request("/auth/me", { token: aliceToken })).body.userId, aliceId);

    const persistedAccounts = await readFile(accountStorePath, "utf8");
    assert.equal(persistedAccounts.includes("correct horse battery staple"), false);
    assert.equal(persistedAccounts.includes(aliceToken), false);
    assert.match(persistedAccounts, /passwordHash/);

    assert.equal((await request("/auth/register", {
      method: "POST",
      body: { username: "ALICE", password: "another correct horse battery" },
    })).status, 409);
    assert.equal((await request("/auth/login", {
      method: "POST",
      body: { username: "alice", password: "wrong password" },
    })).status, 401);

    const aliceSession = await request("/sessions", {
      token: aliceToken,
      method: "POST",
      body: { requestId: "11111111-1111-4111-8111-111111111111" },
    });
    assert.equal(aliceSession.status, 201);
    const bob = await request("/auth/register", {
      method: "POST",
      address: "203.0.113.11",
      body: { username: "bob", password: "another correct horse battery" },
    });
    assert.equal(bob.status, 201);

    const bobSessions = await request("/sessions", { token: bob.body.accessToken });
    assert.deepEqual(bobSessions.body.items, []);
    assert.equal((await request(`/sessions/${aliceSession.body.sessionId}/history`, { token: bob.body.accessToken })).status, 404);
    assert.deepEqual(
      (await request("/sessions", { token: aliceToken })).body.items.map((item) => item.sessionId),
      [aliceSession.body.sessionId],
    );

    // The previous shared-token registry is available only to the operator.
    assert.deepEqual((await request("/sessions", { token: adminToken })).body.items.map((item) => item.sessionId).sort(),
      ["legacy-session", aliceSession.body.sessionId].sort());
    assert.equal((await request("/sessions/legacy-session/history", { token: aliceToken })).status, 404);

    assert.equal((await request("/auth/logout", { token: aliceToken, method: "POST", body: {} })).status, 200);
    assert.equal((await request("/auth/me", { token: aliceToken })).status, 401);
    const loggedIn = await request("/auth/login", {
      method: "POST",
      address: "203.0.113.12",
      body: { username: "alice", password: "correct horse battery staple" },
    });
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.account.userId, aliceId);

    const migratedRegistry = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal(migratedRegistry.version, 2);
    assert.equal(migratedRegistry.legacy.sessions[0], "legacy-session");
    assert.deepEqual(migratedRegistry.users[aliceId].sessions, [aliceSession.body.sessionId]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
