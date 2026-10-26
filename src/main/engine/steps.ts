import type { Step } from '../../shared/types.js';

// Steps can nest (page and item loops have a body). These helpers address a step anywhere in the tree by its ID.

export interface StepLocation { list: Step[]; index: number; step: Step }

export function findStep(steps: Step[], id: string): StepLocation | null {
  for (const [index, step] of steps.entries()) {
    if (step.id === id) return { list: steps, index, step };
    if (step.type === 'loop_pages' || step.type === 'loop_items') {
      const inner = findStep(step.params.steps, id);
      if (inner) return inner;
    }
  }
  return null;
}

export function* allSteps(steps: Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    if (step.type === 'loop_pages' || step.type === 'loop_items') yield* allSteps(step.params.steps);
  }
}
