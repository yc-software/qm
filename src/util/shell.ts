export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
