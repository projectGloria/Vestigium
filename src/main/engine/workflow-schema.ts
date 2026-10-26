import { z } from 'zod';
import { STEP_TYPES, type Locator, type Step, type StepType, type Workflow } from '../../shared/types.js';
import type { ElementCapture, PageEvent } from '../../shared/recorder.js';
import type { ItemPattern, ListContext, PaginationReport } from '../../shared/learn.js';
import { urlSchema } from '../validation.js';

// Every workflow entering the app (recorder, import, DB save) passes through these strict schemas.
// Strict objects reject unknown keys so a hand-edited or hostile file cannot smuggle fields into the runner.

const LIMITS = {
  text: 2048,
  locatorValue: 4096,
  fieldValue: 10_000,
  locators: 12,
  depth: 16,
  steps: 1000,
} as const;

const text = (max: number = LIMITS.text) => z.string().max(max);

export const locatorSchema = z.strictObject({
  strategy: z.enum(['role', 'text', 'testid', 'css', 'xpath', 'fingerprint']),
  value: z.string().min(1).max(LIMITS.locatorValue),
  confidence: z.number().min(0).max(1),
});

// Frame URLs may be about:blank / about:srcdoc for script-built frames, so they are not restricted to http(s).
export const frameRefSchema = z.strictObject({
  url: text(8192),
  name: text(512),
  index: z.number().int().min(0).max(1000),
});

const tabAlias = z.string().regex(/^(main|item|popup-[1-9]\d{0,3})$/, 'Tab must be "main", "item" or "popup-N".');

export const stepTargetSchema = z.strictObject({
  tab: tabAlias,
  frames: z.array(frameRefSchema).max(LIMITS.depth),
  shadowHosts: z.array(z.string().min(1).max(LIMITS.text)).max(LIMITS.depth),
});

const stepWaitSchema = z.strictObject({
  navigation: z.boolean().optional(),
  download: z.boolean().optional(),
});

const coordinate = z.number().finite().min(0).max(10_000_000);
// Reserved node types keep a free-form object until their milestone defines them.
const reserved = z.record(z.string(), z.unknown());

const paramSchemas = {
  navigate: z.strictObject({ url: urlSchema }),
  click: z.strictObject({ opensTab: tabAlias.optional() }),
  type: z.strictObject({ value: text(LIMITS.fieldValue).nullable(), key: z.enum(['Enter', 'Tab']).optional() }),
  select: z.strictObject({ value: text(), label: text() }),
  scroll: z.strictObject({ x: coordinate, y: coordinate }),
  wait: z.strictObject({ ms: z.number().int().min(0).max(600_000) }),
  download: z.strictObject({
    filename: text(1024).nullable(),
    mimeType: text(256).nullable(),
    opensTab: tabAlias.optional(),
  }),
  extract: reserved,
  loop_pages: z.strictObject({
    pagination: z.lazy(() => paginationSchema),
    maxPages: z.number().int().min(1).max(10_000),
    // Recursive: the body is itself a list of steps (validated by the same rules).
    steps: z.lazy((): z.ZodType<Step[]> => z.array(stepSchema).max(LIMITS.steps)),
  }),
  loop_items: z.strictObject({
    pattern: z.lazy(() => itemPatternSchema),
    listUrl: urlSchema,
    maxItems: z.number().int().min(1).max(100_000),
    exclude: z.array(urlSchema).max(5000),
    steps: z.lazy((): z.ZodType<Step[]> => z.array(stepSchema).max(LIMITS.steps)),
  }),
  condition: reserved,
  run_workflow: reserved,
} satisfies Record<StepType, z.ZodType>;

const stepBase = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Step IDs use letters, digits, "_" or "-".'),
  label: z.string().min(1).max(500),
  enabled: z.boolean(),
  locators: z.array(locatorSchema).max(LIMITS.locators),
  target: stepTargetSchema,
  waitFor: stepWaitSchema.nullable(),
  timeoutMs: z.number().int().min(100).max(600_000),
  onFail: z.enum(['retry', 'skip', 'pause', 'abort']),
  review: z.strictObject({
    reason: z.string().min(1).max(1000), at: z.iso.datetime({ offset: true }), previous: z.array(locatorSchema).max(LIMITS.locators),
  }).optional(),
};

