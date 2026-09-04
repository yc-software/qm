type ExternalRole = "member" | "org_admin";

export interface ExternalMember {
  email: string;
  role: ExternalRole;
  expiresAt: number;
  invitedBy: string;
  createdAt: number;
  updatedAt: number;
}

export function externalMemberActive(m: ExternalMember, now = Date.now()): boolean {
  return m.expiresAt > now;
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}
