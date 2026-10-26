// The command line (plan §8): `vestigium run --profile <site> --url <url> --output <dir> --max-pages N --force`.
// Pure parsing, unit-tested; app.ts decides GUI or CLI from the result before anything else starts.

export interface RunCommand {
  kind: 'run'; profile: string; url: string | null; output: string | null; maxPages: number | null; maxItems: number | null;
  force: boolean; dryRun: boolean;
}
export type CliCommand = RunCommand | { kind: 'profiles' } | { kind: 'help' } | { kind: 'error'; message: string };

export const USAGE = `Vestigium command line: runs a saved site profile without the window (the same engine as the app).

  vestigium run --profile <site> [--url <list address>] [--output <folder>]
                [--max-pages <N>] [--max-items <N>] [--force] [--dry-run]
  vestigium profiles        lists the saved site profiles
  vestigium --help

  --profile    the site, as shown under Site profiles (e.g. example.com or 127.0.0.1:4173)
  --url        the list to start on (default: the list the site was taught on)
  --output     the download folder for this run (default: the app's setting)
  --max-pages  at most this many pages; --max-items at most this many items
  --force      download items again even when already downloaded
  --dry-run    find and report, without clicking or downloading

It uses the app's profile and browser session (your logins), so close the Vestigium window first.
If a page needs you (captcha, login, countdown), the window opens and the run waits for you.
Exit codes: 0 done, 1 the run or a download failed, 2 wrong arguments, 3 could not start.`;

const positive = (value: string | undefined, name: string): number | string => {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100_000) return `${name} needs a whole number from 1 to 100000.`;
  return Number(value);
};

// `args`: the arguments after the executable (and, in development, after the app path).
// Returns null when the arguments are not a CLI command at all: then the app opens normally.
export function parseCli(args: string[]): CliCommand | null {
  // A leading "--" is how the launchers (vestigium.cmd, npm run cli) pass the command: Electron refuses to start when
  // any argument follows a URL-like one (its CVE-2018-1000006 guard), unless "--" comes first. It also keeps
  // Chromium from reading our options as its own switches.
  const [command, ...rest] = args[0] === '--' ? args.slice(1) : args;
  if (command === '--help' || command === '-h' || command === 'help') return { kind: 'help' };
  if (command === 'profiles') return rest.length ? { kind: 'error', message: `"profiles" takes no options (got ${rest[0]}).` } : { kind: 'profiles' };
  if (command !== 'run') return null;
  const run: RunCommand = { kind: 'run', profile: '', url: null, output: null, maxPages: null, maxItems: null, force: false, dryRun: false };
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    const value = rest[index + 1];
    const needsValue = () => (value === undefined || value.startsWith('--') ? `${option} needs a value.` : null);
    switch (option) {
      case '--profile':
      case '--url':
      case '--output': {
        const missing = needsValue();
        if (missing) return { kind: 'error', message: missing };
        if (option === '--profile') run.profile = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (option === '--url') {
          if (!/^https?:\/\//i.test(value)) return { kind: 'error', message: '--url must start with http:// or https://.' };
          run.url = value;
        }
        if (option === '--output') run.output = value;
        index++;
        break;
      }
      case '--max-pages':
      case '--max-items': {
        const parsed = positive(value, option);
        if (typeof parsed === 'string') return { kind: 'error', message: parsed };
        if (option === '--max-pages') run.maxPages = parsed;
        else run.maxItems = parsed;
        index++;
        break;
      }
      case '--force':
        run.force = true;
        break;
      case '--dry-run':
        run.dryRun = true;
        break;
      default:
        return { kind: 'error', message: `Unknown option ${option}. See vestigium --help.` };
    }
  }
  if (!run.profile) return { kind: 'error', message: 'run needs --profile <site>. See vestigium profiles for the saved ones.' };
  return run;
}