const stepOf = <T extends StepType>(type: T) =>
  z.strictObject({ ...stepBase, type: z.literal(type), params: paramSchemas[type] });

const description = z.string().min(1).max(1000);
const controlLocators = z.array(locatorSchema).min(1).max(LIMITS.locators);
const shadowHosts = z.array(z.string().min(1).max(LIMITS.text)).max(LIMITS.depth);
export const paginationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('next'), locators: controlLocators, shadowHosts, description }),
  z.strictObject({
    kind: z.literal('url'), description,
    // A real http(s) URL once a page number is filled in; nothing else may be navigated to.
    template: z.string().max(8192).refine(value => value.includes('{{page}}') && urlSchema.safeParse(value.replaceAll('{{page}}', '2')).success,
      'The URL template must be an http(s) URL containing {{page}}.'),
  }),
  z.strictObject({ kind: z.literal('load-more'), locators: controlLocators, shadowHosts, description }),
  z.strictObject({ kind: z.literal('infinite-scroll'), description }),
]);

// Tag names only (see recorder/learn/items.ts); the link path is "tag > tag > a" or empty.
const tagName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Use a lowercase tag name.');
export const itemPatternSchema = z.strictObject({
  parent: tagName,
  container: tagName,
  item: tagName,
  link: z.string().max(512).regex(/^([a-z][a-z0-9-]{0,63}( > [a-z][a-z0-9-]{0,63})*)?$/, 'The link path must be tag names joined by " > ".'),
  description,
});

// Element-bound steps are meaningless without a way to find the element.
const NEEDS_LOCATOR: ReadonlySet<StepType> = new Set(['click', 'type', 'select', 'download']);

export const stepSchema = z
  .discriminatedUnion('type', [
    stepOf('navigate'), stepOf('click'), stepOf('type'), stepOf('select'), stepOf('scroll'), stepOf('wait'),
    stepOf('extract'), stepOf('download'), stepOf('loop_pages'), stepOf('loop_items'), stepOf('condition'),
    stepOf('run_workflow'),
  ])
  .superRefine((step, ctx) => {
    if (NEEDS_LOCATOR.has(step.type) && step.locators.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['locators'], message: `A ${step.type} step needs at least one locator.` });
    }
  });

export const workflowSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Workflow IDs use letters, digits, "_" or "-".'),
    name: z.string().trim().min(1).max(200),
    siteProfileId: z.string().min(1).max(128).nullable(),
    steps: z.array(stepSchema).max(LIMITS.steps),
    variables: z.record(z.string().max(128), z.unknown()),
    createdAt: z.iso.datetime({ offset: true }),
    version: z.number().int().min(1),
  })
  .superRefine((workflow, ctx) => {
    // Step IDs address steps in the editor and run log, so they must be unique across every nesting level.
    const ids = new Set<string>();
    // A popup alias only exists once an earlier step opened it; replay could never reach it otherwise.
    // A loop body sees the tabs opened before it; tabs it opens itself do not leak out of the body.
    const walk = (steps: Step[], path: (string | number)[], tabs: Set<string>, loop: 'pages' | 'items' | null) => {
      steps.forEach((step, index) => {
        const at = [...path, index];
        if (ids.has(step.id)) ctx.addIssue({ code: 'custom', path: [...at, 'id'], message: `Duplicate step ID "${step.id}".` });
        ids.add(step.id);
        if (!tabs.has(step.target.tab)) {
          ctx.addIssue({ code: 'custom', path: [...at, 'target', 'tab'], message: `Tab "${step.target.tab}" is used before any step opens it.` });
        }
        const opened = 'opensTab' in step.params ? step.params.opensTab : undefined;
        if (typeof opened === 'string') {
          if (tabs.has(opened)) ctx.addIssue({ code: 'custom', path: [...at, 'params', 'opensTab'], message: `Tab "${opened}" is opened twice.` });
          tabs.add(opened);
        }
        if (step.type === 'loop_pages') {
          if (loop) ctx.addIssue({ code: 'custom', path: [...at, 'type'], message: `A page loop cannot be inside ${loop === 'pages' ? 'another page loop' : 'an item loop'}.` });
          walk(step.params.steps, [...at, 'params', 'steps'], new Set(tabs), 'pages');
        }
        if (step.type === 'loop_items') {
          if (loop === 'items') ctx.addIssue({ code: 'custom', path: [...at, 'type'], message: 'An item loop cannot contain another item loop.' });
          if (step.target.tab !== 'main') ctx.addIssue({ code: 'custom', path: [...at, 'target', 'tab'], message: 'An item loop reads its list from the main tab.' });
          // The body runs in the "item" tab, which exists only inside the loop.
          walk(step.params.steps, [...at, 'params', 'steps'], new Set([...tabs, 'item']), 'items');
        }
      });
    };
    walk(workflow.steps, ['steps'], new Set(['main']), null);
  });

