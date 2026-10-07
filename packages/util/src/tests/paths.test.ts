import { samePath } from '../paths.js';

describe('samePath', () => {
  it('matches a lowercase drive letter against the uppercase one git prints, on win32', () => {
    expect(samePath('c:/story/project1', 'C:\\story\\project1', 'win32')).toBe(true);
    expect(samePath('C:\\Story\\Project1\\', 'c:/story/project1', 'win32')).toBe(true);
    expect(samePath('c:/story/project1', 'C:\\story\\project2', 'win32')).toBe(false);
  });

  it('keeps case significant elsewhere', () => {
    expect(samePath('/story/project1', '/story/project1/', 'linux')).toBe(true);
    expect(samePath('/story/project1', '/Story/project1', 'linux')).toBe(false);
  });
});
