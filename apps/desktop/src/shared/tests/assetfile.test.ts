import { downloadName } from '../assetfile.js';

describe('what a downloaded picture is called', () => {
  it('is its label and its extension', () => {
    expect(downloadName('Aiko — gala, front', 'a1b2c3d4e5', 'png')).toBe('Aiko — gala, front.png');
  });

  it('drops the characters a filesystem refuses, leaving one space in their place', () => {
    expect(downloadName('greet/s2: "wide" <shot>', 'a1b2c3d4e5', 'png')).toBe(
      'greet s2 wide shot.png',
    );
  });

  // Windows writes a trailing dot or space and can then never open the file again
  it('never ends on a dot or a space', () => {
    expect(downloadName('cafe — night. ', 'a1b2c3d4e5', 'jpg')).toBe('cafe — night.jpg');
  });

  it('falls back to the short hash for a label that survives none of it', () => {
    expect(downloadName('///', 'a1b2c3d4e5', 'png')).toBe('a1b2c3d4.png');
  });

  // A reserved name is legal to type and impossible to write on Windows, whatever the extension
  it('falls back to the short hash for a name Windows reserves', () => {
    expect(downloadName('con', 'a1b2c3d4e5', 'png')).toBe('a1b2c3d4.png');
  });

  it('cuts a label long enough to threaten a path limit', () => {
    const name = downloadName('a'.repeat(400), 'a1b2c3d4e5', 'png');
    expect(name.length).toBeLessThan(90);
    expect(name.endsWith('.png')).toBe(true);
  });
});
