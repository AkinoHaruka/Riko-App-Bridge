import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../dist/index.js";

const bridgeToken = "riko-mobile-bridge-test-token-0123456789";

test("mobile model settings follow DSH settings and write-only credential flows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "riko-mobile-model-settings-"));
  const tokenPath = join(directory, "bridge-token");
  const registryPath = join(directory, "session-registry.json");
  const accountStorePath = join(directory, "accounts.json");
  await writeFile(tokenPath, bridgeToken, { mode: 0o600 });

  const state = {
    namespace: {
      ns: "llm-pi-ai",
      revision: 1,
      value: {
        providers: {
          openai: {
            api: "openai-completions",
            baseURL: "https://api.openai.com/v1",
            models: [{ id: "gpt-test" }],
          },
        },
      },
      user: { providers: {} },
    },
    credentials: new Map(),
    failAcmeCredentialOnce: true,
    discoveredRequest: undefined,
  };

  const settings = {
    writable: true,
    describe: () => [structuredClone(state.namespace)],
    async mutate(namespace, ops, expectedRevision) {
      assert.equal(namespace, "llm-pi-ai");
      if (expectedRevision !== undefined && expectedRevision !== state.namespace.revision) {
        const error = new Error("stale settings revision");
        error.code = "SETTINGS_CONFLICT";
        throw error;
      }
      for (const op of ops) {
        for (const root of [state.namespace.value, state.namespace.user]) {
          let cursor = root;
          for (const part of op.path.slice(0, -1)) {
            cursor[part] ??= {};
            cursor = cursor[part];
          }
          const leaf = op.path.at(-1);
          if (op.op === "set") cursor[leaf] = structuredClone(op.value);
          else delete cursor[leaf];
        }
      }
      state.namespace.revision += 1;
    },
  };

  const credentials = {
    async describe(reference) { return { configured: state.credentials.has(reference), writable: true }; },
    async set(reference, value) {
      if (reference === "ACME_GATEWAY_API_KEY" && state.failAcmeCredentialOnce) {
        state.failAcmeCredentialOnce = false;
        throw new Error(`test backend failure echoed ${value}`);
      }
      state.credentials.set(reference, value);
    },
    async unset(reference) { state.credentials.delete(reference); },
  };

  const configurableProviders = () => {
    const profiles = state.namespace.value.providers ?? {};
    return Object.entries(profiles).map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName ?? provider,
      settingsNs: "llm-pi-ai",
      settingsPath: ["providers", provider],
      declared: provider !== "openai",
    }));
  };
  const llm = {
    listConfigurableProviders: configurableProviders,
    listProviders: () => configurableProviders().map((entry) => ({ id: entry.provider, name: entry.displayName })),
    async discoverModels(settingsNs, request) {
      assert.equal(settingsNs, "llm-pi-ai");
      state.discoveredRequest = request;
      return [{ id: "discovered-model", name: "Discovered", contextWindow: 128000 }];
    },
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
    sessionController: {
      createdSessions: new Set(),
      async list() {
        return { items: [...this.createdSessions].map((sessionId) => ({ sessionId, updatedAt: 1, running: false, blank: false })) };
      },
      async create({ sessionId, agentPreset }) {
        this.createdSessions.add(sessionId);
        return { sessionId, agentPreset };
      },
      async modelCatalog() {
        return {
          groups: Object.entries(state.namespace.value.providers).map(([id, profile]) => ({
            id,
            name: profile.displayName ?? id,
            models: profile.models ?? [],
          })),
        };
      },
      async selectModel(request) { return request; },
    },
    settings,
    credentials,
    llm,
    effect(effect) { effect(); },
    logger: { info() {}, warn() {}, error() {} },
  };

  try {
    apply(ctx, {
      apiTokenFile: tokenPath,
      sessionRegistryFile: registryPath,
      accountStoreFile: accountStorePath,
      allowedProviderHosts: ["alice.example"],
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}/riko-app-api/v1`;
    const request = async (path, method = "GET", body, token = bridgeToken) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };

    const described = await request("/model-settings");
    assert.equal(described.status, 200);
    assert.equal(described.body.providers[0].id, "openai");
    assert.equal(JSON.stringify(described.body).includes(bridgeToken), false);

    const keyWrite = await request("/model-settings/providers/openai/credential", "POST", {
      apiKey: "fake-openai-key-never-returned",
      expectedRevision: 1,
    });
    assert.equal(keyWrite.status, 200);
    assert.equal(state.namespace.value.providers.openai.apiKeyEnv, "OPENAI_API_KEY");
    assert.equal(state.credentials.get("OPENAI_API_KEY"), "fake-openai-key-never-returned");

    const discovery = await request("/model-settings/discover", "POST", {
      baseURL: "https://gateway.example/v1",
      api: "openai-completions",
      apiKey: "fake-discovery-key-never-returned",
    });
    assert.equal(discovery.status, 200);
    assert.equal(discovery.body.models[0].id, "discovered-model");
    assert.equal(JSON.stringify(discovery.body).includes("fake-discovery-key-never-returned"), false);

    const customProvider = {
      provider: "acme-gateway",
      displayName: "Acme Gateway",
      baseURL: "https://gateway.example/v1",
      api: "openai-completions",
      expectedRevision: 2,
      apiKey: "fake-acme-key-never-returned",
      models: [{ id: "acme-chat", name: "Acme Chat", contextWindow: 64000 }],
    };
    const firstCreate = await request("/model-settings/custom-providers", "POST", customProvider);
    assert.equal(firstCreate.status, 502);
    assert.equal(JSON.stringify(firstCreate.body).includes("fake-acme-key-never-returned"), false);

    const retryCreate = await request("/model-settings/custom-providers", "POST", customProvider);
    assert.equal(retryCreate.status, 200);
    assert.equal(state.namespace.value.providers["acme-gateway"].apiKeyEnv, "ACME_GATEWAY_API_KEY");
    assert.equal(state.credentials.get("ACME_GATEWAY_API_KEY"), "fake-acme-key-never-returned");

    const alice = await request("/auth/register", "POST", {
      username: "alice",
      password: "correct horse battery staple",
    });
    assert.equal(alice.status, 201);
    const aliceToken = alice.body.accessToken;
    assert.equal((await request("/model-settings/custom-providers", "POST", {
      provider: "internal-probe",
      displayName: "Internal probe",
      baseURL: "http://127.0.0.1:8080/internal",
      api: "openai-completions",
      apiKey: "unused",
      models: [{ id: "probe" }],
    }, aliceToken)).status, 400);
    const aliceProvider = await request("/model-settings/custom-providers", "POST", {
      provider: "personal-gateway",
      displayName: "Alice Gateway",
      baseURL: "https://alice.example/v1",
      api: "openai-responses",
      apiKey: "alice-only-secret-key",
      models: [{ id: "alice-model" }],
    }, aliceToken);
    assert.equal(aliceProvider.status, 200);
    assert.equal(JSON.stringify(aliceProvider.body).includes("alice-only-secret-key"), false);
    const aliceSettings = await request("/model-settings", "GET", undefined, aliceToken);
    assert.equal(aliceSettings.status, 200);
    assert.deepEqual(aliceSettings.body.providers.filter((item) => item.custom).map((item) => item.id), ["personal-gateway"]);
    assert.equal(aliceSettings.body.canDiscover, false);
    assert.equal(JSON.stringify(aliceSettings.body).includes("alice-only-secret-key"), false);
    assert.equal((await request("/model-settings/discover", "POST", {
      baseURL: "http://127.0.0.1:8080/internal",
      api: "openai-completions",
    }, aliceToken)).status, 403);
    assert.equal((await request("/model-settings/providers/openai/credential", "POST", {
      apiKey: "should-not-write-global-key",
    }, aliceToken)).status, 403);

    const bob = await request("/auth/register", "POST", {
      username: "bob",
      password: "another correct horse battery",
    });
    assert.equal(bob.status, 201);
    const bobSettings = await request("/model-settings", "GET", undefined, bob.body.accessToken);
    assert.deepEqual(bobSettings.body.providers.filter((item) => item.custom).map((item) => item.id), []);
    assert.equal((await request("/model-settings/custom-providers/personal-gateway", "DELETE", undefined, bob.body.accessToken)).status, 404);

    const aliceModels = await request("/models", "GET", undefined, aliceToken);
    assert.equal(aliceModels.body.groups.some((item) => item.id === "acme-gateway"), false);
    assert.equal(aliceModels.body.groups.some((item) => item.id === "riko-u-" + alice.body.account.userId.replaceAll("-", "") + "-personal-gateway"), true);
    const bobModels = await request("/models", "GET", undefined, bob.body.accessToken);
    assert.equal(bobModels.body.groups.some((item) => item.id.includes("personal-gateway")), false);

    const aliceSession = await request("/sessions", "POST", { requestId: "22222222-2222-4222-8222-222222222222" }, aliceToken);
    const bobSession = await request("/sessions", "POST", { requestId: "33333333-3333-4333-8333-333333333333" }, bob.body.accessToken);
    const crossAccountModel = await request(
      `/sessions/${bobSession.body.sessionId}/model`,
      "POST",
      { provider: "riko-u-" + alice.body.account.userId.replaceAll("-", "") + "-personal-gateway", model: "alice-model" },
      bob.body.accessToken,
    );
    assert.equal(crossAccountModel.status, 404);
    assert.equal((await request(`/sessions/${aliceSession.body.sessionId}/history`, "GET", undefined, bob.body.accessToken)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
