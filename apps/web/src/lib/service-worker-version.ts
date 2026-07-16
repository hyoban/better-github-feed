export function shellAssetManifest(markup: string) {
  const assets = new Set<string>()
  for (const match of markup.matchAll(
    /(?:src|href)=["'](\/assets\/[^"'#?]+)(?:[?#][^"']*)?["']/g,
  )) {
    const path = match[1]
    if (path) assets.add(path)
  }
  return [...assets].sort().join('\n')
}

export async function shellMarkupVersion(markup: string) {
  const bytes = new TextEncoder().encode(shellAssetManifest(markup))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
