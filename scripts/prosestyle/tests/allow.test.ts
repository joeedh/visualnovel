import { allowsRewrite } from '../allow.js';

const why = (path: string) => {
  const answer = allowsRewrite(path);
  return answer.allowed ? undefined : answer.why;
};

describe('allowsRewrite', () => {
  it('offers documentation and CLAUDE.md', () => {
    expect(allowsRewrite('docs/reference/proseStyle.md').allowed).toBe(true);
    expect(allowsRewrite('CLAUDE.md').allowed).toBe(true);
  });

  it('reads a Windows path the same as a POSIX one', () => {
    expect(allowsRewrite('docs\\reference\\proseStyle.md').allowed).toBe(true);
  });

  it('refuses the author’s hand-written list', () => {
    expect(why('todos.md')).toMatch(/refused list/);
  });

  it('refuses the generated command tables', () => {
    expect(why('docs/reference/command-table.md')).toMatch(/refused list/);
  });

  it('refuses archived plans', () => {
    expect(why('docs/plans/archive/undo-refactor.md')).toMatch(/history/);
  });

  it('refuses anything outside docs', () => {
    expect(why('README.md')).toMatch(/only CLAUDE.md and docs/);
    expect(why('packages/types/src/index.ts')).toMatch(/only CLAUDE.md and docs/);
  });
});
