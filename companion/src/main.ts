import { join } from 'node:path';
import { createBrain } from './app';
import { PairingStore } from './auth/pairing';
import { loadConfig } from './config';
import { probeDocker } from './sandbox/docker';
import { hostToolEnv, runProcess } from './sandbox/process';

/**
 * nex-brain start          serve on 127.0.0.1 (the LaunchAgent runs this)
 * nex-brain pair           print a one-time code to type into Nex Copilot › Settings › Nex Brain
 * nex-brain unpair         forget the paired browser
 * nex-brain status         pairing and Docker, in a few lines
 * nex-brain sandbox-build  build the sandbox image (needs Docker running and the network, once)
 * (the old `avi-brain` command still works as an alias)
 */

async function main(): Promise<void> {
  // Everything Nex Brain writes (its store, eve's store, artifacts) is readable by this user only
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
          'Not paired yet. Run `nex-brain pair` in a terminal and type the code into Nex Copilot.\n',
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
        `\nNex Brain pairing code:  ${code}\n\nType it into Nex Copilot › Settings › Nex Brain within 10 minutes (port ${config.port}).\n` +
          'It works once; pairing again replaces the browser paired before.\n\n',
      );
      return;
    }
    case 'unpair': {
      await new PairingStore(config.dataDir).revoke();
      process.stdout.write('Nex Brain forgot the paired browser.\n');
      return;
    }
    case 'status': {
      const pairing = await new PairingStore(config.dataDir).status();
      const docker = await probeDocker(runProcess, config.sandboxImage);
      process.stdout.write(
        `Nex Brain ${config.version} on http://${config.host}:${config.port}\n` +
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
    default:
      process.stderr.write(`Unknown command "${command}". Use start, pair, unpair, status or sandbox-build.\n`);
      process.exitCode = 2;
  }
}

main().catch(error => {
  process.stderr.write(`Nex Brain stopped: ${(error as Error).message}\n`);
  process.exit(1);
});
