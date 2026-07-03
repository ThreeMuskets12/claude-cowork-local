import app from "./index.ts";

const PORT = Number(process.env.PORT || 8787);

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${req.method} ${new URL(req.url).pathname}`);
    return app.fetch(req);
  },
});

console.log(`opencode-cowork-proxy listening on http://localhost:${server.port}`);
