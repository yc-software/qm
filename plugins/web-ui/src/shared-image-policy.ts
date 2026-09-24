export function sharedImagePolicy(pageUrl: string, base: string): string {
  const page = new URL(pageUrl);
  const assets = new URL(`${base}assets/`, page).href;
  const devAssets = new URL(`${base}src/assets/`, page).href;
  const files = new URL(`${page.pathname}/files/`, page).href;
  return `img-src data: ${assets} ${devAssets} ${files}`;
}
