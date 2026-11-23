import { onPeople, person } from "./people";

export const onSpeakerAvatars = onPeople;

export function speakerAvatar(principalId: string | undefined): string | undefined {
  return person(principalId)?.avatarUrl;
}
