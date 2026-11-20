import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBrain } from './app';
import { PairingStore } from './auth/pairing';
import { loadConfig } from './config';
import { probeDocker } from './sandbox/docker';
import { hostToolEnv, runProcess } from './sandbox/process';
import { ensureMasker, findClaude, registerClaude, serverCommand, stableNode, vaultInstalled } from './keys/install';
import { serveKeys } from './keys/server';

/**
 * ava-brain start          serve on 127.0.0.1 (the LaunchAgent runs this)
 * ava-brain pair           print a one-time code to type into Ava Copilot › Settings › Ava Brain
 * ava-brain unpair         forget the paired browser
 * ava-brain status         pairing and Docker, in a few lines
 * ava-brain sandbox-build  build the sandbox image (needs Docker running and the network, once)
 * ava-brain keys install   install the Ava Keys masker and register its MCP server with Claude Code
 * ava-brain keys-mcp       the Ava Keys MCP server on stdio (agents start this; see docs/ava-keys.md)
 * (the old `avi-brain` command still works as an alias)
 */

async function main(): Promise<void> {
  // Everything Ava Brain writes (its store, eve's store, artifacts) is readable by this user only
  process.umask(0o077);
  const config = loadConfig();
  const command = process.argv[2] ?? 'start';

  switch (command) {
    case 'start': {
      const brain = await createBrain(config);
      await brain.start();
      const status = await brain.pairing.status();
      if (!status.paired) {
        process.stdout.write(
          'Not paired yet. Run `ava-brain pair` in a terminal and type the code into Ava Copilot.\n',
        );
      }
      const stop = async () => {
        await brain.stop();
        process.exit(0);
      };
      process.on('SIGTERM', () => void stop());
      process.on('SIGINT', () => void stop());
      return;
    }
    case 'pair': {
      const code = await new PairingStore(config.dataDir).createCode();
      process.stdout.write(
        `\nAva Brain pairing code:  ${code}\n\nType it into Ava Copilot › Settings › Ava Brain within 10 minutes (port ${config.port}).\n` +
          'It works once; pairing again replaces the browser paired before.\n\n',
      );
      return;
    }
    case 'unpair': {
      await new PairingStore(config.dataDir).revoke();
      process.stdout.write('Ava Brain forgot the paired browser.\n');
      return;
    }
    case 'status': {
      const pairing = await new PairingStore(config.dataDir).status();
      const docker = await probeDocker(runProcess, config.sandboxImage);
      process.stdout.write(
        `Ava Brain ${config.version} on http://${config.host}:${config.port}\n` +
          `Paired: ${pairing.paired ? `yes (${pairing.client})` : 'no'}\n` +
          `Docker: ${docker.message}\nData: ${config.dataDir}\n`,
      );
      return;
    }
    case 'sandbox-build': {
      const docker = await probeDocker(runProcess, config.sandboxImage);
      if (docker.state !== 'up') {
        process.stderr.write(`${docker.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`Building ${config.sandboxImage} …\n`);
      const result = await runProcess(
        'docker',
        ['build', '--pull', '-t', config.sandboxImage, join(config.packageDir, 'sandbox')],
        { env: hostToolEnv(), timeoutMs: 20 * 60_000, maxOutputBytes: 200_000 },
      );
      process.stdout.write(result.stdout.slice(-4000));
      if (result.code !== 0) {
        process.stderr.write(result.stderr.slice(-4000));
        process.exitCode = 1;
      }
      return;
    }
    case 'keys-mcp': {
      // stdout is the MCP channel: nothing else may write to it
      await serveKeys({ runner: runProcess, packageDir: config.packageDir, nodePath: stableNode(), home: homedir(), version: config.version });
      return;
    }
    case 'keys': {
      if (process.argv[3] !== 'install') {
        process.stderr.write('Use: ava-brain keys install\n');
        process.exitCode = 2;
        return;
      }
      const masker = ensureMasker({ packageDir: config.packageDir, nodePath: stableNode(), home: homedir() });
      process.stdout.write(`Masker: ${masker.path} (${masker.wrote ? 'written' : 'up to date'})\n`);
      if (!vaultInstalled()) {
        process.stdout.write('Vault: offboard-vault is not installed. In the offboard repo run: node offboard.mjs vault init\n');
      } else process.stdout.write('Vault: offboard-vault is installed (root-owned)\n');
      const claude = findClaude();
      if (!claude) process.stdout.write('Claude Code: not found, skipped\n');
      else {
        const said = await registerClaude(runProcess, { claude, command: serverCommand(stableNode(), config.packageDir), home: homedir() });
        process.stdout.write(`${said}\nRemove it with: claude mcp remove --scope user ava-keys\n`);
      }
      return;
    }
    default:
      process.stderr.write(`Unknown command "${command}". Use start, pair, unpair, status, sandbox-build, keys install or keys-mcp.\n`);
      process.exitCode = 2;
  }
}

main().catch(error => {
  process.stderr.write(`Ava Brain stopped: ${(error as Error).message}\n`);
  process.exit(1);
});
