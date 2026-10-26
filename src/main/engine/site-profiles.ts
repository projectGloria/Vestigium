import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunState, SiteProfile, SiteProfileSummary, Step, Workflow } from '../../shared/types.js';
import type { DocumentRepository } from '../store/repositories.js';
import { UserFacingError } from '../errors.js';
import type { Logger } from '../logger.js';
import { allSteps } from './steps.js';

// Site profiles (plan §2): what was learned for a site, so next time a URL and Start are enough, with no recording.
// A recording that generalized into an item loop becomes the profile of its list's site (host, including the port);
// teaching the same site again replaces it. Each run grades the profile:
//   ok       - the run finished and every item worked;
//   degraded - it finished, but steps had to be healed or some items failed (worth a look);
//   broken   - the run failed; `brokenStepId` names the step to re-teach (only that step, plan §2).

const profileSchema = z.strictObject({
  schemaVersion: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), domain: z.string().min(1).max(300),
  listPattern: z.record(z.string(), z.unknown()).nullable(), itemPattern: z.record(z.string(), z.unknown()).nullable(),
  paginationPattern: z.record(z.string(), z.unknown()).nullable(), downloadPattern: z.record(z.string(), z.unknown()).nullable(),
  metadataPatterns: z.record(z.string(), z.string()), rateLimit: z.number().int().min(0).max(600_000),
  lastVerifiedAt: z.string().datetime().nullable(), health: z.enum(['ok', 'degraded', 'broken']),
});
export const validateSiteProfile = (value: unknown): SiteProfile => profileSchema.parse(value) as SiteProfile;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

// The workflow a profile runs, and the step to re-teach when it broke.
const workflowIdOf = (profile: SiteProfile) => (profile.downloadPattern?.workflowId as string | undefined) ?? null;
const brokenStepOf = (profile: SiteProfile) => (profile.downloadPattern?.brokenStepId as string | undefined) ?? null;

export class SiteProfiles {
  constructor(private repository: DocumentRepository<SiteProfile>, private log: Logger) {}

  list(): SiteProfile[] {
    const profiles: SiteProfile[] = [];
    for (const id of this.repository.ids()) {
      try {
        const profile = this.repository.get(id);
        if (profile) profiles.push(profile);
      } catch {
        this.log.write('error', `Site profile ${id} is damaged and was skipped.`);
      }
    }
    return profiles.sort((a, b) => a.domain.localeCompare(b.domain));
  }

  forHost(host: string): SiteProfile | null {
    return this.list().find(profile => profile.domain === host) ?? null;
  }

  summaries(workflows: { id: string; name: string }[]): SiteProfileSummary[] {
    return this.list().map(profile => {
      const workflowId = workflowIdOf(profile);
      return {
        id: profile.id, domain: profile.domain, health: profile.health, lastVerifiedAt: profile.lastVerifiedAt,
        listUrl: (profile.listPattern?.listUrl as string | undefined) ?? null, workflowId,
        workflowName: workflows.find(workflow => workflow.id === workflowId)?.name ?? null,
        brokenStepId: brokenStepOf(profile), brokenStepLabel: (profile.downloadPattern?.brokenStepLabel as string | undefined) ?? null,
      };
    });
  }

  // A generalized workflow (one with an item loop) becomes its site's profile. Returns null for other workflows.
  learn(workflow: Workflow, hostIntervalMs: number): SiteProfile | null {
    const loop = [...allSteps(workflow.steps)].find((step): step is Extract<Step, { type: 'loop_items' }> => step.type === 'loop_items');
    if (!loop) return null;
    const pages = [...allSteps(workflow.steps)].find((step): step is Extract<Step, { type: 'loop_pages' }> => step.type === 'loop_pages');
    const domain = hostOf(loop.params.listUrl);
    if (!domain) return null;
    const existing = this.forHost(domain);
    const profile: SiteProfile = {
      schemaVersion: 1, id: existing?.id ?? randomUUID(), domain,
      listPattern: { listUrl: loop.params.listUrl },
      itemPattern: { ...loop.params.pattern },
      paginationPattern: pages ? { ...pages.params.pagination } : null,
      downloadPattern: { workflowId: workflow.id, steps: loop.params.steps.map(step => step.label) },
      metadataPatterns: {}, rateLimit: hostIntervalMs, lastVerifiedAt: null, health: 'ok',
    };
    this.repository.save(profile);
    this.log.write('info', existing
      ? `Updated the site profile for ${domain}: Start on a ${domain} list now uses "${workflow.name}".`
      : `Saved a site profile for ${domain}: next time, open a ${domain} list and press Start; no teaching needed.`);
    return profile;
  }

  remove(id: string) {
    if (!this.repository.delete(id)) throw new UserFacingError('That site profile no longer exists.');
  }

  // The workflow to run for `url`, with its start address and list address set to `url`.
  plan(url: string, load: (id: string) => Workflow): { profile: SiteProfile; workflow: Workflow } {
    const host = hostOf(url);
    const profile = host ? this.forHost(host) : null;
    if (!profile) throw new UserFacingError(`No site profile for ${host || 'this page'} yet. Teach it once: open a list, press Teach, open one item, download it, then Stop.`);
    const workflowId = workflowIdOf(profile);
    if (!workflowId) throw new UserFacingError(`The site profile for ${host} has no workflow. Teach it again.`);
    let workflow: Workflow;
    try {
      workflow = structuredClone(load(workflowId));
    } catch {
      throw new UserFacingError(`The workflow of the ${host} profile was deleted. Teach the site again.`);
    }
    const navigate = workflow.steps.find(step => step.type === 'navigate');
    if (navigate?.type === 'navigate') {
      navigate.params.url = url;
      navigate.label = `Open ${url}`;
    }
    for (const step of allSteps(workflow.steps)) if (step.type === 'loop_items') step.params.listUrl = url;
    return { profile, workflow };
  }

  // Grades the profile after a run of its workflow (see the header).
  grade(workflowId: string, run: RunState) {
    const profile = this.list().find(candidate => workflowIdOf(candidate) === workflowId);
    if (!profile || run.mode === 'dry' || run.status === 'stopped') return;
    const failedItems = run.results.filter(result => result.status === 'failed').length;
    const healed = run.results.some(result => result.message.startsWith('Healed.'));
    const broken = run.status === 'failed';
    const health: SiteProfile['health'] = broken ? 'broken' : healed || failedItems > 0 ? 'degraded' : 'ok';
    const failure = broken ? run.failure : null;
    this.repository.save({
      ...profile, health, lastVerifiedAt: broken ? profile.lastVerifiedAt : new Date().toISOString(),
      downloadPattern: { ...profile.downloadPattern, brokenStepId: failure?.stepId ?? null, brokenStepLabel: failure?.label ?? null },
    });
    if (health !== profile.health) {
      this.log.write(health === 'ok' ? 'info' : 'warn', health === 'broken'
        ? `The ${profile.domain} profile is broken${failure ? `: "${failure.label}" failed. Re-teach that step` : ''}.`
        : `The ${profile.domain} profile is ${health}.`);
    }
  }
}
