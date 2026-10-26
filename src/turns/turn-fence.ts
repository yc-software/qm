export interface FenceQueryable {
  query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function turnFenceHeld(db: FenceQueryable, turnId: string, token: string): Promise<boolean> {
  const { rows } = await db.query("SELECT qm_turn_fence($1, $2) AS ok", [turnId, token]);
  return rows[0]?.ok === true;
}