// Recorder messages from page preloads. Main adds tab/frame/time itself, so pages cannot claim another frame.
export const elementCaptureSchema = z.strictObject({
  locators: z.array(locatorSchema).min(1).max(LIMITS.locators),
  shadowHosts: z.array(z.string().min(1).max(LIMITS.text)).max(LIMITS.depth),
  description: z.strictObject({
    tag: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    role: text(64).nullable(),
    name: text(500).nullable(),
  }),
});

export const pageEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), target: elementCaptureSchema, list: z.lazy(() => listContextSchema).optional() }),
  z.strictObject({ kind: z.literal('input'), target: elementCaptureSchema, value: text(LIMITS.fieldValue) }),
  z.strictObject({ kind: z.literal('select'), target: elementCaptureSchema, value: text(), label: text() }),
  z.strictObject({ kind: z.literal('key'), target: elementCaptureSchema, key: z.enum(['Enter', 'Tab']) }),
  z.strictObject({ kind: z.literal('scroll'), target: elementCaptureSchema.nullable(), x: coordinate, y: coordinate }),
  z.strictObject({ kind: z.literal('sensitive') }),
  z.strictObject({ kind: z.literal('captcha') }),
]);

// Page analysis answers (untrusted, like every page message).
const httpUrl = z.string().max(8192).regex(/^https?:\/\//);
const candidateSchema = z.strictObject({ capture: elementCaptureSchema, disabled: z.boolean(), evidence: z.array(z.string().max(300)).max(10) });
export const paginationReportSchema = z.strictObject({
  url: z.string().max(8192),
  next: candidateSchema.nullable(),
  loadMore: candidateSchema.nullable(),
  numbered: z.strictObject({
    current: z.number().int().min(0).max(1_000_000).nullable(),
    pages: z.array(z.strictObject({ number: z.number().int().min(0).max(1_000_000), href: httpUrl })).max(500),
  }),
  contentLinks: z.number().int().min(0),
  scrollable: z.boolean(),
});
export const listContextSchema = z.strictObject({
  url: httpUrl,
  items: z.strictObject({ pattern: itemPatternSchema, count: z.number().int().min(2).max(5000), index: z.number().int().min(0).max(4999) }),
  pagination: paginationReportSchema,
});
export const foundItemsSchema = z.strictObject({
  items: z.array(z.strictObject({ url: httpUrl, title: z.string().max(500) })).max(5000),
  loose: z.boolean(),
  highlighted: z.number().int().min(0).max(5000),
});

// Compile-time proof that the schemas and the shared TypeScript types describe the same shapes.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const schemaMatchesTypes: [
  Same<z.output<typeof locatorSchema>, Locator>,
  Same<z.output<typeof stepSchema>, Step>,
  Same<z.output<typeof workflowSchema>, Workflow>,
  Same<z.output<typeof elementCaptureSchema>, ElementCapture>,
  Same<z.output<typeof pageEventSchema>, PageEvent>,
  Same<z.output<typeof itemPatternSchema>, ItemPattern>,
  Same<z.output<typeof paginationReportSchema>, PaginationReport>,
  Same<z.output<typeof listContextSchema>, ListContext>,
] = [true, true, true, true, true, true, true, true];
void schemaMatchesTypes;

export { STEP_TYPES };
