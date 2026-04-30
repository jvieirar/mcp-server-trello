const PORT = Number(process.env.WEBHOOK_PORT ?? 8899);

export function startWebhookServer() {
  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname !== '/webhook') {
        return new Response('Not found', { status: 404 });
      }

      // Trello verifies the endpoint with HEAD before registering
      if (req.method === 'HEAD' || req.method === 'GET') {
        return new Response(null, { status: 200 });
      }

      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response('Bad request', { status: 400 });
        }

        console.error(
          `[webhook] ${new Date().toISOString()}\n` +
          JSON.stringify(body, null, 2)
        );

        return new Response('OK', { status: 200 });
      }

      return new Response('Method not allowed', { status: 405 });
    },
  });

  console.error(`[webhook] listening on port ${PORT}`);
}
