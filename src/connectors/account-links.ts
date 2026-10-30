export interface ComposioReturn {
  url: string | null;
  toolkit: string;
  expiresAt: number;
}

export interface SlackAccountLink {
  principalId: string;
  accountId: string;
  memberId: string;
  userId: string;
  teamId: string;
  user: string;
  workspace: string;
}
