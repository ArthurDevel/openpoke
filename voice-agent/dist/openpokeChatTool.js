function normalizeBaseUrl(value) {
    return value.replace(/\/$/, "");
}
function getMessages(payload) {
    return Array.isArray(payload.messages) ? payload.messages : [];
}
export async function fetchChatHistory(env) {
    const baseUrl = normalizeBaseUrl(env.openpokeServerUrl);
    const historyUrl = `${baseUrl}/api/v1/chat/history`;
    const response = await fetch(historyUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) {
        throw new Error(`OpenPoke chat history failed (${response.status})`);
    }
    const payload = (await response.json());
    return getMessages(payload);
}
export async function sendChatMessage(env, message) {
    const baseUrl = normalizeBaseUrl(env.openpokeServerUrl);
    const sendUrl = `${baseUrl}/api/v1/chat/send`;
    const sendResponse = await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/plain, */*" },
        body: JSON.stringify({
            system: "",
            messages: [{ role: "user", content: message.trim() }],
            stream: false,
        }),
    });
    if (!(sendResponse.ok || sendResponse.status === 202)) {
        const detail = await sendResponse.text();
        throw new Error(detail || `OpenPoke chat send failed (${sendResponse.status})`);
    }
}
