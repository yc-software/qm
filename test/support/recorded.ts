export async function recorded(list: () => Promise<readonly unknown[]>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 300 && (await list()).length < count; attempt++)
    await new Promise((r) => setTimeout(r, 10));
}
