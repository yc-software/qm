/**
 * The sign-in identifier is an email address.
 *
 * Not because anything is mailed to it — in password mode nothing is — but
 * because it is the person key the directory, `personKey`, the OIDC subject
 * derivation and admin grants already agree on. A separate username would
 * change all four.
 */
export function validEmailIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}
