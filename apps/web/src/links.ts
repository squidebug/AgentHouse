/**
 * Where a link a CLI wrote into its output (OSC 8) may take the page: web
 * addresses only, as the address the browser would open. Any other scheme
 * (javascript:, data:, file:) and anything unparsable: null. xterm makes links
 * of nothing else unless told to (`allowNonHttpProtocols`); this holds either way.
 */
export function linkTarget(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}
