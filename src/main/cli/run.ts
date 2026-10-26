import type { WebContents } from 'electron';
import type { RunState, Workflow } from '../../shared/types.js';
import type { SiteProfiles } from '../engine/site-profiles.js';
import type { WorkflowRunner } from '../engine/workflow-runner.js';
import type { DownloadQueue } from '../downloads/queue.js';
import { allSteps } from '../engine/steps.js';
import { UserFacingError } from '../errors.js';
import type { RunCommand } from './args.js';

// `vestigium run` (plan §8): the same profile, workflow, runner and download queue as ▶ Start in the window, without
// showing it. Waits until the run has ended and every download it started has settled, then reports and returns the
// exit code (0 done, 1 something failed, 3 could not start).

export interface CliServices {
  profiles: SiteProfiles;
  load(id: string): Workflow;
  runner: WorkflowRunner;
  downloads: DownloadQueue;
  tab(): WebContents;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function listProfiles(profiles: SiteProfiles, print: (line: string) => void): number {
  const all = profiles.list();
  if (all.length === 0) {
    print('No site profiles yet. Teach one in the app: open a list, press Teach, open one item and download it, then Stop.');
    return 0;
  }
  for (const profile of all) {
    const list = (profile.listPattern?.listUrl as string | undefined) ?? '';
    print(`${profile.domain}\t${profile.health}\t${profile.lastVerifiedAt ?? 'never run'}\t${list}`);
  }
  return 0;
}

export async function runCli(command: RunCommand, services: CliServices, print: (line: string) => void): Promise<number> {
  const { profiles, runner, downloads } = services;
  const profile = profiles.forHost(command.profile);
  if (!profile) {
    const known = profiles.list().map(candidate => candidate.domain);
    print(`No site profile for ${command.profile}.${known.length ? ` Saved profiles: ${known.join(', ')}.` : ' Teach the site once in the app first.'}`);
    return 3;
  }
  const url = command.url ?? (profile.listPattern?.listUrl as string | undefined) ?? null;
  if (!url) {
    print(`The ${profile.domain} profile has no list address; pass --url.`);
    return 2;
  }
  let workflow: Workflow;
  try {
    ({ workflow } = profiles.plan(url, services.load));
  } catch (error) {
    print(error instanceof UserFacingError ? error.message : 'The profile could not be loaded.');
    return 3;
  }
  // Limits for this run only; the stored workflow keeps its own.
  for (const step of allSteps(workflow.steps)) {
    if (step.type === 'loop_pages' && command.maxPages !== null) step.params.maxPages = command.maxPages;
    if (step.type === 'loop_items' && command.maxItems !== null) step.params.maxItems = command.maxItems;
  }

  const since = new Date().toISOString();
  print(`Running the ${profile.domain} profile on ${url}${command.dryRun ? ' (dry run)' : ''}.`);
  runner.start(workflow, command.dryRun ? 'dry' : 'run', services.tab());
  while (runner.isRunning()) await sleep(250);
  const run = runner.status() as RunState;

  // The run hands files to the queue and moves on; the command is finished when those transfers are.
  for (;;) {
    const summary = downloads.summarySince(since);
    if (summary.active === 0) break;
    await sleep(500);
  }
  const summary = downloads.summarySince(since);
  const items = run.results.filter(result => result.label.endsWith('Repeat for every item')).map(result => result.message);
  print(`Run ${run.status}${run.error ? `: ${run.error}` : ''}.`);
  for (const line of items) print(`  ${line}`);
  print(`Downloads: ${summary.done} done, ${summary.failed} failed${summary.paused ? `, ${summary.paused} paused` : ''}.`);
  for (const file of summary.files) print(`  ${file}`);
  return run.status === 'done' && summary.failed === 0 && summary.paused === 0 ? 0 : 1;
}
