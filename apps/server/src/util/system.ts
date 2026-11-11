import path from 'node:path';

/**
 * Windows system tools by absolute path. Called by bare name, Windows and
 * Node's spawn look in the current folder first, where a repository could
 * have placed a same-named program.
 */
export function systemTool(name: 'taskkill.exe' | 'explorer.exe'): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return name === 'explorer.exe' ? path.join(root, name) : path.join(root, 'System32', name);
}
