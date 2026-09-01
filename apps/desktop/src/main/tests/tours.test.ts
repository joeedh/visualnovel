/**
 * The curated tours, checked against the registry they walk the author through.
 *
 * A tour is prose plus invocations, and the prose cannot be tested. The invocations can: a step
 * naming a command that was renamed, or a prop that was dropped, would send the author to a palette
 * form that refuses — and it would do so silently, because a tour is only read when it is run.
 */
import { coerceProps } from '@vn/commands';
import { TOURS } from '../../shared/tours.js';
import { createDesktopRegistry } from '../commands/index.js';

const registry = createDesktopRegistry();

describe('the curated tours', () => {
  it('have distinct ids', () => {
    expect(new Set(TOURS.map((tour) => tour.id)).size).toBe(TOURS.length);
  });

  it('each say what the author will have done', () => {
    for (const tour of TOURS) {
      expect(tour.title.length).toBeGreaterThan(0);
      expect(tour.what.length).toBeGreaterThan(0);
      expect(tour.steps.length).toBeGreaterThan(0);
      for (const step of tour.steps) expect(step.say.length).toBeGreaterThan(0);
    }
  });

  it('name commands that exist', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (step.kind === 'select') continue;
        expect([tour.id, step.id, registry.get(step.id) !== undefined]).toEqual([
          tour.id,
          step.id,
          true,
        ]);
      }
    }
  });

  /**
   * Only the props a step actually carries. A step deliberately leaves the rest to the author, and
   * `coerceProps` would report those as missing, which is the state the author is being walked
   * towards rather than a mistake in the tour.
   */
  it('carry props the commands accept', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (step.kind === 'select' || !step.props) continue;
        const command = registry.get(step.id);
        const named = Object.fromEntries(
          Object.entries(command?.props ?? {}).filter(([name]) => name in (step.props ?? {})),
        );
        const result = coerceProps(named, step.props);
        expect([tour.id, step.id, result.ok]).toEqual([tour.id, step.id, true]);
      }
    }
  });

  it('ask the author to type only a prop the command has', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (step.kind !== 'input') continue;
        const command = registry.get(step.id);
        expect([tour.id, step.supplies, step.supplies in (command?.props ?? {})]).toEqual([
          tour.id,
          step.supplies,
          true,
        ]);
      }
    }
  });
});
