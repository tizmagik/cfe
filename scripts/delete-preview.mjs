import { pathToFileURL } from "node:url";

export async function deletePreview({
  prNumber,
  accountId,
  token,
  fetchApi = fetch,
}) {
  if (!/^[1-9]\d*$/.test(prNumber ?? "")) throw new Error("Invalid PR_NUMBER");
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !token) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
    );
  }
  const worker = `cfe-pr-${prNumber}`;
  const hostname = `pr-${prNumber}.christforeveryone.org`;
  const base = `/accounts/${accountId}/workers`;
  async function api(path, method = "GET", allowMissing = false) {
    const response = await fetchApi(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (allowMissing && response.status === 404) return null;
    const body = await response.text();
    const data = body ? JSON.parse(body) : {};
    if (!response.ok || data.success === false) {
      throw new Error(
        `Cloudflare ${method} ${path} failed: HTTP ${response.status}`,
      );
    }
    return data.result;
  }
  const query = new URLSearchParams({ hostname });
  const domains = await api(`${base}/domains?${query}`);
  // Refuse to detach a hostname if it has been reassigned to another Worker.
  for (const domain of domains) {
    if (domain.hostname !== hostname || domain.service !== worker) {
      throw new Error("Preview domain ownership mismatch");
    }
  }
  for (const domain of domains) {
    await api(
      `${base}/domains/${encodeURIComponent(domain.id)}`,
      "DELETE",
      true,
    );
  }
  await api(`${base}/scripts/${worker}`, "DELETE", true);
  if ((await api(`${base}/domains?${query}`)).length) {
    throw new Error("Preview domain still exists");
  }
  // Workers' script GET returns the script body when it exists, rather than JSON.
  const remaining = await fetchApi(
    `https://api.cloudflare.com/client/v4${base}/scripts/${worker}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (remaining.status !== 404)
    throw new Error("Preview Worker removal not verified");
  return { worker, hostname };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await deletePreview({
    prNumber: process.env.PR_NUMBER,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  console.log(`Verified removal of ${result.worker} and ${result.hostname}`);
}
