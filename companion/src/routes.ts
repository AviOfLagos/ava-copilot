import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  ARTIFACT_HEADERS,
  artifactCreateRequestSchema,
  COMPANION_PROTOCOL_VERSION,
  COMPANION_ROUTES,
  cursorRequestSchema,
  ghRequestSchema,
  healthRequestSchema,
  APP_ROUTES,
  DOCKER_ROUTES,
  MEET_ROUTES,
  MEET_SAY_MAX_BODY_BYTES,
  appOpenRequestSchema,
  meetJoinRequestSchema,
  meetSayRequestSchema,
  pairRequestSchema,
  autoPairRequestSchema,
  sandboxRunRequestSchema,
  sessionAnswerRequestSchema,
  sessionCreateRequestSchema,
  sessionMessageRequestSchema,
  STUDIO_SCRIPT,
  STUDIO_STYLE,
  studioCsp,
  studioPageHtml,
  studioSessionRequestSchema,
  toolCallRequestSchema,
  workflowAckRequestSchema,
  workflowAnswerRequestSchema,
  workflowPutRequestSchema,
  workflowRunRequestSchema,
  WHATSAPP_ROUTES,
  whatsappAckRequestSchema,
  whatsappOwnerRequestSchema,
  whatsappQuietRequestSchema,
  whatsappSendRequestSchema,
} from '@protocol';
import type { HealthReply, MacApp } from '@protocol';
import type { ArtifactStore, StudioKeys } from './artifacts/store';
import type { PairingStore } from './auth/pairing';
import type { GhRunner } from './cli/gh';
import type { BrainConfig } from './config';
import { fail } from './errors';
import type { BrainServer, Route, RouteResult } from './http/server';
import { json } from './http/server';
import type { McpManager } from './mcp/manager';
import type { MeetBot } from './meet/bot';
import type { SandboxManager } from './sandbox/manager';
import type { SessionEngine } from './sessions/eve';
import type { ProfileRegistry } from './sessions/registry';
import { isToolName, runTool } from './sessions/tools';
import type { WhatsAppService } from './whatsapp/service';
import type { MacWorkflows } from './workflows/service';

export interface RouteDeps {
  config: BrainConfig;
  server: BrainServer;
  pairing: PairingStore;
  sandbox: SandboxManager;
  gh: GhRunner;
  mcp: McpManager;
  artifacts: ArtifactStore;
  studio: StudioKeys;
  workflows: MacWorkflows;
  meet: MeetBot;
  // Opens one of the apps the setup needs (open -a), never anything named by the request
  openApp: (app: MacApp) => Promise<void>;
  whatsapp: WhatsAppService;
  registry: ProfileRegistry;
  engine: SessionEngine | null;
  startedAt: number;
  now: () => number;
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      'invalid',
      `The request is not valid${issue ? ` (${issue.path.join('.') || 'body'}: ${issue.message})` : ''}.`,
    );
  }
  return parsed.data;
}

const base64Sha256 = (text: string) => createHash('sha256').update(text).digest('base64');
const STUDIO_CSP = studioCsp(base64Sha256(STUDIO_SCRIPT), base64Sha256(STUDIO_STYLE));

function html(body: string, status = 200, extra: Record<string, string> = {}): RouteResult {
  return {
    kind: 'raw',
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    },
    body,
  };
}

