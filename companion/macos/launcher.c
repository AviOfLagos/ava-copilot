/*
 * Ava Brain's launcher: the program inside "Ava Brain.app" that the LaunchAgent runs.
 *
 *   ava-brain <program> [args...]      e.g. ava-brain /opt/homebrew/bin/node dist/nex-brain.mjs start
 *
 * macOS ties privacy permissions (Calendar, and any later one) to the program that is responsible for a
 * process. Run directly, that is `node`, and a Homebrew upgrade replaces node with a new binary, so macOS
 * forgets the permission and asks again. This launcher spawns the program as a child and stays alive as its
 * parent, so macOS holds the launcher responsible for node and everything node starts (osascript included):
 * the permission belongs to "Ava Brain", whose binary only changes when this file does, and node can be
 * upgraded underneath it.
 *
 * It forwards the signals launchd sends (so `launchctl kickstart -k` and logout stop node cleanly) and exits
 * the way the child did, so launchd's KeepAlive sees node's exit. Plain POSIX, so it also builds and is tested
 * off macOS. Changing it changes the binary, and macOS then asks for each permission once more: bump
 * CFBundleVersion in Info.plist when it changes, which is what makes the installer rebuild it.
 */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static const int FORWARDED[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
#define FORWARDED_COUNT (sizeof FORWARDED / sizeof FORWARDED[0])

static volatile sig_atomic_t child = 0;

static void forward(int sig) {
  if (child > 0) kill((pid_t)child, sig);
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: ava-brain <program> [args...]\n");
    return 64;
  }
  // Ava Brain names this program in its Calendar steps instead of "node"
  setenv("AVA_BRAIN_PROGRAM", "Ava Brain", 1);

  // Signals wait until the child's pid is known; the child starts with them unblocked and at their defaults
  sigset_t forwarded, previous;
  sigemptyset(&forwarded);
  for (size_t i = 0; i < FORWARDED_COUNT; i++) sigaddset(&forwarded, FORWARDED[i]);
  sigprocmask(SIG_BLOCK, &forwarded, &previous);

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  sigemptyset(&action.sa_mask);
  for (size_t i = 0; i < FORWARDED_COUNT; i++) sigaction(FORWARDED[i], &action, NULL);

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setsigmask(&attr, &previous);
  posix_spawnattr_setsigdefault(&attr, &forwarded);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);

  pid_t pid;
  int error = posix_spawnp(&pid, argv[1], NULL, &attr, &argv[1], environ);
  posix_spawnattr_destroy(&attr);
  if (error != 0) {
    fprintf(stderr, "ava-brain: could not start %s: %s\n", argv[1], strerror(error));
    return 127;
  }
  child = pid;
  sigprocmask(SIG_SETMASK, &previous, NULL);

  int status;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) {
      perror("ava-brain: waitpid");
      return 1;
    }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    // Die the same way, so launchd reports the child's signal
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    sigprocmask(SIG_UNBLOCK, &forwarded, NULL);
    raise(sig);
    return 128 + sig;
  }
  return 1;
}
