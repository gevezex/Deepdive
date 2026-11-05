// Lokale nep van OpenAI's aanmeldserver en Responses API. Controleert wat de echte dienst volgens de
// documentatie eist, zodat de test faalt als de app daarvan afwijkt. Gebruikt willekeurige nep-tokens.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";

const b64 = (v) => Buffer.from(v).toString("base64url");
const FORBIDDEN = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"];
const PLAN = "chatgpt.tokens.use.direct";
const ALL_SCOPES = `openid profile email offline_access resource.invoke ${PLAN}`;
const SECRET_MARK = randomBytes(6).toString("hex");

export function startChatgptMock() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const state = {
    log: [],
    violations: [],
    codes: new Map(),
    refreshTokens: new Map(),
    accessTokens: new Set(),
    issued: { access: [], refresh: [], id: [] },
    revoked: [],
    clientId: `oaiapp_nep_${SECRET_MARK}`,
    subject: "sub-e2e",
    email: "lezer@example.com",
    scope: ALL_SCOPES,
    expiresIn: 3600,
    responsesMode: "ok",
    browserMode: "ok",
    tokenFailure: null,
  };
  let base = "";

  const signed = (claims) => {
    const body = `${b64(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }))}.${b64(JSON.stringify(claims))}`;
    return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
  };

  const issue = (clientId, nonce) => {
    const n = randomBytes(16).toString("hex");
    const access = `nep-toegang-${n}`;
    const refresh = `nep-vernieuw-${n}`;
    state.accessTokens.add(access);
    state.refreshTokens.set(refresh, clientId);
    state.issued.access.push(access);
    state.issued.refresh.push(refresh);
    const reply = { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: state.expiresIn, scope: state.scope, earliest_refresh_at: 0 };
    if (nonce !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      reply.id_token = signed({ iss: base, sub: state.subject, aud: [clientId], nonce, email: state.email, iat: now, exp: now + 3600 });
      state.issued.id.push(reply.id_token);
    }
    return reply;
  };

  const check = (ok, what) => {
    if (!ok) state.violations.push(what);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "x-request-id": "req_e2e" });
    res.end(JSON.stringify(body));
  };

  function authorize(url, res) {
    const q = Object.fromEntries(url.searchParams);
    for (const name of ["client_id", "ext_agent_host_id", "response_type", "redirect_uri", "scope", "resource", "state", "nonce", "code_challenge_method", "code_challenge"]) check(q[name], `authorize zonder ${name}`);
    check(q.response_type === "code", "response_type");
    check(q.code_challenge_method === "S256", "code_challenge_method");
    check(q.resource === "https://api.openai.com/v1", "resource");
    check(q.scope === ALL_SCOPES, `scope ${q.scope}`);
    check(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(q.redirect_uri), `redirect_uri ${q.redirect_uri}`);
    check(/^urn:uuid:[0-9a-f-]{36}$/.test(q.ext_agent_host_id), `host-id ${q.ext_agent_host_id}`);
    const fresh = q.client_id === "dynamic_agent_client";
    check(fresh === (q.agent_name_hint === "Deepdive"), "agent_name_hint hoort alleen bij de eerste registratie");
    check(fresh || q.client_id === state.clientId, `onbekende client ${q.client_id}`);
    const target = new URL(q.redirect_uri);
    const mode = state.browserMode;
    if (mode === "deny") {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("state", q.state);
    } else {
      const code = `code-${randomBytes(8).toString("hex")}`;
      state.codes.set(code, { challenge: q.code_challenge, redirect: q.redirect_uri, nonce: mode === "badnonce" ? "verkeerd" : q.nonce, used: false, resource: q.resource });
      target.searchParams.set("code", code);
      target.searchParams.set("state", q.state);
      if (fresh) target.searchParams.set("client_id", state.clientId);
    }
    res.writeHead(302, { Location: target.toString() });
    res.end();
  }

  function token(form, res) {
    if (state.tokenFailure) {
      const { status, code } = state.tokenFailure;
      state.tokenFailure = null;
      return json(res, status, { error: code });
    }
    check(form.client_id !== "dynamic_agent_client", "dynamic_agent_client bij het token-adres");
    check(!("client_secret" in form), "client_secret");
    check(form.resource === "https://api.openai.com/v1", "resource bij token");
    check(form.client_id === state.clientId, `token voor client ${form.client_id}`);
    if (form.grant_type === "authorization_code") {
      const entry = state.codes.get(form.code);
      if (!entry || entry.used) return json(res, 400, { error: "invalid_grant" });
      entry.used = true;
      const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
      check(challenge === entry.challenge, "PKCE klopt niet");
      check(form.redirect_uri === entry.redirect, "redirect_uri verschilt");
      return json(res, 200, issue(form.client_id, entry.nonce));
    }
    if (form.grant_type === "refresh_token") {
      check(!("scope" in form), "scope bij vernieuwen");
      // Een token is na gebruik ongeldig. Zo ziet de test het ook als de app dezelfde twee keer gebruikt.
      if (!state.refreshTokens.has(form.refresh_token)) {
        state.violations.push("onbekend of hergebruikt vernieuwingstoken");
        return json(res, 400, { error: "refresh_token_reused" });
      }
      state.refreshTokens.delete(form.refresh_token);
      return json(res, 200, issue(form.client_id));
    }
    json(res, 400, { error: "unsupported_grant_type" });
  }

  async function responses(req, body, res) {
    check(state.accessTokens.has((req.headers.authorization ?? "").replace("Bearer ", "")), "onbekend toegangstoken");
    const data = JSON.parse(body);
    check(data.store === false, "store");
    check(data.stream === true, "stream");
    check(Array.isArray(data.input), "input geen lijst");
    check(!data.input.some((i) => i.role === "system"), "system-item");
    for (const name of FORBIDDEN) check(!(name in data), `verboden veld ${name}`);
    const mode = state.responsesMode;
    if (mode === "limit") return json(res, 429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limiet" } });
    if (mode === "ineligible") return json(res, 403, { error: { code: "subscription_sharing_user_not_eligible", message: "geen abonnement" } });
    if (mode === "revoked") return json(res, 401, { detail: "Bearer ongeldig" });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const delta of ["Wer", "kt", " via ChatGPT"]) {
      send({ type: "response.output_text.delta", delta });
      await new Promise((r) => setTimeout(r, 150));
    }
    if (mode === "limit_mid_stream") send({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limiet" } } });
    else send({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } });
    res.end();
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const body = Buffer.concat(chunks).toString();
      const form = req.headers["content-type"]?.includes("form") ? Object.fromEntries(new URLSearchParams(body)) : {};
      state.log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, form });
      switch (url.pathname) {
        case "/.well-known/openid-configuration":
          return json(res, 200, { issuer: base, authorization_endpoint: `${base}/api/accounts/authorize`, token_endpoint: `${base}/api/accounts/oauth/token`, jwks_uri: `${base}/jwks`, revocation_endpoint: `${base}/revoke` });
        case "/jwks":
          return json(res, 200, { keys: [jwk] });
        case "/api/accounts/authorize":
          return authorize(url, res);
        case "/api/accounts/oauth/token":
          return token(form, res);
        case "/revoke":
          state.revoked.push(form);
          state.refreshTokens.delete(form.token);
          res.writeHead(200);
          return res.end();
        case "/v1/models":
          if (state.responsesMode === "revoked") return json(res, 401, { detail: "ongeldig" });
          return json(res, 200, { models: [
            { slug: "nep-gpt-snel", display_name: "Nep GPT Snel", visibility: "list" },
            { slug: "nep-verborgen", display_name: "Verborgen", visibility: "hide" },
            { slug: "nep-gpt-diep", display_name: "Nep GPT Diep", visibility: "list" },
          ] });
        case "/v1/responses":
          return responses(req, body, res);
        default:
          res.writeHead(404);
          return res.end();
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, state, close: () => { server.closeAllConnections(); server.close(); } });
    }),
  );
}