export function brainRoutes(deps: RouteDeps): Route[] {
  const engine = () => deps.engine ?? fail('unavailable', 'Agent sessions are off on this Mac.');

  return [
    // ── Pairing and health ──
    {
      method: 'POST',
      path: COMPANION_ROUTES.pair,
      name: 'pair',
      auth: 'pair',
      rate: 'pair',
      async handler({ body }) {
        const request = parse(pairRequestSchema, body);
        const { token, companionId } = await deps.pairing.redeem(request.code, request.client);
        return json({
          ok: true,
          token,
          companionId,
          version: deps.config.version,
          protocol: COMPANION_PROTOCOL_VERSION,
        });
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.autoPair,
      name: 'auto-pair',
      auth: 'pair',
      rate: 'pair',
      async handler({ body }) {
        if (deps.config.autoPair === false) {
          fail('forbidden', 'Automatic pairing is off on this Mac. Run `pnpm pair` in Ava Brain for a code.');
        }
        const request = parse(autoPairRequestSchema, body);
        const { token, companionId } = await deps.pairing.autoPair(request.client);
        return json({
          ok: true,
          token,
          companionId,
          version: deps.config.version,
          protocol: COMPANION_PROTOCOL_VERSION,
        });
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.unpair,
      name: 'unpair',
      auth: 'api',
      rate: 'read',
      async handler() {
        await deps.pairing.revoke();
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.health,
      name: 'health',
      auth: 'api',
      rate: 'health',
      async handler({ body }) {
        const request = parse(healthRequestSchema, body);
        const status = await deps.pairing.status();
        const reply: HealthReply = {
          ok: true,
          protocol: COMPANION_PROTOCOL_VERSION,
          version: deps.config.version,
          companionId: status.companionId,
          uptimeMs: deps.now() - deps.startedAt,
          docker: await deps.sandbox.docker(request.fresh),
          engine: deps.engine?.state() ?? { kind: 'none', state: 'off', message: null },
          mcp: deps.mcp.states(),
          workflows: deps.workflows.stats(),
        };
        return json(reply);
      },
    },

    // ── Sandbox and gh ──
    {
      method: 'POST',
      path: COMPANION_ROUTES.sandboxRun,
      name: 'sandbox.run',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      maxBodyBytes: 1_100_000,
      async handler({ body, signal }) {
        const request = parse(sandboxRunRequestSchema, body);
        return json(
          await deps.sandbox.run({
            profileId: request.profileId,
            command: request.command,
            policy: request.policy,
            stdin: request.stdin,
            signal,
          }),
        );
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.gh,
      name: 'gh',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      async handler({ body, signal }) {
        const request = parse(ghRequestSchema, body);
        const result = await deps.gh.run(request.args, { approved: request.approved, signal });
        return json({ ok: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      },
    },

    // ── MCP tools (the companion as a connector) ──
    {
      method: 'POST',
      path: COMPANION_ROUTES.tools,
      name: 'tools.list',
      auth: 'api',
      rate: 'read',
      async handler() {
        return json({ ok: true, servers: deps.mcp.states(), tools: deps.mcp.tools() });
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.toolCall,
      name: 'tools.call',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      maxBodyBytes: 1_000_000,
      async handler({ body, signal }) {
        const request = parse(toolCallRequestSchema, body);
        return json(
          await deps.mcp.callTool(request.server, request.tool, request.args, {
            fingerprint: request.fingerprint,
            signal,
          }),
        );
      },
    },

    // ── Agent sessions ──
    {
      method: 'POST',
      path: COMPANION_ROUTES.sessions,
      name: 'sessions.create',
      auth: 'api',
      rate: 'sessions',
      dedupe: true,
      maxBodyBytes: 400_000,
      async handler({ body }) {
        const request = parse(sessionCreateRequestSchema, body);
        await deps.registry.put(request.profile, request.model);
        const sessionId = await engine().create(request.profile.id, request.message);
        await deps.registry.bind(sessionId, request.profile.id);
        return json({ ok: true, sessionId });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.sessions}/:id/messages`,
      name: 'sessions.message',
      auth: 'api',
      rate: 'sessions',
      dedupe: true,
      maxBodyBytes: 400_000,
      async handler({ body, params }) {
        const request = parse(sessionMessageRequestSchema, body);
        if (!deps.registry.profileOf(params.id)) fail('not_found', 'There is no such session.');
        await engine().send(params.id, request.message);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.sessions}/:id/answer`,
      name: 'sessions.answer',
      auth: 'api',
      rate: 'sessions',
      dedupe: true,
      async handler({ body, params }) {
        const request = parse(sessionAnswerRequestSchema, body);
        if (!deps.registry.profileOf(params.id)) fail('not_found', 'There is no such session.');
        await engine().answer(params.id, request.approvalId, request.approved, request.note);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.sessions}/:id/cancel`,
      name: 'sessions.cancel',
      auth: 'api',
      rate: 'sessions',
      async handler({ params }) {
        if (!deps.registry.profileOf(params.id)) fail('not_found', 'There is no such session.');
        await engine().cancel(params.id);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.sessions}/:id/events`,
      name: 'sessions.events',
      auth: 'api',
      rate: 'stream',
      async handler({ body, params, signal }) {
        if (!deps.registry.profileOf(params.id)) fail('not_found', 'There is no such session.');
        const { cursor } = parse(cursorRequestSchema, body);
        const events = engine().events(params.id, cursor, signal);
        async function* lines() {
          for await (const event of events) yield JSON.stringify(event);
        }
        return { kind: 'stream', contentType: 'application/x-ndjson', lines: lines() };
      },
    },

    // ── Routines on the Mac ──
    {
      method: 'PUT',
      path: `${COMPANION_ROUTES.workflows}/:id`,
      name: 'workflows.put',
      auth: 'api',
      rate: 'read',
      maxBodyBytes: 400_000,
      async handler({ body, params }) {
        const request = parse(workflowPutRequestSchema, body);
        if (request.workflow.id !== params.id) fail('invalid', 'The routine id does not match the address.');
        const workflow = await deps.workflows.put(request);
        return json({ ok: true, nextRunAt: workflow.nextRunAt });
      },
    },
    {
      method: 'DELETE',
      path: `${COMPANION_ROUTES.workflows}/:id`,
      name: 'workflows.delete',
      auth: 'api',
      rate: 'read',
      async handler({ params }) {
        await deps.workflows.remove(params.id);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.workflows}/:id/run`,
      name: 'workflows.run',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      async handler({ body, params }) {
        parse(workflowRunRequestSchema, body);
        return json({ ok: true, runId: await deps.workflows.runNow(params.id) });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.workflows}/runs/answer`,
      name: 'workflows.answer',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      async handler({ body }) {
        const request = parse(workflowAnswerRequestSchema, body);
        await deps.workflows.answer(request.runId, request.nodeId, request.approved);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.workflowSync,
      name: 'workflows.sync',
      auth: 'api',
      rate: 'read',
      async handler({ body }) {
        return json(deps.workflows.sync(parse(cursorRequestSchema, body).cursor));
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.workflowAck,
      name: 'workflows.ack',
      auth: 'api',
      rate: 'read',
      async handler({ body }) {
        const request = parse(workflowAckRequestSchema, body);
        await deps.workflows.ack(request.outboxIds);
        return json({ ok: true });
      },
    },

    // ── Artifacts and Avi Studio ──
    {
      method: 'POST',
      path: COMPANION_ROUTES.artifactList,
      name: 'artifacts.list',
      auth: 'api',
      rate: 'read',
      async handler() {
        return json({ ok: true, artifacts: await deps.artifacts.list() });
      },
    },
    {
      method: 'POST',
      path: COMPANION_ROUTES.artifacts,
      name: 'artifacts.create',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      maxBodyBytes: 26_000_000,
      async handler({ body }) {
        const request = parse(artifactCreateRequestSchema, body);
        return json({ ok: true, artifact: await deps.artifacts.create(request) });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.artifacts}/:id/open`,
      name: 'artifacts.open',
      auth: 'api',
      rate: 'studio',
      async handler({ params }) {
        if (!(await deps.artifacts.get(params.id))) fail('not_found', 'There is no such artifact.');
        const token = deps.studio.issueToken(params.id);
        return json({ ok: true, url: `${deps.server.selfOrigin}${COMPANION_ROUTES.studio}/${params.id}#${token}` });
      },
    },
    {
      method: 'GET',
      path: `${COMPANION_ROUTES.studio}/:id`,
      name: 'studio.page',
      auth: 'studio-page',
      rate: 'studio',
      async handler({ params }) {
        const artifact = await deps.artifacts.get(params.id);
        if (!artifact) return html('<!doctype html><title>Not found</title><p>There is no such artifact.</p>', 404);
        return html(studioPageHtml(artifact), 200, { 'Content-Security-Policy': STUDIO_CSP });
      },
    },
    {
      method: 'POST',
      path: `${COMPANION_ROUTES.studio}/:id/session`,
      name: 'studio.session',
      auth: 'studio-session',
      rate: 'studio',
      async handler({ body, params }) {
        const request = parse(studioSessionRequestSchema, body);
        const viewKey = deps.studio.redeem(params.id, request.token);
        if (!viewKey) fail('forbidden', 'This link has expired. Open the artifact again from Ava Copilot.');
        return json({ ok: true, viewKey });
      },
    },
    {
      method: 'GET',
      path: `${COMPANION_ROUTES.view}/:id/:key/*`,
      name: 'studio.view',
      auth: 'view',
      rate: 'view',
      async handler({ params }) {
        if (!deps.studio.checkView(params.id, params.key)) fail('not_found', 'There is nothing here.');
        const file = await deps.artifacts.readFile(params.id, params.rest);
        return {
          kind: 'raw',
          status: 200,
          headers: { ...ARTIFACT_HEADERS, 'Content-Type': file.contentType },
          body: file.body,
        };
      },
    },

    // ── Ava in a Google Meet call ──
    {
      method: 'POST',
      path: MEET_ROUTES.status,
      name: 'meet.status',
      auth: 'api',
      rate: 'read',
      async handler() {
        return json({ ok: true, status: deps.meet.status() });
      },
    },
    {
      method: 'POST',
      path: MEET_ROUTES.signin,
      name: 'meet.signin',
      auth: 'api',
      rate: 'run',
      async handler() {
        return json({ ok: true, status: await deps.meet.signin() });
      },
    },
    {
      method: 'POST',
      path: MEET_ROUTES.check,
      name: 'meet.check',
      auth: 'api',
      rate: 'run',
      async handler() {
        await deps.meet.checkSignedIn();
        return json({ ok: true, status: deps.meet.status() });
      },
    },
    {
      method: 'POST',
      path: DOCKER_ROUTES.start,
      name: 'docker.start',
      auth: 'api',
      rate: 'run',
      async handler() {
        return json({ ok: true, docker: await deps.sandbox.startDocker() });
      },
    },
    {
      method: 'POST',
      path: APP_ROUTES.open,
      name: 'apps.open',
      auth: 'api',
      rate: 'run',
      async handler({ body }) {
        const request = parse(appOpenRequestSchema, body);
        await deps.openApp(request.app);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: MEET_ROUTES.join,
      name: 'meet.join',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      async handler({ body }) {
        const request = parse(meetJoinRequestSchema, body);
        return json({ ok: true, status: await deps.meet.join(request.url) });
      },
    },
    {
      method: 'POST',
      path: MEET_ROUTES.say,
      name: 'meet.say',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      maxBodyBytes: MEET_SAY_MAX_BODY_BYTES,
      async handler({ body }) {
        const request = parse(meetSayRequestSchema, body);
        const durationMs = await deps.meet.say(request.audio, request.meetingCode);
        return json({ ok: true, durationMs, status: deps.meet.status() });
      },
    },
    {
      // Stopping is never held back by a busy limit: it has a bucket of its own
      method: 'POST',
      path: MEET_ROUTES.stop,
      name: 'meet.stop',
      auth: 'api',
      rate: 'meetStop',
      async handler() {
        return json({ ok: true, status: await deps.meet.stop() });
      },
    },
    {
      method: 'POST',
      path: MEET_ROUTES.leave,
      name: 'meet.leave',
      auth: 'api',
      rate: 'meetStop',
      async handler() {
        return json({ ok: true, status: await deps.meet.leave() });
      },
    },

    // ── Ava on WhatsApp (the owner only; see whatsapp/service.ts) ──
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.status,
      name: 'whatsapp.status',
      auth: 'api',
      rate: 'read',
      async handler() {
        return json({ ok: true, status: deps.whatsapp.status() });
      },
    },
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.link,
      name: 'whatsapp.link',
      auth: 'api',
      rate: 'run',
      async handler() {
        return json({ ok: true, status: await deps.whatsapp.link() });
      },
    },
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.unlink,
      name: 'whatsapp.unlink',
      auth: 'api',
      rate: 'run',
      async handler() {
        return json({ ok: true, status: await deps.whatsapp.unlink() });
      },
    },
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.owner,
      name: 'whatsapp.owner',
      auth: 'api',
      rate: 'run',
      async handler({ body }) {
        const request = parse(whatsappOwnerRequestSchema, body);
        return json({ ok: true, status: deps.whatsapp.setOwner(request.number) });
      },
    },
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.quiet,
      name: 'whatsapp.quiet',
      auth: 'api',
      rate: 'read',
      async handler({ body }) {
        const request = parse(whatsappQuietRequestSchema, body);
        return json({ ok: true, status: deps.whatsapp.setQuietHours(request.quietStart, request.quietEnd) });
      },
    },
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.inbox,
      name: 'whatsapp.inbox',
      auth: 'api',
      rate: 'read',
      async handler() {
        const messages = deps.whatsapp.pull();
        return json({ ok: true, messages, status: deps.whatsapp.status() });
      },
    },
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.ack,
      name: 'whatsapp.ack',
      auth: 'api',
      rate: 'read',
      async handler({ body }) {
        deps.whatsapp.ack(parse(whatsappAckRequestSchema, body).ids);
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: WHATSAPP_ROUTES.send,
      name: 'whatsapp.send',
      auth: 'api',
      rate: 'run',
      dedupe: true,
      maxBodyBytes: 40_000,
      async handler({ body }) {
        const request = parse(whatsappSendRequestSchema, body);
        return json({ ok: true, status: await deps.whatsapp.send(request) });
      },
    },

    // ── For the eve agent process only ──
    {
      method: 'GET',
      path: '/internal/profiles/:id',
      name: 'internal.profile',
      auth: 'internal',
      rate: 'internal',
      async handler({ params }) {
        const profile = deps.registry.profile(params.id);
        if (!profile) fail('not_found', 'Unknown profile.');
        return json({ ok: true, profile });
      },
    },
    {
      method: 'GET',
      path: '/internal/models/:id',
      name: 'internal.model',
      auth: 'internal',
      rate: 'internal',
      async handler({ params }) {
        const model = await deps.registry.model(params.id);
        if (!model) fail('not_found', 'Unknown profile.');
        return json({ ok: true, model });
      },
    },
    {
      method: 'POST',
      path: '/internal/tools/:name',
      name: 'internal.tool',
      auth: 'internal',
      rate: 'internal',
      maxBodyBytes: 26_000_000,
      async handler({ body, params, signal }) {
        if (!isToolName(params.name)) fail('not_found', 'Unknown tool.');
        const request = body as { profileId?: unknown; input?: unknown; approved?: unknown };
        if (typeof request.profileId !== 'string') fail('invalid', 'Which profile?');
        const output = await runTool(deps, params.name, request.profileId, request.input, signal, {
          approved: request.approved === true,
        });
        return json({ ok: true, output });
      },
    },
  ];
}
