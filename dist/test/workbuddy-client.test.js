import assert from "node:assert/strict";
import test from "node:test";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
const config = {
    apiBaseUrl: "https://test.workbuddy",
    clientId: "client",
    clientSecret: "secret",
    accessToken: "access",
    tokenFile: "/tmp/unused-workbuddy-token.json",
    dbFile: "/tmp/unused-workbuddy.sqlite",
    oauthRedirectUri: "http://127.0.0.1:8787/oauth/callback",
    oauthPort: 8787,
    oauthScopes: "user.localassistant.invokable user.localassistant.readable",
    requestTimeoutMs: 1000,
};
test("calls the documented local assistant endpoints and normalizes envelopes", async () => {
    const seen = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        seen.push({ url, init });
        if (url.endsWith("/localassistant"))
            return new Response(JSON.stringify({ code: 0, data: { online: true } }), { status: 200 });
        if (url.endsWith("/localassistant/message") && init.method === "POST")
            return new Response(JSON.stringify({ code: 0, data: { message_id: "msg-1" } }), { status: 200 });
        return new Response(JSON.stringify({ code: 0, data: { messages: [{ message_id: "msg-2", role: "assistant", content: ["TASK_STATUS: completed"], msg_type: "text" }] } }), { status: 200 });
    };
    try {
        const client = new WorkBuddyClient(config);
        assert.deepEqual((await client.health()).online, true);
        assert.equal((await client.sendMessage("hello")).messageId, "msg-1");
        assert.equal((await client.messages({ afterMessageId: "msg-1" }))[0]?.message_id, "msg-2");
        assert.equal(seen[0]?.init.headers && new Headers(seen[0].init.headers).get("authorization"), "Bearer access");
        const sendBody = JSON.parse(String(seen[1]?.init.body));
        assert.deepEqual(sendBody, { content: "hello", msg_type: "text" });
        assert.match(seen[2]?.url ?? "", /message_id=msg-1/);
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});
test("rejects WorkBuddy business errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 403, msg: "insufficient_scope" }), { status: 200 });
    try {
        await assert.rejects(() => new WorkBuddyClient(config).health(), /WorkBuddy API error 403/);
    }
    finally {
        globalThis.fetch = originalFetch;
    }
});
//# sourceMappingURL=workbuddy-client.test.js.map