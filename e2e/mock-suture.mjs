import http from 'node:http';

/**
 * A stand-in for the Suture agent API (`<admin console>/api/agent/v1`), for the growth numbers tests. It answers
 * the read calls in the shapes the real one documents, and can be switched to the states a collector must cope
 * with: off (503 agent_api_off), a refused token (401), and an answer in a shape nobody expects.
 */

const source = (label, campaign) => ({ label, ...(campaign ? { utm_campaign: campaign } : {}) });

export async function startMockSuture({ token = `test-token-${'x'.repeat(32)}` } = {}) {
  const state = {
    // 'ok' | 'off' | 'odd'
    mode: 'ok',
    token,
    requests: [],
    // Sign-ups by UTC day: a list of [source label, campaign?]
    signups: {},
  };
  const today = () => new Date().toISOString().slice(0, 10);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    state.requests.push({
      path: url.pathname,
      auth: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
    });
    if (!url.pathname.startsWith('/api/agent/v1')) return send(404, { error: { code: 'not_found', message: 'No.' } });
    if (state.mode === 'off') {
      return send(503, { error: { code: 'agent_api_off', message: 'The agent API is off here.' } });
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) {
      return send(401, { error: { code: 'unauthorized', message: 'A valid agent token is required.' } });
    }
    const path = url.pathname.slice('/api/agent/v1'.length);
    const day = url.searchParams.get('since') ?? today();
    const windowed = { read_at: new Date().toISOString(), since: day, until: url.searchParams.get('until') };
    const list = rows => {
      const items = rows.map(([label, campaign]) => ({
        created_at: `${day}T08:00:00.000Z`,
        source: source(label, campaign),
      }));
      const counts = new Map();
      for (const item of items) counts.set(item.source.label, (counts.get(item.source.label) ?? 0) + 1);
      return {
        ...windowed,
        total: items.length,
        truncated: false,
        by_source: [...counts].map(([label, count]) => ({ source: label, count })),
        items,
      };
    };
    switch (path) {
      case '':
      case '/':
        return send(200, { name: 'suture-agent-api', version: 1, read_at: new Date().toISOString() });
      case '/signups':
        if (state.mode === 'odd') return send(200, { signups: 7 });
        return send(200, { ...list(state.signups[day] ?? []), available: true });
      case '/waitlist':
      case '/access-requests':
      case '/feedback':
        return send(200, list([]));
      case '/spend':
        return send(200, { ...windowed, total_usd: 0, truncated: false, items: [] });
      case '/payments':
        return send(200, {
          ...windowed,
          available: false,
          reason: 'payments_not_recorded',
          total: null,
          items: [],
          paid_orgs: [],
        });
      case '/orgs':
        return send(200, {
          read_at: new Date().toISOString(),
          total: 3,
          truncated: false,
          active_7d: 2,
          by_plan: [{ plan: 'free', count: 3 }],
          by_source: [],
          items: [],
        });
      default:
        return send(404, { error: { code: 'not_allowed', message: 'No.' } });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    today,
    baseUrl: `http://127.0.0.1:${port}/api/agent/v1`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
