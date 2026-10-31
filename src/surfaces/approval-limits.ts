export const INLINE_COMMAND_MAX = 1_800;

export const APPROVAL_SUMMARY_MAX = 400;

export const isHttpUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//.test(url);
