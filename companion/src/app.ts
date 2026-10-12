import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ArtifactStore, StudioKeys } from './artifacts/store';
import { PairingStore } from './auth/pairing';
import { createGhRunner } from './cli/gh';
import { privateDir } from './config';
import type { BrainConfig } from './config';
import { BrainServer } from './http/server';
import type { Logger } from './log';
import { createLogger } from './log';
import { McpManager } from './mcp/manager';
import type { McpConnect } from './mcp/manager';
import { brainRoutes } from './routes';
import { SandboxManager } from './sandbox/manager';
import { runProcess } from './sandbox/process';
import type { ProcessRunner } from './sandbox/process';
import { EveEngine } from './sessions/eve';
import type { SessionEngine } from './sessions/eve';
import { ProfileRegistry } from './sessions/registry';
import { createKeyStore } from './workflows/keys';
import type { KeyStore } from './workflows/keys';
import { MacWorkflows } from './workflows/service';
import type { MacWorkflowsDeps } from './workflows/service';

/** Stand-ins for tests: process runner, MCP connector, clock, network, session engine. */
export interface BrainDeps {
  log?: Logger;
  run?: ProcessRunner;
  connectMcp?: McpConnect;
  keys?: KeyStore;
  now?: () => number;
  fetch?: MacWorkflowsDeps['fetch'];
  lookup?: MacWorkflowsDeps['lookup'];
  // null: no agent sessions; undefined: eve
  engine?: SessionEngine | null;
}

export type Brain = Awaited<ReturnType<typeof createBrain>>;

/** Puts Avi Brain together. Nothing listens or starts until start(). */
export async function createBrain(config: BrainConfig, deps: BrainDeps = {}) {
  privateDir(config.dataDir);
  const log = deps.log ?? createLogger({ app: 'avi-brain' });
  const now = deps.now ?? Date.now;
  const run = deps.run ?? runProcess;
  const internalSecret = randomBytes(32).toString('base64url');
  const pairing = new PairingStore(config.dataDir, now);
  const server = new BrainServer({
    host: config.host,
    port: config.port,
    pairing,
    internalSecretHash: createHash('sha256').update(internalSecret).digest('hex'),
    log,
  });
  const keys = deps.keys ?? createKeyStore({ run });
  const sandbox = new SandboxManager({ run, image: config.sandboxImage, dataDir: config.dataDir, log, now });
  const gh = createGhRunner({ run, log });
  const mcp = new McpManager({ configPath: join(config.dataDir, 'mcp.json'), log, connect: deps.connectMcp });
  const artifacts = new ArtifactStore({ dataDir: config.dataDir, sandbox, log, now });
  const studio = new StudioKeys(now);
  const workflows = new MacWorkflows({
    dataDir: config.dataDir,
    sandbox,
    keys,
    log,
    fetch: deps.fetch,
    lookup: deps.lookup,
  });
  const registry = new ProfileRegistry(config.dataDir, keys);
  const engine =
    deps.engine === undefined
      ? new EveEngine({
          packageDir: config.packageDir,
          log,
          internalUrl: () => `${server.selfOrigin}/internal`,
          internalSecret,
        })
      : deps.engine;
  const startedAt = now();
  server.add(
    ...brainRoutes({
      config,
      server,
      pairing,
      sandbox,
      gh,
      mcp,
      artifacts,
      studio,
      workflows,
      registry,
      engine,
      startedAt,
      now,
    }),
  );

  return {
    config,
    server,
    pairing,
    sandbox,
    mcp,
    artifacts,
    studio,
    workflows,
    registry,
    engine,
    internalSecret,
    async start(): Promise<number> {
      const port = await server.listen();
      await workflows.start();
      // Slow starters do not hold up the API: health says what is still starting
      void mcp.start().catch(error => log.warn('MCP servers did not start', { error: (error as Error).message }));
      void engine
        ?.start()
        .catch(error => log.warn('The agent engine did not start', { error: (error as Error).message }));
      log.info('Avi Brain listening', { url: server.selfOrigin });
      return port;
    },
    async stop(): Promise<void> {
      workflows.stop();
      await engine?.stop();
      await mcp.stop();
      await server.close();
    },
  };
}
