export const send = (res, status, data, headers = {}) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    ...headers,
  });
  res.end(JSON.stringify(data));
};

export const sendData = (res, status, data) => send(res, status, { ok: true, data });

export async function readRequestBody(req) {
  const parts = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 30 * 1024 * 1024) {
      throw Object.assign(new Error("请求内容不能超过 30MB"), { code: "REQUEST_TOO_LARGE" });
    }
    parts.push(chunk);
  }
  return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
}
