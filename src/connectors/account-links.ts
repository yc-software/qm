interface SlackAccountLink {
  principalId: string;
  accountId: string;
  memberId: string;
  userId: string;
  teamId: string;
  user: string;
  workspace: string;
}

export interface SlackAccountRows {
  get(principalId: string): Promise<SlackAccountLink | null>;
  put(principalId: string, link: SlackAccountLink): Promise<void>;
}
